# Mainstream Agent Long-Task Stability Specification

**Status:** Proposed  
**Date:** 2026-07-20  
**Scope:** Provider proxy compatibility and long-running tool-use sessions

## 1. Objective

Ensure that mainstream Agent clients can use Chat2API for long-running tasks without losing task state, tool availability, tool-call pairing, or provider-session continuity after multiple turns and context compaction.

The project remains an Agent-aware multi-provider API proxy. This specification does not turn it into a general-purpose Agent Harness.

## 2. Success Definition

A supported client/provider combination is considered stable when it can complete this workflow:

```text
user task
→ first tool call
→ tool result
→ multiple tool turns
→ context compaction
→ continued tool call
→ child task/handoff when applicable
→ final answer
```

After compaction, the model must still know:

- the original user goal;
- completed and incomplete work;
- the current workflow step and next action;
- available tools and their current names;
- the relationship between assistant `tool_calls` and tool `tool_call_id` results;
- the correct provider session and parent/child relationship.

## 3. Initial Support Matrix

The first acceptance matrix is intentionally small:

| Client family | Initial providers | Required modes |
|---|---|---|
| OpenCode | Qwen, GLM, DeepSeek | streaming and non-streaming |
| Cline or KiloCode | Qwen, GLM | streaming and non-streaming |
| Cherry Studio | one primary managed-tool provider | streaming and non-streaming |

The exact client choice for the second row may be adjusted based on actual usage. New clients or providers must not be added to the acceptance matrix without a concrete compatibility need.

## 4. Functional Requirements

### FR-1: Tool-call continuity

- A valid tool call must be exposed as OpenAI-compatible `tool_calls`.
- A following tool result must preserve its exact `tool_call_id`.
- A request without a new `tools` field must still be able to continue an existing tool workflow when the session catalog is valid.
- Streaming and non-streaming responses must produce equivalent tool-call semantics.
- Ordinary XML, Markdown examples, fenced code, escaped tags, malformed blocks, and unknown tool names must not become tool calls.

### FR-2: Compaction continuity

- Tool exchanges must remain structurally paired during sliding-window or summary processing.
- Runtime configuration and historical tool catalogs must not be narrated into summaries.
- Active tool workflows must not be sent through an ordinary summary path that loses the active exchange.
- Summary failure, contamination, or unusable output must use a bounded fallback.
- A server-summary boundary must create a fresh provider session only when required.
- Subsequent turns in the same summary epoch must reuse that provider session.

### FR-3: Child-session continuity

- Tool-child and subagent-child boundaries must carry a bounded handoff.
- The parent must be able to consume the handoff without losing its provider session identity.
- Child provider sessions must be deleted or otherwise finalized when the workflow ends.
- A child session must not silently overwrite unrelated parent state.

### FR-4: Provider routing

- Provider-specific adapters may retain provider-specific request and response logic.
- `ToolCallingEngine` remains the sole owner of managed tool prompt injection and response parsing decisions.
- `RequestAssembly` and `ProviderRuntime` remain the main-path boundaries; no new global orchestration layer is required.
- Native versus managed tool support must be declared accurately in the provider capability profile.

## 5. Observability Requirements

The current Logger, NDJSON output, runtime traces, and `extract-session-log.ps1` remain the observability foundation. Do not replace them with a new logging architecture.

Each major request event should be correlatable by the same request identifier:

```text
request
→ context processing
→ tool transform
→ request assembly
→ session boundary
→ provider request
→ provider response
→ tool parser
→ state write
```

The trace must make these facts observable:

- raw and final message counts;
- raw and final prompt character counts;
- summary result and fallback kind;
- boundary reason;
- provider session action;
- provider session ID source;
- tool plan/protocol/catalog source;
- malformed-output retry;
- child-session cleanup;
- provider response boundary and parse result.

If a failure cannot be distinguished using the existing trace, add the smallest missing field to the existing event. Do not introduce a new abstraction solely for logging.

## 6. Acceptance Tests

Each supported matrix row must pass the following scenarios:

1. Initial request with tools.
2. Assistant tool call followed by one tool result.
3. Multiple sequential tool calls.
4. Follow-up request where the client omits the `tools` field.
5. Streaming tool-call response.
6. Non-streaming tool-call response.
7. Client compact followed by another tool call.
8. Server summary followed by another tool call.
9. Active tool workflow crossing a summary boundary.
10. Malformed tool output with exactly one bounded recovery attempt.
11. Unknown tool output without accidental execution.
12. Child session handoff and cleanup.
13. Provider session reuse across subsequent turns.
14. Provider session restart after the required boundary.
15. No raw managed protocol leakage in ordinary assistant text.

The live probe must produce a session report from `scripts/extract-session-log.ps1`. A passing test is not sufficient if the resulting timeline cannot explain the provider session, context transformation, and tool decision.

## 7. Priorities

### P0: Long-task golden path

- Freeze the initial client/provider matrix.
- Run and stabilize the full multi-turn probe.
- Verify compaction, tool continuity, provider session epochs, child handoff, and cleanup.
- Fix only root causes demonstrated by logs and request/response evidence.

### P1: Reliability hardening

- Close any missing request correlation fields in existing traces.
- Verify all retry paths are bounded and observable.
- Verify provider capability declarations match actual behavior.
- Add regression fixtures for every discovered long-task failure.

### P2: Maintenance

- Identify unused legacy parsers and deprecated prompt helpers.
- Remove them only after proving they have no active callers and adding equivalent coverage where necessary.
- Avoid broad session or context refactors without a reproduced failure.

## 8. Explicit Non-Goals

The following are not required by this specification:

- DeepSeek JSON Output;
- Chat Prefix Completion;
- FIM completion;
- a general token-budget or cost-optimization system;
- a new unified Context Control Plane;
- a general-purpose tool executor;
- a persistent semantic memory system;
- multi-agent scheduling or swarm orchestration;
- replacing provider-specific adapters with one universal adapter.

These features may be added later only when a supported client requires them or a measured stability problem cannot otherwise be solved.

## 9. Decision Rule

For every proposed change, ask:

1. Does it improve a supported client/provider long-task path?
2. Can the improvement be demonstrated with a reproducible probe?
3. Can the resulting behavior be explained from the existing trace?
4. Is the change smaller than introducing another global abstraction?

If the answer to the first two questions is no, the change is outside the current scope.
