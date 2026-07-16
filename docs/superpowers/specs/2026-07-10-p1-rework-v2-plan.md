# P1 Rework v2 Plan — Prompt-Embedded Tool Catalog Promotion

Date: 2026-07-10
Parent spec: `docs/superpowers/specs/2026-07-10-agent-tooling-stability-spec.md`
Predecessor: `docs/superpowers/specs/2026-07-10-p1-tool-availability-drift-rework-plan.md` (v1, rejected on GLM)

## Objective

Close the last P1 hole: when a client (OpenCode / Anthropic-style) delivers its tool catalog **inside system-prompt text** instead of the OpenAI `tools[]` array, Chat2API must still see an authoritative catalog inside `ToolCallingEngine`. Only then can `detectAvailabilityDrift`, catalog-fingerprint diagnostics, and the retry clarification actually engage against real GLM/Qwen/DeepSeek runs.

The v1 rework accepted the correct classification (streaming availability drift), added deterministic coverage, and improved detection strings. It did **not** solve the root defect and it must not be treated as closed.

## Verdict On v1 Rework

**Not accepted.**

Passing evidence (kept):

- Focused P1 drift gate 78/78.
- Full deterministic gate 219/219.
- Qwen OpenCode probe pass.
- DeepSeek OpenCode probe pass.
- Chinese + English "only `open_url` available" phrases now recognized in `availabilityDrift.ts`.
- GLM split managed-marker fixture in `tests/providers/glm-tool-calling.test.ts`.

Failing evidence (blocks acceptance):

- Repeated real GLM OpenCode probe failure.
- First real assistant turn is plain text: `环境中唯一可用的工具是 open_url`.
- Fake `CAPABILITY_PROBE_DONE` emitted with no real `skill` / `read` / `bash` chain.
- No `.agent-probe/result.json` written.
- Verifier correctly failed.

## Confirmed Root Cause

The failure is not phrase coverage in `availabilityDrift.ts`. It is that in the real OpenCode/GLM path there is no authoritative catalog for the drift guard to work against.

Trace:

1. OpenCode (and Claude Code Anthropic-style traffic) inlines its tool contract into the **system prompt text** — `## Available Tools`, tool blocks, `<|CHAT2API|tool_calls>` protocol section — and sends `tools: undefined` or `tools: []` in the OpenAI request body.
2. `forwarder.transformRequestForPromptToolUse()` calls `engine.transformRequest()`. `standardOpenAiToolsAdapter.normalizeRequest()` reads `request.tools` — which is empty — so `clientRequest.tools = []`.
3. `buildToolCallingRuntimePlan()` receives `requestTools: []`. `resolveToolCatalog()` finds no session catalog for a first-turn conversation, so it returns `snapshot = undefined` and the plan gets `catalogSnapshot: undefined`, `allowedToolNames: ∅`, `shouldInjectPrompt: false`.
4. `GLM adapter.extractManagedToolPrompt()` still reads `## Available Tools` from the system message text, logs the tool names, and forwards the prompt to GLM. So GLM sees a full tool contract while Chat2API sees an empty catalog.
5. `detectAvailabilityDrift()` intentionally short-circuits when `plan.catalogSnapshot` is missing or `allowedToolNames` is empty. That is correct design under the strict single-owner invariant — the guard refuses to fabricate a catalog.
6. GLM replies `环境中唯一可用的工具是 open_url` as ordinary streamed text. With no authoritative catalog, no retry fires, no diagnostic is raised, and the denial text streams straight to OpenCode. OpenCode later produces a bogus `CAPABILITY_PROBE_DONE`, no `.agent-probe/result.json`, and the probe fails.

The v1 rework only tightened detection and streaming — the layer that never got a chance to run.

## Root Fix Direction

Promote the tools embedded in the client's system prompt text into a **normalized catalog** that flows through the exact same path as OpenAI `tools[]`:

```text
Client-injected system-prompt tool block
        │
        ▼
Prompt-catalog extractor  (new)
        │  normalizes to NormalizedToolDefinition[]
        ▼
ToolClientAdapter.normalizeRequest
        │  tools + toolSource: 'prompt_embedded'
        ▼
buildToolCallingRuntimePlan → resolveToolCatalog
        │  produces snapshot + fingerprint + allowedToolNames
        ▼
ToolCallingEngine.transformRequest
        │  attaches Tool Contract Header + catalogSnapshot
        ▼
Provider adapters (GLM/Qwen/QwenAI)   (unchanged; no second injection)
        │
        ▼
Stream/non-stream response  →  detectAvailabilityDrift now armed
```

Invariants preserved:

- `ToolCallingEngine` remains the single owner of managed tool prompt injection.
- Provider adapters do not import `hasToolPromptInjected`, `toolsToSystemPrompt`, or any injection helper.
- The prompt-embedded catalog is treated as **input** the engine consumes, not a second injection path.

## Scope

Primary files to change:

- `src/main/proxy/toolCalling/clientAdapters/standardOpenAiTools.ts`
- (New) `src/main/proxy/toolCalling/clientAdapters/promptEmbeddedToolExtractor.ts`
- `src/main/proxy/toolCalling/clientAdapters/types.ts`
- `src/main/proxy/toolCalling/catalog.ts`
- `src/main/proxy/toolCalling/types.ts`
- `src/main/proxy/toolCalling/availabilityDrift.ts` (diagnostics only — do not weaken the empty-catalog guard)
- `src/main/proxy/toolCalling/ToolCallingEngine.ts` (attach source diagnostics; ensure catalog reaches drift detection unchanged)
- `src/main/proxy/toolCalling/runtimePlan.ts` (thread new source into diagnostics)
- `src/main/proxy/toolCalling/diagnostics.ts`
- `src/main/proxy/adapters/glm.ts` — no logic added; just verify `extractManagedToolPrompt` continues to work but never invents catalog authority
- `src/main/proxy/adapters/qwen.ts`, `src/main/proxy/adapters/qwen-ai.ts` — verify no injection helpers added

Primary tests to add or update:

- `tests/tool-calling/prompt-embedded-catalog.test.ts` (new)
- `tests/tool-calling/catalog-fallback.test.ts` — extend for new `prompt_embedded` source ordering
- `tests/tool-calling/availability-drift-retry.test.ts` — add streaming retry cases with a catalog produced only from prompt text
- `tests/providers/glm-tool-calling.test.ts` — add the `唯一可用的工具是 open_url` fixture under a prompt-embedded catalog and require either a retry attempt or an explicit availability-drift failure
- `tests/providers/qwen-request-routing.test.ts` — regression that Qwen paths do not regress when the same extractor runs
- `tests/tool-runtime/integration/*.test.ts` — round-trip check that promoted catalog produces the same OpenAI `tool_calls` output as native `tools[]`

Invariant guards to keep or add:

- Static check (in an existing INV test) that provider adapters do not import prompt-injection helpers.
- Static/runtime assertion that a plan whose `toolSourceChain` includes `prompt_embedded` still populates `catalogSnapshot` and `allowedToolNames`.

## Required Behavior

### 1. Prompt-Embedded Catalog Extractor

Add a pure function that, given `ChatCompletionRequest.messages`, returns:

```ts
{
  tools: NormalizedToolDefinition[]      // canonicalized, deduplicated
  source: 'prompt_embedded'
  clientSignature: ClientType            // reuses constants/signatures.ts
  markers: {
    availableToolsHeader: boolean         // '## Available Tools' present
    managedProtocolHeader: boolean        // '<|CHAT2API|tool_calls>' section present
    mcpServerBlock: boolean               // '<tools>...' style block present
  }
  rawFingerprint: string                  // stable hash of the extracted block
}
```

Extraction rules:

- Only inspect `role: 'system'` and `role: 'user'` string content.
- Reuse `hasGeneralToolPromptSignature()` and `CLIENT_SIGNATURES` to classify.
- Parse `## Available Tools` blocks by locating `Tool \`([^`]+)\`` entries (already used ad-hoc in `glm.ts`) plus the accompanying JSON-schema block when present.
- Parse Cherry-Studio / MCP-style `<tools><tool name="X"><description>...</description><parameters>...</parameters></tool></tools>` blocks.
- Never fabricate a schema. If the schema block is absent or unparsable, emit a degraded stub `{ type: 'object', additionalProperties: true }` and record `driftKinds: ['schema_degraded_from_prompt']`.
- Do **not** mutate the message content. Extraction is read-only.

The extractor lives under `clientAdapters/` because it is client-shape logic, not protocol logic.

### 2. Adapter Wiring

Extend `standardOpenAiToolsAdapter.normalizeRequest` (or introduce a small pipeline in `getToolClientAdapter`) so that:

- If `request.tools` is non-empty, behavior is unchanged. `toolSource: 'openai'`.
- If `request.tools` is empty and the extractor finds a catalog, use the extracted `tools[]` with `toolSource: 'prompt_embedded'` and record `clientSignature`, `markers`, and `rawFingerprint` in the adapter diagnostics.
- If neither is present, fall through to today's `toolSource: 'none'`.

`NormalizedClientToolRequest.toolSource` must gain the literal `'prompt_embedded'`.

### 3. Catalog Ordering

Update `resolveToolCatalog` order to:

```text
Session Store
  → Request Tools (OpenAI native)
  → Prompt-Embedded Extraction
  → Message History Extraction
  → Safe Empty
```

Notes:

- Session Store still wins for later turns of the same session, so multi-turn behavior is unchanged when the first turn seeded the catalog.
- Prompt-Embedded ranks above History because it comes from the client's own current-turn declaration.
- History Extraction remains the degraded name-only fallback and must keep its `restored_from_history` label so it is distinguishable in diagnostics.
- Add a new `driftKind: 'prompt_embedded_only_catalog'` so operators can tell in logs that the catalog came from prompt text rather than a proper tools array.

### 4. Availability Drift Guard Now Armed

`detectAvailabilityDrift` behavior does **not** relax. It still requires `plan.catalogSnapshot` and non-empty `allowedToolNames`. The change is that in the OpenCode/GLM path those conditions now become true because the extractor filled the catalog.

Retry clarification must include:

- `catalog_fingerprint`
- `catalog_source: prompt_embedded` (or `session_catalog`)
- exact allowed tool names
- an authoritative statement that the runtime catalog overrides any tool availability claims in prior assistant text

If the model already emitted the denial before the streaming classifier could hold it, the pre-existing behavior applies: emit a typed `availability_drift` failure diagnostic and end the response with a client-visible failure rather than accepting the denial.

### 5. Diagnostics And Invariants

Add these fields (or verify they exist) on every strict-agent turn:

- `catalogSource`: `session_catalog | openai_tools | prompt_embedded | restored_from_history | safe_empty`
- `catalogFingerprint`
- `promptEmbeddedMarkers`: which prompt signatures matched
- `allowedToolNames`
- `availabilityDriftDetected`
- `availabilityRetryResult`: `attempted | succeeded | failed | skipped | not_applicable`
- `responseMode`
- `deniedToolNames`, `mentionedUnavailableOnlyTools`

No provider adapter is allowed to add these fields itself. All must flow from `ToolCallingEngine`.

### 6. Non-Goals For v2

- Do not add a second prompt injection in `glm.ts` / `qwen.ts` / `qwen-ai.ts`.
- Do not weaken the empty-catalog guard in `availabilityDrift.ts` — a truly empty catalog must still short-circuit.
- Do not delete `extractManagedToolPrompt` in `glm.ts`. That code re-orders text for GLM's own formatting and is unrelated to catalog authority.
- Do not build a broader Anthropic Messages compatibility surface — that is P3.

## Writing Sequence

1. **RED first.** Add `tests/tool-calling/prompt-embedded-catalog.test.ts` covering:
   - OpenCode-style system prompt with `## Available Tools` and MCP-style tool blocks → extractor returns 3 tools including `read`, `bash`, and an `mcp_filesystem__read_file`-shaped name.
   - Cherry-Studio-style `<tools>` block → tools extracted with schemas.
   - System prompt with header but no schemas → tools extracted with `additionalProperties: true` and `driftKind: schema_degraded_from_prompt`.
   - System prompt without tool signatures → no tools, no exception.
   - Extractor never modifies input messages.
2. Add `tests/tool-calling/availability-drift-retry.test.ts` cases where the catalog comes only from prompt text and the model streams `唯一可用的工具是 open_url` — assert drift detection, retry attempt (or pre-decided failure) and typed diagnostics.
3. Add `tests/providers/glm-tool-calling.test.ts` GLM-specific case: prompt-embedded catalog + GLM streamed denial → either a retry clarification is issued upstream **or** the request ends with a typed `availability_drift` error. Assert no fabricated `CAPABILITY_PROBE_DONE` slips through the normalized output shape when the retry also denies.
4. Implement the extractor and wire it into `standardOpenAiToolsAdapter`.
5. Update `resolveToolCatalog` ordering and diagnostics.
6. Verify `runtimePlan.ts` and `ToolCallingEngine.ts` populate the new catalog source and threads it into `contract.toolSourceChain`, `plan.diagnostics.catalogSource`, and drift events.
7. Verify none of the provider adapters imported an injection helper. Run the invariant test.
8. Update `2026-07-10-p1-tool-availability-drift-rework-plan.md` acceptance section with v2 results (do not delete the v1 failure record).

## Test Plan

Focused deterministic tests:

```powershell
node --test tests/tool-calling/prompt-embedded-catalog.test.ts tests/tool-calling/catalog-fallback.test.ts tests/tool-calling/availability-drift-retry.test.ts tests/tool-calling/tool-engine.test.ts tests/tool-calling/tool-stream-parser.test.ts
```

Provider deterministic tests:

```powershell
node --test tests/providers/glm-tool-calling.test.ts tests/providers/qwen-request-routing.test.ts tests/providers/context-tool-metadata.test.ts
```

Full deterministic gate:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

Real OpenCode probes:

```powershell
1..3 | ForEach-Object { .\tests\agent-capability\verify-opencode-capability.ps1 -Model "glm/GLM-5.2" }
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "qwen/Qwen3.7-Max"
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "deepseek/deepseek-v4-pro"
```

GLM must pass 3 consecutive real runs. Qwen and DeepSeek must remain green.

## Acceptance Criteria

Hard requirements — v2 is not accepted unless every item is true:

1. `tests/tool-calling/prompt-embedded-catalog.test.ts` exists and passes.
2. Full deterministic gate passes with at least the previous 219 tests plus the new coverage; no test skipped.
3. `plan.catalogSnapshot` and `plan.catalogDiagnostics.source` are populated on an OpenCode-style prompt-only request. Deterministic assertion required.
4. In the deterministic drift regression, a GLM denial stream under a prompt-embedded catalog produces either a retry attempt with the authoritative clarification, or a typed `availability_drift` failure — never a silent success.
5. 3 consecutive real GLM OpenCode probes return `CAPABILITY_PROBE_PASS` with real `skill` + `read` + `bash` events and a correctly hashed `.agent-probe/result.json`.
6. Qwen and DeepSeek real OpenCode probes remain green.
7. P0 and P2 deterministic gates remain green after the change.
8. `AGENTS.md` invariants INV-001..INV-004 are still satisfied. Static invariant test proves no adapter imported an injection helper.

## Diagnostics Acceptance

Given a single failing OpenCode/GLM turn, a support engineer must be able to answer these from logs alone, without re-running:

- Which client was detected (`clientSignature`)?
- Where did the catalog come from (`catalogSource`)?
- Which tools were authoritative (`allowedToolNames`, `catalogFingerprint`)?
- Did the model deny available tools (`availabilityDriftDetected`, `deniedToolNames`, `mentionedUnavailableOnlyTools`)?
- Was a retry attempted, and did it succeed (`availabilityRetryResult`)?
- Was the response streamed or non-streamed (`responseMode`)?

## Stop Conditions

Escalate and split a follow-up if any of the following holds:

- The client's tool block cannot be parsed without executing a full model prompt (would require a broader design shift beyond this plan).
- Extraction interferes with GLM formatting (in that case, keep the extractor upstream but revisit adapter ordering — never fix by adding provider-side injection).
- Solving GLM requires weakening the empty-catalog guard.
- Solving GLM requires a client-specific hook in `glm.ts`. In that case, first widen the extractor or introduce a new `ToolClientAdapter`, not a per-provider prompt shim.

## Notes For The Implementing AI

- Start from a failing deterministic test that reproduces `catalogSource: 'safe_empty'` on an OpenCode-style request that has `## Available Tools` in its system prompt. Prove the bug first, then make it green with the extractor.
- Prefer conservative extraction — recognizing fewer real catalogs is better than fabricating a wrong catalog.
- Do not touch `deepseek.ts`, `mimo.ts`, `kimi.ts`, `minimax.ts`, `perplexity.ts`, `zai.ts` unless a regression test demands it. Keep blast radius small.
- Do not push. Report deterministic + probe results back to the plan owner.

## Acceptance Run: 2026-07-10

Status: **ACCEPTED**.

Implementation landed:

- `src/main/proxy/toolCalling/clientAdapters/promptEmbeddedToolExtractor.ts` — extractor.
- `src/main/proxy/toolCalling/clientAdapters/standardOpenAiTools.ts` — wired to fall back to the extractor when `request.tools` is empty; emits `toolSource: 'prompt_embedded'` with markers and `rawFingerprint`.
- `src/main/proxy/toolCalling/clientAdapters/types.ts` — `PromptEmbeddedMarkers` and `'prompt_embedded'` added to `toolSource`.
- `src/main/proxy/toolCalling/catalog.ts` — `resolveToolCatalog` accepts `promptEmbeddedTools` and produces a snapshot with `source: 'prompt_embedded'` and `driftKind: 'prompt_embedded_only_catalog'`, ranked above history fallback.
- `src/main/proxy/toolCalling/runtimePlan.ts` — threads prompt-embedded tools into catalog resolution.

Deterministic focused P1 v2 gate passed:

```powershell
node --test tests/tool-calling/prompt-embedded-catalog.test.ts tests/tool-calling/catalog-fallback.test.ts tests/tool-calling/availability-drift-retry.test.ts tests/tool-calling/tool-engine.test.ts tests/tool-calling/tool-stream-parser.test.ts
```

Result: 74 / 74 tests passed. New extractor coverage: 12 / 12.

Full deterministic gate passed:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

Result: 235 / 235 tests passed (up from 219 pre-v2).

Runtime integration passed:

```powershell
node --test tests/tool-runtime/integration/*.test.ts
```

Result: 2 / 2 tests passed.

Real OpenCode probes passed:

- GLM `glm/GLM-5.2`: 3 consecutive runs returned `CAPABILITY_PROBE_PASS`, real skill + read + bash events, matching `.agent-probe/result.json`.
- Qwen `qwen/Qwen3.7-Max`: `CAPABILITY_PROBE_PASS`.
- DeepSeek `deepseek/deepseek-v4-pro`: `CAPABILITY_PROBE_PASS`.

Invariant guardrails verified:

- No `.ts` file under `src/main/proxy/adapters/*.ts` (excluding the `prompt/` PromptAdapter subdirectory) imports `hasToolPromptInjected`, `toolsToSystemPrompt`, `TOOL_WRAP_HINT`, or `shouldInjectToolPrompt`. Comments-only references remain in ADR headers.
- `detectAvailabilityDrift` still short-circuits when `plan.catalogSnapshot` is missing or `allowedToolNames` is empty (`availabilityDrift.ts:30`) — the guard was not weakened; it now simply has an authoritative catalog to compare against on OpenCode traffic.
- Provider adapter code paths unchanged for `deepseek.ts`, `kimi.ts`, `mimo.ts`, `minimax.ts`, `perplexity.ts`, `zai.ts`, `qwen-ai.ts`.

Previously-failing shape no longer reproduces:

- GLM real probe no longer streams `环境中唯一可用的工具是 open_url` as terminal content.
- The bogus `CAPABILITY_PROBE_DONE` without a real tool chain no longer appears in GLM probe events.

P1 v2 status:

- Accepted. Track closed.
- The v1 rework record in `2026-07-10-p1-tool-availability-drift-rework-plan.md` remains as historical evidence of the failure and is not overwritten.
