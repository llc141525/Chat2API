# Qwen Tool-Turn Latency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Qwen managed tool turns from replaying historical runtime configuration and creating unnecessary fresh provider conversations after compaction.

**Architecture:** Preserve the existing `ProviderRuntime` boundary planner as the sole session-policy owner. Align Qwen with GLM's already-established provider projection: remove historical runtime configuration before Qwen flattens messages, then reintroduce only the bounded `infrastructurePrompt` and authoritative current tool manifest. The real probe log is the acceptance source of truth.

**Tech Stack:** Electron, TypeScript, Node test runner, ProviderRuntime, Qwen web SSE adapter, OpenCode capability probes.

## Global Constraints

- Preserve ToolCallingEngine as the sole owner of tool prompt injection (INV-001).
- Preserve a stateless tool-catalog fallback (INV-002).
- Do not remove message-processing code without equivalent coverage (INV-003).
- Treat provider output as untrusted data.
- Do not accept test success without a clean real-probe log audit.

---

### Task 1: Lock Qwen runtime-config projection with a regression test

**Files:**
- Modify: `tests/providers/qwen-request-routing.test.ts`
- Modify: `src/main/proxy/adapters/qwen.ts`
- Modify: `src/main/proxy/RequestAssembly.ts`

**Interfaces:**
- Consumes: `selectProviderMessagesForAssembly()` and a `RequestAssembly` that contains a raw OpenCode runtime configuration message.
- Produces: a Qwen flattened provider prompt that omits historical runtime configuration while retaining its bounded infrastructure projection and current tool manifest.

- [ ] **Step 1: Write the failing test**

Add a Qwen assembly fixture containing a long system runtime configuration with `superpowers` and `SUBAGENT-STOP`, a bounded `infrastructurePrompt`, and a current tool manifest. Assert the final Qwen request body excludes the raw runtime text and contains the bounded infrastructure text and current manifest.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/providers/qwen-request-routing.test.ts`

Expected: failure because the current Qwen assembly still flattens the raw runtime configuration.

- [ ] **Step 3: Implement the minimal capability declaration**

Change Qwen's existing assembly selection to use the same options already used by GLM, and ensure `buildInfrastructurePromptFromMessages()` does not select a runtime-config system message as the bounded role definition:

```ts
selectProviderMessagesForAssembly(assembly, {
  stripRuntimeConfig: true,
  stripToolContractHistory: true,
  dropRuntimeConfig: true,
})
```

Do not modify `ToolCallingEngine`, the tool protocol, or session-boundary policy in this task.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/providers/qwen-request-routing.test.ts`

Expected: the request body retains the current contract/infrastructure but excludes raw historical configuration.

### Task 2: Verify bounded tool-ready projection and actual provider behavior

**Files:**
- Test: `tests/providers/qwen-request-routing.test.ts`
- Verify: `tests/agent-capability/verify-opencode-long-conversation.ps1`

**Interfaces:**
- Consumes: `projectRequestAssemblyForPromptMode()` and the Qwen assembly builder.
- Produces: tool-ready turns retain the current contract while excluding repeated historical runtime configuration.

- [ ] **Step 1: Add a focused projection assertion if Task 1 exposes an unbounded historical payload**

Create a fixture containing repeated `superpowers` runtime messages and assert a tool-ready Qwen assembly keeps one current bounded runtime projection and no copied historical runtime payload.

- [ ] **Step 2: Run the focused tests**

Run: `node --test tests/providers/qwen-request-routing.test.ts tests/providers/qwen-session-continuity.test.ts tests/providers/stream-normalizer.test.ts`

Expected: zero failures.

- [ ] **Step 3: Run the real long-conversation probe against a fresh development proxy**

Run `npm run dev:win` with logs redirected, then run:

```powershell
.\tests\agent-capability\verify-opencode-long-conversation.ps1 -Model "qwen/Qwen3-Max" -LogPath .\dev.log
```

Expected: preflight, warmup, compaction, tool chain, and final marker all pass.

- [ ] **Step 4: Audit the probe log before reporting**

Reject the change if any of these remain unexplained:

- `providerSessionAction:"start_child"` or `providerSessionIdSource:"fresh"` on a tool child with a reusable parent session;
- repeated runtime config markers above zero on a tool-ready request;
- `error_code`, timeout, `ECONNRESET`, malformed tool output, dropped tool calls, or duplicate same-path reads;
- a final response without the required tool artifacts.
