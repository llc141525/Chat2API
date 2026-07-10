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

## Scope

Primary files:

- `src/main/proxy/toolCalling/ToolCallingEngine.ts`
- `src/main/proxy/toolCalling/runtimePlan.ts`
- `src/main/proxy/toolCalling/ToolStreamParser.ts`
- `src/main/proxy/sessionManager.ts`
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

## Stop Conditions

Stop and split a follow-up if:

- Fixing Qwen requires provider request format redesign beyond catalog/tool runtime.
- A provider natively supports a better structured tool API and should move to a separate provider profile.
- A compatibility change would violate the single-owner prompt injection invariant.
