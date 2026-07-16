# P1 Tool And MCP Reliability Writing Plan

Date: 2026-07-10
Parent spec: `docs/superpowers/specs/2026-07-10-agent-tooling-stability-spec.md`

## Objective

Restore reliable multi-turn tool use for OpenCode and MCP-style tools without reintroducing duplicate provider-adapter prompt injection.

The target state is that Chat2API can preserve tool definitions, parse managed provider output, validate arguments, and return OpenAI-compatible `tool_calls` across multi-turn agent workflows.

## User-Visible Symptoms

- Tool use regressed from bad argument quality to no usable tool calls.
- Later turns lose tool definitions.
- MCP tools fail or disappear after a tool result.
- Models choose wrong parameter names or produce malformed arguments that are passed through.
- OpenCode real probe can load the `agent-capability-probe` skill, then emit plain text claiming only `open_url` is available instead of calling `read` and `bash`.
- Enabling context management can drop prompt-injected tool definitions even when summary/compact is not enabled.

## Scope

Primary files:

- `src/main/proxy/toolCalling/ToolCallingEngine.ts`
- `src/main/proxy/toolCalling/runtimePlan.ts`
- `src/main/proxy/toolCalling/ToolStreamParser.ts`
- `src/main/proxy/sessionManager.ts`
- `src/main/proxy/services/contextManagementService.ts`
- `src/main/proxy/contextMessageMetadata.ts`
- `src/main/proxy/toolRuntime/data/`
- `src/main/proxy/toolRuntime/runner/`
- `src/main/proxy/adapters/qwen.ts`
- `src/main/proxy/adapters/glm.ts`
- `src/main/proxy/adapters/qwen-ai.ts`

Primary tests:

- `tests/tool-calling/catalog-fallback.test.ts`
- `tests/tool-calling/tool-stream-parser.test.ts`
- `tests/tool-runtime/data/*.test.ts`
- `tests/tool-runtime/integration/*.test.ts`
- `tests/providers/context-tool-metadata.test.ts`
- `tests/providers/glm-tool-calling.test.ts`
- `tests/providers/qwen-request-routing.test.ts`

## Invariants

Do not break these:

- `ToolCallingEngine` is the sole owner of managed prompt injection.
- Provider adapters must not import tool prompt injection helpers.
- Catalog fallback order is:

```text
Session Store -> Message History Extraction -> Request Tools -> Safe Empty
```

- Managed XML is canonical for GLM, Qwen, and Qwen AI unless a provider profile explicitly changes it.
- Invalid tool output must be blocked, not repaired into fake confidence.

## Writing Sequence

### Step 0: Protect Tool Definition Messages During Context Management

Before changing parser or prompt logic, verify context management is not deleting the tool contract.

Risk:

- Sliding window and token-limit strategies can remove early non-system messages.
- Some tool definitions are prompt-injected into user-shaped or provider-formatted messages, not only `role: "system"` messages.
- `preserveToolExchangePairs` protects assistant `tool_calls` and matching tool results, but does not by itself protect original tool definition/catalog messages.

Required behavior:

- Messages containing managed tool prompt signatures must be protected like system messages.
- MCP-style tool definition blocks such as `<tools><tool>...</tool></tools>` must be protected.
- Tool result messages and assistant tool-call messages should remain governed by pair preservation, not misclassified as tool definitions.
- If protected tool-definition messages alone exceed token limits, emit diagnostics and prefer failing/degrading explicitly over silently removing the contract.

Tests to add or keep:

- Sliding window keeps prompt-injected tool definitions in user/system messages.
- Token limit keeps prompt-injected tool definitions.
- Summary fallback keeps prompt-injected tool definitions.
- Tool exchange pair preservation still restores assistant/tool result pairs without duplicating tool definition messages.

### Step 1: Freeze The Catalog Rules

Document and test catalog resolution:

- Current request tools are saved into the session catalog.
- Same session later turns reuse the complete catalog.
- Assistant `tool_calls` and tool messages preserve `tool_call_id`.
- History-only fallback recovers only observed tool names and uses degraded safe schemas.
- Safe empty means no tools are available and no managed prompt should pretend otherwise.

### Step 2: Make Schema Validation The Gate

Ensure streaming and non-streaming paths share the same validation expectations:

- Unknown tool names fail.
- Missing required parameters fail.
- Object parameters must parse as JSON objects.
- Array parameters must parse as JSON arrays.
- String parameters remain strings even when they contain JSON-looking text.
- CDATA is preserved for string values.

The validator must reject bad structure before the assembler creates OpenAI `tool_calls`.

### Step 3: Make Assembly Schema-Aware

For valid object/array parameters, assemble OpenAI `function.arguments` using JSON values, not stringified nested JSON.

Example target:

```json
{"options":{"mode":"safe"},"tags":["a","b"]}
```

Not:

```json
{"options":"{\"mode\":\"safe\"}","tags":"[\"a\",\"b\"]"}
```

### Step 4: Normalize Stream And Non-Stream Runtime

The same logical output must produce the same OpenAI-compatible tool calls in both modes:

- stream: `delta.tool_calls` then final `finish_reason: "tool_calls"`
- non-stream: `message.tool_calls`, `message.content: null`, `finish_reason: "tool_calls"`

Do not allow legacy protocol fallback to parse wrong-protocol content under a managed XML plan.

### Step 5: MCP-Style Tool Coverage

Add tests with names that look like MCP/server-scoped tools, for example:

- `mcp_filesystem__read_file`
- `default_api:read_file`
- `server.tool_name`

The exact names should match what OpenCode or the project fixtures use. The purpose is to prove names survive:

- prompt rendering
- managed XML parsing
- allowed-tool validation
- OpenAI assembly
- multi-turn history restoration

### Step 6: Provider Prompt Boundary Review

Review Qwen first:

- It currently flattens role/history into one text block.
- Tool contracts, assistant tool calls, tool results, and latest user text need strong boundaries.

Do not solve this by duplicating prompt injection. The provider adapter can format already-prepared messages, but the tool contract must still come from `ToolCallingEngine`.

## Test Plan

Focused tests:

```powershell
node --test tests/tool-calling/catalog-fallback.test.ts tests/tool-calling/tool-stream-parser.test.ts tests/tool-runtime/data/*.test.ts
```

Provider/runtime tests:

```powershell
node --test tests/tool-runtime/integration/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

Full deterministic gate:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

## OpenCode Verification

Default:

```powershell
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "glm/GLM-5.2"
```

Provider-risk probes:

```powershell
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "qwen/Qwen3.7-Max"
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "deepseek/deepseek-v4-pro"
```

## Acceptance Criteria

- Same-session turns retain the complete tool catalog.
- History-only fallback is safe and explicitly degraded.
- MCP-style names survive the full tool-call lifecycle.
- Bad parameters are rejected before tool calls are emitted.
- Valid tool calls produce OpenAI-compatible stream and non-stream outputs.
- OpenCode probe proves skill use, multiple non-skill tools, and a post-result tool call.

## Acceptance Run: 2026-07-10

Focused deterministic gate passed:

```powershell
node --test tests/tool-calling/output-inspection.test.ts tests/tool-calling/tool-stream-parser.test.ts tests/tool-calling/catalog-fallback.test.ts tests/tool-calling/tool-catalog.test.ts tests/tool-calling/tool-engine.test.ts tests/tool-runtime/data/*.test.ts
```

Result:

- 107 tests passed.
- Session catalog fallback tests passed.
- Same-session subset request reuses the full session catalog instead of shrinking tool availability.
- ToolCallingEngine keeps the full catalog when a later request sends only a subset of tools.
- Required parameter and object/array schema validation tests passed.
- Stream parser still suppresses malformed and post-tool-call residue.

Provider/runtime gate passed:

```powershell
node --test tests/tool-runtime/integration/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

Result:

- 51 tests passed.
- Context management preserved assistant `tool_calls` and `tool_call_id` metadata.
- GLM, Qwen, and Qwen AI managed XML provider routing tests passed.
- Qwen stream rewrite recovery and empty-output safety tests passed.

Full deterministic gate passed:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

Result:

- 207 tests passed.

Real OpenCode probes passed:

```powershell
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "glm/GLM-5.2"
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "qwen/Qwen3.7-Max"
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "deepseek/deepseek-v4-pro"
```

Result:

- All three probes returned `CAPABILITY_PROBE_PASS`.
- `result.json` exactly matched deterministic expected values.
- Event streams included the real `agent-capability-probe` skill invocation.
- Event streams included at least two non-skill tool calls.
- Event streams proved multi-turn tool use with a non-skill tool call after a tool result.
- Final assistant text included `CAPABILITY_PROBE_DONE`.

P1 status:

- Accepted for the verified GLM, Qwen, and DeepSeek paths.
- The earlier real-probe failure where the model claimed only `open_url` was available is no longer reproduced.

## Stop Conditions

Stop and split a follow-up if:

- Fixing Qwen requires provider request format redesign beyond catalog/tool runtime.
- A provider natively supports a better structured tool API and should move to a separate provider profile.
- A compatibility change would violate the single-owner prompt injection invariant.

## Reopening: 2026-07-11 — Qwen Intermittent Malformed + Compaction Audit

The 2026-07-10 acceptance is superseded for two surfaces. Manual reuse on 2026-07-11 surfaced:

1. **Intermittent Qwen `malformed_tool_output`** — the terminal outcome from `outputInspection.ts:172` reproduces sporadically on Qwen turns. Deterministic tests did not catch it and one-shot probes are not enough evidence.
2. **Context management summary compaction has not been re-verified end-to-end** for multi-turn tool exchanges against the P1 v2 prompt-embedded catalog path. Compaction is the load-bearing path for long OpenCode / Claude Code sessions.

Follow-up plan: `2026-07-11-p0-p1-followup-plan.md` — Tracks B and C.

Scope added to P1 in the follow-up (Track B — Qwen intermittent malformed):

- Decide per specific root cause between (a) parser repair for benign artifacts (whitespace, control chars, order-tolerant assembly) with visible per-repair-path counters, and (b) a bounded, typed one-shot parse retry mirroring the availability drift retry mechanic. Do not silently swallow the classification.
- Real Qwen probe gate widened to **five consecutive** `CAPABILITY_PROBE_PASS` runs so intermittent flips are visible.

Scope added to P1 in the follow-up (Track C — context management compaction audit):

- Preserve original insertion order across every strategy (`SlidingWindowStrategy`, `TokenLimitStrategy`, `SummaryStrategy`). Reassembling as `[...protectedMessages, ...trimableMessages]` moves protected content to the front of the array regardless of its original position and is the root of most compaction pathologies. Fix by dropping non-protected messages in place, not by role-bucketing.
- Route `containsToolDefinitions` through the same signature registry the prompt-embedded extractor uses, so any client signature that reaches the extractor also protects its tool-definition message from compaction.
- Guarantee `toolSessionKey` propagation across compacted turns and expose a `catalogRescueByCompaction` diagnostic so the P1 v2 session-catalog rescue is provably running when compaction prunes the prompt-embedded block.
- Distinguish `summary_success | summary_generator_missing | summary_generator_failed | summary_not_needed` as typed strategy result subkinds instead of hiding failure behind a console warning.
- Add a `preserveToolDefinitionMessages` guardrail pass (mirroring `preserveToolExchangePairs`) that restores protected tool-definition messages if a strategy ever drops one — guardrail only; the strategies themselves must not drop them.
- Add a long-conversation probe that exercises real sliding-window and summary compaction within a single OpenCode session.

Original P1 main status: ACCEPTED for the same-session catalog reuse, MCP name survival, schema validation, and stream/non-stream parity paths. **REOPENED** for Qwen intermittent malformed and for context management compaction correctness. Do not close this reopening until the follow-up plan's acceptance criteria are met.
