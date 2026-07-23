# Tool Runtime Legacy Parser Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the sixth batch of the Chat2API single truth tool runtime: freeze legacy competing parser paths, ensure provider adapters are transport-only for tool protocol handling, and run the deterministic regression gate.

**Architecture:** The new runtime is now the authoritative path for managed tool parsing. Legacy parser utilities may remain for compatibility where not yet connected, but they must not be used by managed GLM/Qwen/Qwen AI non-stream or stream tool paths. Provider adapters must not inject additional tool prompts or select parser protocols.

**Tech Stack:** TypeScript, Node.js built-in test runner (`node --test`), existing provider regression tests.

---

## Prerequisites

Complete these earlier plans first:

- `2026-06-30-tool-runtime-control-plane.md`
- `2026-06-30-tool-runtime-structure-chain.md`
- `2026-06-30-tool-runtime-repair-assembler.md`
- `2026-06-30-tool-runtime-stream-mapping.md`
- `2026-06-30-tool-runtime-runner-facade.md`

## Scope

This plan implements:

- Tests proving managed providers do not use legacy parser fallback for mixed protocol output.
- Tests proving provider adapters do not inject tool prompts.
- Stream tool requests use runtime full-buffer path or explicitly remain unconnected with guard tests.
- Deprecation guards around old parser paths.
- Deterministic regression gate.

This plan intentionally does not implement:

- Full LiteLLM-style QualityRouter.
- OpenCode probe fixes beyond preserving the existing probe contract.
- Provider behavior rewrites unrelated to tool protocol boundaries.

## File Structure

Files to inspect and possibly modify:

- `src/main/proxy/forwarder.ts`
  - Ensure managed tool transformations are centralized.
- `src/main/proxy/toolCalling/ToolCallingEngine.ts`
  - Ensure facade delegates managed parsing to runtime.
- `src/main/proxy/toolCalling/ToolStreamParser.ts`
  - Freeze or redirect managed stream parsing as required.
- `src/main/proxy/utils/streamToolHandler.ts`
  - Keep deprecated; prevent managed runtime from depending on it.
- `src/main/proxy/utils/toolParser.ts`
- `src/main/proxy/utils/toolParser/index.ts`
- `src/main/proxy/utils/unifiedToolParser.ts`
  - Keep only for legacy compatibility; do not use for managed XML runtime.
- Provider adapters:
  - `src/main/proxy/adapters/glm.ts`
  - `src/main/proxy/adapters/qwen.ts`
  - `src/main/proxy/adapters/qwen-ai.ts`
  - Other adapters only if tests show prompt injection still exists.
- Tests:
  - `tests/providers/glm-tool-calling.test.ts`
  - `tests/providers/qwen-request-routing.test.ts`
  - `tests/providers/context-tool-metadata.test.ts`
  - `tests/tool-calling/tool-stream-parser.test.ts`
  - New: `tests/tool-runtime/integration/managed-provider-boundary.test.ts`

## Boundary Rules

- Managed XML output must be parsed through the runtime structure chain, not legacy parser fallback.
- Provider adapters must not add tool prompts when the forwarder/runtime already transformed messages.
- A mixed protocol output must never produce `tool_calls` through legacy parser paths.
- If a legacy parser remains exported, tests must prove managed runtime does not call it.

---

### Task 1: Managed Provider Boundary Regression Tests

**Files:**
- Create: `tests/tool-runtime/integration/managed-provider-boundary.test.ts`

- [ ] **Step 1: Write the boundary tests**

Create `tests/tool-runtime/integration/managed-provider-boundary.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'

import { ToolCallingEngine } from '../../../src/main/proxy/toolCalling/ToolCallingEngine.ts'
import type { Provider } from '../../../src/main/store/types.ts'

const provider: Provider = {
  id: 'qwen',
  name: 'Qwen',
  type: 'builtin',
  authType: 'token',
  apiEndpoint: '',
  headers: {},
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
}

function engine(): ToolCallingEngine {
  return new ToolCallingEngine({
    enabled: true,
    mode: 'force',
    clientAdapterId: 'standard-openai-tools',
    diagnosticsEnabled: false,
    advanced: { promptPreviewEnabled: false },
  })
}

function transformedPlan() {
  return engine().transformRequest({
    request: {
      model: 'qwen-test',
      messages: [{ role: 'user', content: 'run pwd' }],
      tools: [{
        type: 'function',
        function: {
          name: 'bash',
          parameters: {
            type: 'object',
            properties: { argument: { type: 'string' } },
            required: ['argument'],
          },
        },
      }],
    },
    provider,
    actualModel: 'qwen-test',
  }).plan
}

test('mixed protocol managed output is repaired by runtime, not legacy fallback', () => {
  const plan = transformedPlan()
  const result = {
    choices: [{
      message: {
        role: 'assistant',
        content: '<|CHAT2API|tool_calls><|CHAT2API|invoke name="bash"><|CHAT2API|parameter name="argument"><![CDATA[pwd]]></arg_value></tool_call>',
      },
      finish_reason: 'stop',
    }],
  }

  engine().applyNonStreamResponse(result, plan)

  assert.equal(result.choices[0].finish_reason, 'tool_calls')
  assert.equal(result.choices[0].message.content, null)
  assert.deepEqual(result.choices[0].message.tool_calls, [{
    id: 'call_0',
    index: 0,
    type: 'function',
    function: {
      name: 'bash',
      arguments: '{"argument":"pwd"}',
    },
  }])
})

test('bracket protocol output is ignored when selected protocol is managed_xml', () => {
  const plan = transformedPlan()
  const result = {
    choices: [{
      message: {
        role: 'assistant',
        content: '[function_calls]\n[call:bash]{"argument":"pwd"}[/call]\n[/function_calls]',
      },
      finish_reason: 'stop',
    }],
  }

  engine().applyNonStreamResponse(result, plan)

  assert.equal(result.choices[0].finish_reason, 'stop')
  assert.equal(result.choices[0].message.tool_calls, undefined)
})
```

- [ ] **Step 2: Run boundary tests**

Run:

```powershell
node --test tests/tool-runtime/integration/managed-provider-boundary.test.ts
```

Expected: PASS after batch 5. If it fails, fix `ToolCallingEngine.applyNonStreamResponse` so managed XML selected protocol never falls back to bracket parsing.

- [ ] **Step 3: Commit Task 1**

Run:

```powershell
git add tests/tool-runtime/integration/managed-provider-boundary.test.ts
git commit -m "test: cover managed provider parser boundary"
```

Expected: commit includes only the boundary test file.

---

### Task 2: Provider Prompt Injection Guard Tests

**Files:**
- Modify or create provider tests under `tests/providers/`

- [ ] **Step 1: Add provider prompt injection assertions**

Add assertions to the most relevant provider tests, starting with:

- `tests/providers/glm-tool-calling.test.ts`
- `tests/providers/qwen-request-routing.test.ts`

Add this style of assertion where provider request payloads are inspected:

```ts
assert.equal(serializedRequest.includes('## Available Tools'), true)
assert.equal(countOccurrences(serializedRequest, '## Available Tools'), 1)
assert.equal(countOccurrences(serializedRequest, '<|CHAT2API|tool_calls>'), 1)

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1
}
```

If the existing tests inspect transformed messages instead of serialized request bodies, assert the same condition on `JSON.stringify(messages)`.

- [ ] **Step 2: Run provider tests**

Run:

```powershell
node --test tests/providers/glm-tool-calling.test.ts tests/providers/qwen-request-routing.test.ts tests/providers/context-tool-metadata.test.ts
```

Expected: PASS. If duplicate prompts appear, remove direct adapter prompt injection and keep only forwarder/runtime injection.

- [ ] **Step 3: Commit Task 2**

Run:

```powershell
git add tests/providers/glm-tool-calling.test.ts tests/providers/qwen-request-routing.test.ts tests/providers/context-tool-metadata.test.ts src/main/proxy/adapters/glm.ts src/main/proxy/adapters/qwen.ts src/main/proxy/adapters/qwen-ai.ts
git commit -m "test: guard managed provider prompt boundaries"
```

Expected: commit includes provider tests and only adapter files actually needed to remove duplicate injection.

---

### Task 3: Legacy Parser Dependency Audit

**Files:**
- Inspect:
  - `src/main/proxy/utils/streamToolHandler.ts`
  - `src/main/proxy/utils/toolParser.ts`
  - `src/main/proxy/utils/toolParser/index.ts`
  - `src/main/proxy/utils/unifiedToolParser.ts`
  - `src/main/proxy/toolCalling/ToolStreamParser.ts`
  - `src/main/proxy/toolCalling/ToolCallingEngine.ts`

- [ ] **Step 1: Search legacy parser usage**

Run:

```powershell
rg -n "parseToolCallsFromText|parseToolCallsStream|unifiedToolParser|streamToolHandler|buildToolCall|ToolStreamParser" src/main/proxy tests
```

Expected: output shows legacy parser references. Categorize each as:

- still used by old tests only
- still used by unmanaged legacy path
- incorrectly used by managed runtime path

- [ ] **Step 2: Remove managed runtime dependency on legacy parser**

If managed runtime path imports any of these legacy APIs, remove that import and route through:

```ts
getStructureProtocolAdapter
validateToolCallStructure
repairStructure
assembleOpenAIToolCalls
```

Do not delete legacy files in this task unless no references remain.

- [ ] **Step 3: Add comments only where they prevent reintroduction**

If a legacy file remains, add a concise module-level comment:

```ts
/**
 * Legacy parser path. Managed tool runtime must not depend on this module.
 * New managed XML parsing belongs under src/main/proxy/toolRuntime/.
 */
```

Do not add comments to every function.

- [ ] **Step 4: Run runtime and tool-calling tests**

Run:

```powershell
node --test tests/tool-runtime/control/*.test.ts tests/tool-runtime/data/*.test.ts tests/tool-runtime/runner/*.test.ts tests/tool-calling/*.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

Run:

```powershell
git add src/main/proxy/utils/streamToolHandler.ts src/main/proxy/utils/toolParser.ts src/main/proxy/utils/toolParser/index.ts src/main/proxy/utils/unifiedToolParser.ts src/main/proxy/toolCalling/ToolStreamParser.ts src/main/proxy/toolCalling/ToolCallingEngine.ts tests/tool-calling
git commit -m "chore: guard legacy tool parser boundaries"
```

Expected: commit includes only files actually touched.

---

### Task 4: Deterministic Regression Gate

**Files:**
- No source changes unless tests expose a regression.

- [ ] **Step 1: Run the project deterministic tool gate**

Run:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run focused new runtime tests**

Run:

```powershell
node --test tests/tool-runtime/control/*.test.ts tests/tool-runtime/data/*.test.ts tests/tool-runtime/runner/*.test.ts tests/tool-runtime/integration/*.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run build if deterministic tests pass**

Run:

```powershell
npm run build
```

Expected: PASS, or fail only on known pre-existing TypeScript/build errors documented before this batch.

- [ ] **Step 4: Commit regression fixes if any were needed**

If Step 1-3 required fixes, commit them:

```powershell
git add <changed-files>
git commit -m "fix: complete managed tool runtime migration"
```

Expected: commit includes only regression fixes from this task.

---

### Task 5: OpenCode Probe Handoff

**Files:**
- No source changes unless the probe exposes a runtime bug.

- [ ] **Step 1: Start the app**

Run:

```powershell
npm run dev:win 2>&1 | Tee-Object -FilePath .\dev.log
```

Keep it running.

- [ ] **Step 2: Run the OpenCode probe**

In a second terminal, run:

```powershell
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "GLM-5.2"
```

Expected:

- `.agent-probe/result.json` matches the verifier's computed hashes and edge-case echo fields.
- `.agent-probe/opencode-events.ndjson` contains a real `agent-capability-probe` skill invocation.
- Event stream contains at least two non-skill tool calls.
- At least one tool call occurs after the first tool result/observation.
- Final assistant text contains `CAPABILITY_PROBE_DONE`.

- [ ] **Step 3: Commit probe fixes if any were needed**

If the probe exposed a bug and fixes were made:

```powershell
git add <changed-files>
git commit -m "fix: pass opencode tool runtime probe"
```

Expected: commit includes only probe-related fixes.

---

## Batch Verification

This batch is accepted only when:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

passes, and the new runtime tests pass:

```powershell
node --test tests/tool-runtime/control/*.test.ts tests/tool-runtime/data/*.test.ts tests/tool-runtime/runner/*.test.ts tests/tool-runtime/integration/*.test.ts
```

For final project acceptance, run the OpenCode probe from Task 5.

## Self-Review Checklist

- Managed XML no longer falls back to bracket/OpenCode parser paths.
- Provider adapters do not inject duplicate tool prompts.
- Legacy parser files are clearly fenced off from managed runtime.
- Mixed protocol output never reaches client tool execution unless it passes structural repair, reparse, revalidate, and assembly.
- Deterministic regression gate passes before OpenCode probe.
