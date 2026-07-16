# Provider Runtime Main Path Architecture Spec

Date: 2026-07-14
Branch: `codex/qwen-provider-session-continuity`
Scope: Cross-provider long-task stability, not Qwen-specific parser repair

## Verdict

The current branch must not be accepted as an architecture-level long-task fix.

The code contains useful pieces, but they are not connected as a coherent runtime:

- `ProviderRuntime` is a thin wrapper around `forwarder.ts`, not the owner of provider lifecycle.
- `WebProviderPlugin` and `streamNormalizer` exist, but the main request path still dispatches to provider-specific `forwardX` methods.
- `RequestAssembly` has `summaryText` and context metadata fields, but the real `forwarder` path does not pass context compaction output into it.
- Tool child, server summary, prompt refresh, and child handoff are implemented as scattered Qwen-heavy logic rather than a provider-agnostic state machine.
- Tests overfit source strings and hand-built assemblies; they do not prove the live runtime path satisfies the spec.

Therefore parser fixes, Qwen malformed XML repairs, and provider-specific prompt tweaks are only patches. The durable fix is to make one runtime pipeline own session economy, context compression, prompt refresh, handoff, and OpenAI output shaping for every web provider.

## Non-Goals

- Do not continue adding Qwen-only parser compatibility as the main work.
- Do not weaken existing tool no-loss invariants.
- Do not remove existing provider adapters before a runtime path can replace them.
- Do not declare plugin architecture complete because plugin files exist.
- Do not rely on source-text tests as acceptance for runtime behavior.

Existing Qwen parser repair work may remain as an isolated compatibility patch, but it is not acceptance evidence for this spec.

## Core Architecture Target

Target flow:

```text
OpenAI route
  -> RequestForwarder
     -> ProviderRuntime
        -> WebProviderPlugin
        -> ProviderStreamNormalizer / ProviderNonStreamNormalizer
```

Ownership:

- `RequestForwarder`
  - request/account/provider routing
  - retry envelope
  - HTTP-facing `ForwardResult`
  - no provider-specific session state decisions

- `ProviderRuntime`
  - provider plugin selection
  - request preparation via `RequestAssembly`
  - provider conversation state read/write
  - session boundary policy
  - compact/server-summary fork policy
  - prompt refresh policy
  - child/subagent handoff policy
  - stream/non-stream OpenAI output shaping
  - common diagnostics and replay harness

- `WebProviderPlugin`
  - provider URL/method/header/body
  - provider stream/non-stream parsing into normalized runtime events/results
  - provider session id and parent id extraction
  - provider delete-session behavior
  - provider-private error classification

## Evidence Of Current Wrong Shape

### A. Runtime/Forwarder Cycle

Current `ProviderRuntime` imports `ConversationState`, `getProviderConversationState`, `setProviderConversationState`, and `shouldUseProviderConversationFallback` from `forwarder.ts`.

This makes `ProviderRuntime -> forwarder.ts -> ProviderRuntime` a cycle and prevents runtime from being the owner of lifecycle policy.

Acceptance:

- Provider conversation state helpers live in a shared module outside `forwarder.ts`.
- `ProviderRuntime` does not import `forwarder.ts`.
- `forwarder.ts` may import `ProviderRuntime`, but not the reverse.

### B. Plugins Are Not Main Path

Current `forwarder.ts` still uses provider-specific methods:

- `forwardDeepSeek`
- `forwardGLM`
- `forwardKimi`
- `forwardQwen`
- `forwardQwenAi`
- `forwardZai`
- `forwardMiniMax`
- `forwardMimo`
- `forwardPerplexity`

The plugin registry, fixture replay, and stream normalizer are not used by the main runtime path.

Acceptance:

- At least Qwen and one non-Qwen provider can run through `ProviderRuntime.forward(...)` using `WebProviderPlugin`.
- The old `forwardX` path can remain as fallback during migration, but tests must prove the runtime path is exercised.
- Plugin fixture replay must use the same plugin parse/build APIs as runtime.

### C. Plugin Contract Drops Long-Task Inputs

Current `ProviderRuntimeRequest` lacks:

- `RequestAssembly`
- `ToolManifest`
- `summaryText`
- `promptRefreshMode`
- session boundary reason
- provider conversation state
- child handoff state

Some plugins construct fake assemblies with `toolManifest: null` and `summaryText: null`.

Acceptance:

- `ProviderRuntimeRequest` carries the real `RequestAssembly`.
- Plugins do not fabricate assemblies that drop tool contracts or summaries.
- Prompt refresh mode is a runtime decision passed into plugins as provider request options.

### D. Summary Is Not Structured In Real Forward Path

`RequestAssembly` supports `summaryText`, but `prepareRequest()` currently builds assembly from `request.messages` and `toolManifest` only. Context management results are not passed into assembly.

Acceptance:

- Context management returns structured summary/handoff data in addition to rendered messages.
- `buildRequestAssembly()` receives `contextResult` and `summaryText` on the real path.
- Provider adapters/plugins consume summary from assembly, not by scanning system-message strings.

### E. Server Summary Fork Key Is Content-Volatile

`server_summary` fork currently hashes truncated message content into `epochSource`. During active tool workflows, small summary/tool-result changes can create fresh provider session keys repeatedly.

Acceptance:

- Provider session epochs are based on logical workflow identity, not changing message content.
- `server_summary` during the same active tool workflow preserves the workflow provider session key or uses a deterministic summary-child key tied to the workflow id.
- Prompt mode logs should not show repeated fresh-session full refresh for the same active tool loop unless repair/full is explicitly required.

### F. Workflow Progress Is Text-Heuristic

Context management infers next tool step by parsing rendered skill text and completed tool messages. This is fragile and provider/model-dependent.

Acceptance:

- Runtime maintains a provider-agnostic workflow ledger:
  - workflow id
  - skill/subagent id if any
  - ordered required steps when known
  - completed tool calls
  - artifacts
  - next required action
  - error/repair state
- Compaction renders a bounded view of the ledger.
- Tests verify the ledger drives the next step after summary without relying on provider-specific prose.

## Implementation Plan

### Node 1: Runtime Boundary Repair

Goal: make `ProviderRuntime` independent and capable of owning shared state policy.

Allowed write set:

- `src/main/proxy/services/ProviderRuntime.ts`
- new `src/main/proxy/services/providerConversationState.ts`
- `src/main/proxy/forwarder.ts` only to import shared state from the new module
- related tests

Acceptance:

- No `ProviderRuntime -> forwarder.ts` import.
- Existing deterministic suites pass.
- Add a runtime import test that fails if the cycle returns.

### Node 2: Plugin Contract Upgrade

Goal: make plugins capable of receiving real long-task inputs.

Allowed write set:

- `src/main/proxy/plugins/types.ts`
- `src/main/proxy/plugins/WebProviderPlugin.ts`
- `src/main/proxy/plugins/QwenProviderPlugin.ts`
- one non-Qwen plugin, preferably GLM
- plugin tests and fixture replay tests

Acceptance:

- `ProviderRuntimeRequest` carries `assembly` and `promptRefreshMode`.
- Qwen plugin no longer builds an empty fake assembly.
- GLM or another non-Qwen plugin demonstrates the same contract.
- Registry can be imported in the project test environment.

### Node 3: Runtime Main Path Pilot

Goal: route Qwen plus one non-Qwen provider through `ProviderRuntime` behind an explicit migration gate.

Allowed write set:

- `src/main/proxy/services/ProviderRuntime.ts`
- `src/main/proxy/forwarder.ts`
- plugin implementations for pilot providers
- stream/non-stream normalizers
- tests

Acceptance:

- Test proves runtime path is selected for pilot providers.
- Runtime path preserves tool contract, summary, session id, parent id, delete policy, stream tool calls, and non-stream tool calls.
- Old provider-specific path remains as fallback until parity is proven.

### Node 4: Structured Workflow Ledger

Goal: replace text-heuristic long-task progress with structured workflow state.

Allowed write set:

- new `src/main/proxy/services/workflowLedger.ts`
- `contextManagementService.ts`
- `sessionBoundary.ts`
- `ProviderRuntime.ts`
- long-task verifier tests

Acceptance:

- Active tool workflow has stable workflow id.
- Completed tool calls and artifacts are recorded structurally.
- Server summary compaction renders bounded ledger state.
- Long probe reaches at least one `bash` after first `read`.

### Node 5: Cross-Provider Acceptance

Goal: prove the design migrates beyond Qwen.

Acceptance:

- Deterministic runtime fixture passes for Qwen and one non-Qwen provider.
- Real OpenCode short task passes on Qwen.
- If credentials are available, run same short capability probe on a second provider.
- No provider-specific parser repair is considered acceptance evidence unless the runtime path also passes.

## First Subagent Task

Implement Node 1 only.

The subagent must not touch parser repair, Qwen XML compatibility, renderer assets, icons, or unrelated deleted files.

The main agent will review:

- import graph
- deterministic tests
- whether any source-only tests were added instead of runtime tests
- whether behavior changed outside the stated write set

Status: accepted on 2026-07-14.

Evidence:

- `ProviderRuntime.ts` no longer imports `forwarder.ts`.
- Provider conversation state helpers were moved to `src/main/proxy/services/providerConversationState.ts`.
- `tests/providers/provider-runtime-boundary.test.ts` dynamically imports `ProviderRuntime.ts` with a loader that rejects `forwarder.ts` and provider adapter graph imports.
- `node --input-type=module -e "const mod=await import('./src/main/proxy/services/ProviderRuntime.ts'); console.log(Object.keys(mod).join(','));"` prints `ProviderRuntime`.
- `node --test tests/providers/provider-runtime-boundary.test.ts tests/providers/qwen-session-continuity.test.ts tests/providers/context-tool-metadata.test.ts tests/routes/openai-session-identity.test.ts tests/providers/multi-turn-conversation.test.ts` passes `75/75`.

## Second Subagent Task

Implement Node 2 only.

The goal is to make the plugin contract carry the same long-task inputs the forwarder/runtime already computed, without routing live traffic through plugins yet.

Allowed write set:

- `src/main/proxy/plugins/types.ts`
- `src/main/proxy/plugins/WebProviderPlugin.ts`
- `src/main/proxy/plugins/QwenProviderPlugin.ts`
- `src/main/proxy/plugins/GLMProviderPlugin.ts`
- `tests/providers/qwen-provider-plugin.test.ts`
- `tests/providers/plugin-registry.test.ts`
- `tests/providers/fixture-replay.test.ts`
- narrowly related test helpers or fixtures

Do not edit:

- parser files under `src/main/proxy/toolCalling/` or `src/main/proxy/toolRuntime/`
- `src/main/proxy/forwarder.ts`
- renderer assets/icons
- unrelated logs, temp probe output, deleted user files

Required changes:

- Add `assembly: RequestAssembly` to `ProviderRuntimeRequest`.
- Add `promptRefreshMode?: PromptRefreshMode` to `ProviderRuntimeRequest`, importing the type from `src/main/proxy/promptBudgetPolicy.ts`.
- Add structured session boundary input to `ProviderRuntimeRequest`, at minimum `sessionBoundaryReason?: ProxyContext['sessionBoundaryReason']`.
- Qwen plugin must use `input.assembly` directly and must not construct a fake assembly with `toolManifest: null` and `summaryText: null`.
- Qwen plugin must pass `input.promptRefreshMode` into the Qwen request body path.
- GLM plugin, or one clearly documented non-Qwen plugin, must compile against the upgraded contract and preserve its current behavior.

Acceptance:

- A test fails if Qwen plugin drops `assembly.toolManifest`, `assembly.summaryText`, or `promptRefreshMode`.
- A test imports the plugin registry in Node and confirms at least Qwen plus one non-Qwen plugin are available.
- Existing fixture replay tests still use plugin build/parse APIs, not a hand-built alternate path.
- Run:

```powershell
node --test tests/providers/qwen-provider-plugin.test.ts tests/providers/plugin-registry.test.ts tests/providers/fixture-replay.test.ts tests/providers/provider-runtime-boundary.test.ts
```

The main agent will review the diff and run the same tests before accepting Node 2.

Status: accepted on 2026-07-14.

Evidence:

- `ProviderRuntimeRequest` now carries `assembly`, `promptRefreshMode`, and `sessionBoundaryReason`.
- `QwenProviderPlugin` uses `input.assembly` directly and no longer builds an empty fake assembly.
- Qwen plugin passes `promptRefreshMode` through the Qwen assembly request path.
- `GLMProviderPlugin` is adapted as the non-Qwen contract proof.
- The plugin registry is importable in Node and eagerly exposes Qwen plus GLM; Electron/browser-sensitive providers are lazy-loaded.
- `node --test tests/providers/qwen-provider-plugin.test.ts tests/providers/plugin-registry.test.ts tests/providers/fixture-replay.test.ts tests/providers/provider-runtime-boundary.test.ts` passes `30/30`.
- `npm run build` passes.

Note:

- `registry.ts` was modified beyond the initial allowed write set because the previous source-text registry tests could not prove real Node importability. This is accepted as part of Node 2 because the architecture requires runtime-importable plugin infrastructure.

## Third Subagent Task

Implement Node 3 as a gated pilot only.

The goal is to connect the plugin runtime to the real `RequestForwarder` path for Qwen and GLM behind an explicit migration gate, while keeping the existing dedicated provider methods as default fallback.

Allowed write set:

- `src/main/proxy/services/ProviderRuntime.ts`
- `src/main/proxy/forwarder.ts`
- `src/main/proxy/services/streamNormalizer.ts`
- `src/main/proxy/plugins/registry.ts` only if runtime lookup requires a narrow adjustment
- `tests/providers/provider-runtime-main-path.test.ts` or equivalent new focused test
- narrowly related existing provider runtime/plugin tests

Do not edit:

- parser files under `src/main/proxy/toolCalling/` or `src/main/proxy/toolRuntime/`
- provider parser compatibility logic
- renderer assets/icons
- unrelated logs, temp probe output, deleted user files

Required behavior:

- Add a `ProviderRuntime.forward(...)` style entry point that:
  - receives the real request, account, provider, actual model, proxy context, `RequestAssembly`, and prompt refresh decision if available;
  - selects a `WebProviderPlugin`;
  - reads provider conversation state through the runtime state helpers;
  - calls `plugin.buildRequest()` with the real assembly and prompt/session fields;
  - performs provider HTTP through an injectable transport or the existing axios instance;
  - calls `plugin.parseStream()` plus `normalizeProviderStreamToOpenAI()` for stream responses;
  - calls `plugin.parseNonStream()` for non-stream responses;
  - writes provider session state through runtime helpers.
- Add an explicit gate, for example an env var or a private forwarder predicate, so only Qwen and GLM can use the runtime pilot and only when enabled.
- `RequestForwarder.doForward()` should try the runtime pilot before the old dedicated forwarder only when the gate is enabled and the provider is one of the pilot providers.
- When the gate is disabled, old behavior must remain selected.
- Runtime pilot must return a normal `ForwardResult` and preserve status, headers, body/stream, latency, and errors.

Acceptance:

- Test proves gate disabled uses the old dedicated path.
- Test proves gate enabled selects `ProviderRuntime.forward()` for Qwen and GLM.
- Test proves runtime passes the real `RequestAssembly.toolManifest`, `summaryText`, and prompt refresh mode to Qwen plugin.
- Test proves runtime stream output goes through `normalizeProviderStreamToOpenAI()`.
- Test proves runtime writes provider session id back to conversation state.
- Existing Node 1 and Node 2 tests still pass.
- Run:

```powershell
node --test tests/providers/provider-runtime-main-path.test.ts tests/providers/provider-runtime-boundary.test.ts tests/providers/qwen-provider-plugin.test.ts tests/providers/plugin-registry.test.ts tests/providers/fixture-replay.test.ts tests/providers/qwen-session-continuity.test.ts tests/providers/context-tool-metadata.test.ts tests/routes/openai-session-identity.test.ts
```

The main agent will review whether the live default remains unchanged and whether the runtime pilot is a real execution path rather than source-text proof.

Status: accepted on 2026-07-14 as a gated pilot.

Evidence:

- `RequestForwarder.doForward()` only selects the runtime pilot when `CHAT2API_PROVIDER_RUNTIME_PILOT` is one of `1`, `true`, `yes`, or `on`, and only for Qwen/GLM.
- Gate-disabled behavior still uses the old dedicated provider path.
- Gate-enabled behavior selects `ProviderRuntime.forward()` for Qwen and GLM.
- `ProviderRuntime.forward()` selects a plugin, passes real `RequestAssembly`, prompt refresh mode, session boundary reason, session id fields, thinking/web-search booleans, performs transport, uses plugin parse APIs, normalizes stream output through `normalizeProviderStreamToOpenAI()`, and writes provider session state.
- A review fix corrected true request-field mapping: `reasoning_effort -> enableThinking` and `web_search -> enableWebSearch`.
- `node --test tests/providers/provider-runtime-main-path.test.ts tests/providers/provider-runtime-boundary.test.ts tests/providers/qwen-provider-plugin.test.ts tests/providers/plugin-registry.test.ts tests/providers/fixture-replay.test.ts tests/providers/qwen-session-continuity.test.ts tests/providers/context-tool-metadata.test.ts tests/routes/openai-session-identity.test.ts` passes `94/94`.
- `npm run build` passes.

Remaining risk:

- The pilot path is not the default runtime.
- Non-stream OpenAI output shaping and managed tool-call parsing are still mostly provider/plugin-specific. This must be addressed before enabling the runtime path by default.
- Streaming session state currently writes from the provider web request/session fields, not from late stream `session_update` events. This is acceptable for the gated pilot but should be revisited before default rollout.

## Fourth Subagent Task

Implement Node 4 as a minimal structured workflow ledger extraction.

The goal is not to rewrite all context management. The goal is to move the active skill/tool progress model out of ad hoc rendered-text construction and into a pure, testable ledger that the existing handoff renderer can consume.

Allowed write set:

- new `src/main/proxy/services/workflowLedger.ts`
- `src/main/proxy/services/contextManagementService.ts`
- `tests/services/workflowLedger.test.ts`
- narrowly related existing context-management tests

Do not edit:

- parser files under `src/main/proxy/toolCalling/` or `src/main/proxy/toolRuntime/`
- provider plugins/runtime/forwarder
- renderer assets/icons
- unrelated logs, temp probe output, deleted user files

Required behavior:

- Add a pure `workflowLedger` module that can derive, from bounded message groups:
  - workflow kind (`active_skill` or `completed_tool_handoff`)
  - pinned skill instruction blocks when present
  - completed tool steps with tool name, tool call id when available, artifact path when available, and bounded evidence
  - next required instruction when present
  - next required tool name
  - next required tool argument hint
  - omitted completed exchange count
- Move or wrap the existing helper logic for:
  - completed tool step extraction
  - pinned skill instruction extraction
  - next incomplete skill instruction detection
  - checkpoint/handoff rendering
  into this module, preserving current output shape where tests depend on it.
- `contextManagementService.ts` should call the ledger renderer instead of directly assembling the active workflow checkpoint from scattered helper functions.
- Keep the current bounded text format markers for compatibility:
  - `[Active skill workflow state checkpoint]`
  - `[Completed tool exchange handoff]`
- The ledger module must not import provider adapters, plugin runtime, or forwarder.

Acceptance:

- Existing tool metadata preservation tests still pass; especially no regression of tool definitions / tool call metadata loss.
- Direct ledger tests prove a read step followed by a bash step produces `nextToolName = bash` and a `command=` argument hint.
- Direct ledger tests prove a later read step after earlier read/bash completions produces `nextToolName = read` and the later `filePath=...`, not the first read path.
- Direct ledger tests prove old completed exchanges collapse into a bounded handoff without copying long raw tool output.
- Run:

```powershell
node --test tests/services/workflowLedger.test.ts tests/services/contextManagement-tool-handoff.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-session-continuity.test.ts
```

The main agent will review that this is a structural extraction, not another provider/parser patch.

Status: accepted on 2026-07-14 after review fix.

Evidence:

- Added `src/main/proxy/services/workflowLedger.ts` as a pure grouped-message ledger module.
- `contextManagementService.ts` now delegates checkpoint/handoff rendering to `buildWorkflowLedgerHandoffMessage()`.
- The compatibility markers `[Active skill workflow state checkpoint]` and `[Completed tool exchange handoff]` are preserved.
- The ledger derives active skill/completed handoff kind, pinned instruction blocks, completed tool steps, artifact hints, bounded evidence, next instruction/tool/argument hint, and omitted exchange counts.
- The ledger module does not import provider adapters, plugin runtime, `ProviderRuntime`, `forwarder`, parser, or tool runtime internals.
- Review found and fixed one local contract mismatch: `buildCompletedToolExchangeHandoffMessage()` now accepts `ChatMessage[][]`, matching the workflow ledger grouped-exchange contract and its caller.
- `node --test tests/services/workflowLedger.test.ts tests/services/contextManagement-tool-handoff.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-session-continuity.test.ts` passes `58/58`.
- `npm run build` passes.

Remaining risk:

- This is still a minimal extraction from existing message history, not a fully persisted provider-agnostic workflow state machine with workflow id/error repair state.
- Repository-wide `npx tsc -p tsconfig.node.json --noEmit` is not currently a clean acceptance gate because the repo has many pre-existing TypeScript errors. It did, however, catch the Node 4 grouped-message mismatch that was repaired during review.
- Full acceptance of the long-task architecture still requires a real OpenCode probe, not only local deterministic tests.

## Node 5: Real OpenCode Acceptance Probe

Goal: prove the architecture under real OpenCode behavior rather than helper-level tests.

Required validation:

- Start the app with the runtime pilot enabled when validating the new provider runtime path.
- Run the deterministic regression layer from `AGENTS.md`.
- Run a real OpenCode capability probe and inspect the event stream, not just final assistant text.
- Run the long-conversation probe and require evidence that context management actually compacted tool workflow state while preserving tool definitions and tool-call metadata.
- If Qwen still fails short-context or long-context probe, treat it as an implementation bug in the main runtime/session/context path, not as a parser-only patch opportunity.

Status: failed on 2026-07-14.

Evidence:

- Dev app was started with `CHAT2API_PROVIDER_RUNTIME_PILOT=1`; Electron listened on `127.0.0.1:8081`.
- Deterministic regression layer passed:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

Result: `301/301`.

- Real Qwen short-context probe failed:

```powershell
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "qwen/Qwen3-Max"
```

Result: `CAPABILITY_PROBE_FAIL`.

- Probe facts:
  - OpenCode exited successfully.
  - `.agent-probe/result.json` existed and matched deterministic expected values.
  - The OpenCode NDJSON event stream was valid.
  - The event stream contained `read`, then `bash`, then final `CAPABILITY_PROBE_DONE`.
  - The event stream did not contain a real `skill` tool call for `agent-capability-probe`.
- Dev log facts:
  - The Qwen turn had `planMode: "managed"`, `toolCount: 10`, and `injected: true`; tools were not missing.
  - The final Qwen prompt was extremely large (`finalContentLength` around `69957`/`71017`/`61905` across probe turns).
  - `skill` was present in the rendered tool catalog, but the "first action must be skill" constraint was only natural-language task text competing with the large tool catalog and project instructions.

Interpretation:

- This is not a parser failure and not a tool-definition-loss failure.
- The provider received tools, but the runtime did not elevate the client/agent's mandatory next tool action into a compact, high-priority, provider-agnostic tool action constraint.
- Treat this as a request assembly / tool contract architecture gap.

## Node 6: Tool Action Constraint Contract

Goal: make required next tool actions first-class request assembly state instead of relying on low-signal natural-language instructions buried in huge prompts.

Allowed write set:

- `src/main/proxy/toolCalling/ToolManifest.ts`
- `src/main/proxy/toolCalling/ToolCallingEngine.ts`
- `src/main/proxy/RequestAssembly.ts`
- provider-neutral tests under `tests/tool-calling/` or `tests/providers/`
- narrowly related Qwen request routing/assembly tests

Do not edit:

- provider parsers
- `src/main/proxy/toolCalling/ToolStreamParser.ts`
- `src/main/proxy/toolRuntime/`
- Qwen-only malformed XML repair logic
- renderer assets/icons
- logs/temp probe output

Required behavior:

- Add a provider-agnostic `ToolActionConstraint` or equivalent to the tool manifest/request assembly.
- Detect a mandatory first tool constraint when:
  - the current request exposes a `skill` tool, and
  - the active system/developer/agent/user instruction says the first assistant action must be a real `skill` tool call, and
  - there is not already a completed `skill` tool result in the current active request context.
- The detector should extract the skill name when it is explicitly written, for example `agent-capability-probe` or `long-conversation-probe`.
- Render the constraint as a short high-priority block before the verbose tool catalog in the managed tool manifest:
  - only valid next tool: `skill`
  - required argument: `name=<skill name>`
  - do not call `read`, `bash`, `write`, or other non-skill tools before that skill result
- Keep the full tool catalog available; do not delete tool definitions and do not narrow the catalog permanently.
- Once the skill tool result is present, do not keep forcing `skill`; the next turn must allow the normal requested non-skill tools.
- Keep this provider-neutral: Qwen, GLM, and other managed providers should receive the same assembly-level constraint.

Acceptance:

- Add deterministic tests proving:
  - a first-skill instruction with a `skill` tool produces the action constraint and renders it before the tool catalog.
  - after a `tool` message for that skill call exists, the action constraint is absent.
  - existing tool manifest tests and tool metadata preservation tests still pass.
- Re-run:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
npm run build
```

- Then re-run the real Qwen short-context probe:

```powershell
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "qwen/Qwen3-Max"
```

The node is not accepted until the event stream contains a real `agent-capability-probe` skill invocation before non-skill tool calls.

Status: partially accepted on 2026-07-14.

Deterministic evidence:

- `ToolManifest` now carries a provider-neutral `ToolActionConstraint`.
- `ToolCallingEngine` detects first-action skill requirements and renders a short high-priority constraint before the verbose tool catalog.
- `RequestAssembly` surfaces `toolActionConstraint` from the manifest.
- `node --test tests/tool-calling/*.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts` passes `248/248`.
- `npm run build` passes.

Real probe evidence after restarting the dev app with `CHAT2API_PROVIDER_RUNTIME_PILOT=1`:

- Qwen emitted a real managed `skill` tool call for `agent-capability-probe` before non-skill tools.
- Qwen then emitted the required `read` call for `tests/agent-capability/input.txt`.
- Qwen then emitted the required `bash` call that generated `.agent-probe/result.json`.
- `.agent-probe/result.json` matched the deterministic expected SHA-256, byte length, line count, and edge-case fields.

Remaining failure:

- The OpenCode verifier did not complete. The model entered a post-result loop, repeatedly reading `.agent-probe/result.json` and re-running the result-generation `bash` command instead of emitting the terminal text `CAPABILITY_PROBE_DONE`.
- This means Node 6 solved the missing first skill action, but did not solve terminal workflow finalization.

Interpretation:

- This is not a parser failure and not a tool-definition-loss failure.
- This is a request assembly / workflow contract gap: after required tool work is complete, the provider still receives a huge tool catalog and no compact high-priority "no more tools, final text only" terminal constraint.

## Node 7: Terminal Workflow Finalization Constraint

Goal: prevent completed tool workflows from looping by making terminal final-answer requirements first-class request assembly state.

Allowed write set:

- `src/main/proxy/toolCalling/ToolManifest.ts`
- `src/main/proxy/toolCalling/ToolCallingEngine.ts`
- `src/main/proxy/RequestAssembly.ts`
- provider-neutral tests under `tests/tool-calling/`
- narrowly related Qwen request-routing/metadata tests if needed

Do not edit:

- provider parsers
- `src/main/proxy/toolCalling/ToolStreamParser.ts`
- `src/main/proxy/toolRuntime/`
- Qwen-only malformed XML repair logic
- provider adapters/plugins/runtime unless a compile error proves the manifest contract requires a narrow type update
- renderer assets/icons
- logs/temp probe output

Required behavior:

- Extend the provider-neutral tool/action contract to represent a terminal text constraint, not only `first_skill_required`.
- Detect a terminal finalization constraint when all are true:
  - active instructions explicitly require a final exact text marker after tool work, for example `CAPABILITY_PROBE_DONE`;
  - the current active request context already contains evidence that the required terminal artifact/tool result exists, for example a `bash` tool result after generating `.agent-probe/result.json` or a completed read of `.agent-probe/result.json`;
  - there is no later user instruction asking for more work.
- Render the terminal constraint before the verbose tool catalog, with short wording:
  - no tool call is valid for this turn;
  - output exactly the required final text;
  - do not call `read`, `bash`, `write`, `skill`, or any other tool.
- Do not delete tool definitions from stored session state, and do not permanently narrow the tool catalog.
- Keep this provider-neutral. The same terminal constraint must be useful for Qwen, GLM, and other managed providers.
- Prefer a pure detector/helper inside the tool contract layer. If it needs workflow evidence, derive it from `ChatMessage[]` using structured tool-call/tool-result metadata first and bounded content matching second.

Acceptance:

- Add deterministic tests proving:
  - a prompt with final marker instructions but no completed terminal tool evidence does not suppress/forbid tools.
  - after the required result-generation `bash` tool result exists, the manifest renders a terminal final-answer constraint before the tool catalog.
  - after a completed read of `.agent-probe/result.json`, the terminal final-answer constraint is still active.
  - first-skill constraints still win before the skill result exists.
  - existing tool metadata preservation and qwen request-routing tests still pass.
- Run:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
npm run build
```

- Restart the dev app after implementation; the Electron main process did not reliably pick up Node 6 changes without restart.
- Re-run the real Qwen short-context probe:

```powershell
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "qwen/Qwen3-Max"
```

The node is not accepted until the event stream contains, in order, a real `agent-capability-probe` skill call, at least two non-skill tool calls, at least one non-skill tool call after the first observation, and terminal assistant text containing `CAPABILITY_PROBE_DONE` without a post-result tool loop.

Status: deterministic accepted, real probe failed on 2026-07-14.

Deterministic evidence:

- `ToolActionConstraint` now supports `terminal_final_text_required`.
- The engine keeps first-skill precedence before the skill result exists.
- The terminal final-answer constraint activates only after result-generation or result-read tool evidence exists in tests.
- `node --test tests/tool-calling/*.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts` passes `253/253`.
- `npm run build` passes.

Real probe evidence:

- With `CHAT2API_PROVIDER_RUNTIME_PILOT=1`, Qwen/OpenCode exited quickly and `.agent-probe/result.json` was missing. The event stream contained only start/finish and no tools.
- With the runtime pilot disabled, Qwen returned `CAPABILITY_PROBE_DONE` directly, again without creating `.agent-probe/result.json` and without any tool calls.
- The old dedicated Qwen path confirmed HTTP status 200 and streamed plain text `CAPABILITY_PROBE_DONE`.
- The first managed tool turn still had a prompt around `70231` characters with the full catalog.

Interpretation:

- This is not a provider-runtime pilot parser problem.
- This is not a terminal-detector over-trigger shown by deterministic tests.
- The first-skill constraint is still just prompt text competing with a very large full tool catalog and the prompt's later terminal instruction. Qwen can jump directly to final text.
- The next architecture fix must reduce the prompt surface of constrained turns while preserving the authoritative catalog in structured state.

## Node 8: Action-Scoped Tool Catalog Projection

Goal: when a one-turn action constraint exists, render only the currently valid tool surface for that turn while preserving the full catalog structurally for future turns.

Allowed write set:

- `src/main/proxy/toolCalling/ToolManifest.ts`
- `src/main/proxy/toolCalling/ToolCallingEngine.ts`
- `src/main/proxy/RequestAssembly.ts`
- provider-neutral tests under `tests/tool-calling/`
- narrowly related provider metadata/routing tests if needed

Do not edit:

- provider parsers
- `src/main/proxy/toolCalling/ToolStreamParser.ts`
- `src/main/proxy/toolRuntime/`
- Qwen-only malformed XML repair logic
- provider adapters/plugins/runtime unless a compile error proves a narrow type update is required
- renderer assets/icons
- logs/temp probe output

Required behavior:

- Keep `ToolManifest.tools`, `allowedToolNames`, and `catalogFingerprint` as the full authoritative catalog.
- Add a rendered-prompt projection for constrained turns:
  - for `first_skill_required`, render the high-priority constraint plus only the `skill` tool definition in the verbose catalog section;
  - for `terminal_final_text_required`, render the high-priority terminal constraint and omit verbose tool definitions entirely, because no tool is valid for that turn;
  - when no constraint is active, render the full catalog exactly as before.
- Do not permanently remove or narrow tool definitions. The next turn after the skill result must be able to use `read`, `bash`, and the rest of the catalog via session/current request restoration.
- The contract header may still include the full fingerprint, but the rendered constrained prompt must explicitly say that the full catalog is preserved by the gateway and only the current action surface is shown.
- This is a speed/quality balancing mechanism: fewer tokens in constrained turns, stronger action signal, no loss of structured tool definitions.

Acceptance:

- Deterministic tests prove:
  - `first_skill_required` manifests still carry the full catalog structurally.
  - `first_skill_required` rendered prompt includes the `skill` tool definition and excludes `read`/`bash` verbose definitions.
  - after the skill tool result exists, the rendered prompt includes `read` and `bash` definitions again.
  - `terminal_final_text_required` rendered prompt contains no verbose tool definitions, but the manifest still carries the full catalog structurally.
  - existing metadata preservation and qwen routing tests still pass.
- Run:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
npm run build
```

- Restart the dev app and re-run the real Qwen probe first without the runtime pilot to validate the tool contract change, then with `CHAT2API_PROVIDER_RUNTIME_PILOT=1` to validate the migration path.

Status: accepted for the existing Qwen path, failed for the runtime pilot on 2026-07-14.

Deterministic evidence:

- `first_skill_required` constrained prompts render only the `skill` verbose definition while preserving the full structural manifest catalog.
- `terminal_final_text_required` constrained prompts render no verbose tool definitions while preserving the full structural manifest catalog.
- After a skill result exists, the full `read`/`bash` catalog definitions return.
- `node --test tests/tool-calling/*.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts` passes `254/254`.
- `npm run build` passes.

Real evidence without runtime pilot:

- `.\tests\agent-capability\verify-opencode-capability.ps1 -Model "qwen/Qwen3-Max"` passes.
- The OpenCode event stream contains `skill -> read -> bash -> final text`.
- `.agent-probe/result.json` exactly matches deterministic expected values.
- The first managed prompt dropped from about `70231` characters before Node 8 to about `50028` characters after Node 8.

Real evidence with `CHAT2API_PROVIDER_RUNTIME_PILOT=1`:

- The same probe fails with missing `.agent-probe/result.json`.
- The OpenCode event stream contains only start/finish and no tool calls.
- The runtime pilot still builds the reduced `50028`-character first managed prompt, so Node 8 is active.

Interpretation:

- The provider-neutral tool contract is now sufficient for the existing Qwen forward path.
- The runtime pilot still cannot be accepted. `QwenProviderPlugin.parseStream()` receives only the raw response and lacks the `ToolCallingPlan`, so it cannot convert managed XML into OpenAI tool-call deltas. It also does not yet have parity with the existing `QwenStreamHandler` for real Qwen stream details.

## Node 9: Runtime Pilot Stream Tool-Call Parity

Goal: make the ProviderRuntime pilot stream path preserve the same managed tool-call behavior as the existing Qwen stream path.

Allowed write set:

- `src/main/proxy/plugins/types.ts`
- `src/main/proxy/plugins/WebProviderPlugin.ts`
- `src/main/proxy/plugins/QwenProviderPlugin.ts`
- `src/main/proxy/services/ProviderRuntime.ts`
- `src/main/proxy/services/streamNormalizer.ts` if the normalized event contract needs a narrow extension
- focused provider runtime/plugin tests

Do not edit:

- `src/main/proxy/toolCalling/ToolStreamParser.ts`
- `src/main/proxy/toolRuntime/`
- Qwen-only malformed XML repair logic
- renderer assets/icons
- unrelated logs/temp probe output

Required behavior:

- Extend the plugin stream parse contract so stream parsing receives enough runtime context to parse managed tool calls:
  - at minimum the provider response, model, and `ToolCallingPlan`;
  - preferably a typed `ProviderRuntimeStreamInput` rather than ad hoc positional parameters.
- Qwen runtime pilot streaming must emit OpenAI-compatible tool calls for managed XML in the same cases the existing Qwen path does.
- The runtime pilot must not emit raw managed XML as ordinary assistant text when a valid tool call is present.
- The runtime pilot must end valid tool-call turns with `finish_reason: "tool_calls"`.
- Preserve session state writes for Qwen session id / parent req id.
- If the cleanest short-term bridge is to reuse the existing `QwenStreamHandler`, document it as a parity bridge and keep the plugin contract capable of a future normalized implementation.

Acceptance:

- Add deterministic tests proving the ProviderRuntime Qwen pilot stream path can convert a Qwen stream containing managed XML into OpenAI `delta.tool_calls`.
- Add or update tests proving a plain text Qwen stream still emits text and `finish_reason: "stop"`.
- Existing runtime main path, plugin registry, context metadata, and tool-calling tests still pass.
- Run:

```powershell
node --test tests/providers/provider-runtime-main-path.test.ts tests/providers/qwen-provider-plugin.test.ts tests/providers/plugin-registry.test.ts tests/tool-calling/*.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
npm run build
```

- Restart with `CHAT2API_PROVIDER_RUNTIME_PILOT=1` and re-run:

```powershell
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "qwen/Qwen3-Max"
```

Node 9 is not accepted until the runtime pilot real probe passes.

Status update on 2026-07-14:

- Deterministic stream parity tests passed after adding `ProviderRuntimeStreamInput` with `response`, `rawResponse`, `model`, and `toolCallingPlan`.
- `npm run build` passed.
- The runtime pilot real Qwen probe still failed after a clean restart:
  - OpenCode event stream contained only start/text/finish.
  - The assistant text was `Error: Provider returned empty assistant output for managed tool turn qwen:Qwen3-Max`.
  - `.agent-probe/result.json` was missing.
  - `dev.log` showed the reduced managed prompt was active at about `50014` characters.
  - `dev.log` showed `[Qwen] Starting stream handler...`, `Content-Encoding: undefined`, and `Stream closed`, but no `[Qwen] Parsed event`.

Revised interpretation:

- The remaining Node 9 failure is no longer proven to be a tool parser or prompt problem.
- The runtime pilot is not yet HTTP-contract-equivalent to the existing Qwen adapter path.
- The old Qwen assembly path sends complete `DEFAULT_HEADERS`, `responseType: "stream"`, `timeout: 120000`, and `decompress: false`.
- The ProviderRuntime default transport currently owns too many HTTP details and does not let provider plugins declare provider-private transport options.
- The Qwen plugin request currently does not preserve the full old Qwen header/options contract.

Additional Node 9 acceptance:

- `ProviderWebRequest` or an equivalent plugin/runtime contract must let plugins declare transport options needed by real web providers, without hard-coding provider names in `ProviderRuntime`.
- `ProviderRuntime.defaultTransport()` must merge those plugin/request transport options into the Axios request.
- `QwenProviderPlugin.buildRequest()` must preserve the old Qwen adapter's critical HTTP behavior, including complete default web headers and `decompress: false` for streaming.
- Deterministic tests must prove runtime transport option merging and Qwen plugin request parity.
- The real Qwen runtime pilot probe remains the final acceptance gate.

Final Node 9 status: accepted on 2026-07-14.

Deterministic evidence:

- `ProviderWebRequest` now carries provider-neutral `transportOptions`.
- `ProviderRuntime.defaultTransport()` merges plugin-declared `responseType`, `timeout`, `decompress`, and `validateStatus`.
- `QwenProviderPlugin.buildRequest()` reuses the old adapter's `DEFAULT_HEADERS` and declares stream transport options equivalent to the old Qwen assembly path, including `decompress: false`.
- Runtime Qwen managed XML stream parity tests still pass.
- `node --test tests/providers/provider-runtime-main-path.test.ts tests/providers/qwen-provider-plugin.test.ts tests/providers/plugin-registry.test.ts tests/tool-calling/*.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts` passes `283/283`.
- `npm run build` passes.

Real pilot evidence:

- After restarting with `CHAT2API_PROVIDER_RUNTIME_PILOT=1`, `.\tests\agent-capability\verify-opencode-capability.ps1 -Model "qwen/Qwen3-Max"` passes.
- The verifier confirms `.agent-probe/result.json` exactly matches deterministic expected values.
- The OpenCode event stream contains a real `agent-capability-probe` skill invocation.
- The OpenCode event stream contains at least two non-skill tool calls and proves multi-turn tool use after the first observation.
- The final assistant text contains `CAPABILITY_PROBE_DONE`.
- The observed event order is `skill -> read -> bash -> final text`.
- `dev.log` now shows `Content-Encoding: gzip` and parsed Qwen stream events in the runtime pilot path.

Conclusion:

- The Node 9 runtime pilot stream failure was caused by runtime/plugin HTTP-contract drift from the old Qwen path.
- This is now closed for the short OpenCode capability probe.
- This does not yet prove arbitrary long-conversation compaction behavior; that remains a later long-task acceptance node.

## Node 10: Compact Epoch Session Handoff

Goal: make context compaction an actual provider-session boundary, not only a shorter local message list.

Problem statement:

- The current `forwardChatCompletion()` path can detect `summaryGenerated` and call `forkProviderConversationContext(..., reason: 'server_summary')`.
- However the real request assembly path still rebuilds `RequestAssembly` from only `request.messages` and `toolManifest`.
- Summary/context-management output is not carried as structured runtime input into `prepareRequest()` / `ProviderRuntime.forward(...)`.
- Provider state fallback can still read old provider conversation state through the tool-session fallback path on managed tool follow-up turns.
- This means a request can look compacted locally while the provider-side web session can still continue with old session ids / parent ids or unstructured summary text.

Architecture requirement:

- `server_summary` and `client_compact` must create a new provider conversation epoch.
- The compacted request must carry a bounded structured summary/handoff into `RequestAssembly.summaryText`.
- Runtime/plugin request building must use the new epoch's provider state only; it must not rehydrate the prior provider session id from fallback state across a compact boundary.
- Tool metadata must continue to survive compaction via the stateless fallback chain:
  `Session Store -> Message History Extraction -> Request Tools -> Safe Empty`.

Allowed write set:

- `src/main/proxy/forwarder.ts`
- `src/main/proxy/RequestAssembly.ts`
- `src/main/proxy/services/contextManagementService.ts`
- `src/main/proxy/services/providerConversationState.ts`
- `src/main/proxy/services/ProviderRuntime.ts`
- `src/main/proxy/sessionBoundary.ts`
- focused tests under `tests/providers/` and `tests/services/`

Do not edit:

- provider parser compatibility code
- `src/main/proxy/toolCalling/ToolStreamParser.ts`
- `src/main/proxy/toolRuntime/`
- renderer assets/icons
- unrelated docs/log/temp probe output

Required behavior:

- Extend the real forward path so context-management `processResult` is passed into `buildRequestAssembly()`.
- If summary compaction occurred, `RequestAssembly.summaryText` must contain the bounded summary/handoff text used for the compacted turn.
- `prepareRequest()` must accept assembly/context inputs instead of silently rebuilding from raw messages only.
- `ProviderRuntime.readSessionState()` must not fallback to `toolSessionKey` for `server_summary`, `client_compact`, `summary_generator`, `tool_child`, or `subagent_child` boundaries.
- `ProviderRuntime.writeSessionState()` must not mirror compact child provider state back onto the fallback tool session key.
- Existing tool catalog/metadata restoration must remain structurally full after compact: compact changes the provider conversation epoch, not the tool catalog identity.
- The server-summary epoch source must be based on bounded logical workflow identity and compact result metadata, not raw/truncated full message content that can churn on every summary.

Acceptance:

- Add deterministic tests proving:
  - context-management summary output reaches `RequestAssembly.summaryText` on the actual forwarder/runtime path;
  - `server_summary` and `client_compact` requests do not read provider session id / parent req id from the fallback tool-session state;
  - compact child state is written only to the compact epoch key and not mirrored back to the tool-session fallback key;
  - tool catalog identity and full tool metadata remain available after compact;
  - the runtime pilot still passes Qwen managed stream tool calls.
- Run:

```powershell
node --test tests/providers/provider-runtime-main-path.test.ts tests/providers/qwen-session-continuity.test.ts tests/providers/web-session-behavior.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts tests/services/contextManagement-*.test.ts tests/tool-calling/*.test.ts
npm run build
```

- Then run a real compact/long-context OpenCode probe if the deterministic layer passes. The acceptance evidence must include result JSON plus the OpenCode event stream, and the stream must show tool use after compaction rather than only final text.

Status: accepted on 2026-07-15.

Deterministic evidence:

- `forwardChatCompletion()` now carries the context-management result into the real `doForward()` / `prepareRequest()` path.
- `buildRequestAssembly()` extracts structured compact summary/handoff sections into `RequestAssembly.summaryText` and preserves metadata showing context management was applied.
- The runtime compact boundary tests prove `server_summary` does not read stale provider state from the fallback tool session key.
- The runtime compact write tests prove compact child provider state is written only to the compact epoch key and not mirrored back to the fallback tool key.
- The forwarder runtime test proves a compacted request reaches `ProviderRuntime.forward()` with summary text, context metadata, full structural tool manifest, and `sessionBoundaryReason: server_summary`.
- `buildServerSummaryEpochSource()` derives the server-summary epoch from bounded logical metadata instead of raw message content.
- `node --test tests/providers/provider-runtime-main-path.test.ts tests/providers/qwen-session-continuity.test.ts tests/providers/web-session-behavior.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts tests/services/contextManagement-*.test.ts tests/tool-calling/*.test.ts` passes `360/360`.
- `npm run build` passes.

Real Qwen long-probe evidence:

- Restarted the app with `CHAT2API_PROVIDER_RUNTIME_PILOT=1`.
- `.\tests\agent-capability\verify-opencode-long-conversation.ps1 -Model "qwen/Qwen3-Max" -TimeoutSeconds 240` passes.
- The verifier reports compaction before the final tool probe and again during the final run: `summary=True`.
- The verifier saves required artifacts under `.agent-probe/`, including `long-result.json`, `long-step-1.txt`, `long-step-2.txt`, and `long-summary.txt`.
- `long-result.json` is structurally valid and matches the expected input hash/byte/line facts for `tests/agent-capability/input.txt`.
- `.agent-probe/opencode-long-final-events.ndjson` contains `33` events with `skill=1`, `read=3`, `bash=6`, and final `LONG_CONVERSATION_PROBE_DONE` marker evidence.
- The verifier confirms no `summary_contamination` drift or fabricated tool inventory leaked into the probe output.

Remaining risk:

- Economy metrics parsing reported empty boundary/prompt-refresh distributions even though the verifier accepted compaction and tool evidence. This is a diagnostics gap, not a Node 10 functional failure.
- The current architecture proves compacted main-session continuation. Tool-call-as-child-session and subagent-as-child-session for every provider remain later expansion nodes.

## Node 11: Child Session Boundary Primitive

Goal: introduce a provider-agnostic child-session primitive so high-noise execution work can run in a fresh provider epoch and return only bounded handoff state to the parent session.

Problem statement:

- Node 10 proves that server-summary compaction can create a real provider-session boundary for the main conversation.
- However tool-heavy work is still mostly represented as ordinary parent-session history. Tool calls, tool observations, and subagent handoffs are among the most token-expensive parts of an agent trace.
- If every tool/subagent exchange remains in the parent provider session, the parent web AI session still becomes long even when local context management trims messages.
- The durable architecture should make noisy execution scopes child sessions by policy, not by provider-specific prompt tricks.

Architecture requirement:

- Runtime must expose one shared child-session boundary primitive, not Qwen-only special cases.
- A child session has:
  - parent provider conversation key;
  - child provider conversation key;
  - boundary reason (`tool_child` or `subagent_child`);
  - bounded parent input summary;
  - bounded child result handoff;
  - optional child provider session ids for cleanup;
  - full structural tool catalog identity preserved outside the rendered child prompt.
- The parent session must receive a compact handoff message/state, not the raw child transcript.
- Child provider state must not mirror back into the parent/tool fallback key.
- The existing tool definition no-loss invariant remains mandatory:
  `Session Store -> Message History Extraction -> Request Tools -> Safe Empty`.

Allowed write set:

- `src/main/proxy/sessionBoundary.ts`
- `src/main/proxy/services/providerConversationState.ts`
- `src/main/proxy/services/ProviderRuntime.ts`
- `src/main/proxy/services/childSessionCleanup.ts`
- `src/main/proxy/services/contextManagementService.ts`
- focused tests under `tests/providers/` and `tests/services/`

Do not edit:

- provider parser compatibility code
- `src/main/proxy/toolCalling/ToolStreamParser.ts`
- `src/main/proxy/toolRuntime/`
- provider adapters/plugins unless a compile error proves a narrow type update is required
- renderer assets/icons
- unrelated docs/log/temp probe output

Required behavior:

- Add or complete a typed child-session boundary helper that can derive a child `ProxyContext` from a parent `ProxyContext` without reusing the parent's provider session epoch.
- The helper must support both `tool_child` and `subagent_child` reasons.
- Runtime state reads for child boundaries must not read provider ids from the parent/tool fallback key.
- Runtime state writes for child boundaries must write to the child key and optionally write a bounded `ChildSessionHandoff` to the parent handoff key; they must not mirror the child provider state to the fallback tool-session key.
- Child cleanup must use the recorded child provider session id when available, but cleanup failure must not delete or corrupt parent state.
- Context-management rendering must be able to consume a `ChildSessionHandoff` and render a bounded parent-visible handoff without raw child transcript content.
- Tool catalog metadata must remain full and restorable after the child handoff.

Acceptance:

- Add deterministic tests proving:
  - `tool_child` and `subagent_child` contexts derive distinct child provider conversation keys from the same parent;
  - child boundary reads do not fallback to parent/tool provider state;
  - child boundary writes do not mirror child provider state to the fallback key;
  - parent handoff state is bounded and does not include raw child transcript content;
  - child cleanup targets the recorded child provider session id and does not delete parent provider state on failure;
  - full tool catalog metadata still resolves after a child handoff.
- Run:

```powershell
node --test tests/providers/web-session-behavior.test.ts tests/providers/child-session-cleanup.test.ts tests/providers/context-tool-metadata.test.ts tests/services/contextManagement-tool-handoff.test.ts tests/services/contextManagement-*.test.ts tests/tool-calling/*.test.ts
npm run build
```

Node 11 is not accepted until the main agent reviews the diff and deterministic evidence. A real OpenCode probe may be deferred unless this node changes the live tool execution path; if live routing is changed, the real short and long probes are mandatory.

Status: deterministic accepted on 2026-07-15.

Evidence:

- Added typed `deriveChildProxyContext(...)` for `tool_child` and `subagent_child` child provider epochs.
- `ChildSessionHandoff` now carries an optional structural `childProviderSessionId` for cleanup.
- `cleanupChildProviderSession(...)` deletes only when policy allows it and a recorded child provider session id exists; cleanup failures surface without parent state mutation.
- Child provider state reads do not fall back to parent/tool session state.
- Child provider state writes stay on the child key and can write bounded parent handoff state without mirroring child provider ids to the fallback key.
- Parent-visible child handoff rendering remains bounded and does not include raw child transcript content or internal child provider session ids.
- Tool catalog metadata remains restorable after a child handoff insertion.
- `node --test tests/providers/web-session-behavior.test.ts tests/providers/child-session-cleanup.test.ts tests/providers/context-tool-metadata.test.ts tests/services/contextManagement-tool-handoff.test.ts tests/services/contextManagement-*.test.ts tests/tool-calling/*.test.ts` passes `322/322`.
- `npm run build` passes.

Remaining risk:

- This node creates and verifies the shared child-session primitive. It does not yet reroute every live tool call or subagent invocation through a child provider session.
- The live forwarder cleanup path still has provider-specific cleanup wiring. The next node should replace that with the provider-neutral cleanup primitive and prove it on the live runtime path.

## Node 12: Live Child Session Cleanup Wiring

Goal: connect the Node 11 child-session primitive to the live request path so completed child sessions record provider-neutral cleanup state and the parent cleanup path does not depend on Qwen-only fields.

Problem statement:

- Node 11 added `deriveChildProxyContext(...)`, structural `childProviderSessionId`, and `cleanupChildProviderSession(...)`.
- The live Qwen path still stores `childQwenSessionId` on the parent state and deletes through `adapter.deleteSession(...)` directly.
- `ProviderRuntime.writeRuntimeSessionState(...)` writes provider session ids, but it does not yet record the child provider session id into `ChildSessionHandoff`.
- This means the architecture has the right primitive, but the live path still contains provider-specific cleanup policy.

Architecture requirement:

- Runtime/forwarder child cleanup must use provider-neutral handoff state:
  - child handoff carries `childProviderSessionId` structurally;
  - parent state stores the bounded handoff only;
  - cleanup uses `cleanupChildProviderSession(...)` and plugin/adapter delete capability;
  - cleanup must not leak the internal child provider session id into model-visible handoff text.
- Provider-specific code may still perform provider-private deletion, but the decision and state shape must live in common services.
- Existing `childQwenSessionId` should not be the canonical cleanup mechanism. It may remain only as temporary backward compatibility if a test proves old state must still be consumed.

Allowed write set:

- `src/main/proxy/forwarder.ts`
- `src/main/proxy/services/ProviderRuntime.ts`
- `src/main/proxy/services/childSessionCleanup.ts`
- `src/main/proxy/services/providerConversationState.ts`
- `src/main/proxy/sessionBoundary.ts`
- focused provider/runtime tests

Do not edit:

- provider parser compatibility code
- `src/main/proxy/toolCalling/ToolStreamParser.ts`
- `src/main/proxy/toolRuntime/`
- provider adapters/plugins except for narrow type compile fixes
- renderer assets/icons
- unrelated docs/log/temp probe output

Required behavior:

- Live child-session handoff creation must pass the final child provider session id into `buildChildSessionHandoff(...)`.
- Parent handoff state must store `childProviderSessionId` structurally on `childSessionHandoff`, not as a separate Qwen-specific parent field.
- Parent handoff rendering must still omit `childProviderSessionId`.
- Parent handoff consumption must call `cleanupChildProviderSession(...)`.
- The delete callback supplied to cleanup may be provider-specific, but the cleanup decision and session-id selection must be provider-neutral.
- Runtime pilot child session writes should also be able to attach the final provider session id to a parent handoff when one exists.
- Existing delete-current-session behavior must remain unchanged.

Acceptance:

- Add deterministic tests proving:
  - live Qwen child handoff creation passes the final child provider session id into `ChildSessionHandoff`;
  - parent cleanup deletes using `childSessionHandoff.childProviderSessionId`;
  - parent cleanup does not require `childQwenSessionId`;
  - rendered parent handoff text omits `childProviderSessionId`;
  - runtime pilot child handoff writes can carry provider-neutral `childProviderSessionId`;
  - full tool catalog metadata still survives child handoff consumption.
- Run:

```powershell
node --test tests/providers/qwen-session-continuity.test.ts tests/providers/web-session-behavior.test.ts tests/providers/child-session-cleanup.test.ts tests/providers/provider-runtime-main-path.test.ts tests/providers/context-tool-metadata.test.ts tests/tool-calling/*.test.ts
npm run build
```

Node 12 is accepted only after main-session review confirms live cleanup policy no longer depends on `childQwenSessionId` as the canonical mechanism. A real probe is not mandatory unless the implementation changes live tool routing or prompt construction; if it does, run the short Qwen OpenCode probe.

Status: deterministic accepted on 2026-07-15.

Evidence:

- Live Qwen child handoff creation now passes the final child provider session id into `buildChildSessionHandoff(... childProviderSessionId)`.
- Parent cleanup consumes `childSessionHandoff.childProviderSessionId` through `cleanupChildProviderSession(...)`.
- New canonical parent handoff state no longer depends on `childQwenSessionId`; legacy fields are only a compatibility fallback for old stored state.
- `ProviderRuntime.writeSessionState(...)` can attach the final provider session id onto a parent handoff for child boundaries.
- Parent-visible handoff text still omits `childProviderSessionId`.
- Deterministic tests prove provider-neutral child cleanup wiring, runtime handoff session-id attachment, and tool catalog preservation.
- `node --test tests/providers/qwen-session-continuity.test.ts tests/providers/web-session-behavior.test.ts tests/providers/child-session-cleanup.test.ts tests/providers/provider-runtime-main-path.test.ts tests/providers/context-tool-metadata.test.ts tests/tool-calling/*.test.ts` passes `319/319`.
- `npm run build` passes.

Remaining risk:

- This node does not yet reroute live tool execution or subagent execution into child sessions. It makes their cleanup/handoff state safe once that routing is enabled.
- The compatibility fallback for older `childQwenSessionId`/`childProviderSessionId` parent fields can be removed in a later cleanup-only node after migration confidence is high.

## Node 13: Route-Level Child Boundary Propagation

Goal: prove the real OpenAI chat route propagates grouped tool/subagent child boundaries into the forwarder/runtime path, not only the pure identity helper.

Problem statement:

- `deriveOpenAISessionIdentity(...)` can classify grouped tool workflows as `tool_child` and subagent runs as `subagent_child`.
- `forwarder.ts` and `ProviderRuntime` already enforce child boundary read/write/cleanup policy when `ProxyContext.sessionBoundaryReason` is set.
- The remaining architecture risk is an integration gap: route code could build the right base context but fail to pass the derived child boundary into the real request path.

Architecture requirement:

- `/v1/chat/completions` must apply session identity before calling `RequestForwarder.forwardChatCompletion(...)`.
- Active grouped tool workflows must reach the forwarder with:
  - stable `toolCatalogSessionKey`;
  - child `providerConversationSessionKey`;
  - `parentProviderConversationSessionKey`;
  - `sessionBoundaryReason: 'tool_child'`.
- Subagent headers/metadata must reach the forwarder with `sessionBoundaryReason: 'subagent_child'`.
- The route-level proof must not rely only on source-string matching; it must execute the route or an exported route helper with a stubbed forwarder/selection path.

Allowed write set:

- `src/main/proxy/routes/chat.ts`
- `src/main/proxy/routes/openaiSession.ts`
- focused route/provider tests
- narrow test helpers if needed

Do not edit:

- provider parser compatibility code
- `src/main/proxy/toolCalling/ToolStreamParser.ts`
- `src/main/proxy/toolRuntime/`
- provider adapters/plugins
- renderer assets/icons
- unrelated docs/log/temp probe output

Required behavior:

- Add a route-level deterministic test that executes the chat completion path with an active grouped tool workflow and asserts the captured `ProxyContext` is `tool_child`.
- Add a route-level deterministic test for subagent header or metadata propagation.
- The tests must also assert the tool catalog key remains the parent logical key while the provider conversation key is forked.
- Existing helper-level identity tests must continue passing.

Acceptance:

- Run:

```powershell
node --test tests/routes/openai-session-identity.test.ts tests/providers/provider-runtime-main-path.test.ts tests/providers/qwen-session-continuity.test.ts tests/providers/web-session-behavior.test.ts tests/tool-calling/*.test.ts
npm run build
```

Node 13 is not sufficient to claim live tool execution is fully child-routed; it proves the route-to-runtime boundary signal is real. Node 14 should then enable/verify actual live child execution and run Qwen short/long probes.

Status: deterministic accepted on 2026-07-15.

Evidence:

- `chat.ts` now exposes a narrow route preparation seam that executes the real chat route context construction and calls `applyOpenAISessionIdentity(...)` before forwarding.
- Route-level tests execute that seam with a stubbed forwarder and capture the actual `ProxyContext` passed to `forwardChatCompletion(...)`.
- Active grouped tool workflow route test proves:
  - `sessionBoundaryReason: 'tool_child'`;
  - stable parent `toolCatalogSessionKey`;
  - forked child `providerConversationSessionKey`;
  - populated `parentProviderConversationSessionKey`.
- Subagent metadata route test proves `sessionBoundaryReason: 'subagent_child'` and parent tool catalog preservation.
- Existing identity/helper tests still prove grouped tool workflow keys are stable across contiguous tool results and distinct across independent workflows.
- `node --test tests/routes/openai-session-identity.test.ts tests/providers/provider-runtime-main-path.test.ts tests/providers/qwen-session-continuity.test.ts tests/providers/web-session-behavior.test.ts tests/tool-calling/*.test.ts` passes `322/322`.
- `npm run build` passes.

Remaining risk:

- This node proves route-to-forwarder boundary propagation. It still does not prove live provider execution is fully child-routed under real OpenCode traffic.
- `chat.ts` now uses lazy imports around some runtime dependencies to keep the route preparation seam Node-testable. Build passes, but Vite emits dynamic/static import chunking warnings. A later cleanup can narrow the seam to reduce those warnings without changing behavior.

## Node 14: Live Tool-Child Routing Probe

Goal: prove real OpenCode traffic reaches the provider runtime as bounded child sessions during tool workflows, not only in deterministic route tests.

Problem statement:

- Node 13 proves `/v1/chat/completions` can propagate `tool_child` and `subagent_child` boundaries into the forwarder.
- The original failure mode was not only missing helper logic; it was real long-running agent traffic silently accumulating provider-side context.
- A deterministic route test can still pass while live OpenCode request shapes fail classification, logging, prompt-budget routing, or runtime pilot state writes.

Architecture requirement:

- When real OpenCode runs a grouped tool workflow through Qwen with provider runtime pilot enabled, tool-result turns must be routed with:
  - `sessionBoundaryReason: 'tool_child'`;
  - stable parent `toolCatalogSessionKey`;
  - forked child `providerConversationSessionKey`;
  - populated `parentProviderConversationSessionKey`.
- The child routing evidence must come from real request logs and OpenCode event streams, not only unit tests.
- If real traffic does not produce `tool_child`, the fix must target the request-shape classification or route/runtime boundary propagation. Do not patch Qwen parser behavior as a substitute.
- Tool definitions must remain restorable through the existing fallback chain:
  - Session Store -> Message History Extraction -> Request Tools -> Safe Empty.

Allowed write set if the probe fails:

- `src/main/proxy/routes/openaiSession.ts`
- `src/main/proxy/routes/chat.ts`
- `src/main/proxy/forwarder.ts`
- focused route/provider tests
- focused probe scripts only if they are missing necessary evidence capture

Do not edit:

- provider parser compatibility code
- `src/main/proxy/toolCalling/ToolStreamParser.ts`
- `src/main/proxy/toolRuntime/`
- provider adapters/plugins unless a compile error proves a narrow type update is required
- renderer assets/icons
- unrelated docs/log/temp probe output

Acceptance:

1. Start the app with provider runtime pilot enabled:

```powershell
$env:CHAT2API_PROVIDER_RUNTIME_PILOT="1"; npm run dev:win 2>&1 | Tee-Object -FilePath .\dev.log
```

2. Run the short Qwen OpenCode probe:

```powershell
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "qwen/Qwen3-Max"
```

3. Inspect `dev.log` and `.agent-probe/opencode-events.ndjson`. Acceptance requires all of:

- OpenAI session diagnostics contain `boundaryReason":"tool_child"` during real tool-result turns.
- Forwarder/runtime diagnostics show the same requests carrying a child boundary into provider execution.
- OpenCode events contain a real `agent-capability-probe` skill invocation.
- OpenCode events contain at least two non-skill tool calls.
- At least one tool call occurs after the first observation/tool result event.
- Final assistant text contains `CAPABILITY_PROBE_DONE`.

4. If the short probe passes with child-boundary evidence, run the long Qwen OpenCode probe:

```powershell
.\tests\agent-capability\verify-opencode-long-conversation.ps1 -Model "qwen/Qwen3-Max" -TimeoutSeconds 240
```

5. Long-probe acceptance requires:

- final marker `LONG_CONVERSATION_PROBE_DONE`;
- real skill and non-skill tool events;
- at least one post-observation tool call;
- `server_summary` or compact-epoch evidence where the probe crosses the compact threshold;
- `tool_child` evidence for live tool-result turns.

Node 14 is accepted only when the main agent records the exact probe commands, log evidence, and event-stream evidence. If evidence is missing, delegate the implementation fix to a subagent and keep this node open.

Status: accepted on 2026-07-15.

Evidence so far:

- First short Qwen probe passed before the runtime key-order fix:

```powershell
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "qwen/Qwen3-Max"
```

- Event evidence from that run:
  - `skill -> read -> bash -> final`;
  - 12 OpenCode events;
  - 2 non-skill tools;
  - post-observation tool use;
  - final text `CAPABILITY_PROBE_DONE`.
- Log evidence from that run:
  - `OpenAISession` emitted `boundaryReason":"tool_child"` for real tool-result turns.
  - Forwarder transform logs still showed `toolSessionKeyPresent:false`, revealing a runtime pilot key propagation defect.
- A narrow runtime pilot fix changed the forwarder to compute `conversationStateKey` and `toolSessionKey` before request transformation, and deterministic `provider-runtime-main-path` coverage now proves `toolSessionKeyPresent:true` in the runtime pilot path.
- Second short Qwen probe after that fix failed:
  - OpenCode exited successfully but `.agent-probe/result.json` was missing.
  - `dev.log` showed `toolSessionKeyPresent:true`.
  - Qwen generated malformed managed XML: `read` with parameter `path` instead of required `filePath`.
  - `ToolStreamParser` rejected the call with `schema_validation_failed: Unknown parameter path`.
  - OpenCode event stream contained only `step_start` and `step_finish`, with no real `tool_use`.
- Prompt/schema and Qwen first-turn session semantics were then tightened:
  - managed XML prompt now renders per-tool exact XML examples with schema parameter names such as `filePath`;
  - generic `parameter name="argument"` examples were removed;
  - Qwen runtime pilot no longer marks a first provider request as a continuation merely because it generated a new provider session id internally.
- Third short Qwen probe after those fixes passed:
  - event stream contained `skill,read,bash`;
  - `read` used `filePath`;
  - final text was `CAPABILITY_PROBE_DONE`;
  - `dev.log` showed live `tool_child` turns with `toolSessionKeyPresent:true`, `providerConversationSessionKeyIsChild:true`, and `parentProviderConversationSessionKeyPresent:true`.
- Long Qwen probe after those fixes still failed:
  - warmup turns completed;
  - compaction was proven in `dev.log`;
  - final tool probe emitted no OpenCode `tool_use`;
  - Qwen generated malformed managed XML for `skill`: parameter name `long-conversation-probe` instead of required parameter name `name`;
  - `ToolStreamParser` rejected the call with `schema_validation_failed: Unknown parameter long-conversation-probe`.
- First-skill action constraints were then tightened to render an exact managed XML call for `skill(name="long-conversation-probe")` instead of relying on natural-language instruction.
- Clean full long Qwen probe then passed:

```powershell
.\tests\agent-capability\verify-opencode-long-conversation.ps1 -Model "qwen/Qwen3-Max" -TimeoutSeconds 360
```

  - verifier output ended with `CAPABILITY_PROBE_PASS` and `LONG_CONVERSATION_PROBE_PASS`;
  - completed 6 OpenCode warmup turns in session `ses_09c8f92b0ffeVIjjVcNMviIC9s`;
  - compaction was proven before final tool execution with `summary=True`;
  - `.agent-probe/opencode-long-final-events.ndjson` contained 33 event lines;
  - event stream contained `LONG_CONVERSATION_PROBE_DONE`, a real `long-conversation-probe` skill call, `long-conversation-payload.txt`, and post-observation non-skill tool use;
  - `dev.log` showed repeated real `tool_child` request traces with `toolSessionKeyPresent:true`, `providerConversationSessionKeyIsChild:true`, and `parentProviderConversationSessionKeyPresent:true`.
- Deterministic regression gate passed after updating the GLM prompt-positioning test to account for per-tool exact XML examples:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts tests/providers/qwen-provider-plugin.test.ts tests/providers/provider-runtime-main-path.test.ts
```

  - result: `333/333` pass.
- Build passed:

```powershell
npm run build
```

- Probe economy metrics were updated to parse the current `[Forwarder] Runtime pilot request trace` log format. Before this verifier maintenance fix, the long probe passed but `.agent-probe/economy-metrics.json` misleadingly reported zero boundary reasons because it only parsed an older Qwen prompt-budget diagnostic format.

Current root-cause hypothesis:

- The accepted fix is not a parser alias patch. The durable boundary is now: runtime preserves the stable tool catalog key, context compaction keeps structured tool/workflow state, and first required tool actions render exact schema-shaped managed XML.
- Remaining follow-up is cross-provider long-context validation: Qwen short/long probes and the GLM short probe are accepted, but GLM or another non-Qwen web provider still needs a long compacting probe before the whole architecture can be called provider-agnostic in production.

## Node 15: GLM Runtime Assembly Wiring And Short Probe

Goal: prove a non-Qwen provider consumes the same runtime `RequestAssembly` contract and can pass the OpenCode short capability probe through the provider runtime pilot.

Problem statement:

- GLM was routed through the provider runtime pilot, but its plugin still used the old message-only prompt builder.
- `ToolCallingEngine` generated the correct `toolManifest.renderedPrompt`, including the first-skill action constraint, but `GLMProviderPlugin` did not pass that manifest into the provider prompt.
- The live symptom was architectural, not parser-related:
  - first, GLM emitted pseudo `<skill_tool_call>` text;
  - after prompt tightening, GLM skipped tools and emitted `CAPABILITY_PROBE_DONE`;
  - `dev.log` showed `injected:true` but the GLM final prompt lacked `[High-priority tool action constraint]`.

Architecture requirement:

- Provider plugins must consume `RequestAssembly` as the authoritative prompt input.
- Tool contracts, summaries, and action constraints must not depend on ad hoc mutation of OpenAI `messages`.
- The GLM runtime path must use the same manifest/summary channel as Qwen.
- Parser aliases for pseudo skill tags are not an acceptable fix.

Implemented changes:

- `src/main/proxy/adapters/glm.ts`
  - Added `buildGLMAssemblyPromptMessagesForTest(...)`, a pure assembly-aware prompt builder.
  - It combines `assembly.summaryText` and `assembly.toolManifest.renderedPrompt` and feeds them to the existing GLM `messagesToPrompt(...)` placement logic.
- `src/main/proxy/plugins/GLMProviderPlugin.ts`
  - Replaced the old `buildGLMPromptMessagesForTest(input.assembly.messages, ...)` path with `buildGLMAssemblyPromptMessagesForTest(input.assembly, ...)`.
- `src/main/proxy/toolCalling/ToolCallingEngine.ts`
  - Strengthened first-skill constraints so the exact complete Chat2API XML block appears before natural-language descriptions.
  - Explicitly marks `<skill_tool_call>`, `<tool_call>`, JSON-only descriptions, fenced examples, and explanatory text as invalid formats.
- `tests/providers/glm-tool-calling.test.ts`
  - Added coverage proving GLM assembly prompt construction includes `catalog_fingerprint`, `[High-priority tool action constraint]`, and the exact `skill(name="agent-capability-probe")` XML.
- `tests/providers/plugin-registry.test.ts`
  - Added a guard that GLM plugin builds provider prompts from `RequestAssembly` tool manifests.
- `tests/tool-calling/tool-engine.test.ts`
  - Added guards that the exact managed XML appears before natural-language descriptions and pseudo skill tags are explicitly invalid.

Acceptance evidence:

- GLM live short OpenCode probe passed:

```powershell
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "glm/GLM-5.2"
```

  - verifier output ended with `CAPABILITY_PROBE_PASS`;
  - `.agent-probe/result.json` matched deterministic expected values;
  - `.agent-probe/opencode-events.ndjson` contained real `skill`, `read`, `bash`, and final text events;
  - event stream proved post-observation non-skill tool use;
  - final assistant text was `CAPABILITY_PROBE_DONE`.
- Live log evidence from `dev.log`:
  - `Provider GLM (glm) has 1 available accounts`;
  - `Model mapped from "GLM-5.2" to "glm-5.2"`;
  - first tool turn had `providerId:"glm"`, `planMode:"managed"`, `toolCount":10`, `injected":true`;
  - GLM final prompt contained `[High-priority tool action constraint]` and the exact Chat2API XML `skill` call;
  - GLM stream emitted managed XML tool markers for `skill`, `read`, and `bash`;
  - later tool-result turns showed `sessionBoundaryReason":"tool_child"`, `toolSessionKeyPresent":true`, `providerConversationSessionKeyIsChild":true`, and `parentProviderConversationSessionKeyPresent":true`.
- Deterministic regression gate passed:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts tests/providers/qwen-provider-plugin.test.ts tests/providers/provider-runtime-main-path.test.ts tests/providers/provider-flow.test.ts
```

  - result: `366/366` pass.
- Architecture/runtime gate passed:

```powershell
node --test tests/providers/plugin-registry.test.ts tests/providers/provider-runtime-boundary.test.ts tests/providers/provider-runtime-main-path.test.ts tests/providers/fixture-replay.test.ts tests/providers/stream-normalizer.test.ts tests/providers/child-session-cleanup.test.ts tests/providers/web-session-behavior.test.ts tests/services/workflowLedger.test.ts tests/tool-calling/prompt-budget-policy.test.ts
```

  - result: `95/95` pass.

Remaining risk:

- GLM short probe is now accepted, but GLM long compacting probe has not yet been run.
- Provider runtime pilot is still gated by `CHAT2API_PROVIDER_RUNTIME_PILOT`.
- Some GLM tests still cover legacy message-prompt extraction for backward compatibility; the runtime acceptance path is now assembly-based.

## Node 16: GLM Long-Context Tool Workflow Hardening

Goal: make the non-Qwen long compacting probe follow the same bounded-session architecture as Qwen, without adding provider-specific parser aliases or treating GLM as a special-case string problem.

Problem statement:

- The first GLM long probe failures were not caused by missing XML parser aliases.
- GLM was seeing too much contaminated task/history text during constrained tool turns and eventually rejected the managed contract as fabricated.
- During active tool workflows, context summary generation could also call the same external provider and hit `429`, adding latency and blocking pressure inside the live tool loop.
- A durable fix must bound what the provider sees at each stage:
  - first required skill turn;
  - active skill checkpoint continuation;
  - summary/compact handoff during active tool workflow.

Architecture requirement:

- First required tool/skill turns must project provider-facing messages away from the original user task body and toward the authoritative runtime contract.
- Active skill continuation turns must project the provider view to the latest structured checkpoint instead of replaying raw skill docs, tool payloads, and previous refusal text.
- Active tool workflow compaction must prefer structured handoff/checkpoint state over a fresh external summarizer call.
- The OpenAI-facing and provider-facing histories may differ, but the provider projection must preserve the tool catalog and managed XML contract.
- Tool definitions must continue to survive through the existing fallback chain: Session Store -> Message History Extraction -> Request Tools -> Safe Empty.

Implemented changes:

- `src/main/proxy/toolCalling/ToolCallingEngine.ts`
  - Added exact immediate-next-output XML for `first_skill_required`.
  - Repeated the exact required `skill(name=...)` managed XML after the projected tool surface.
  - Explicitly warns not to emit final probe markers before the required tool sequence.
- `src/main/proxy/RequestAssembly.ts`
  - Added provider-message projection for `first_skill_required` turns so contaminated task text is not replayed to the provider during the first constrained skill call.
  - Added active skill checkpoint projection using `[Active skill workflow state checkpoint]` as the provider-visible continuation source.
- `src/main/proxy/adapters/glm.ts`
  - GLM assembly prompt construction now uses the provider projection instead of raw `assembly.messages`.
- `src/main/proxy/services/contextManagementService.ts`
  - `SummaryStrategy` now skips external summary generation during active tool workflows and returns `summary_skipped_active_tool_workflow`.
  - The fallback handoff still applies structured replacements/drops, preserving active workflow state without calling the provider summarizer.
  - Summary output such as `No conversation to summarize.` / `没有可总结的对话` is now treated as unusable and replaced by `summary_fallback_local` instead of being inserted as `[Prior conversation summary]`.
  - External summary failure, missing generator, empty summary output, contaminated summary output, and no-op summary output now produce a bounded local fallback summary (`summary_fallback_local`) instead of silently degrading to recent-message-only sliding-window behavior.
  - `summary_fallback_local` is counted as `summaryGenerated`, so compact still creates a server-summary provider epoch seeded with bounded state even when the external summarizer is unavailable.
- `src/main/proxy/forwarder.ts`
  - The external summary generator now checks sanitized input before opening a provider `summary_generator` child session.
  - If sanitizer output contains no real non-system history after removing tool catalogs/system directives, it returns an unusable empty summary and lets `SummaryStrategy` create the local fallback summary.
  - This prevents provider web UIs from accumulating `No conversation to summarize.` summary-child conversations that do not contribute state to the parent task.
- `tests/agent-capability/verify-opencode-capability.ps1` and `tests/agent-capability/verify-opencode-long-conversation.ps1`
  - Added provider preflight before expensive OpenCode execution.
  - A provider-side `429` is now reported as `provider_preflight_failed` instead of being misdiagnosed as a long OpenCode/tool-loop timeout.
- `tests/agent-capability/check-provider-health.ps1`
  - Added a small no-tool provider/model health matrix so live acceptance can distinguish Chat2API regressions from upstream model/account unavailability before starting expensive OpenCode probes.
  - Classifies `429` as `provider_rate_limited`, model-name errors as `model_unavailable`, auth/login failures separately, and HTTP-200 error text such as "please refresh/retry" as `provider_unavailable` instead of `healthy`.
- Focused tests were added or updated in:
  - `tests/tool-calling/tool-engine.test.ts`;
  - `tests/tool-calling/tool-manifest.test.ts`;
  - `tests/providers/glm-tool-calling.test.ts`;
  - `tests/services/contextManagement-order-preservation.test.ts`;
  - `tests/services/contextManagement-tool-handoff.test.ts`.

Live probe evidence:

- After exact first-skill XML tightening, GLM still refused because the provider was receiving the full contaminated task prompt. This confirmed the bug was in provider-facing assembly, not XML parsing.
- After first-skill provider projection, GLM created `.agent-probe/long-step-1.txt` and proceeded into real tool use, but later refused before `.agent-probe/long-summary.txt` because raw skill/history text was replayed on continuation turns.
- After active checkpoint projection, a GLM long run progressed through the real sequence:
  - `skill long-conversation-probe`;
  - `read tests/agent-capability/input.txt`;
  - `bash` creating `long-step-1.txt`;
  - `read tests/agent-capability/long-conversation-payload.txt`;
  - `bash` creating `long-step-2.txt`;
  - `bash` creating `long-result.json`;
  - `bash` creating `long-check-1.txt`;
  - `bash` creating `long-check-2.txt`.
- A later run exposed summary pressure during the active workflow:
  - `dev.log` contained `[SummaryGenerator] Failed to generate summary: Provider runtime request failed with status 429`;
  - this led to skipping external summary generation during active tool handoff.
- The latest GLM long probe attempt did not produce a behavioral failure inside the tool chain. It timed out during warmup turn 1 with `.agent-probe/opencode-long-warmup-1.ndjson` at 0 bytes, which indicates the provider/account/runtime call did not yield any OpenCode event before timeout.
- A follow-up sanity check confirmed the selected route was the Zhipu provider, not Zai:
  - OpenCode command used `--model glm/GLM-5.2`;
  - `dev.log` showed `providerId":"glm"`, `Provider GLM (glm)`, and `Model mapped from "GLM-5.2" to "glm-5.2"`;
  - a plain no-tool `/v1/chat/completions` health request with `model: "glm/GLM-5.2"` failed with `Provider runtime request failed with status 429`.
- A no-pilot A/B check confirmed the `429` is not caused by the runtime pilot:
  - the app was restarted without `CHAT2API_PROVIDER_RUNTIME_PILOT`;
  - `dev-nopilot.log` showed the old GLM adapter path (`[GLM] Sending chat request...`) and no runtime pilot trace;
  - the same plain no-tool request still failed with `HTTP 429`.
- Manual provider observation showed GLM summary attempts can return `No conversation to summarize.`; deterministic coverage now proves this no-op summary is rejected and not inserted into compacted context.
- Follow-up architecture hardening changed summary failure behavior from "drop old messages and keep recent only" to "insert a bounded local fallback summary and mark summaryGenerated." This preserves the compact invariant even when the provider used for summary is rate-limited, returns empty text, or says there is no conversation to summarize.
- A second follow-up hardening prevents empty sanitized summary inputs from reaching the provider at all. Regression coverage proves the summary generator does not call `doForward` for sanitized tool/system-only history, while still calling the provider for real user/assistant history.
- Provider health smoke on 2026-07-15:
  - `glm/GLM-5.2`: `provider_rate_limited` (`429`) on a plain no-tool request;
  - `kimi/Kimi-K2.6`: `healthy`;
  - `mimo/MiMo-V2.5`: `healthy`;
  - `minimax/MiniMax-M2.7`: `healthy`;
  - `qwen/Qwen3-Max`: `healthy`;
  - `zai/GLM-5-Turbo`: `provider_unavailable` because it returned HTTP 200 with an error body asking to refresh/retry.
  - Evidence file: `.agent-probe/provider-health-smoke.json`.

Deterministic evidence:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts tests/providers/qwen-provider-plugin.test.ts tests/providers/provider-runtime-main-path.test.ts tests/providers/provider-flow.test.ts
```

- result: `369/369` pass.

```powershell
node --test tests/providers/plugin-registry.test.ts tests/providers/provider-runtime-boundary.test.ts tests/providers/provider-runtime-main-path.test.ts tests/providers/fixture-replay.test.ts tests/providers/stream-normalizer.test.ts tests/providers/child-session-cleanup.test.ts tests/providers/web-session-behavior.test.ts tests/services/workflowLedger.test.ts tests/tool-calling/prompt-budget-policy.test.ts tests/services/contextManagement-order-preservation.test.ts tests/services/contextManagement-tool-handoff.test.ts
```

- result: `118/118` pass.

```powershell
node --test tests/services/contextManagement-summary-failure-diagnostic.test.ts tests/services/contextManagement-order-preservation.test.ts tests/services/contextManagement-tool-handoff.test.ts tests/services/contextManagement-summary-input-sanitization.test.ts
```

- result: `35/35` pass.

```powershell
node --test tests/services/contextManagement-summary-failure-diagnostic.test.ts tests/services/contextManagement-summary-input-sanitization.test.ts tests/services/contextManagement-order-preservation.test.ts tests/services/contextManagement-tool-handoff.test.ts tests/providers/provider-runtime-main-path.test.ts tests/providers/glm-tool-calling.test.ts tests/tool-calling/tool-engine.test.ts tests/tool-calling/tool-manifest.test.ts tests/tool-calling/prompt-budget-policy.test.ts
```

- result: `160/160` pass.

```powershell
node --test tests/services/contextManagement-summary-failure-diagnostic.test.ts tests/providers/provider-runtime-main-path.test.ts
```

- result: `20/20` pass.
- Includes `RequestForwarder summary generator skips provider request when sanitized history is empty`, proving the provider summary child session is not opened for empty sanitized history.

```powershell
npm run build
```

- result: pass.

Status: partially accepted on deterministic and architectural evidence, not live accepted.

Remaining risk:

- GLM long compacting probe has not passed end to end.
- The latest live blocker is provider/account rate limiting on the Zhipu GLM route (`glm/GLM-5.2`), so the next useful action is to rerun when that provider is responsive or run the same long probe on another non-Qwen provider with credentials.
- Current non-Qwen candidates for the next live probe are `kimi/Kimi-K2.6`, `mimo/MiMo-V2.5`, and `minimax/MiniMax-M2.7`; do not use `zai/GLM-5-Turbo` as acceptance evidence while it returns HTTP-200 error text.
- Do not declare provider-agnostic long-task support complete until one non-Qwen long compacting probe passes with real event-stream and log evidence.

## Review Checklist

- Does this move policy upward into runtime instead of downward into adapters?
- Does this make the next provider easier, or only Qwen easier?
- Is summary/tool/workflow state structured before it is rendered as prompt text?
- Can this be verified without a lucky model response?
- Does the test prove the actual main path, not just a helper or source string?
