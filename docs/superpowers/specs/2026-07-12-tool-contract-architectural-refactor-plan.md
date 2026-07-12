# Tool Contract Architectural Refactor Plan

Date: 2026-07-12
Status: Draft, pending user review
Scope: Root-cause fix for recurring "model forgets tools" regression

## Executive Summary

The "model forgets available tools after several turns" bug has been patched 40+ times across
commits but never structurally fixed. Every fix adds another guard, another signature match,
another check — without eliminating the condition that makes guard layers necessary. This plan
replaces that defensive layering with a design where the condition cannot arise.

The core change: **the tool contract ceases to be a string embedded in `messages[]` and becomes
a first-class `ToolManifest` data structure carried alongside messages in a new `RequestAssembly`.
The contract is injected at the very last moment — inside the provider adapter's body builder —
so context management, summary compaction, sliding window, and token limiting cannot touch it
because they never see it.**

## Current Architecture: Five Structural Contradictions

### Contradiction 1: Flat-prompt providers collapse all semantic structure

Qwen's `chat2.qianwen.com` and GLM's `chatglm.cn` APIs have no native `tools` field. The adapter
flattens everything into a single text blob: system messages, tool definitions, conversation
history, all concatenated with `\n\n`. The model receives the tool contract as "one paragraph
among many" and its attention to it is purely statistical — no structural guarantee.

**Current code path (Qwen, `qwen.ts:155-192`):**
```
systemPrompts = all system-role messages joined by \n\n
conversationParts = user/assistant/tool messages flattened to text
finalContent = `${systemPrompt}\n\nUser: ${conversation}`
→ sent as messages[0].content to Qwen's chat API
```

The tool contract string lives inside `systemPrompt` because `ToolCallingEngine.injectPrompt()`
appended it to the last system message. If any step before this join mutates, reorders, or drops
system messages, the contract is silently lost.

### Contradiction 2: Contract is injected per-turn, but history accumulates across turns

- `ToolCallingEngine.injectPrompt()` appends the current-turn authoritative contract to the
  last string system message (`ToolCallingEngine.ts:278-289`).
- Context management (sliding window, summary, token limit) operates on the full message
  array including accumulated history.
- The SummaryStrategy generates a narrative summary of "what happened," which may include
  model-generated descriptions of past tool activity ("the assistant used the `read` tool...").
- That narrative competes with the current-turn authoritative contract for the model's attention.

The `summaryPrompt` explicitly says "DO NOT list, describe, or restate available tools," but
enforcing a negative instruction on a weak summarizer model is structurally unreliable.

### Contradiction 3: Nine copy-pasted forward methods, each responsible for calling tool injection

`forwarder.ts` contains 9 provider-specific forward methods, each calling
`this.transformRequestForPromptToolUse()`, which instantiates a new `ToolCallingEngine` and calls
`engine.transformRequest()`. This is a manual convention, not enforced by the type system.

```
forwardDeepSeek   → transformRequestForPromptToolUse (line 762)
forwardGLM        → transformRequestForPromptToolUse (line 970)
forwardKimi       → transformRequestForPromptToolUse (line 1163)
forwardQwen       → transformRequestForPromptToolUse (line 1288)
forwardQwenAi     → transformRequestForPromptToolUse (line 1412)
forwardZai        → transformRequestForPromptToolUse (line 1536)
forwardMinimax    → transformRequestForPromptToolUse (line 1670)
forwardPerplexity → transformRequestForPromptToolUse (line 1846)
forwardMimo       → transformRequestForPromptToolUse (line 1995)
```

Context management runs once in `forwardWithRetry()` (line 594-640), BEFORE these methods.
But if a provider-specific method adds or modifies messages, context management doesn't re-run.
If someone adds a 10th provider and forgets to call transformRequest, the bug is silent until
a user hits the right message count.

### Contradiction 4: Two ghost injection systems exist alongside the real one

- `ToolCallingEngine.transformRequest()` — the real injection system, actually called.
- `PromptInjectionService.process()` — fully implemented, zero importers (grep confirmed).
- `BasePromptAdapter.transformRequest()` + `PromptAdapterRegistry` — implemented, zero callers.

These ghost systems are dead code today, but any agent or developer who reads them and thinks
"this is the injection entry point" will create a double-injection or format-conflict bug.
History already contains this: `02f6737 fix(glm): remove duplicate tool prompt injection
causing format conflict`.

### Contradiction 5: Cross-module protection relies on shared string signatures

`contextManagementService.ts:168 containsToolDefinitions()` protects tool-containing messages
from deletion by checking `hasGeneralToolPromptSignature(content)` and `/<tools>[\s\S]*?<\/tools>/i`.

This means:
- Changing `## Available Tools` to any other header silently disables protection.
- A user message containing `## Available Tools` is wrongly protected.
- An assistant reply containing `<tools>` is wrongly protected.
- `GENERAL_TOOL_SIGNATURES` (17 strings in `constants/signatures.ts`) must be manually kept in
  sync with every prompt template change across 5 protocol adapters and an unknown number of
  prompt variants.

### Why patches keep failing

Every past fix added one more rule/guard/signature to this system:

```
04b2fa9 feat: inject tool contract header           ← added contract header
976f402 feat: detect tool availability drift         ← added drift detection
5776043 feat: record tool catalog diagnostics        ← added diagnostics
446d3e3 feat: adapter tool-injection enforcement     ← added eslint rules
bf0f16a feat: add prompt-embedded tool catalog       ← added embedded catalog
475fce3 fix: harden stream tool parsing              ← added parser hardening
481149e feat: harden tool calling across providers   ← added sanitizer + retry
```

Each fix addressed a symptom. None addressed the condition: **the tool contract is a string
embedded in a mutable array, and every module in the pipeline has access to mutate that array.**

## Target Architecture

### Core insight

A tool contract is **not conversation content**. It is **per-turn runtime configuration** that
the provider adapter must render into the final request body. It should be carried alongside
messages as a first-class typed value, not embedded inside them as a substring.

### New data flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Forwarder.requestPipeline()                     │
│                                                                     │
│  messages[]                                                        │
│    │                                                                │
│    ├─► ContextManagementService.process(messages)                   │
│    │   └─► compacted messages + summaryText (if compaction)         │
│    │                                                                │
│    ├─► ToolCallingEngine.planTools(messages, tools, provider)       │
│    │   └─► ToolManifest { header, tools[], renderedPrompt }         │
│    │       (Does NOT modify messages)                               │
│    │                                                                │
│    └─► RequestAssembly = {                                         │
│          messages: compactedMessages,                               │
│          toolManifest: ToolManifest | null,                        │
│          summaryText: string | null,                               │
│        }                                                            │
│                                                                     │
│  ProviderAdapter.buildRequestBody(assembly) → API-specific body    │
│    └─► Adapter is the ONLY place contract text joins history text  │
└─────────────────────────────────────────────────────────────────────┘
```

### Key properties

1. **Context management never sees the tool contract.** It operates on messages only.
2. **ToolCallingEngine doesn't mutate messages.** It produces a `ToolManifest` value object.
3. **Provider adapters are the single assembly point.** They receive the contract as a typed
   object, not as a substring they must search for.
4. **No string-based cross-module coupling.** Modules communicate through typed interfaces,
   not shared string constants.

### Component responsibilities (before vs after)

| Component | Before (Current) | After (Target) |
|---|---|---|
| `ToolCallingEngine` | Mutates messages by appending tool prompt to last system message | Returns `ToolManifest`; messages untouched |
| `ContextManagementService` | Must detect/protect tool-containing messages via string matching | Operates on messages without tool-awareness |
| `SummaryStrategy` | Must guard against summarizer reproducing tool content | Summarizes conversation only; contract is not in summary input |
| Provider adapters | Each has its own `extractManagedToolPrompt` / `toolsPrompt` / `systemMessages.join()` logic | Receive `RequestAssembly` with contract as typed field; use a single `renderFinalPrompt()` helper |
| `Forwarder` forward methods | 9 copy-pasted call sites for `transformRequestForPromptToolUse()` | 1 unified `prepareRequest()` method; 9 provider methods receive pre-built assembly |
| `PromptInjectionService` | Dead code, implemented but unused | Deleted |
| `PromptAdapterRegistry` + adapters | Dead code, implemented but unused | Deleted |
| `GENERAL_TOOL_SIGNATURES` | Used by both context management and tool injection for cross-module string matching | Reduced to output-parsing use only |

## Phase-by-Phase Implementation Plan

### Phase 0: Audit and freeze (1 file changed, 0 behavior change)

**Goal:** Document every call site and dependency before touching anything.

**Actions:**
1. Run the full regression gate and record baseline:
   ```powershell
   node --test tests/tool-calling/*.test.ts tests/providers/*.test.ts tests/services/*.test.ts tests/tool-runtime/**/*.test.ts tests/routes/*.test.ts
   ```
2. Generate a dependency graph of all files that import from:
   - `ToolCallingEngine`
   - `contextManagementService`
   - `promptInjectionService`
   - `adapters/prompt/*`
   - `constants/signatures`
3. Tag the current HEAD as `pre-tool-contract-refactor` for easy rollback.

**Acceptance:** Baseline test count and pass rate recorded. Dependency graph committed to
the spec directory.

### Phase 1: Introduce `ToolManifest` and `RequestAssembly` (3 new files, 0 behavior change)

**Goal:** Create the new data types. No existing code changes behavior.

**New files:**
- `src/main/proxy/toolCalling/ToolManifest.ts` — `ToolManifest` type and `createToolManifest()` factory
- `src/main/proxy/RequestAssembly.ts` — `RequestAssembly` type and `buildRequestAssembly()` factory
- `tests/tool-calling/tool-manifest.test.ts` — unit tests for manifest creation

**`ToolManifest` type:**
```typescript
interface ToolManifest {
  /** Protocol used to render the prompt (managed_xml, managed_bracket, etc.) */
  protocol: ToolProtocolId
  /** Fingerprint of the tool catalog used to generate this manifest */
  catalogFingerprint: string
  /** List of tool names allowed in this turn */
  allowedToolNames: string[]
  /** The tool definitions */
  tools: NormalizedToolDefinition[]
  /** Pre-rendered prompt text for the whole tool section (header + definitions) */
  renderedPrompt: string
  /** Contract header metadata */
  contractHeaderVersion: number
}
```

**`RequestAssembly` type:**
```typescript
interface RequestAssembly {
  /** Conversation messages (after context management, without tool contract strings) */
  messages: ChatMessage[]
  /** Authoritative tool contract for this turn, or null if no tools */
  toolManifest: ToolManifest | null
  /** Summary text if summary compaction occurred, null otherwise */
  summaryText: string | null
  /** Metadata for diagnostics */
  metadata: {
    contextManagementApplied: boolean
    strategiesExecuted: string[]
    originalMessageCount: number
    finalMessageCount: number
  }
}
```

**`buildRequestAssembly()` function:**
```typescript
function buildRequestAssembly(input: {
  messages: ChatMessage[]
  toolManifest: ToolManifest | null
  summaryText?: string | null
  contextResult?: ContextProcessResult
}): RequestAssembly
```

**Acceptance:**
- New types compile without errors.
- `tool-manifest.test.ts` passes.
- Full regression gate output unchanged from Phase 0 baseline.

### Phase 2: Extract tool prompt rendering from `injectPrompt()` into `createToolManifest()` (2 files changed)

**Goal:** `ToolCallingEngine` gains a `createToolManifest()` method that produces a `ToolManifest`
without mutating messages. The existing `injectPrompt()` behavior is preserved via a wrapper.

**Changed files:**
- `src/main/proxy/toolCalling/ToolCallingEngine.ts`
- `tests/tool-calling/tool-engine.test.ts`

**Changes to `ToolCallingEngine`:**
1. Add `createToolManifest(plan: ToolCallingPlan): ToolManifest` — renders the prompt and
   packages it with metadata into a ToolManifest. Pure function, no side effects on messages.
2. `transformRequest()` now:
   - Calls `createToolManifest(plan)` to get the manifest
   - Appends `toolManifest` to the returned `ToolCallingTransformResult` (new optional field)
   - Still calls `injectPrompt()` for backward compatibility (existing callers still get
     contract-in-messages behavior)
3. Add temporary console.warn if `injectPrompt()` is called — to identify any callers we
   missed during audit.

**`ToolCallingTransformResult` becomes:**
```typescript
interface ToolCallingTransformResult {
  messages: ChatMessage[]
  tools?: ChatCompletionTool[]
  plan: ToolCallingPlan
  toolManifest?: ToolManifest  // NEW
}
```

**Acceptance:**
- All existing tests pass (contract still injected into messages for backward compat).
- New tests verify `createToolManifest()` produces correct renderedPrompt for each protocol.
- No console.warn about unexpected injectPrompt() callers appears in test output.

### Phase 3: Teach provider adapters to consume `RequestAssembly` (new interface, 0 adapters changed)

**Goal:** Define the `ProviderRequestPreparer` interface that adapters will implement.
Create a `renderFinalPrompt()` shared helper. No adapter behavior changes yet.

**New files:**
- `src/main/proxy/adapters/ProviderRequestPreparer.ts` — interface definition
- `src/main/proxy/adapters/renderFinalPrompt.ts` — shared prompt assembly helper
- `tests/providers/render-final-prompt.test.ts`

**`ProviderRequestPreparer` interface:**
```typescript
interface ProviderRequestPreparer {
  /** Build the API-specific request body from a RequestAssembly */
  buildRequestBody(assembly: RequestAssembly, options: ProviderRequestOptions): unknown

  /** Build the API-specific messages array from a RequestAssembly */
  buildMessages(assembly: RequestAssembly, options: ProviderRequestOptions): unknown[]
}
```

**`renderFinalPrompt()` helper:**
```typescript
function renderFinalPrompt(input: {
  baseSystemPrompt: string | null        // from system messages (base instructions)
  summaryText: string | null             // from context compaction
  toolContractText: string | null        // from ToolManifest.renderedPrompt
  conversationText: string               // from user/assistant/tool messages
  template: 'prefix' | 'suffix' | 'interleave'
  separator?: string                     // default '\n\n'
}): string
```

This replaces the duplicated pattern in Qwen (`systemPrompt + '\n\nUser: ' + userContent`),
GLM (`systemPrompt ? `${systemPrompt}\n\nUser: ${userContent}` : userContent`), and others.

**Acceptance:**
- `render-final-prompt.test.ts` passes for all template modes.
- No existing tests break (interface is defined, not yet implemented by adapters).

### Phase 4: Migrate one provider adapter as proof of concept (Qwen, 3 files changed)

**Goal:** Convert the Qwen adapter to consume `RequestAssembly`. This is the highest-risk
provider and the primary subject of the recurring bug. Proving it works on Qwen first
de-risks the remaining adapters.

**Changed files:**
- `src/main/proxy/adapters/qwen.ts`
- `src/main/proxy/forwarder.ts` (`forwardQwen` only)
- `tests/providers/qwen-request-routing.test.ts`

**Changes to `QwenAdapter`:**
1. Add `buildRequestBody(assembly: RequestAssembly, options): any` method.
2. This method calls `renderFinalPrompt()` with `toolContractText` from `assembly.toolManifest`,
   `summaryText` from `assembly.summaryText`, and system messages + conversation from
   `assembly.messages`.
3. `buildQwenChatRequestBody()` is refactored to delegate to `buildRequestBody()`. The old
   signature is preserved for now, marked `@deprecated`.

**Changes to `forwarder.ts`:**
1. In `forwardQwen()`, change the flow from:
   ```
   transformed = this.transformRequestForPromptToolUse(request, provider, toolSessionKey)
   // transformed.messages has the contract embedded as a string
   adapter.chatCompletion({ messages: transformed.messages, ... })
   ```
   to:
   ```
   assembly = this.prepareRequest(request, provider, toolSessionKey)  // NEW unified method
   adapter.chatCompletionWithAssembly(assembly, options)
   ```

2. Add `prepareRequest()` as a private method:
   ```typescript
   private prepareRequest(request, provider, toolSessionKey): RequestAssembly {
     const transformed = this.transformRequestForPromptToolUse(request, provider, toolSessionKey)
     return buildRequestAssembly({
       messages: this.stripToolContractsFromMessages(transformed.messages),
       toolManifest: transformed.toolManifest ?? null,
       contextResult: this.lastContextResult,
     })
   }
   ```

**Changes to tests:**
- `qwen-request-routing.test.ts`: Update tests to use `buildRequestBody(assembly)`.
- Add tests for: contract always after summary, contract present even when 0 system messages
  in input, contract preserved when contextResult is null.

**Acceptance:**
- `node --test tests/providers/qwen-request-routing.test.ts` passes.
- Full regression gate unchanged.
- Manual OpenCode probe: `qwen/Qwen3.7-Max` with `--ContextMaxMessages 4 --SummaryKeepRecentMessages 3`
  produces real tool use after compaction.

### Phase 5: Remove tool contract from messages (2 files changed)

**Goal:** `ToolCallingEngine.injectPrompt()` is replaced by `createToolManifest()`.
Messages are no longer mutated by tool injection.

**Changed files:**
- `src/main/proxy/toolCalling/ToolCallingEngine.ts`
- `tests/tool-calling/tool-engine.test.ts`

**Changes:**
1. `transformRequest()` no longer calls `injectPrompt()`. It calls `createToolManifest()`
   and returns the manifest alongside unmodified messages.
2. `injectPrompt()` and `findLastStringSystemMessageIndex()` are deleted.
3. `ToolCallingTransformResult.messages` is now always `request.messages` (unchanged).

**Acceptance:**
- All tests that check for tool contract in `transformed.messages` are updated to check
  `transformed.toolManifest.renderedPrompt` instead.
- Full regression gate passes.
- Qwen adapter no longer finds tool contract strings in its input messages —
  the strings now come from `assembly.toolManifest.renderedPrompt`.

### Phase 6: Remove tool-protection logic from context management (3 files changed)

**Goal:** Context management no longer needs to know about tool definitions. The
`containsToolDefinitions()` function and its callers are simplified.

**Changed files:**
- `src/main/proxy/services/contextManagementService.ts`
- `tests/services/context-management.test.ts`
- `tests/providers/context-tool-metadata.test.ts` (update or remove)

**Changes:**
1. Remove `containsToolDefinitions()`.
2. In `SlidingWindowStrategy.execute()` and `TokenLimitStrategy.execute()`:
   - `protectedMessages` filter changes from `msg.role === 'system' || containsToolDefinitions(msg) || ...`
     to `msg.role === 'system' || ...` (system still protected; tool definitions no longer
     a special case because they're not in messages at all).
3. Remove the `hasGeneralToolPromptSignature` import from contextManagementService.
4. In `sanitizeMessagesForSummary()` (`summarySanitizer.ts`):
   - Remove the tool-catalog stripping logic for system messages (system messages no longer
     contain tool catalogs).
   - Keep the assistant-message stripping (assistant might still quote tool names).
   - Keep the tool-exchange summarization (tool_call/tool_result pairs → placeholder text).

**Acceptance:**
- `node --test tests/services/context-management.test.ts` passes.
- Sliding window no longer protects messages based on tool content strings.
- Summary compaction no longer needs to guard against tool catalog contamination in system messages.
- Full regression gate passes.

### Phase 7: Migrate remaining provider adapters (9 files changed, one at a time)

**Goal:** Each provider adapter implements `buildRequestBody(assembly)` and the forwarder's
corresponding forward method uses `prepareRequest()`.

**Order (least-risk first):**
1. `mimo.ts` — newest adapter, fewest dependencies
2. `zai.ts` — experimental status, low traffic
3. `kimi.ts` — similar pattern to Qwen
4. `minimax.ts` — similar pattern
5. `perplexity.ts` — has `PerplexityStreamHandler`, needs careful stream test
6. `qwen-ai.ts` — variant of Qwen
7. `deepseek.ts` — most complex adapter, has session/token management
8. `glm.ts` — has conversation state, `extractManagedToolPrompt`, multi-turn support
9. `deepseek-stream.ts` — stream variant

**For each adapter:**
1. Add `buildRequestBody(assembly: RequestAssembly, options): any` method.
2. In the forwarder, replace the direct `transformRequestForPromptToolUse()` call with
   `this.prepareRequest()` + `adapter.buildRequestBody()`.
3. Run the adapter's specific tests.
4. Run the full regression gate.

**Acceptance (per adapter):**
- Adapter-specific tests pass.
- Provider capability probe passes for that provider.
- Full regression gate passes.

### Phase 8: Delete dead code (6+ files deleted)

**Goal:** Remove the ghost injection systems.

**Files to delete:**
- `src/main/proxy/services/promptInjectionService.ts`
- `src/main/proxy/adapters/prompt/BasePromptAdapter.ts`
- `src/main/proxy/adapters/prompt/DefaultPromptAdapter.ts`
- `src/main/proxy/adapters/prompt/KiloCodePromptAdapter.ts`
- `src/main/proxy/adapters/prompt/CherryStudioPromptAdapter.ts`
- `src/main/proxy/adapters/prompt/PromptAdapterRegistry.ts`
- `src/main/proxy/adapters/prompt/index.ts`

**Files to update:**
- Remove exports of deleted files from barrel exports.
- `src/main/proxy/services/promptGenerator.ts` — keep only if still used; audit first.
- `src/main/proxy/utils/clientDetector.ts` — keep `detectClient()` and `hasToolPromptInjected()`
  if they're used by the response-parsing path; audit first and remove injection-only functions.

**Acceptance:**
- `tsc --noEmit` passes.
- Grep for `PromptInjectionService`, `BasePromptAdapter`, `PromptAdapterRegistry` returns
  zero results in `src/`.
- Full regression gate passes.

### Phase 9: Unify forwarder call sites (1 file changed: `forwarder.ts`)

**Goal:** Replace 9 duplicate `transformRequestForPromptToolUse()` + ad-hoc preparation logic
with a single `prepareRequest()` pipeline.

**Changed files:**
- `src/main/proxy/forwarder.ts`

**Changes:**
1. `prepareRequest()` becomes the single preparation entry point:
   ```typescript
   private prepareRequest(
     request: ChatCompletionRequest,
     provider: Provider,
     actualModel: string,
     context: ProxyContext
   ): RequestAssembly {
     const config = storeManager.getConfig()
     const toolSessionKey = this.buildToolCatalogSessionKey(provider, account, actualModel, context)
     const transformed = this.transformRequestForPromptToolUse(request, provider, toolSessionKey)

     return buildRequestAssembly({
       messages: request.messages,  // ToolCallingEngine no longer mutates these
       toolManifest: transformed.toolManifest ?? null,
       summaryText: context.summaryText ?? null,
       contextResult: context.lastContextResult,
     })
   }
   ```

2. Each `forwardXxx()` method replaces:
   ```typescript
   const toolSessionKey = this.buildToolCatalogSessionKey(...)
   const transformed = this.transformRequestForPromptToolUse(request, provider, toolSessionKey)
   const transformedRequest = { ...request, messages: transformed.messages, tools: transformed.tools }
   ```
   with:
   ```typescript
   const assembly = this.prepareRequest(request, provider, actualModel, context)
   ```

3. The `requestId` parameter to `transformRequestForPromptToolUse` is moved to
   `prepareRequest()`.

**Acceptance:**
- All provider forward methods use `prepareRequest()`.
- No direct calls to `transformRequestForPromptToolUse()` remain in forward methods
  (only in `prepareRequest()` and retry paths).
- Full regression gate passes.
- All provider capability probes pass.

### Phase 10: Reduce `GENERAL_TOOL_SIGNATURES` to output-parsing scope only

**Goal:** The signature constants file is no longer used for cross-module tool-injection
coordination. Reduce it to what's needed for response parsing.

**Changed files:**
- `src/main/proxy/constants/signatures.ts`
- All files that import from it (audit via grep)

**Changes:**
1. Keep signatures needed for:
   - Client detection (`CLIENT_SIGNATURES` — used to identify which client sent the request)
   - Output format detection (`FORMAT_SIGNATURES` — used to parse tool calls from model output)
   - `hasGeneralToolPromptSignature()` — keep for response-side checks only (detecting if a
     model response contains tool injection artifacts)
2. Remove or mark `@deprecated` signatures that existed only for injection-side protection.
3. Add comment: "These signatures are for OUTPUT PARSING only. Tool injection no longer
   uses string-based detection."

**Acceptance:**
- `tsc --noEmit` passes.
- Response parsing tests pass.
- No injection-side code imports these constants.

## Risk Assessment

### High risk
- **Phase 5 (remove contract from messages):** If any code path still reads tool contract
  from messages after this phase, tools silently vanish. Mitigation: Phase 4 proves the new
  path works on Qwen before Phase 5 removes the old path.
- **Phase 7 (DeepSeek + GLM):** These adapters have the most bespoke logic. Mitigation:
  migrate them one at a time, test each with a live probe, keep Phase 0's git tag for
  instant rollback.

### Medium risk
- **Phase 6 (context management simplification):** Removing protection logic could cause
  sliding window to drop system messages unexpectedly. Mitigation: system messages themselves
  are still protected; only the tool-signature-based additional protection is removed.
  The tests in `context-tool-metadata.test.ts` validate this.

### Low risk
- **Phase 8 (delete dead code):** If we mis-identify code as dead, compilation breaks
  immediately. Mitigation: `tsc --noEmit` catches this. No runtime risk.
- **Phase 10 (signature reduction):** If a signature is still needed, tests break.
  Mitigation: grep audit before removing any constant.

### Rollback strategy
Each phase produces a commit. If any phase fails:
1. `git revert <phase-commit>` to return to the previous phase.
2. Or `git reset --hard pre-tool-contract-refactor` for full rollback.

## Test Strategy

### Regression gate (run after every phase)
```powershell
node --test tests/tool-calling/*.test.ts tests/providers/*.test.ts tests/services/*.test.ts tests/tool-runtime/**/*.test.ts tests/routes/*.test.ts
```

### Provider capability probes (run after Phases 4, 7, 9)
```powershell
powershell -ExecutionPolicy Bypass -File .\tests\agent-capability\verify-opencode-provider-matrix.ps1 -Models "qwen/Qwen3.7-Max","glm/glm-4.7","deepseek/deepseek-chat" -Runs 1
```

### Live long-conversation probe (run after Phases 4, 7)
```powershell
powershell -ExecutionPolicy Bypass -File .\tests\agent-capability\verify-opencode-long-conversation.ps1 -Model "qwen/Qwen3.7-Max" -ContextMaxMessages 4 -SummaryKeepRecentMessages 3 -TimeoutSeconds 300
```

### New unit tests (created in early phases, maintained throughout)
- `tests/tool-calling/tool-manifest.test.ts`
- `tests/providers/render-final-prompt.test.ts`
- `tests/providers/request-assembly.test.ts`

## Appendix A: Complete File Inventory

### Files to create (5)
1. `src/main/proxy/toolCalling/ToolManifest.ts`
2. `src/main/proxy/RequestAssembly.ts`
3. `src/main/proxy/adapters/ProviderRequestPreparer.ts`
4. `src/main/proxy/adapters/renderFinalPrompt.ts`
5. `tests/tool-calling/tool-manifest.test.ts`
6. `tests/providers/render-final-prompt.test.ts`
7. `tests/providers/request-assembly.test.ts`

### Files to modify (25+)
1. `src/main/proxy/toolCalling/ToolCallingEngine.ts`
2. `src/main/proxy/toolCalling/types.ts`
3. `src/main/proxy/forwarder.ts`
4. `src/main/proxy/adapters/qwen.ts`
5. `src/main/proxy/adapters/glm.ts`
6. `src/main/proxy/adapters/deepseek.ts`
7. `src/main/proxy/adapters/deepseek-stream.ts`
8. `src/main/proxy/adapters/kimi.ts`
9. `src/main/proxy/adapters/minimax.ts`
10. `src/main/proxy/adapters/zai.ts`
11. `src/main/proxy/adapters/mimo.ts`
12. `src/main/proxy/adapters/perplexity.ts`
13. `src/main/proxy/adapters/qwen-ai.ts`
14. `src/main/proxy/adapters/index.ts`
15. `src/main/proxy/services/contextManagementService.ts`
16. `src/main/proxy/services/summarySanitizer.ts`
17. `src/main/proxy/services/contextManagementRetry.ts`
18. `src/main/proxy/constants/signatures.ts`
19. `tests/tool-calling/tool-engine.test.ts`
20. `tests/providers/qwen-request-routing.test.ts`
21. `tests/providers/context-tool-metadata.test.ts`
22. `tests/services/context-management.test.ts`
23. `tests/services/summary-sanitizer.test.ts` (create if missing)
24. `tests/agent-capability/verify-opencode-long-conversation.ps1`

### Files to delete (7+)
1. `src/main/proxy/services/promptInjectionService.ts`
2. `src/main/proxy/adapters/prompt/BasePromptAdapter.ts`
3. `src/main/proxy/adapters/prompt/DefaultPromptAdapter.ts`
4. `src/main/proxy/adapters/prompt/KiloCodePromptAdapter.ts`
5. `src/main/proxy/adapters/prompt/CherryStudioPromptAdapter.ts`
6. `src/main/proxy/adapters/prompt/PromptAdapterRegistry.ts`
7. `src/main/proxy/adapters/prompt/index.ts`
8. `src/main/proxy/services/promptGenerator.ts` (audit first; keep if used by non-injection code)

## Appendix B: Dependency Graph (current → target)

```
CURRENT:
  forwarder.ts
    ├── ToolCallingEngine.transformRequest()  ← injects contract into messages
    ├── ContextManagementService.process()     ← must protect tool-containing messages
    │   ├── containsToolDefinitions()          ← string matching on GENERAL_TOOL_SIGNATURES
    │   └── SummaryStrategy                   ← must sanitize + detect contamination
    ├── 9× forwardXxx()                       ← each calls transformRequest manually
    │   └── ProviderAdapter                   ← each extracts tool prompt from messages
    └── ContextManagementRetry                ← rebuilds messages without summaries

  (GHOST) PromptInjectionService.process()     ← zero callers
  (GHOST) PromptAdapterRegistry                ← zero callers

TARGET:
  forwarder.ts
    ├── prepareRequest()                       ← SINGLE preparation entry point
    │   ├── ContextManagementService.process() ← operates on messages, no tool awareness
    │   └── ToolCallingEngine.createToolManifest() ← pure function, no message mutation
    └── 9× forwardXxx()
        └── ProviderAdapter.buildRequestBody(assembly)  ← contract comes from assembly, not messages
```

## Appendix C: What Does NOT Change

These components are deliberately NOT modified:
- **Tool stream parsing** (`ToolStreamParser`, `outputInspection`, protocol parsers) — these
  operate on model output, not request assembly.
- **Tool catalog resolution** (`buildToolCallingRuntimePlan`, catalog snapshot, drift detection) —
  the catalog logic is correct; only the *injection* of its output into messages changes.
- **Client detection** (`detectClient`, `CLIENT_SIGNATURES`) — still needed to identify which
  client is making the request.
- **Provider conversation state** (`ProviderConversationState`, multi-turn session tracking) —
  independent concern.
- **Account pool rotation** — independent concern.
- **MCP proxy layer** — independent concern.
