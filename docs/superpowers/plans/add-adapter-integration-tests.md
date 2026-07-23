# Add Adapter Integration Tests - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommendedd) or superpowersexecuting-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create permanent regression tests covering GLM, Qwen, MiniMax, Kimi, and DeepSeek adapters end-to-end for tool calling, including session miss and second-turn-no-tools scenarios.

**Architecture:** A single integration test file that exercises each adapter's request transformation and response parsing through the ToolCallingEngine, simulating multi-turn conversations with session anomalies. Tests use `node:test` and mock provider HTTP calls.

**Tech Stack:** TypeScript, Node.js built-in test runner (`node:test`)

## Global Constraints

- INV-001 [Single Ownership]: `ToolCallingEngine` is the sole owner of tool prompt injection. Provider Adapters must never import `hasToolPromptInjected`, `toolsToSystemPrompt`, `TOOL_WRAP_HINT`, or `shouldInjectToolPrompt`.
- INV-002 [Stateless Fallback]: Any tool resolution logic depending on Session Store must have a stateless degradation path: `Session Store → Message History Extraction → Request Tools → Safe Empty`. Returning an empty tool list without fallback is forbidden.
- INV-003 [Delete = Risk]: Deleting any tool/message processing code during refactoring requires explicit declaration of original purpose and equivalent coverage proof in the PR description. Unprovable deletions must be retained with `// TODO: investigate why this exists`.
- INV-004 [Client Quirks Matrix]: All tool-calling changes must be verified against the known client behavior quirks list, not solely against OpenAI official documentation.

---

### Task 1: Scaffold Adapter Integration Test File with Shared Helpers

**Files:**
- Create: `tests/tool-calling/adapter-integration.test.ts`

**Interfaces:**
- Consumes: `ToolCallingEngine.transformRequest()`, `ToolCallingEngine.applyNonStreamResponse()`, adapter registry
- Produces: Shared test helpers (`createMockEngine`, `simulateTurn`, `assertToolPromptComplete`) used by Tasks 2-6

- [ ] **Step 1: Create the test scaffold with shared helpers**

Create `tests/tool-calling/adapter-integration.test.ts`:



- [ ] **Step 2: Run scaffold to verify it loads**

Run: `node --test tests/tool-calling/adapter-integration.test.ts`
Expected: PASS (no tests yet, just scaffold)

- [ ] **Step 3: Commit**



---

### Task 2: GLM Adapter Integration Tests

**Files:**
- Modify: `tests/tool-calling/adapter-integration.test.ts`

**Interfaces:**
- Consumes: Shared helpers from Task 1
- Produces: GLM-specific test cases for second-turn-no-tools and session-key anomaly scenarios

- [ ] **Step 1: Add GLM test cases**

Append inside the outer `describe` block:



- [ ] **Step 2: Run GLM tests**

Run: `node --test tests/tool-calling/adapter-integration.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**



---

### Task 3: Qwen Adapter Integration Tests

**Files:**
- Modify: `tests/tool-calling/adapter-integration.test.ts`

- [ ] **Step 1: Add Qwen test cases**

Append inside the outer `describe` block:



- [ ] **Step 2: Run tests**

Run: `node --test tests/tool-calling/adapter-integration.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**



---

### Task 4: MiniMax, Kimi, DeepSeek Adapter Integration Tests

**Files:**
- Modify: `tests/tool-calling/adapter-integration.test.ts`

- [ ] **Step 1: Add MiniMax test cases**



- [ ] **Step 2: Add Kimi test cases**



- [ ] **Step 3: Add DeepSeek test cases**



- [ ] **Step 4: Run all adapter integration tests**

Run: `node --test tests/tool-calling/adapter-integration.test.ts`
Expected: PASS — all 8 tests across 5 providers pass.

- [ ] **Step 5: Commit**



---

### Task 5: Drift Detection Boundary Case Tests

**Files:**
- Modify: `tests/tool-calling/adapter-integration.test.ts`

- [ ] **Step 1: Add drift detection boundary tests**



- [ ] **Step 2: Run full test suite**

Run: `node --test tests/tool-calling/adapter-integration.test.ts`
Expected: PASS

- [ ] **Step 3: Run complete tool-calling test suite for regression check**

Run: `node --test tests/tool-calling/*.test.ts`
Expected: PASS — all existing and new tests pass.

- [ ] **Step 4: Commit**