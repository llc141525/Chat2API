# P3 Claude Code Compatibility Writing Plan

Date: 2026-07-10
Parent spec: `docs/superpowers/specs/2026-07-10-agent-tooling-stability-spec.md`

## Objective

Make Claude Code work through Chat2API's Anthropic Messages compatibility route after the OpenAI-compatible OpenCode path is stable.

Claude Code is lower priority than swallowed replies and OpenCode tool reliability, but it should use the same stable runtime rather than becoming a parallel implementation.

## User-Visible Symptom

Claude Code reports:

```text
There's an issue with the selected model (qwen/Qwen3.7-Max). It may not exist or you may not have access to it. Run /model to pick a different model.
```

This must not be assumed to mean the provider model is truly unavailable. It can also mean:

- Anthropic route returns an invalid response shape.
- Streaming event order is invalid.
- Model mapping/load-balancer selection failed.
- Tool history was converted to plain text instead of structured tool turns.
- `/v1/messages` compatibility is incomplete.
- `/v1/models` or model discovery behavior expected by Claude Code is missing.

## Scope

Primary files:

- `src/main/proxy/routes/anthropic.ts`
- `src/main/proxy/modelMapper.ts`
- `src/main/proxy/loadbalancer.ts`
- `src/main/proxy/forwarder.ts`
- `src/main/proxy/utils/toolFormatConverter.ts`
- provider adapters receiving Anthropic-normalized OpenAI requests

Primary tests:

- new route-level Anthropic compatibility tests under `tests/`
- existing tool-format converter tests if present
- OpenCode tests remain the prerequisite gate

## Prerequisite

Do not start this plan until P0-P2 are green for OpenCode, at minimum:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

And:

```powershell
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "glm/GLM-5.2"
```

## Writing Sequence

### Step 1: Capture Claude Code Request/Response Shape

Add safe debug logging for Anthropic compatibility requests:

- route path
- model
- stream flag
- tool count
- message count
- whether tool_use/tool_result blocks exist
- selected provider/account/model
- normalized terminal error class

Never log auth tokens or full tool arguments by default.

### Step 2: Fix Anthropic-To-OpenAI Message Conversion

Current compatibility must preserve structure:

- Anthropic text block -> OpenAI text content
- Anthropic `tool_use` block in assistant history -> OpenAI assistant `tool_calls`
- Anthropic `tool_result` block in user history -> OpenAI `tool` message with matching `tool_call_id`
- Anthropic `tools[].input_schema` -> OpenAI `tools[].function.parameters`

Avoid converting tool use and tool results into plain text placeholders because that destroys multi-turn tool semantics.

### Step 3: Fix OpenAI-To-Anthropic Non-Stream Conversion

OpenAI response mapping must produce valid Anthropic Messages API shape:

- text content -> `{ type: "text", text }`
- OpenAI `message.tool_calls[]` -> `{ type: "tool_use", id, name, input }`
- `finish_reason: "tool_calls"` -> `stop_reason: "tool_use"`
- ordinary stop -> `stop_reason: "end_turn"`

If JSON arguments cannot parse into an object, return `{}` and log a diagnostic rather than throwing.

### Step 4: Fix OpenAI-To-Anthropic Stream Conversion

Streaming must emit valid Anthropic event order:

```text
message_start
content_block_start
content_block_delta*
content_block_stop
message_delta
message_stop
```

Tool streaming must emit:

- `content_block_start` with `type: "tool_use"`
- `content_block_delta` with `type: "input_json_delta"`
- `content_block_stop`
- `message_delta.stop_reason: "tool_use"`

Do not close text blocks that were never opened. Do not emit invalid empty content block sequences.

### Step 5: Model Mapping And Discovery

Trace model resolution for:

- `qwen/Qwen3.7-Max`
- `GLM-5.2`
- `deepseek-v4-pro`
- Claude Code aliases such as `sonnet`, `opus`, and `haiku` if they reach the server

The route should report precise failures:

- no provider configured
- no account available
- mapped model missing
- provider auth failure
- provider 404/model access failure
- malformed provider response

If Claude Code requires `/v1/models`, add a compatibility route or document why it is not needed.

### Step 6: Manual Claude Code Smoke

Use sanitized environment examples only:

```powershell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8081/v1"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL="qwen/Qwen3.7-Max"
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1"
claude
```

Do not commit real `ANTHROPIC_AUTH_TOKEN` values.

## Test Plan

Add route or converter tests:

- Anthropic text request maps to OpenAI chat request.
- Anthropic tools preserve `input_schema`.
- Anthropic assistant `tool_use` maps to OpenAI assistant `tool_calls`.
- Anthropic user `tool_result` maps to OpenAI `tool` message.
- OpenAI non-stream `tool_calls` maps to Anthropic `tool_use`.
- OpenAI stream `delta.tool_calls` maps to Anthropic `tool_use` stream events.
- Model selection failures return typed Anthropic errors.

Run:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

Then route-specific Anthropic tests once added.

## Acceptance Criteria

- Claude Code can send a text request through `/v1/messages`.
- Claude Code tool-use history preserves structured tool turns.
- Anthropic stream event order is valid.
- Model mapping failures are specific and actionable.
- OpenCode remains green after Anthropic compatibility changes.

## Stop Conditions

Stop and split a follow-up if:

- Claude Code requires a broader Anthropic API surface beyond `/v1/messages`.
- A provider model is truly unavailable despite correct route behavior.
- Fixing Claude Code would require bypassing the shared OpenAI-compatible tool runtime.

## Acceptance Run: 2026-07-11

Status: **ACCEPTED for the tested Claude Code compatibility surface**.

Deterministic route gate:

```powershell
node --test tests/routes/anthropic-compatibility.test.ts
```

Result: **PASS, 11/11**. Covered text conversion, Anthropic `tools[].input_schema` preservation, assistant `tool_use` to OpenAI `tool_calls`, user `tool_result` to OpenAI `tool` messages, OpenAI non-stream `tool_calls` back to Anthropic `tool_use`, stream event ordering with `input_json_delta`, typed model/provider errors, model discovery routes, qualified provider/model ids, and Claude base URL aliases.

OpenCode prerequisite gate:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

Result: **PASS, 251/251**.

Raw Anthropic Messages HTTP smoke:

```powershell
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8081/v1/messages' ...
```

Result: **PASS**. `qwen/Qwen3.7-Max` returned a valid Anthropic message object with `content: [{ type: "text", text: "CLAUDE_COMPAT_TEXT_OK" }]` and `stop_reason: "end_turn"`.

Claude Code CLI text smoke:

```powershell
claude -p --bare --model 'qwen/Qwen3.7-Max' --tools "" --no-session-persistence --output-format text 'Reply with exactly CLAUDE_CLI_COMPAT_OK'
```

Result: **PASS**. Output was exactly:

```text
CLAUDE_CLI_COMPAT_OK
```

Claude Code CLI tool-use smoke, `Read`:

```powershell
claude -p --bare --verbose --model 'qwen/Qwen3.7-Max' --tools Read --permission-mode bypassPermissions --no-session-persistence --output-format stream-json 'Use the Read tool to read tests/agent-capability/input.txt, then answer only the first line prefixed with FIRST_LINE='
```

Result: **PASS**. The stream showed `tools:["Read"]`, an assistant `tool_use` named `Read`, a user `tool_result` carrying `tests/agent-capability/input.txt`, and final result:

```text
FIRST_LINE=Chat2API Agent Capability Probe
```

Claude Code CLI tool-use smoke, `Bash`:

```powershell
claude -p --bare --verbose --model 'qwen/Qwen3.7-Max' --tools Bash --permission-mode bypassPermissions --no-session-persistence --output-format stream-json 'Use Bash to run: pwd. Then answer only BASH_OK if the command succeeded.'
```

Result: **PASS**. The stream showed `tools:["Bash"]`, an assistant `tool_use` named `Bash`, a user `tool_result` with stdout `/e/Chat2API`, and final result:

```text
BASH_OK
```

Acceptance notes:

- The original user-visible symptom ("selected model may not exist") did not reproduce in the text, HTTP, Read, or Bash smoke tests for `qwen/Qwen3.7-Max`.
- The tested Claude Code tool loop preserves structured `tool_use` / `tool_result` turns through Chat2API instead of flattening them to prose.
- This run did not individually validate every Claude Code built-in or MCP tool name such as `NotebookEdit`, `TaskCreate`, `CronCreate`, or CodeGraph MCP commands. Those depend on the Claude Code client session's enabled tool/MCP configuration. The compatibility claim here is that Chat2API's Anthropic route can carry the tool-use protocol correctly; each optional tool family still needs its own client-side availability check when enabled.
