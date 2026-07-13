# Qwen Provider Session Continuity Spec

Date: 2026-07-13
Branch: codex/qwen-provider-session-continuity
Baseline commit: 3f16737 `milestone: qwen simple-context tool calling baseline`

## Problem

Qwen can execute simple managed-tool tasks, but Chat2API currently creates a fresh Qwen web session for each request. The Qwen web API live probe proved that reusing `session_id` lets Qwen remember prior turns, while a fresh `session_id` cannot.

Current Qwen request assembly still flattens all OpenAI messages into one web-chat `text/plain` message. That works for short contexts but forces Chat2API to carry all memory in prompt text, causing long-context degradation.

## Evidence

Probe: `scripts/probes/qwen-session-memory-probe.mjs`

Observed result:

- Turn 1: new `session_id`, model acknowledges a nonce.
- Turn 2: same `session_id`, previous `reqid` as `parent_req_id`, model recalls nonce.
- Variant: same `session_id`, `parent_req_id = "0"`, model still recalls nonce.
- Control: new `session_id`, model cannot recall nonce.

Conclusion: Qwen provider-side session memory is usable. `session_id` is the minimum continuity key; `parent_req_id` should still be preserved for message-tree correctness.

## Goals

1. Reuse Qwen provider sessions across Chat2API turns.
2. Preserve the current simple-context baseline as fallback.
3. Keep tool-calling invariants intact: `ToolCallingEngine` remains sole prompt owner.
4. Add deterministic tests before relying on live probes.
5. Make each work node small enough to review and compact.

## Non-Goals

- No UI settings in the first implementation node.
- No immediate replacement of context management.
- No immediate prompt delta optimization for Qwen assembly path.
- No broad refactor of all provider adapters.

## Architecture

### State

Extend shared `ConversationState` to support Qwen:

- `qwenSessionId?: string`
- `qwenParentReqId?: string`

Use existing `getProviderConversationState` / `setProviderConversationState` and the same keying strategy as GLM/DeepSeek:

- primary: provider + account + model + user/session dimension
- fallback: tool catalog session key when managed tool history is present

### Request Shape

Change Qwen adapter request input to optionally accept:

- `sessionId?: string`
- `parentReqId?: string`

For a fresh turn:

- generate `session_id`
- use `parent_req_id = "0"`
- use `scene_param = "first_turn"`

For a continued provider session:

- reuse stored `session_id`
- use stored `qwenParentReqId` when available, otherwise `"0"`
- use `scene_param = "chat"`

The first implementation may still send the flattened current prompt history. That is deliberately redundant but safer; provider memory should help, while existing Chat2API history remains a fallback.

### Response Capture

`QwenStreamHandler` already captures:

- `communication.sessionid`
- `communication.reqid`

Expose both after stream/non-stream completion:

- `getSessionId()`
- `getResponseId()` or `getParentReqId()`

Forwarder stores them on stream end and after non-stream completion.

## Work Nodes

### Node 1: Minimal Session Continuity

Planning timebox: 15-20 minutes
Execution timebox: 25-40 minutes

Owner: worker subagent

Files:

- `src/main/proxy/adapters/qwen.ts`
- `src/main/proxy/forwarder.ts`
- `tests/providers/qwen-session-continuity.test.ts` or nearby provider tests

Acceptance:

- Qwen adapter can build request bodies with caller-supplied `sessionId` and `parentReqId`.
- `parent_req_id` is no longer hardcoded in the continued-session path.
- `forwardQwen` reads and writes Qwen conversation state.
- Streaming path stores state when stream ends.
- Non-stream path stores state after parsing.
- Deterministic tests prove the request body and forwarder source/behavior.

Checkpoint compression:

- Worker final answer must include changed files, test commands, and a 10-line max state summary.
- Main agent summarizes accepted changes and next risks in 10 lines max before Node 2.

### Node 2: Assembly Summary and Prompt Safety

Planning timebox: 15 minutes
Execution timebox: 25-35 minutes

Owner: worker subagent after Node 1 review

Files:

- `src/main/proxy/RequestAssembly.ts`
- `src/main/proxy/forwarder.ts`
- `src/main/proxy/adapters/qwen.ts`
- `tests/providers/qwen-request-routing.test.ts`

Acceptance:

- Qwen assembly path does not drop context summary system messages.
- Tool manifest remains authoritative and after summary.
- Tests fail if summary is omitted from assembly path.

### Node 3: Qwen Delta Prompt Mode

Planning timebox: 20 minutes
Execution timebox: 40-60 minutes

Owner: worker subagent only after Node 1 live/proxy behavior is validated

Acceptance:

- When provider session exists, Qwen sends only the new user/tool delta needed since the previous assistant tool turn.
- Full-history prompt remains fallback when no provider session exists.
- Long tool results are not duplicated across provider memory and prompt history.

### Node 4: Live Probe and Regression Gate

Planning timebox: 10-15 minutes
Execution timebox: 20-30 minutes

Owner: main agent review plus optional worker verification

Acceptance:

- Deterministic tests pass.
- `qwen-session-memory-probe.mjs` still passes.
- A proxy-level two-turn request confirms Chat2API reuses Qwen session state.

## Risks

- Qwen may keep memory by `session_id` but still use `parent_req_id` for branching; preserve both.
- Delete-after-chat config can erase provider state; state saving must respect deletion behavior.
- Assembly path currently flattens history; session continuity should not be used as an excuse to remove prompt fallback too early.
- Existing `.claude/worktrees/tool-contract-refactor` has internal untracked `.agent-probe/`; do not delete it without user approval.

## Delegation Rules

- Main agent owns spec, review, integration decisions, and checkpoint summaries.
- Worker owns only assigned code files for each node.
- Worker must use model `gpt-5.4` and low reasoning.
- Worker must not revert unrelated changes.
- Worker must compress final state after each node.
