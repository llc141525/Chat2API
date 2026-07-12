# P1 Tool Availability Drift Rework Plan

Date: 2026-07-10
Parent plan: `docs/superpowers/specs/2026-07-10-p1-tool-mcp-reliability-writing-plan.md`
Trigger: GLM OpenCode probe intermittently loaded the skill, then replied that only `open_url` was available instead of calling `read` and `bash`.

## Objective

Close the remaining P1 reliability gap where a model loses or misreads the current tool catalog during an agent workflow and emits plain text denying available tools.

The target state is that Chat2API treats this as tool availability drift, not as a normal assistant answer. When the runtime has an authoritative non-empty tool catalog, a response such as "only open_url is available" must be detected, diagnosed, and retried or failed explicitly before the client accepts it as terminal output.

## Failure Evidence

During P2 acceptance, the deterministic tests passed and Qwen passed the real OpenCode probe. GLM failed once, then passed on retry.

Observed failed shape:

- The `agent-capability-probe` skill was invoked successfully.
- The next assistant message was plain text claiming only `open_url` was available.
- No `read` or `bash` tool call was emitted.
- `.agent-probe/result.json` was never created.
- A later retry with the same class of request passed.

This proves the provider, parser, and local fixture can work, but one real model turn can drift away from the tool contract after a successful tool or skill result.

## Classification

This is P1.

It is not P0 swallowed reply:

- The model returned visible assistant text.
- The proxy did not drop the provider response.

It is not P2 angle-bracket leakage:

- The failure happened before reading `tests/agent-capability/input.txt`.
- No fake XML, escaped tag, or managed marker content needed to be parsed.

It is not context compact:

- The failure happened in a short probe flow.
- The tool catalog should still have been active.

It is not a managed XML parser failure:

- The model emitted no managed XML tool-call block to parse.
- Existing parser tests cover unknown, malformed, fenced, and literal angle-bracket cases.

The practical root cause is tool availability belief drift: the model saw a stale or irrelevant tool availability frame and trusted that frame over the current Chat2API-managed catalog.

## Current Gap

The codebase already has a non-stream availability retry path:

- `ToolCallingEngine.applyNonStreamResponse(...)` calls `detectAvailabilityDrift(...)` when parsed output is plain text.
- `forwarder.ts` retries non-stream provider calls when the retry fingerprint matches the current catalog.
- Tests cover non-stream denial, one retry per plan, valid tool-call bypass, and forced-tool clarification.

The remaining high-risk gap is real agent streaming.

OpenCode-style clients usually stream. Once a provider stream starts forwarding ordinary assistant text to the client, Chat2API can no longer invisibly replace that response with a retry. That means the same availability drift detection that works in non-stream mode can be too late or absent for the mode users actually exercise.

## Root Cause Hypotheses

Treat these as hypotheses until instrumented evidence confirms or rejects them:

- The model overweights the most recent tool result or skill output and underweights the managed tool contract.
- Large skill text can introduce a competing mental model of available tools.
- The model latches onto a visible tool name such as `open_url` and incorrectly infers that all other tools are unavailable.
- `tool_choice: auto` allows a plain-text denial instead of forcing a tool call when the task clearly requires local tools.
- Streaming paths do not have the same "detect plain-text denial before final delivery" behavior as non-stream paths.
- Current diagnostics record catalog resolution, but do not make the failed streamed denial easy to correlate with catalog fingerprint, provider, and tool names.

## Rework Scope

Primary files:

- `src/main/proxy/toolCalling/availabilityDrift.ts`
- `src/main/proxy/toolCalling/ToolCallingEngine.ts`
- `src/main/proxy/toolCalling/ToolStreamParser.ts`
- `src/main/proxy/toolCalling/types.ts`
- `src/main/proxy/forwarder.ts`
- provider stream handlers used by GLM, Qwen, Qwen AI, DeepSeek, and other managed profiles

Primary tests:

- `tests/tool-calling/availability-drift-retry.test.ts`
- `tests/tool-calling/tool-engine.test.ts`
- `tests/tool-calling/tool-stream-parser.test.ts`
- provider streaming tests, especially GLM and Qwen
- `tests/agent-capability/verify-opencode-capability.ps1`

## Required Behavior

### 1. Detect Availability Denial More Precisely

Extend detection beyond generic "tool unavailable" phrasing.

Must detect examples like:

- `I only have open_url available.`
- `I don't have access to read or bash.`
- `The read tool is not available in this environment.`
- `当前只能使用 open_url，不能使用 read 或 bash。`
- `没有 read/bash 工具。`

Must not trigger when:

- The request has no authoritative catalog.
- The allowed tool list is empty.
- The model already emitted valid tool calls.
- The text is a user-provided quoted/fenced example, unless the whole assistant answer is clearly an operational denial.

### 2. Bring Streaming To Parity With Non-Stream

Streaming managed-tool responses need a pre-delivery classification point.

Acceptable implementation options:

- Buffer the beginning of a managed stream until it is classified as tool-call structure, ordinary safe text, or availability denial.
- For strict agent profiles, buffer the full first assistant content when a non-empty catalog exists and no tokens have been delivered yet.
- If a denial is detected before any client-visible content is emitted, perform the same availability retry used by non-stream.
- If denial is detected after content has already been emitted, record diagnostics and end with an explicit tool availability drift error rather than silently accepting a misleading answer.

Do not duplicate tool prompt injection in provider adapters. `ToolCallingEngine` remains the owner of the contract and retry clarification.

### 3. Retry With An Authoritative Catalog Clarification

The retry prompt must include:

- current catalog fingerprint
- exact allowed tool names for this turn
- the fact that this catalog is authoritative
- the selected protocol and required managed XML shape
- a direct instruction that a needed available tool must be called rather than denied

If the original request forced a tool through `tool_choice`, the retry must expose only that forced tool.

### 4. Bound Retry Behavior

Prevent loops:

- At most one availability retry per request plan and catalog fingerprint.
- Preserve the existing `availabilityRetryAttempted` guard.
- Record `attempted`, `succeeded`, `failed`, or `skipped` consistently for stream and non-stream.

If the retry also denies available tools, return a client-visible failure that names the provider/model and says the model refused the authoritative tool catalog. Do not return a fake successful assistant answer.

### 5. Improve Diagnostics

Diagnostics should make this failure explainable from logs without re-running the probe.

Add or ensure fields for:

- `availabilityDriftDetected`
- `availabilityRetryResult`
- `catalogFingerprint`
- `allowedToolNames`
- `deniedToolNames`
- `mentionedUnavailableOnlyTools`, for example `open_url`
- `responseMode: streaming | non_streaming`
- `providerId`
- `actualModel`
- whether any assistant content had already been sent to the client

## Test Plan

Focused deterministic tests:

```powershell
node --test tests/tool-calling/availability-drift-retry.test.ts tests/tool-calling/tool-engine.test.ts tests/tool-calling/tool-stream-parser.test.ts
```

Provider streaming tests:

```powershell
node --test tests/providers/glm-tool-calling.test.ts tests/providers/qwen-request-routing.test.ts
```

Full deterministic gate:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

Real OpenCode probes:

```powershell
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "glm/GLM-5.2"
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "qwen/Qwen3.7-Max"
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "deepseek/deepseek-v4-pro"
```

For GLM specifically, run the probe more than once before declaring this fixed:

```powershell
1..3 | ForEach-Object { .\tests\agent-capability\verify-opencode-capability.ps1 -Model "glm/GLM-5.2" }
```

## New Regression Fixtures

Add fixtures that simulate these responses under a non-empty catalog containing `read` and `bash`:

- non-stream: `I only have open_url available.`
- streaming split across chunks: `I only` / ` have open_url` / ` available.`
- streaming denial after skill-like text: `I loaded the skill, but I do not have access to read or bash.`
- Chinese denial: `当前没有 read 和 bash 工具，只能使用 open_url。`
- valid managed XML after retry
- repeated denial after retry

Assertions:

- First denial triggers availability retry before terminal success.
- Retry clarification includes the authoritative tool names.
- Valid retry output converts to OpenAI `tool_calls`.
- Repeated denial fails explicitly.
- No partial denial text leaks to the client in the pre-delivery retry case.

## Acceptance Criteria

- Streaming and non-streaming managed profiles both detect available-tool denial.
- The GLM `open_url`-only failure is reproduced by a deterministic test before the fix and blocked after the fix.
- A real OpenCode GLM probe passes three consecutive runs.
- Qwen and DeepSeek probes still pass.
- Existing P0 and P2 gates stay green.
- No provider adapter adds managed tool prompt injection.

## Notes For Implementation

Start with the streaming path. Non-stream retry already exists, so the fastest useful proof is a failing streaming test that reproduces the `open_url`-only denial.

The most likely durable design is to move availability-denial observation into the same stream classification layer that already suppresses incomplete or malformed managed markers. That keeps parser, validation, and denial handling close together while preserving `ToolCallingEngine` as the single owner of the tool contract.

## Acceptance Run: 2026-07-10

Status: failed.

Deterministic gates passed:

```powershell
node --test tests/tool-calling/availability-drift-retry.test.ts tests/tool-calling/tool-engine.test.ts tests/tool-calling/tool-stream-parser.test.ts
node --test tests/providers/glm-tool-calling.test.ts tests/providers/qwen-request-routing.test.ts
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

Observed results:

- Focused P1 drift gate passed: 50 tests.
- Provider gate passed: 49 tests.
- Full deterministic gate passed after follow-up coverage: 219 tests.
- Qwen real OpenCode probe passed.
- DeepSeek real OpenCode probe passed.
- GLM real OpenCode probe failed repeatedly.

GLM failure shape after follow-up inspection:

- The model emitted plain assistant text before any real tool call.
- The text claimed: `环境中唯一可用的工具是 open_url`.
- It also emitted `CAPABILITY_PROBE_DONE` even though `.agent-probe/result.json` was missing.
- OpenCode exited successfully, so this is not a provider transport failure.
- The verifier correctly failed because no deterministic result file existed.

Additional deterministic coverage added during this acceptance:

- Chinese/English "only available tool is open_url" availability-denial detection.
- GLM cumulative managed-marker buffering coverage for split `<|CHAT2API|tool_calls>` snapshots.

Current root cause conclusion:

The remaining GLM failure is not a missing phrase in `availabilityDrift.ts` alone. In the real OpenCode/GLM path, the adapter logs tool names extracted from the textual `## Available Tools` prompt, but the request does not show a `Tool Contract Header` or authoritative ToolCallingEngine catalog fingerprint. Because `detectAvailabilityDrift` intentionally requires a non-empty authoritative catalog, the stream guard has no catalog basis and lets the denial text through as ordinary assistant content.

Required next rework:

- Promote prompt-extracted OpenCode tool definitions into the ToolCallingEngine catalog, or ensure the Anthropic/OpenCode request path reaches ToolCallingEngine with normalized tools before GLM formatting.
- Keep `ToolCallingEngine` as the single owner of managed prompt injection.
- Do not solve this by making GLM adapter inject a second tool prompt.
- Add a deterministic integration test where OpenCode-style tools exist only in the prompt text and GLM emits `唯一可用的工具是 open_url`; the expected result is an explicit availability-drift failure or a retry backed by a real catalog.

## v2 Implementation Run: 2026-07-10

Status: deterministic gates complete, real probe pending.

Changes delivered:

- `src/main/proxy/toolCalling/clientAdapters/promptEmbeddedToolExtractor.ts` (new): pure extractor that parses `## Available Tools` blocks and Cherry-Studio `<tools>` XML from system/user messages into `NormalizedToolDefinition[]` with `source: 'prompt_embedded'`.
- `src/main/proxy/toolCalling/clientAdapters/standardOpenAiTools.ts`: when `request.tools` is empty, falls back to the extractor; sets `toolSource: 'prompt_embedded'`.
- `src/main/proxy/toolCalling/clientAdapters/types.ts`: added `'prompt_embedded'` to `toolSource`; added `PromptEmbeddedMarkers` and diagnostics fields.
- `src/main/proxy/toolCalling/types.ts`: added `'prompt_embedded'` to `ToolSource`, `ToolCatalogSource`, `ToolContractSourceStep`, `ToolCatalogSnapshot.source`; added `'prompt_embedded_only_catalog'` and `'schema_degraded_from_prompt'` to `ToolCatalogDriftKind`.
- `src/main/proxy/toolCalling/catalog.ts`: added `promptEmbeddedTools` to `ToolCatalogResolveInput`; resolution order now Session → OpenAI Tools → Prompt-Embedded → History → Safe Empty.
- `src/main/proxy/toolCalling/runtimePlan.ts`: routes prompt-embedded tools through the dedicated field; `buildToolSourceChain` returns `['current_request', 'prompt_embedded']` for the new path.
- `tests/tool-calling/prompt-embedded-catalog.test.ts` (new): 12 tests covering extraction, schema parsing, dedup, immutability, empty-detection, fingerprint stability.
- `tests/tool-calling/availability-drift-retry.test.ts`: 3 new tests confirming `catalogSnapshot` is populated from prompt-embedded path and drift detection engages.
- `tests/providers/glm-tool-calling.test.ts`: 1 new test confirming non-stream GLM denial under prompt-embedded catalog returns a retry request (not silent success).

Deterministic gate results:

```
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
→ 235 tests, 235 pass, 0 fail
```

Previous baseline: 219. New coverage: +16.

Real probe gate (GLM ×3, Qwen, DeepSeek): pending. Must pass before v2 acceptance.
