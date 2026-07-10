# Agent Tooling Stability Spec

Date: 2026-07-10
Workspace: `E:\Chat2API`

## Purpose

This spec defines the long-term repair track for Chat2API agent clients, especially OpenCode and Claude Code, when using managed tool-calling through non-native providers such as GLM, Qwen, Qwen AI, and DeepSeek.

The immediate user-facing failures are:

1. Assistant replies are swallowed after tool use, or some models swallow the first assistant reply.
2. Tool use regressed from "poor argument quality" to "tool use unavailable"; multi-turn requests can lose tool definitions.
3. Replies can contain leaked or garbled angle-bracket protocol fragments.
4. Claude Code cannot use the configured model through the Anthropic compatibility route.

OpenCode is the default verification client. Claude Code compatibility is important but lower priority until the OpenAI-compatible path is stable.

Do not store real API tokens, cookies, or pasted user secrets in fixtures, specs, logs, or committed examples.

## Priority Order

### P0: Swallowed Replies

Fix first. A request must never complete as a successful empty assistant response unless the selected contract explicitly allows intentional silence.

Known variants:

- After a tool call, the next assistant reply is swallowed.
- A model's first assistant message is empty even when no tool call has happened yet.
- Streaming emits a `tool_calls` finish, then later content is dropped without a diagnostic path.
- Non-streaming returns `content: ""`, `content: null`, missing `message`, or an empty `choices` shape and is treated as success.

Required behavior:

- Empty output must become a typed diagnostic outcome, not a silent success.
- If the provider returns no usable assistant text and no usable tool calls, return a UI/client-safe error for strict agent contracts.
- If the response contains validated tool calls, it counts as non-empty output.
- If the provider emits post-tool-call residue in the same assistant turn, suppress it as malformed provider output and end with `finish_reason: "tool_calls"`.
- If an empty first reply happens on a provider/model, capture the raw provider status and normalized Chat2API response in diagnostics.

Implementation focus:

- `src/main/proxy/toolCalling/outputInspection.ts`
- `src/main/proxy/forwarder.ts`
- provider adapters under `src/main/proxy/adapters/`
- stream finalization paths in `ToolStreamParser` and Qwen/GLM/Qwen AI adapters

Regression tests to add or keep:

- Non-stream empty content with strict contract fails with `provider_empty`.
- Non-stream validated `tool_calls` passes even with `content: null`.
- Stream with no content and no tool calls fails or emits a diagnostic error rather than `[DONE]` only.
- First provider chunk is whitespace only, followed by real content: real content must still be emitted.
- First provider chunk is whitespace only, followed by finish: strict agent contract must fail.
- Tool-call response followed by later plain text chunk: no text escapes after `tool_calls`.

### P1: Tool Use And MCP Reliability

Tool definitions must be stable across multi-turn agent workflows. Tool use quality problems should be fixed by schema validation, structural parsing, and prompt/history boundaries, not by adding duplicate prompt injection in provider adapters.

Required behavior:

- `ToolCallingEngine` remains the sole owner of managed tool prompt injection.
- Provider adapters must not import or reimplement prompt injection helpers.
- Tool catalog resolution must follow:

```text
Session Store -> Message History Extraction -> Request Tools -> Safe Empty
```

- A session catalog, when present, must preserve the full tool set across later turns.
- History-only fallback may recover observed tools, but must not pretend it knows unobserved schemas.
- Managed XML is the canonical protocol for GLM, Qwen, and Qwen AI unless a provider profile explicitly says otherwise.
- Valid managed XML tool calls convert to OpenAI `tool_calls` in both stream and non-stream paths.
- Invalid, unknown, malformed, incomplete, fenced, or wrong-protocol tool blocks must not become tool calls.
- Object and array parameters must be valid JSON values for their schema before OpenAI `function.arguments` are assembled.
- MCP tools are not special-cased by name. They must pass through the same catalog, validation, assembly, and multi-turn preservation path as built-in OpenCode tools.

Implementation focus:

- `src/main/proxy/toolCalling/ToolCallingEngine.ts`
- `src/main/proxy/toolCalling/ToolStreamParser.ts`
- `src/main/proxy/toolCalling/runtimePlan.ts`
- `src/main/proxy/sessionManager.ts`
- `src/main/proxy/toolRuntime/data/`
- `src/main/proxy/adapters/qwen.ts`
- `src/main/proxy/adapters/glm.ts`
- `src/main/proxy/adapters/qwen-ai.ts`

Regression tests to add or keep:

- Same-session multi-turn request keeps the full tool catalog after a tool result.
- History-only fallback recovers only observed tool names and uses safe degraded schemas.
- Assistant `tool_calls` and tool `tool_call_id` survive context processing.
- MCP-style tool names with namespace separators survive prompt rendering, parsing, validation, and assembly.
- Required parameter omission is rejected in streaming and non-streaming.
- Object/array schema parameters reject scalar text and assemble valid JSON as JSON values, not stringified JSON.
- OpenCode probe proves skill invocation plus at least two non-skill tools, with one tool call after a tool result.

### P2: Angle-Bracket And Garbled Reply Leakage

Angle brackets are valid user/model text. Protocol markers are not valid user-visible assistant text once a managed tool protocol is active.

Required behavior:

- Ordinary text like `<tag>value</tag>`, `<<<<<>>>>>`, XML examples, escaped tags, and JSON-looking text remains ordinary text.
- CDATA arguments preserve literal `<`, `>`, newlines, fake XML, JSON strings, and protocol-looking substrings.
- Fenced examples are never parsed as live tool calls.
- Partial markers such as `<|CHAT2API|tool_calls`, `|tool_calls>`, or provider-sliced closing tags must not leak to clients.
- Qwen cumulative snapshot rewrites must not be diffed by length alone.

Implementation focus:

- `src/main/proxy/toolCalling/ToolStreamParser.ts`
- `src/main/proxy/toolRuntime/data/stream/StreamGate.ts`
- `src/main/proxy/toolRuntime/data/protocols/managedXmlStructure.ts`
- Qwen stream diffing in `src/main/proxy/adapters/qwen.ts`

Regression tests to add or keep:

- Ordinary XML-like text does not start tool buffering.
- Fenced tool-call examples remain content.
- CDATA with fake XML and protocol-looking text round-trips.
- Partial managed marker followed by flush does not emit marker text.
- Qwen cumulative snapshot rewrite does not emit suffix residue.
- Text after streamed tool call is suppressed with diagnostics.

### P3: Claude Code Anthropic Compatibility

Claude Code uses the Anthropic Messages API, while Chat2API primarily normalizes OpenAI-compatible chat completions. The Anthropic route must map Claude Code requests into the same stable OpenAI-compatible tool runtime without losing model mappings or tool semantics.

Observed user config shape:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8081/v1",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "qwen/Qwen3.7-Max",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "GLM-5.2",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4-pro"
  },
  "model": "sonnet"
}
```

Observed Claude Code error:

```text
There's an issue with the selected model (qwen/Qwen3.7-Max). It may not exist or you may not have access to it. Run /model to pick a different model.
```

Do not assume this is only a provider access failure. It can also be caused by Anthropic compatibility gaps, model-name mapping differences, unsupported `/v1/models` discovery, request validation, or stream event shape differences.

Required behavior:

- `/v1/messages` and `/anthropic/v1/messages` accept Claude Code requests.
- Anthropic `tools` convert to OpenAI `tools` without losing `input_schema`.
- Anthropic `tool_use` and `tool_result` history convert to OpenAI assistant `tool_calls` and `tool` messages, not plain text placeholders.
- OpenAI `tool_calls` convert back to Anthropic `tool_use` blocks.
- Streaming emits valid Anthropic event order:

```text
message_start
content_block_start
content_block_delta*
content_block_stop
message_delta
message_stop
```

- Tool-use streaming emits `tool_use` blocks with valid `input_json_delta`.
- Model aliases used by Claude Code resolve through the same model mapping/load-balancer path as OpenAI requests.
- If a model is unavailable, the error should name the Chat2API selection failure precisely: no provider, no account, auth failure, provider 404, or adapter error.

Implementation focus:

- `src/main/proxy/routes/anthropic.ts`
- `src/main/proxy/modelMapper.ts`
- `src/main/proxy/loadbalancer.ts`
- `src/main/proxy/utils/toolFormatConverter.ts`
- provider adapters that receive Anthropic-originated OpenAI-normalized requests

Regression tests to add:

- Anthropic text request maps to OpenAI request and back.
- Anthropic `tools` preserve schema.
- Anthropic `tool_use` history maps to assistant `tool_calls`.
- Anthropic `tool_result` maps to OpenAI `tool` message with matching `tool_call_id`.
- OpenAI tool-call response maps to Anthropic `stop_reason: "tool_use"`.
- Claude Code model alias request for `qwen/Qwen3.7-Max` reaches the model mapper and returns a typed selection/provider error, not a generic malformed response.

## Provider-Specific Work Items

### Qwen Domestic

Qwen is the highest-risk provider for agent workflows.

Known root causes from prior investigation:

- Stream handler uses length-only diffs on cumulative provider snapshots.
- Stream parser allows later content after a tool call.
- Prompt/history formatting collapses roles into one user text block.

Required fixes:

- Replace length-only diffing with prefix-aware snapshot handling.
- If a snapshot rewrite occurs, do not emit suffix residue; re-evaluate the full managed buffer or wait for final content.
- Preserve clearer boundaries between system contract, assistant tool calls, tool results, and latest user text.
- Add realistic Qwen stream tests using mixed `text/plain`, `multi_load/iframe`, cumulative snapshots, rewrites, and split markers.

### GLM

GLM is currently the primary probe target. It must remain green while fixing Qwen.

Required fixes:

- Keep managed XML validation and non-stream parsing behavior.
- Run deterministic tests before and after any GLM adapter change.
- Run the OpenCode probe with `glm/GLM-5.2` as the default final gate.

### Qwen AI

Treat Qwen AI failures separately until server/provider logs prove they are tool-runtime failures.

Required fixes:

- Capture provider status, response body, retry behavior, and adapter headers in safe diagnostics.
- Do not classify generic provider 500s as parser bugs.
- Add route-level tests for retry response handling and normalized error messages.

### DeepSeek

DeepSeek is a regression sentinel.

Required fixes:

- Keep existing passing probe behavior intact.
- Include one DeepSeek model in post-fix smoke probes when changes touch shared runtime.

## Diagnostics Requirements

Every strict agent request should produce enough local evidence to classify a failure without re-running blindly:

- request id
- provider id
- requested model and actual model
- client adapter id
- protocol
- tool count
- tool catalog source
- whether prompt injection happened
- stream/non-stream mode
- terminal outcome:

```text
content
tool_calls
provider_empty
malformed_tool_output
unknown_tool
schema_validation_failed
provider_error
selection_error
client_transform_error
```

Diagnostics must be safe:

- Do not log auth tokens, cookies, or full secrets.
- Raw provider snippets may be truncated and redacted.
- Tool arguments may be logged only in deterministic tests or explicitly redacted debug files.

## Required Gates

### Deterministic Regression Gate

Run before any real model probe:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

Also run relevant runtime data tests when changing validation, assembly, protocol adapters, or response mapping:

```powershell
node --test tests/tool-runtime/data/*.test.ts tests/tool-runtime/integration/*.test.ts tests/tool-runtime/control/*.test.ts
```

### OpenCode Model Probe Gate

Start the app:

```powershell
npm run dev:win 2>&1 | Tee-Object -FilePath .\dev.log
```

Run the default probe:

```powershell
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "glm/GLM-5.2"
```

For Qwen-specific work, also run:

```powershell
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "qwen/Qwen3.7-Max"
```

If Qwen remains red but GLM is green, the result may be accepted only when:

- deterministic Qwen regression tests prove the fixed bug class is covered;
- the remaining failure has a separate provider-specific diagnostic event;
- the final status explicitly says Qwen remains blocked or degraded.

### Claude Code Compatibility Gate

Run only after P0-P2 are green for OpenCode.

Minimum manual smoke:

```powershell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8081/v1"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL="qwen/Qwen3.7-Max"
claude
```

Expected:

- Claude Code can start a conversation without generic model-not-found messaging when Chat2API has a matching provider/account.
- If the provider is unavailable, the error is specific and attributable.
- A tool-using Claude Code request produces valid Anthropic `tool_use` and `tool_result` turns.

## Non-Goals

- Do not add provider-adapter prompt injection to paper over runtime bugs.
- Do not delete legacy tool/message processing code without proving equivalent coverage.
- Do not parse every angle-bracket block as a tool call.
- Do not rely on final assistant text alone as proof of tool capability.
- Do not make Qwen pass by weakening OpenCode probe requirements.
- Do not commit user tokens or real provider cookies.

## Done Criteria

This repair track is done when all of the following are true:

- P0 empty/swallowed responses have deterministic tests and typed diagnostics.
- P1 multi-turn tool and MCP catalog preservation passes deterministic tests.
- P2 angle-bracket leakage and partial marker cases pass deterministic tests.
- GLM OpenCode probe passes with `CAPABILITY_PROBE_PASS`.
- Qwen either passes the OpenCode probe or has a documented provider-specific remaining failure with deterministic coverage for the fixed runtime layer.
- Claude Code can use `/v1/messages` through Chat2API for text and tool-use flows, or failures are classified by precise compatibility diagnostics.
- No new code violates the tool injection invariants in `AGENTS.md`.
