<![CDATA[# MCP Client Integration Implementation Plan

**Date:** 2026-07-01
**Status:** Draft
**Design Doc:** `2026-07-01-mcp-client-integration-design.md`

## Overview

This plan implements Chat2API as an MCP Client with automatic tool loop execution for AI agents. The implementation spans 7 phases over approximately 10 days.

## Phase 1: Environment Setup (Day 1)

**Goal:** Set up project structure and dependencies

### Tasks

1. Add `@modelcontextprotocol/sdk` dependency
   

2. Create module structure:
   

3. Extend store types:
   - `src/main/store/types.ts`: Add `AppConfig.mcpServers` interface
   - `src/renderer/src/stores/mcpServers.ts`: UI store for MCP server management

### Verification



---

## Phase 2: McpClientManager (Days 2-3)

**Goal:** Implement MCP client connection management

### Implementation

**File:** `src/main/proxy/mcp/clientManager.ts`

**Key responsibilities:**
- Spawn and manage child processes for MCP servers
- Expose `listTools()` and `callTool()` methods
- Implement crash detection and recovery with exponential backoff
- Implement circuit breaker (3 failures in 60s → open for 5 min)

**Core methods:**



**Recovery strategy table:**

| Attempt | Backoff Delay | Max Attempts | Action on Failure |
|---------|--------------|--------------|-------------------|
| 1 | 1s | 5 | Log error, increment attempt count |
| 2 | 2s | 5 | Log warning, attempt reconnect |
| 3 | 4s | 5 | Log warning, attempt reconnect |
| 4 | 8s | 5 | Log error, mark circuit open |
| 5 | 16s | 5 | Log error, mark circuit open |

### Testing

**Unit tests:** `tests/mcp/clientManager.test.ts`
- Server spawn and initialization
- Tool listing and calling
- Crash detection and recovery
- Circuit breaker behavior

**Run tests:**


### Verification



---

## Phase 3: McpToolExecutor (Day 3)

**Goal:** Implement tool execution with timeout and error handling

### Implementation

**File:** `src/main/proxy/mcp/toolExecutor.ts`

**Key responsibilities:**
- Execute MCP tools via McpClientManager
- Apply per-server timeout (default 30s)
- Normalize tool results to OpenAI format
- Handle execution errors gracefully

**Core interface:**



### Testing

**Unit tests:** `tests/mcp/toolExecutor.test.ts`
- Tool execution success path
- Timeout handling
- Error result normalization
- Malformed tool name handling

**Run tests:**


### Verification



---

## Phase 4: ToolLoopOrchestrator (Days 4-5)

**Goal:** Implement tool loop orchestration with catalog management

### Implementation

**File:** `src/main/proxy/mcp/orchestrator.ts`

**Key responsibilities:**
- Merge MCP tools with client tools
- Detect catalog drift and block invalid requests
- Manage loop iteration and termination
- Handle INV-002 fallback chain

**Core interface:**



**INV-002 fallback chain:**



### Testing

**Unit tests:** `tests/mcp/orchestrator.test.ts`
- Tool merging logic
- Catalog drift detection
- Loop termination conditions
- INV-002 fallback chain
- Tool naming collision detection

**Run tests:**


### Verification



---

## Phase 5: ProxyRequestHandler Layer (Day 5)

**Goal:** Extract request handling and integrate Orchestrator

### Implementation

**File:** `src/main/proxy/proxyRequestHandler.ts`

**Key responsibilities:**
- Extract existing request-handling logic from `forwarder.ts`
- Instantiate ToolLoopOrchestrator
- Drive the tool loop
- Keep Forwarder as pure transport

**Core flow:**



**Migration path:**
1. Extract logic from `forwarder.ts` (no behavior change)
2. Add Orchestrator instantiation
3. Forwarder signature unchanged, called by Orchestrator

### Testing

**Integration tests:** `tests/mcp/proxyRequestHandler.test.ts`
- Request routing with and without tools
- Orchestrator integration
- Forwarder pure transport invariant

**Run tests:**


### Verification



---

## Phase 6: SSE Streaming Protocol (Days 6-7)

**Goal:** Implement SSE streaming with single [DONE] guarantee

### Implementation

**File:** `src/main/proxy/mcp/streamHandler.ts`

**Key responsibilities:**
- Emit SSE frames matching OpenAI format
- Buffer tool call markers until complete parse
- Execute MCP tools after stream completes
- Send keep-alive comments every 15s during tool execution

**SSE Frame structure:**



**Streaming lifecycle:**



**Critical compatibility rules:**
1. `finish_reason="tool_calls"` on final chunk of segment
2. Only one `[DONE]` per request, at very end
3. Keep-alive comments every 15s during tool execution
4. `tool_calls[].id` stable across segments
5. Client-passthrough tools: emit segment normally, let client execute
6. Argument streaming: buffer until JSON complete

### Testing

**Integration tests:** `tests/mcp/streaming.test.ts`
- SSE frame structure validation
- Single [DONE] guarantee
- Keep-alive timing
- Multi-segment loop
- Argument streaming across chunks

**Client compatibility matrix:**

| Client | Tested | Focus |
|--------|--------|-------|
| OpenCode | ✓ | Primary target |
| OpenAI Node SDK v4.x | ✓ | Reference implementation |
| LangChain v0.2+ | ✓ | Wrapper compatibility |
| curl | ✓ | Protocol-level verification |

**Run tests:**


### Verification



---

## Phase 7: End-to-End Testing & Documentation (Days 8-10)

**Goal:** Verify complete system and document usage

### Testing

**Deterministic regression layer:**



**MCP-specific deterministic tests:**



**OpenCode Model Probe layer:**

1. Start the app:


2. Run MCP probe:


**Probe requirements:**
- Event stream contains at least one `mcp__*` tool call + result pair
- Multi-turn loop proven (tool result → follow-up model output)
- Single `[DONE]` in SSE stream
- Circuit breaker recovery tested

### Documentation

**User documentation:**
- How to add MCP servers in settings
- Tool naming convention explanation
- Troubleshooting common issues

**Developer documentation:**
- Module architecture diagram
- Data flow documentation
- INV-001~004 compliance checklist

### Verification



---

## Rollout Plan

### Day 1: Environment Setup
- All developers pull latest code
- Run `npm install` to get new dependencies
- Verify build succeeds

### Day 2-3: Backend Core
- Deploy to development environment
- Run unit tests for MCP modules
- Manual smoke testing with test MCP server

### Day 4-5: Integration Layer
- Deploy to staging environment
- Run integration tests
- OpenCode manual testing

### Day 6-7: Streaming Protocol
- Deploy to staging environment
- Test with all clients in compatibility matrix
- Fix any SSE protocol issues

### Day 8-10: End-to-End & Production
- Run final gate (deterministic + probe)
- Deploy to production
- Monitor logs for circuit breaker triggers
- Collect user feedback

---

## Risks and Mitigations

### Risk 1: SSE [DONE] misuse
- **Mitigation:** Integration test with OpenAI SDK v4.x to verify single [DONE]

### Risk 2: Circuit breaker state loss
- **Mitigation:** Persist circuit state to `AppConfig.mcpServers[name].circuitState`

### Risk 3: Catalog drift during reconnection
- **Mitigation:** Force `tools/list` refresh after successful reconnection

### Risk 4: INV-002 fallback not tested
- **Mitigation:** Unit tests mock Session Store failure and verify fallback chain

---

## Success Criteria

- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] Deterministic regression layer passes
- [ ] OpenCode Model Probe passes with MCP path
- [ ] No TypeScript errors
- [ ] No linting errors
- [ ] Single [DONE] verified in all SSE streams
- [ ] Circuit breaker prevents cascading failures
- [ ] INV-001~004 invariants respected
- [ ] Documentation complete
</arg_value></tool_call>>