# Fix Catalog Fallback Chain - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the tool definition fallback chain so prompt injection never loses tools, even when Session Store is unavailable or requestTools is empty.

**Architecture:** Patch three files in the tool-calling pipeline: `catalog.ts` adds message-history-based tool extraction when both session catalog and request tools are missing; `runtimePlan.ts` logs a warning and degrades safely instead of throwing when allowedTools is empty but injection was expected; `availabilityDrift.ts` ensures retry clarification carries the full original tool list.

**Tech Stack:** TypeScript, Node.js built-in test runner (`node:test`)

## Global Constraints

- INV-001 [Single Ownership]: `ToolCallingEngine` is the sole owner of tool prompt injection. Provider Adapters must never import `hasToolPromptInjected`, `toolsToSystemPrompt`, `TOOL_WRAP_HINT`, or `shouldInjectToolPrompt`.
- INV-002 [Stateless Fallback]: Any tool resolution logic depending on Session Store must have a stateless degradation path: `Session Store → Message History Extraction → Request Tools → Safe Empty`. Returning an empty tool list without fallback is forbidden.
- INV-003 [Delete = Risk]: Deleting any tool/message processing code during refactoring requires explicit declaration of original purpose and equivalent coverage proof in the PR description. Unprovable deletions must be retained with `// TODO: investigate why this exists`.
- INV-004 [Client Quirks Matrix]: All tool-calling changes must be verified against the known client behavior quirks list, not solely against OpenAI official documentation.

---

### Task 1: Add Message History Tool Extraction Fallback in catalog.ts

**Files:**
- Modify: `src/main/proxy/toolCalling/catalog.ts:59-69`
- Test: `tests/tool-calling/catalog-fallback.test.ts`

**Interfaces:**
- Consumes: `extractManagedHistoryToolNames(messages)` from `runtimePlan.ts:132-154`
- Produces: Enhanced `resolveSnapshot()` that returns a valid snapshot built from history tool names when session catalog is missing

- [ ] **Step 1: Write the failing test**

Create `tests/tool-calling/catalog-fallback.test.ts`:



- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/tool-calling/catalog-fallback.test.ts`
Expected: FAIL — first test asserts `blocked === false` but current code returns `blocked: true` at line 62 when `hasManagedToolHistory && !existing`.

- [ ] **Step 3: Implement message history fallback in catalog.ts**

Modify `src/main/proxy/toolCalling/catalog.ts` lines 59-69. Replace the blocking branch with history-based snapshot construction:



Also add `'restored_from_history'` to the `ToolCatalogDriftKind` union type in `src/main/proxy/toolCalling/types.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/tool-calling/catalog-fallback.test.ts`
Expected: PASS — all three tests pass.

- [ ] **Step 5: Run existing catalog tests to ensure no regression**

Run: `node --test tests/tool-calling/tool-catalog.test.ts`
Expected: PASS — all existing tests still pass.

- [ ] **Step 6: Commit**



---

### Task 2: Safe Degradation in runtimePlan.ts When allowedTools Is Empty

**Files:**
- Modify: `src/main/proxy/toolCalling/runtimePlan.ts:42-54`
- Test: `tests/tool-calling/runtime-plan-degradation.test.ts`

**Interfaces:**
- Consumes: Updated `resolveSnapshot()` from Task 1 (may now return snapshot from history)
- Produces: `buildToolCallingRuntimePlan()` that logs warning and returns `mode: 'disabled'` instead of throwing when `allowedTools.length === 0 && shouldInjectPrompt` would have been true

- [ ] **Step 1: Write the failing test**

Create `tests/tool-calling/runtime-plan-degradation.test.ts`:



- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/tool-calling/runtime-plan-degradation.test.ts`
Expected: FAIL — current code may throw at line 32-34 when catalog is blocked, or produce incorrect mode.

- [ ] **Step 3: Implement safe degradation in runtimePlan.ts**

Modify `src/main/proxy/toolCalling/runtimePlan.ts` around lines 32-54. Replace the throw-on-blocked with conditional handling:



After computing `allowedTools` (line 41), add explicit empty-tools-with-history check before line 42:



Add `'no_tools_with_managed_history'` to the `DisabledReason` type in `types.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/tool-calling/runtime-plan-degradation.test.ts`
Expected: PASS

- [ ] **Step 5: Run existing runtime-plan tests**

Run: `node --test tests/tool-calling/runtime-plan.test.ts`
Expected: PASS — no regressions.

- [ ] **Step 6: Commit**



---

### Task 3: Ensure availabilityDrift Retry Carries Complete Tool Definitions

**Files:**
- Modify: `src/main/proxy/toolCalling/availabilityDrift.ts:32-40`
- Test: `tests/tool-calling/availability-drift-retry.test.ts`

**Interfaces:**
- Consumes: `ToolCallingPlan.allowedToolNames`, `ToolCallingPlan.snapshot.catalog_fingerprint`
- Produces: `buildAvailabilityRetryClarification()` output that includes all tool names and fingerprint verifiably

- [ ] **Step 1: Write the failing test**

Create `tests/tool-calling/availability-drift-retry.test.ts`:



- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/tool-calling/availability-drift-retry.test.ts`
Expected: FAIL or PASS depending on current implementation. If current implementation already includes all names, this serves as a regression anchor.

- [ ] **Step 3: Verify and harden buildAvailabilityRetryClarification**

Read `src/main/proxy/toolCalling/availabilityDrift.ts:32-40`. Verify that:
1. It iterates over ALL `plan.allowedToolNames` (not a subset)
2. It includes `plan.snapshot?.catalog_fingerprint`
3. It handles missing snapshot gracefully

If the current implementation is correct, add a defensive assertion at the top of the function:



- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/tool-calling/availability-drift-retry.test.ts`
Expected: PASS

- [ ] **Step 5: Run full tool-calling test suite**

Run: `node --test tests/tool-calling/*.test.ts`
Expected: PASS — all tests pass including new ones.

- [ ] **Step 6: Commit**



---

### Task 4: End-to-End Manual Verification

**Files:** None (manual verification)

- [ ] **Step 1: Start dev server**

Run: `npm run dev:win 2>&1 | Tee-Object -FilePath .\dev.log`

- [ ] **Step 2: Test OpenCode multi-turn with Qwen**

Configure Qwen provider, start OpenCode session, invoke a tool, then send a follow-up message that triggers another tool call. Verify no tool context loss occurs.

- [ ] **Step 3: Test Session Miss scenario**

Restart the app mid-conversation to force session miss. Send a follow-up tool-using message. Verify the fallback chain restores tool definitions from message history.

- [ ] **Step 4: Stop dev server and commit any fixes discovered**