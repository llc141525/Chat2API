# Tool Runtime Runner and ToolCallingEngine Facade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the fifth batch of the Chat2API single truth tool runtime: a thin `ToolTurnRunner` execution shell and a compatibility facade path for `ToolCallingEngine`.

**Architecture:** `ToolTurnRunner` executes FSM-requested operations through injected dependencies and reduces outcomes back into FSM events. It owns no tool policy. `ToolCallingEngine` remains as a compatibility facade for existing call sites while delegating planning and non-stream response processing to the new runtime chain.

**Tech Stack:** TypeScript, Node.js built-in test runner (`node --test`), existing Chat2API forwarder/tool-calling APIs.

---

## Prerequisites

Complete these earlier plans first:

- `2026-06-30-tool-runtime-control-plane.md`
- `2026-06-30-tool-runtime-structure-chain.md`
- `2026-06-30-tool-runtime-repair-assembler.md`
- `2026-06-30-tool-runtime-stream-mapping.md`

## Scope

This plan implements:

- `ModelInvoker` and runner dependency types.
- `ToolTurnRunner` with fake invoker tests.
- A managed non-stream path inside `ToolCallingEngine.applyNonStreamResponse` that uses:
  - selected protocol adapter
  - validator
  - structural repair
  - reparse/revalidate
  - assembler
- Compatibility with existing `ToolCallingEngine.transformRequest` call sites.

This plan intentionally does not implement:

- Provider adapter changes.
- Stream path integration.
- QualityRouter.
- Old parser deletion.
- Full forwarder refactor.

## File Structure

- Create: `src/main/proxy/toolRuntime/runner/types.ts`
  - Runner input/dependency/result types.
- Create: `src/main/proxy/toolRuntime/runner/ToolTurnRunner.ts`
  - Executes FSM operations using injected dependencies.
- Create: `src/main/proxy/toolRuntime/runner/index.ts`
  - Re-exports runner APIs.
- Modify: `src/main/proxy/toolRuntime/data/types.ts`
  - Add blocked malformed safe message constant or mapping helper type if needed.
- Modify: `src/main/proxy/toolCalling/ToolCallingEngine.ts`
  - Thin non-stream response processing into new runtime chain.
- Create: `tests/tool-runtime/runner/tool-turn-runner.test.ts`
  - Tests runner control-flow with fake dependencies.
- Modify/Create: `tests/tool-calling/tool-engine.test.ts`
  - Add facade regression tests for valid, mixed malformed repaired, and blocked malformed outputs.

## Boundary Rules

- `ToolTurnRunner` may call dependencies but must not inspect XML, tool schema details, provider IDs, or raw parser regexes.
- `ToolTurnRunner` may ask `RepairPolicy` only through an injected function that returns an abstract decision.
- `ToolCallingEngine` may remain a facade but should not call legacy parser utilities for managed non-stream parsing.
- This batch must not change provider adapters.

---

### Task 1: ToolTurnRunner With Fake Dependencies

**Files:**
- Create: `src/main/proxy/toolRuntime/runner/types.ts`
- Create: `src/main/proxy/toolRuntime/runner/ToolTurnRunner.ts`
- Create: `src/main/proxy/toolRuntime/runner/index.ts`
- Create: `tests/tool-runtime/runner/tool-turn-runner.test.ts`

- [ ] **Step 1: Write failing runner tests**

Create `tests/tool-runtime/runner/tool-turn-runner.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'

import { runToolTurn } from '../../../src/main/proxy/toolRuntime/runner/index.ts'
import type { ToolPlan } from '../../../src/main/proxy/toolRuntime/control/index.ts'
import type { ToolTurnRunnerDeps } from '../../../src/main/proxy/toolRuntime/runner/index.ts'
import type { NormalizedToolDefinition } from '../../../src/main/proxy/toolCalling/types.ts'

const plan: ToolPlan = {
  profile: 'managed_buffered_structural',
  protocol: 'managed_xml',
  allowedToolNames: ['bash'],
  diagnostics: {
    providerId: 'qwen',
    model: 'qwen-test',
    profile: 'managed_buffered_structural',
    mode: 'managed',
    protocol: 'managed_xml',
    reason: 'provider_managed_tools',
    toolCount: 1,
    toolChoiceMode: 'auto',
    allowedToolNames: ['bash'],
  },
}

const tools: NormalizedToolDefinition[] = [{
  name: 'bash',
  parameters: { type: 'object', properties: { argument: { type: 'string' } }, required: ['argument'] },
  source: 'openai',
}]

function deps(overrides: Partial<ToolTurnRunnerDeps> = {}): ToolTurnRunnerDeps {
  return {
    invokeModel: async () => ({ status: 'completed', rawOutput: 'hello' }),
    extractStructure: () => ({ kind: 'no_intent', protocol: 'managed_xml', content: 'hello' }),
    validateStructure: () => ({ status: 'plain_text', content: 'hello' }),
    canRepair: () => false,
    repairStructure: () => ({ status: 'not_repairable', reason: 'no' }),
    assembleToolCalls: () => [],
    mapResponse: (input) => ({ mapped: input }),
    ...overrides,
  }
}

test('runner maps plain text without repair or assembly', async () => {
  const calls: string[] = []
  const result = await runToolTurn({
    plan,
    tools,
    deps: deps({
      validateStructure: () => {
        calls.push('validate')
        return { status: 'plain_text', content: 'hello' }
      },
      mapResponse: (input) => {
        calls.push(input.kind)
        return { mapped: input }
      },
    }),
  })

  assert.deepEqual(calls, ['validate', 'plain_text'])
  assert.deepEqual(result, { status: 'success', response: { mapped: { kind: 'plain_text', content: 'hello' } } })
})

test('runner repairs once, revalidates, assembles, and maps tool calls', async () => {
  let validateCount = 0
  const result = await runToolTurn({
    plan,
    tools,
    deps: deps({
      validateStructure: () => {
        validateCount += 1
        if (validateCount === 1) {
          return {
            status: 'invalid_structure',
            failure: { kind: 'mixed_protocol_container', selectedProtocol: 'managed_xml', detail: 'mixed' },
            malformedIntent: {
              selectedProtocol: 'managed_xml',
              toolName: 'bash',
              parameters: [{ name: 'argument', rawPayload: 'pwd', payloadEncoding: 'cdata' }],
              rawContainerFingerprint: 'f',
              failureKind: 'mixed_protocol_container',
            },
          }
        }
        return {
          status: 'valid_structure',
          cleanContent: null,
          validated: [{
            callIndex: 0,
            toolName: 'bash',
            parameters: [{ name: 'argument', rawPayload: 'pwd', payloadEncoding: 'cdata' }],
          }],
        }
      },
      canRepair: () => true,
      repairStructure: () => ({ status: 'repaired', protocol: 'managed_xml', method: 'deterministic_rewrap', repairedText: '<fixed />' }),
      assembleToolCalls: () => [{ id: 'call_0', index: 0, type: 'function', function: { name: 'bash', arguments: '{"argument":"pwd"}' } }],
      mapResponse: (input) => ({ mapped: input }),
    }),
  })

  assert.equal(validateCount, 2)
  assert.deepEqual(result, {
    status: 'success',
    response: {
      mapped: {
        kind: 'valid_tool_calls',
        toolCalls: [{ id: 'call_0', index: 0, type: 'function', function: { name: 'bash', arguments: '{"argument":"pwd"}' } }],
      },
    },
  })
})

test('runner blocks invalid structure when repair is not allowed', async () => {
  const result = await runToolTurn({
    plan,
    tools,
    deps: deps({
      validateStructure: () => ({
        status: 'invalid_structure',
        failure: { kind: 'unknown_tool_name', selectedProtocol: 'managed_xml', detail: 'bad' },
      }),
      canRepair: () => false,
      mapResponse: (input) => ({ mapped: input }),
    }),
  })

  assert.deepEqual(result, {
    status: 'success',
    response: {
      mapped: {
        kind: 'blocked_malformed',
        safeMessage: 'The model attempted a tool call but produced invalid tool-call markup. Chat2API blocked it to avoid executing an unsafe or malformed tool request.',
      },
    },
  })
})
```

- [ ] **Step 2: Run runner tests to verify they fail**

Run:

```powershell
node --test tests/tool-runtime/runner/tool-turn-runner.test.ts
```

Expected: FAIL with missing runner module.

- [ ] **Step 3: Implement runner types**

Create `src/main/proxy/toolRuntime/runner/types.ts`:

```ts
import type { ToolCall } from '../../types.ts'
import type { ToolPlan } from '../control/types.ts'
import type {
  MalformedToolIntent,
  ProtocolStructureResult,
  StructuralRepairResult,
  ToolRuntimeMappingInput,
  ToolValidationOutcome,
  ValidatedCallStructure,
} from '../data/types.ts'
import type { NormalizedToolDefinition } from '../../toolCalling/types.ts'

export interface ModelInvocationResult {
  status: 'completed'
  rawOutput: string
}

export interface ToolTurnRunnerDeps {
  invokeModel(): Promise<ModelInvocationResult>
  extractStructure(rawOutput: string): ProtocolStructureResult
  validateStructure(protocolResult: ProtocolStructureResult): ToolValidationOutcome
  canRepair(intent: MalformedToolIntent | undefined, outcome: ToolValidationOutcome): boolean
  repairStructure(intent: MalformedToolIntent): StructuralRepairResult
  assembleToolCalls(validated: ValidatedCallStructure[], tools: NormalizedToolDefinition[]): ToolCall[]
  mapResponse(input: ToolRuntimeMappingInput): unknown
}

export interface ToolTurnRunnerInput {
  plan: ToolPlan
  tools: NormalizedToolDefinition[]
  deps: ToolTurnRunnerDeps
}

export type ToolTurnRunnerResult =
  | { status: 'success'; response: unknown }
  | { status: 'failed'; error: string }
```

- [ ] **Step 4: Implement ToolTurnRunner**

Create `src/main/proxy/toolRuntime/runner/ToolTurnRunner.ts`:

```ts
import {
  createInitialToolControlState,
  transitionToolState,
} from '../control/ToolStateMachine.ts'
import type {
  ToolEvent,
  ToolOperation,
} from '../control/types.ts'
import type {
  ToolRuntimeMappingInput,
  ToolValidationOutcome,
} from '../data/types.ts'
import type { ToolTurnRunnerInput, ToolTurnRunnerResult } from './types.ts'

export const BLOCKED_MALFORMED_TOOL_MESSAGE =
  'The model attempted a tool call but produced invalid tool-call markup. Chat2API blocked it to avoid executing an unsafe or malformed tool request.'

export async function runToolTurn(input: ToolTurnRunnerInput): Promise<ToolTurnRunnerResult> {
  let state = createInitialToolControlState()
  let event: ToolEvent = { type: 'start' }
  let rawOutput = ''
  let validation: ToolValidationOutcome | undefined
  let mappingInput: ToolRuntimeMappingInput | undefined

  for (let guard = 0; guard < 20; guard += 1) {
    const transition = transitionToolState(state, event)
    state = transition.nextState
    if (transition.nextOperation === null) {
      return { status: 'success', response: input.deps.mapResponse(mappingInput ?? { kind: 'blocked_malformed', safeMessage: BLOCKED_MALFORMED_TOOL_MESSAGE }) }
    }

    const opResult = await executeOperation(transition.nextOperation, input, {
      rawOutput,
      validation,
      mappingInput,
    })

    rawOutput = opResult.rawOutput ?? rawOutput
    validation = opResult.validation ?? validation
    mappingInput = opResult.mappingInput ?? mappingInput
    event = opResult.event
  }

  return { status: 'failed', error: 'Tool turn exceeded transition guard' }
}

async function executeOperation(
  operation: ToolOperation,
  input: ToolTurnRunnerInput,
  context: {
    rawOutput: string
    validation?: ToolValidationOutcome
    mappingInput?: ToolRuntimeMappingInput
  },
): Promise<{
  event: ToolEvent
  rawOutput?: string
  validation?: ToolValidationOutcome
  mappingInput?: ToolRuntimeMappingInput
}> {
  switch (operation) {
    case 'invoke_model': {
      const result = await input.deps.invokeModel()
      return {
        rawOutput: result.rawOutput,
        event: { type: 'operation_succeeded', resultKind: 'model_output' },
      }
    }
    case 'validate_structure':
    case 'validate_repaired_structure': {
      const protocolResult = input.deps.extractStructure(context.rawOutput)
      const validation = input.deps.validateStructure(protocolResult)
      return classifyValidation(input, validation)
    }
    case 'repair_structure': {
      if (!context.validation || context.validation.status !== 'invalid_structure' || !context.validation.malformedIntent) {
        return { event: { type: 'operation_failed', failureKind: 'structural_repair_failed' } }
      }
      const repair = input.deps.repairStructure(context.validation.malformedIntent)
      if (repair.status !== 'repaired') {
        return { event: { type: 'operation_failed', failureKind: 'structural_repair_failed' } }
      }
      return {
        rawOutput: repair.repairedText,
        event: { type: 'operation_succeeded', resultKind: 'repaired_structure_text' },
      }
    }
    case 'assemble_tool_calls': {
      if (!context.validation || context.validation.status !== 'valid_structure') {
        return { event: { type: 'operation_failed', failureKind: 'assembly_failed' } }
      }
      const toolCalls = input.deps.assembleToolCalls(context.validation.validated, input.tools)
      return {
        mappingInput: { kind: 'valid_tool_calls', toolCalls },
        event: { type: 'operation_succeeded', resultKind: 'openai_tool_calls' },
      }
    }
    case 'map_response': {
      return {
        event: { type: 'operation_succeeded', resultKind: 'response_mapped' },
        mappingInput: context.mappingInput ?? { kind: 'blocked_malformed', safeMessage: BLOCKED_MALFORMED_TOOL_MESSAGE },
      }
    }
    case 'delegate_error':
      return { event: { type: 'operation_succeeded', resultKind: 'error_delegated' } }
    case 'gate_stream':
      return { event: { type: 'operation_failed', failureKind: 'stream_error' } }
  }
}

function classifyValidation(
  input: ToolTurnRunnerInput,
  validation: ToolValidationOutcome,
): {
  event: ToolEvent
  validation: ToolValidationOutcome
  mappingInput?: ToolRuntimeMappingInput
} {
  if (validation.status === 'plain_text') {
    return {
      validation,
      mappingInput: { kind: 'plain_text', content: validation.content },
      event: { type: 'operation_succeeded', resultKind: 'plain_text' },
    }
  }

  if (validation.status === 'valid_structure') {
    return {
      validation,
      event: { type: 'operation_succeeded', resultKind: 'valid_structure' },
    }
  }

  const repairable = input.deps.canRepair(validation.malformedIntent, validation)
  return {
    validation,
    event: {
      type: 'operation_failed',
      failureKind: repairable ? 'invalid_structure_repairable' : 'invalid_structure_blocked',
    },
  }
}
```

- [ ] **Step 5: Export runner**

Create `src/main/proxy/toolRuntime/runner/index.ts`:

```ts
export * from './types.ts'
export * from './ToolTurnRunner.ts'
```

- [ ] **Step 6: Run runner tests**

Run:

```powershell
node --test tests/tool-runtime/runner/tool-turn-runner.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 1**

Run:

```powershell
git add src/main/proxy/toolRuntime/runner tests/tool-runtime/runner/tool-turn-runner.test.ts
git commit -m "feat: add tool turn runner shell"
```

Expected: commit includes only runner files and tests.

---

### Task 2: ToolCallingEngine Non-Stream Facade

**Files:**
- Modify: `src/main/proxy/toolCalling/ToolCallingEngine.ts`
- Modify/Create: `tests/tool-calling/tool-engine.test.ts`

- [ ] **Step 1: Add failing facade regression tests**

Append to `tests/tool-calling/tool-engine.test.ts`:

```ts
import { ToolCallingEngine } from '../../src/main/proxy/toolCalling/ToolCallingEngine.ts'

test('ToolCallingEngine non-stream blocks mixed protocol output before tool_calls', () => {
  const engine = new ToolCallingEngine({
    enabled: true,
    mode: 'force',
    clientAdapterId: 'standard-openai-tools',
    diagnosticsEnabled: false,
    advanced: { promptPreviewEnabled: false },
  })

  const transform = engine.transformRequest({
    request: {
      model: 'qwen-test',
      messages: [{ role: 'user', content: 'list files' }],
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
    provider: {
      id: 'qwen',
      name: 'Qwen',
      type: 'builtin',
      authType: 'token',
      apiEndpoint: '',
      headers: {},
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    },
    actualModel: 'qwen-test',
  })

  const response = {
    choices: [{
      message: {
        role: 'assistant',
        content: '<|CHAT2API|tool_calls><|CHAT2API|invoke name="bash"><|CHAT2API|parameter name="argument"><![CDATA[pwd]]></arg_value></tool_call>',
      },
      finish_reason: 'stop',
    }],
  }

  engine.applyNonStreamResponse(response, transform.plan)

  assert.equal(response.choices[0].message.content, null)
  assert.equal(response.choices[0].finish_reason, 'tool_calls')
  assert.equal(response.choices[0].message.tool_calls[0].function.name, 'bash')
  assert.equal(response.choices[0].message.tool_calls[0].function.arguments, '{"argument":"pwd"}')
})
```

- [ ] **Step 2: Run the targeted facade test to verify current behavior**

Run:

```powershell
node --test tests/tool-calling/tool-engine.test.ts
```

Expected: FAIL until `ToolCallingEngine.applyNonStreamResponse` delegates to the new structure chain.

- [ ] **Step 3: Refactor `applyNonStreamResponse` to use the new runtime chain**

Modify `src/main/proxy/toolCalling/ToolCallingEngine.ts`.

Add imports:

```ts
import type { MalformedToolIntent } from '../toolRuntime/data/index.ts'
import {
  assembleOpenAIToolCalls,
  getStructureProtocolAdapter,
  repairStructure,
  validateToolCallStructure,
} from '../toolRuntime/data/index.ts'
```

Replace the body of `applyNonStreamResponse` with:

```ts
  applyNonStreamResponse(result: any, plan: ToolCallingPlan): void {
    if (!plan.shouldParseResponse) return

    const message = result?.choices?.[0]?.message
    if (!message || typeof message.content !== 'string') return

    const adapter = getStructureProtocolAdapter(plan.protocol)
    const firstStructure = adapter.extractStructure(message.content)
    const firstValidation = validateToolCallStructure({
      plan: {
        profile: 'managed_buffered_structural',
        protocol: plan.protocol,
        allowedToolNames: [...plan.allowedToolNames],
        forcedToolName: plan.forcedToolName,
        diagnostics: {
          providerId: plan.providerId,
          model: plan.diagnostics.model,
          actualModel: plan.diagnostics.actualModel,
          profile: 'managed_buffered_structural',
          mode: 'managed',
          protocol: plan.protocol,
          reason: plan.diagnostics.reason,
          toolCount: plan.tools.length,
          toolChoiceMode: plan.toolChoiceMode,
          forcedToolName: plan.forcedToolName,
          allowedToolNames: [...plan.allowedToolNames],
        },
      },
      protocolResult: firstStructure,
      tools: plan.tools,
    })

    const validation = firstValidation.status === 'invalid_structure' && firstValidation.malformedIntent
      ? validateRepaired(adapter, firstValidation.malformedIntent, plan)
      : firstValidation

    if (validation.status === 'plain_text') {
      plan.diagnostics.parserFormat = 'unknown'
      plan.diagnostics.parsedToolCallCount = 0
      return
    }

    if (validation.status === 'invalid_structure') {
      plan.diagnostics.parserFormat = plan.protocol
      plan.diagnostics.parsedToolCallCount = 0
      plan.diagnostics.malformedReason = validation.failure.kind
      return
    }

    const toolCalls = assembleOpenAIToolCalls({
      validated: validation.validated,
      tools: plan.tools,
    })
    if (toolCalls.length === 0) return

    message.content = validation.cleanContent || null
    message.tool_calls = toolCalls
    result.choices[0].finish_reason = 'tool_calls'
    plan.diagnostics.parserFormat = plan.protocol
    plan.diagnostics.parsedToolCallCount = toolCalls.length
  }
```

Add helper below `injectPrompt`:

```ts
function validateRepaired(
  adapter: ReturnType<typeof getStructureProtocolAdapter>,
  malformedIntent: MalformedToolIntent,
  plan: ToolCallingPlan,
) {
  const repaired = repairStructure(malformedIntent)
  if (repaired.status !== 'repaired') {
    return {
      status: 'invalid_structure' as const,
      failure: {
        kind: 'malformed_container' as const,
        selectedProtocol: plan.protocol,
        detail: repaired.reason,
      },
    }
  }

  return validateToolCallStructure({
    plan: {
      profile: 'managed_buffered_structural',
      protocol: plan.protocol,
      allowedToolNames: [...plan.allowedToolNames],
      forcedToolName: plan.forcedToolName,
      diagnostics: {
        providerId: plan.providerId,
        model: plan.diagnostics.model,
        actualModel: plan.diagnostics.actualModel,
        profile: 'managed_buffered_structural',
        mode: 'managed',
        protocol: plan.protocol,
        reason: plan.diagnostics.reason,
        toolCount: plan.tools.length,
        toolChoiceMode: plan.toolChoiceMode,
        forcedToolName: plan.forcedToolName,
        allowedToolNames: [...plan.allowedToolNames],
      },
    },
    protocolResult: adapter.extractStructure(repaired.repairedText),
    tools: plan.tools,
  })
}
```

- [ ] **Step 4: Remove old non-stream parser helper**

In `src/main/proxy/toolCalling/ToolCallingEngine.ts`, remove the now-unused `parseSelectedProtocol` function. Keep the `getToolProtocol` import because `renderPrompt` still uses it.

- [ ] **Step 5: Run facade tests**

Run:

```powershell
node --test tests/tool-calling/tool-engine.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run runtime tests plus facade tests**

Run:

```powershell
node --test tests/tool-runtime/control/*.test.ts tests/tool-runtime/data/*.test.ts tests/tool-runtime/runner/*.test.ts tests/tool-calling/tool-engine.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

Run:

```powershell
git add src/main/proxy/toolCalling/ToolCallingEngine.ts tests/tool-calling/tool-engine.test.ts
git commit -m "feat: route non-stream tool parsing through runtime"
```

Expected: commit includes only ToolCallingEngine and its tests.

---

## Batch Verification

After Tasks 1-2 are complete, run:

```powershell
node --test tests/tool-runtime/control/*.test.ts tests/tool-runtime/data/*.test.ts tests/tool-runtime/runner/*.test.ts tests/tool-calling/tool-engine.test.ts
```

Then run the project deterministic subset:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

Expected: PASS, or failures clearly unrelated to this batch and documented before moving on.

Do not run the OpenCode model probe for this batch unless this is the last integration batch being accepted.

## Self-Review Checklist

- Runner has no XML regexes or provider-specific logic.
- Runner uses dependency outputs and FSM events only.
- `ToolCallingEngine` no longer creates non-stream `tool_calls` through the old parser path.
- Mixed protocol non-stream output is structurally repaired and revalidated before `tool_calls`.
- Provider adapters are untouched.
