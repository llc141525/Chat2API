# MCP Client Integration Design

**Date:** 2026-07-01
**Status:** Approved
**Scope:** Chat2API as MCP Client with auto tool loop for AI agents (OpenCode and other tool-using clients)

## Problem

Chat2API currently acts as a transparent relay: tools come from the client, get rendered into managed XML prompts, and model responses are parsed back to OpenAI format. There is no local tool execution capability. AI agents cannot use external MCP Server tools (filesystem, database, web-search) through Chat2API.

## Solution

Integrate `@modelcontextprotocol/sdk` as an MCP Client inside Chat2API's Electron main process. MCP tools are executed locally by Chat2API, with results injected back into the conversation context automatically. The client sees standard OpenAI tool_calls and remains unaware of MCP internals.

## Architecture

### Module Boundary Principles

1. **Orchestrator is the single tool loop owner.** It owns catalog state, drift detection, session management, and loop termination decisions.
2. **Engine is a stateless protocol codec.** It receives resolved tools + messages as input, outputs injected messages or structural parse events. It holds no catalog state, performs no validation, and makes no semantic decisions.
3. **Engine outputs structural events only.** `ParsedToolCall { name, arguments, rawText }` means "the model emitted this structured text." It does not mean the tool exists, the arguments are valid, or execution should proceed.
4. **Orchestrator owns all semantic interpretation.** It validates structural events against the catalog, routes to executors, handles availability drift, and decides retry/terminate.
5. **Forwarder is pure transport.** It receives a complete request and returns a raw response. It has no knowledge of the tool loop.
6. **MCP Client Manager is pure connection management.** It exposes `listTools()` and `callTool()` only. It knows nothing about prompts, engines, or forwarders.

### Module Map



### Data Flow



### Forwarder → Orchestrator Calling Path

The Forwarder remains pure transport and does **not** call the Orchestrator directly. A new thin layer `ProxyRequestHandler` (sits between the HTTP server entry point and the Forwarder) owns the Orchestrator instance and drives the loop:



**Why not direct Forwarder → Orchestrator delegation:**

- Forwarder is currently "pure transport" per AGENTS.md; injecting loop logic would violate INV-001's separation spirit.
- Forwarder handles streaming/non-streaming SSE transport concerns; mixing in catalog/loop state would couple unrelated concerns.
- `ProxyRequestHandler` is the single entry point that already exists conceptually (the request router); promoting it to a named class makes the orchestration boundary explicit.

**Migration path:**

1. Extract current request-handling logic from `forwarder.ts` into `ProxyRequestHandler` (no behavior change).
2. Add Orchestrator instantiation in `ProxyRequestHandler`.
3. Forwarder keeps its current signature, called by Orchestrator via `ProxyRequestHandler`.

### Configuration

Stored in `AppConfig.mcpServers`:



UI: New MCP Server management panel in settings, supporting add/remove/edit/test-connection.

### Tool Naming Convention

MCP tools are namespaced to avoid collisions with client-provided tools:



Rules:

- `serverName`: alphanumeric + hyphen/underscore only
- `originalToolName`: preserve original case
- Double underscore separator: `mcp__` prefix, `__` between server and tool

Examples:

- filesystem server → `mcp__filesystem__read_file`
- web-search server → `mcp__web-search__search`
- Custom server "my-tools" → `mcp__my-tools__custom_action`

Routing map in Orchestrator:



### Loop Termination Conditions

1. Model response contains no tool_calls → return response
2. Iteration count exceeds configurable `maxToolLoopIterations` (default 20) → return last response with warning
3. All tool_calls in a turn are client-passthrough (no MCP tools) → return response to client
4. Unrecoverable executor error → return error response

### Error Handling

- MCP Server connection failure: log error, exclude that server's tools from catalog, continue with remaining tools
- Tool execution timeout: configurable per-server timeout (default 30s), return error as tool result message
- Malformed tool_call from model: Engine emits structural event, Orchestrator fails validation, injects clarification message and retries once
- MCP Server crash mid-loop: detect broken pipe, attempt reconnect, if failed treat as connection failure above

### MCP Server Crash Recovery

MCP Servers run as child processes spawned via stdio; crashes are expected and must be handled gracefully.

**Detection signals:**

1. Child process `exit` event fires unexpectedly (non-zero code or null)
2. `callTool()` / `listTools()` throws `ERR_STREAM_DESTROYED` or times out
3. JSON-RPC response contains an error code indicating transport failure

**Recovery strategy (exponential backoff):**



**Per-attempt behavior:**

1. Spawn new child process with original `command` / `args` / `env`
2. Send `initialize` JSON-RPC handshake
3. Call `tools/list` to refresh catalog
4. If all succeed → mark server as `available`, resume loop
5. If any step fails → log and increment backoff

**Loop-level behavior during recovery:**

- **During an active tool loop:** Orchestrator pauses loop, attempts recovery. If recovery succeeds within max attempts, resume loop with refreshed tool list. If recovery fails, mark affected tools as unavailable, inject error message as tool result, continue loop with remaining tools.
- **Between requests:** Recovery runs lazily on next `listTools()` call. No background polling to avoid CPU waste.
- **Catalog drift:** After recovery, `listTools()` may return a different tool set (server was restarted with different config). Orchestrator must refresh the routing map and log the diff.

**Circuit breaker:**

- 3 consecutive crash-recovery failures within 60s → server marked `circuitOpen` for 5 minutes
- During `circuitOpen`, `listTools()` returns empty, `callTool()` returns immediate error without spawn attempt
- UI shows server status as "Circuit Open (retry in X min)"

### Streaming Behavior

When the model streams a response containing MCP tool_calls:

1. Stream content chunks before tool markers to the client normally
2. Buffer tool call markers until complete parse
3. Execute MCP tools after stream completes
4. Re-request model with tool results
5. Stream the follow-up response to the client

The client sees multiple streaming segments separated by tool execution pauses. This matches how native tool calling works in OpenAI's API.

### SSE Protocol Details

Chat2API must emit SSE frames that match OpenAI's streaming format so existing OpenAI-compatible clients (including OpenCode) work without modification.

**Frame structure (per OpenAI spec):**



**MCP loop streaming lifecycle:**



**Critical compatibility rules:**

1. **`finish_reason="tool_calls"` on the final chunk of a segment** signals the client to expect tool execution. OpenAI's official clients treat this as the end of one round.
2. **Do not send `[DONE]` between segments.** Only one `[DONE]` per request, at the very end. Sending `[DONE]` mid-loop causes OpenAI SDK clients to close the stream prematurely.
3. **Keep-alive comments** (`: keep-alive\n\n`) must be sent every 15s during tool execution to prevent client/proxy idle timeouts (default SSE idle is 30s on most clients).
4. **`tool_calls[].id` must be stable** across segments — the same `call_xxx` ID used in segment 1's delta must match the `tool_call_id` referenced when results are injected for segment 2.
5. **For client-passthrough tools (non-MCP):** emit the segment normally with `finish_reason="tool_calls"` then `[DONE]`, and let the client execute. Do not loop.
6. **Argument streaming:** arguments may arrive across multiple delta chunks (OpenAI spec). Engine's stream parser must buffer until the JSON is complete before handing to Orchestrator.

**Client compatibility test matrix:**

| Client | Tested versions | Notes |
|---|---|---|
| OpenCode | latest | Primary target, uses OpenAI SDK |
| OpenAI Node SDK | v4.x | Reference implementation |
| LangChain | v0.2+ | Common wrapper |
| curl | manual | Protocol-level verification |

### Key Risks and Mitigations

**Risk 1: SSE 多段流 [DONE] 语义误用**

- **风险**: 工具循环中误发 `[DONE]` 导致 OpenAI SDK 客户端提前关闭流,后续 tool_calls 段丢失
- **触发条件**: 每个 tool_calls 段结束误加 `[DONE]`;或 keep-alive 期间误判为结束
- **缓解**:
  - 单次请求只发送一个 `[DONE]`,位于最终 `stop` 段之后
  - 工具执行期间发送 keep-alive 注释 (`: keep-alive\n\n`) 每 15 秒一次
  - 集成测试: 用 OpenAI Node SDK v4.x 抓包验证,断言整个流只有一个 `[DONE]`

**Risk 2: 熔断器状态丢失**

- **风险**: Chat2API 重启后熔断状态清零,刚崩溃过的 MCP Server 立即被尝试拉起,引发雪崩
- **触发条件**: App 崩溃/重启后,`circuitOpen` 状态未持久化
- **缓解**:
  - 熔断状态写入 `AppConfig.mcpServers[name].circuitState` (in-memory + 定时落盘)
  - 重启后读取,若 `circuitOpen` 且冷却时间未过,跳过自动拉起,UI 提示用户手动重置
  - 记录最近崩溃时间戳,避免重启后立即重试

**Risk 3: 退避重连期间工具调用缓存策略缺失**

- **风险**: MCP Server 重连期间,Orchestrator 缓存的 tool list 已过期但仍在用,导致调用不存在的工具或参数 schema 不匹配
- **触发条件**: Server 在重连后更新了 tool list (新增/删除/改 schema),Orchestrator 未刷新 routing map
- **缓解**:
  - 重连成功后强制调用 `tools/list` 刷新 catalog,routing map 重置
  - 重连期间对 in-flight tool_calls 返回临时错误 `SERVER_RECONNECTING`,注入 tool result message 让模型重试
  - 对比新旧 tool list,记录 diff 到日志;schema 变化的工具标记为 `drifted`,下次调用前重新校验
  - 设置最长重连窗口 (默认 30s),超时后该 server 工具全部标记 `unavailable`,走 INV-002 fallback

### Invariant Compatibility

**INV-001 (Single Ownership):**

- `ToolCallingEngine` retains `transformRequestForPromptToolUse()` and all prompt injection logic (`hasToolPromptInjected`, `toolsToSystemPrompt`, `TOOL_WRAP_HINT`, `shouldInjectToolPrompt`).
- Orchestrator does **not** import or call these symbols; it provides resolved tools + messages to `Engine.render()` and receives structural events back.
- Provider adapters continue to be forbidden from importing prompt injection symbols.

**INV-002 (Stateless Fallback):**

MCP tool resolution must degrade gracefully when Session Store is unavailable:



Returning an empty tool list without attempting `listTools()` is forbidden.

**INV-003 (Delete = Risk):**

Migration of catalog/drift logic from Engine to Orchestrator is a relocation, not a deletion. PR description must declare:

- Original location: `ToolCallingEngine` (prompt + catalog intertwined)
- New location: `ToolLoopOrchestrator` (catalog only), `ToolCallingEngine` (prompt only)
- Equivalent coverage proof: regression test suite passes unchanged + new orchestrator tests pass

**INV-004 (Client Quirks Matrix):**

All MCP-related tool-calling changes must be verified against the known client quirks list, plus:

- OpenCode's behavior when receiving `finish_reason="tool_calls"` followed by keep-alive comments (does it wait or close?)
- OpenAI SDK's handling of multiple `finish_reason="tool_calls"` segments in one stream (must not panic)
- LangChain's tool_call_id matching across segments

### Migration Plan for Existing Code

1. Extract `catalog.ts` (session store) and drift logic into `ToolLoopOrchestrator`
2. Refactor `ToolCallingEngine.transformRequestForPromptToolUse()` → `Engine.render(tools, messages)` (pure function)
3. Refactor `ToolCallingEngine.applyNonStreamResponse()` → `Engine.parse(response)` (returns structural events)
4. Move allowed_tools validation from Engine to Orchestrator
5. Move availability drift detection from Engine to Orchestrator
6. Add `ProxyRequestHandler` layer between HTTP server entry and Forwarder; Orchestrator lives here
7. Update `forwarder.ts` to be called by `ProxyRequestHandler` (remains pure transport, no direct Orchestrator dependency)
8. Add `@modelcontextprotocol/sdk` dependency
9. Implement `McpClientManager`, `McpToolExecutor`, `ToolLoopOrchestrator`
10. Extend store types and UI for MCP server configuration

### Testing Strategy

**Deterministic tests (no MCP Server needed):**

- Orchestrator correctly merges MCP + client tools
- Orchestrator detects drift and blocks invalid requests
- Engine renders/parses without holding state
- Structural events are validated against catalog
- Loop terminates on all four conditions
- Tool naming collision detection

**MCP-specific deterministic tests:**



**Integration tests (with test MCP Server):**

- End-to-end: OpenCode request → MCP tool execution → model response with tool result
- Multi-turn loop: model calls tool A, then tool B, then produces final answer
- Server crash recovery during active loop
- Timeout handling

**Existing regression tests must continue passing:**

- All tests in `tests/tool-calling/*.test.ts`
- GLM tool calling tests
- Context tool metadata tests
- Qwen request routing tests

**Final Gate alignment (per AGENTS.md):**

Deterministic layer command (extended):



OpenCode Model Probe layer: existing probe does not exercise MCP path. A separate `mcp-probe` scenario must be added to `tests/agent-capability/` that:

1. Configures a test stdio MCP server (e.g., filesystem on temp dir)
2. Sends an OpenCode request requiring MCP tool use
3. Asserts the event stream contains at least one `mcp__*` tool call + result pair
4. Asserts multi-turn loop (tool result → follow-up model output)
5. Asserts single `[DONE]` in SSE stream

### Out of Scope

- SSE / Streamable HTTP transport (stdio only for v1)
- Remote MCP Server support
- MCP resources and prompts (tools only)
- Dynamic per-request MCP server selection
- Tool execution sandboxing beyond process isolation
- OAuth-authenticated MCP servers
- Server-side tool result caching