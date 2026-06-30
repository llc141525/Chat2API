# Tool Availability Catalog Phase 6: Final Regression and Probe Prep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this phase task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Source Spec:** [`docs/superpowers/specs/2026-06-30-tool-availability-catalog-design.md`](../specs/2026-06-30-tool-availability-catalog-design.md)

**Parent Index:** [`docs/superpowers/plans/2026-06-30-tool-availability-catalog.md`](./2026-06-30-tool-availability-catalog.md)

## Phase Isolation Rule

- This document contains only Phase 6: Final Regression and Probe Prep.
- Do not implement files or steps from other Phase 7 plan documents while executing or validating this phase.
- If working tree changes from another phase already exist, leave them unvalidated until their own phase review.

### Task 6: Final Regression and Probe Prep

**Files:**
- Modify tests only if failures expose missing catalog assertions:
  - `tests/providers/context-tool-metadata.test.ts`
  - `tests/providers/qwen-request-routing.test.ts`
  - `tests/providers/glm-tool-calling.test.ts`
  - `tests/tool-calling/tool-stream-parser.test.ts`

- [ ] **Step 1: Run all deterministic tool-calling tests**

Run:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run existing tool-runtime tests**

Run:

```powershell
node --test tests/tool-runtime/control/*.test.ts tests/tool-runtime/data/*.test.ts tests/tool-runtime/integration/*.test.ts tests/tool-runtime/runner/*.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run build**

Run:

```powershell
npm run build
```

Expected: PASS.

- [ ] **Step 4: Start app for OpenCode probe**

Run:

```powershell
npm run dev:win 2>&1 | Tee-Object -FilePath .\dev.log
```

Expected: app starts and proxy is reachable. Keep this process running until the probe completes.

- [ ] **Step 5: Run OpenCode probe for Qwen**

In another terminal:

```powershell
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "qwen3.7"
```

Expected:

- `.agent-probe/result.json` matches deterministic local hash/length/line expectations.
- `.agent-probe/opencode-events.ndjson` contains the `agent-capability-probe` skill invocation.
- event stream contains at least two non-skill tool calls.
- at least one tool call occurs after the first tool result/observation.
- final assistant text contains `CAPABILITY_PROBE_DONE`.

- [ ] **Step 6: Inspect diagnostics for tool availability**

Review the latest app logs or any exposed debug output and confirm these structural facts appear during managed tool turns:

- `tool_catalog_resolved`
- `tool_contract_injected`
- same `catalogFingerprint` through the turn
- no tool arguments in diagnostic event payloads

- [ ] **Step 7: Commit any test-only adjustments**

If Steps 1-6 required deterministic test changes:

```powershell
git add tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts tests/providers/glm-tool-calling.test.ts tests/tool-calling/tool-stream-parser.test.ts
git commit -m "test: cover tool catalog regression gate"
```

If no files changed, do not create an empty commit.
