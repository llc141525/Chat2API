# Context Recovery State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace lossy compaction-only summaries with a session-persisted, event-driven recovery state that preserves long-running tool workflows across repeated compactions and child sessions.

**Architecture:** Keep conversation messages disposable, make a versioned `SessionRecoveryState` the authoritative task checkpoint, and render a bounded recovery projection through `RequestAssembly`. Parent, tool-child, and subagent sessions form a persisted session tree connected by typed, exactly-once handoffs.

**Tech Stack:** TypeScript, existing session store, `ContextManagementService`, `WorkflowStateDigest`, `RequestAssembly`, Node test runner.

---

### Task 1: Define the persisted state and event contracts

**Files:**
- Create: `src/main/proxy/services/sessionRecoveryState.ts`
- Modify: `src/main/store/types.ts`
- Test: `tests/services/sessionRecoveryState.test.ts`

- [x] Define `SessionRecoveryState`, `RecoveryEvent`, `SessionNode`, and `TypedSessionHandoff` with explicit version, session/parent IDs, state version, compaction epoch, lifecycle status, pending children, completed children, verified facts, pending work, failures, decisions, constraints, artifacts, and next action/tool.
- [x] Distinguish `claimed`, `executed`, and `verified` facts; only runtime tool results and verification events may mark work verified.
- [x] Define serialization defaults and migration behavior for missing fields and older state versions.
- [x] Add tests for fresh state, version migration, child state, and bounded field limits, including subtype boundary rejection.

### Task 2: Implement an idempotent recovery-state reducer

**Files:**
- Modify: `src/main/proxy/services/sessionRecoveryState.ts`
- Test: `tests/services/sessionRecoveryState.test.ts`

- [x] Implement `reduceRecoveryEvent(state, event)` for tool calls/results, verification, failures, compaction, child creation, child completion, handoff consumption, provider-session changes, and task completion.
- [x] Make event application idempotent using retained event receipts plus stable domain-key replay protection; reject unprovable stale writes using `stateVersion`.
- [x] Preserve concurrent child results by child ID and never merge a handoff twice.
- [x] Add tests for duplicate events, stale versions, failed retries, bounded receipt eviction, and child completion before parent consumption.

### Task 3: Persist the session tree and typed handoffs

**Files:**
- Modify: `src/main/proxy/sessionManager.ts`
- Modify: `src/main/proxy/services/ProviderRuntime.ts`
- Modify: `src/main/proxy/services/contextManagementService.ts`
- Test: `tests/providers/provider-runtime-session-boundary.test.ts`, `tests/services/contextManagement-tool-handoff.test.ts`
- Support: `src/main/store/sessionRecoveryPersistence.ts`

- [x] Load and persist recovery state with the existing session store; keep state scoped to the session and remove it only on explicit session deletion/terminal cleanup.
- [x] Create child nodes for tool-child and subagent-child sessions and bind them to parent recovery session ID, tool call ID, and provider session ID.
- [ ] Emit bounded typed handoffs containing verified results, artifacts, failures, and remaining work; exclude raw child transcripts and tool contracts.
- [x] Consume handoffs exactly once before the parent continues, then clean up child provider sessions after successful recovery consumption.
- [ ] Add crash/restart tests proving an unfinished parent and child can resume without duplicate handoff or duplicate cleanup.

**Bridge decision:** `SessionRecoveryState.sessionId` is an explicit agent/session identity carried as `recoverySessionId` through the route/forwarder/runtime path. It must not be inferred from OpenCode request `sessionId`, provider conversation IDs, or `conversationStateKey`; those remain separate metadata and are recorded as provider/session dimensions.

- [x] Add the explicit recovery identity bridge through route → forwarder → provider runtime, with stable child identity derivation that remains separate from provider conversation/session IDs.

### Task 4: Make compaction project authoritative state, not re-infer it

**Files:**
- Modify: `src/main/proxy/services/workflowStateDigest.ts`
- Modify: `src/main/proxy/services/contextManagementService.ts`
- Modify: `src/main/proxy/RequestAssembly.ts`
- Test: `tests/services/contextManagement-workflow-digest.test.ts`, `tests/services/workflowStateDigest.test.ts`, `tests/services/requestAssembly-context-economy.test.ts`

- [ ] Extend digest rendering to accept persisted recovery state and include objective, current phase, verified progress, pending work, next action/tool, child status, failures, decisions, constraints, artifacts, and epoch within a hard character budget.
- [ ] Keep external summary as narrative context only; prevent it from overwriting runtime-derived state.
- [ ] Add a bounded recovery projection after every compaction boundary, including client compact, server summary, local fallback, and child handoff.
- [ ] Preserve authoritative tool catalog and tool-call pairing separately from the recovery text.
- [ ] Add tests for repeated compactions, stale summaries, missing parameters, active tool workflows, child handoffs, and marker-free provider prompts.

### Task 5: Add observability and acceptance gates

**Files:**
- Modify: existing context/session trace emitters in `src/main/proxy/services/` and `src/main/proxy/RequestAssembly.ts`
- Test: `tests/providers/context-economy-diagnostics.test.ts`, `tests/services/sessionBoundaryPlan.test.ts`

- [ ] Log session ID, parent/child ID, event ID, state version, compaction epoch, state source, handoff status, provider session action, and recovery projection size on the existing correlation ID.
- [ ] Make state conflicts, stale handoffs, recovery fallback, and child cleanup observable without logging credentials or raw transcripts.
- [ ] Add deterministic acceptance scenarios for repeated compaction, provider-session reuse/restart, tool continuation, child handoff, and cleanup.
- [ ] Run the project’s focused context/session test set, build, and one audited golden-path probe only after all deterministic tests pass.

---

## Assumptions

- Recovery state is persisted per session, not shared as cross-task semantic memory.
- Runtime events outrank model-written summaries.
- No extra recovery confirmation model turn is added in v1.
- Existing provider/session boundaries remain the integration points; no new global orchestration layer is introduced.
