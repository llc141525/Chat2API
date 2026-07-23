# Tool Runtime Structural Repair and Assembler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the third batch of the Chat2API single truth tool runtime: deterministic structural repair and the single OpenAI `tool_calls` assembler.

**Architecture:** This batch keeps repair and assembly separate. `StructuralRepair` receives only `MalformedToolIntent` and returns canonical selected-protocol text; it never validates, parses raw model output, or emits tool calls. `ToolCallAssembler` receives only `ValidatedCallStructure[]` and is the only component in the runtime allowed to create OpenAI `ToolCall[]`.

**Tech Stack:** TypeScript, Node.js built-in test runner (`node --test`), existing Chat2API `ToolCall` response type.

---

## Prerequisites

Complete these earlier batches first:

- [`docs/superpowers/plans/2026-06-30-tool-runtime-control-plane.md`](./2026-06-30-tool-runtime-control-plane.md)
- [`docs/superpowers/plans/2026-06-30-tool-runtime-structure-chain.md`](./2026-06-30-tool-runtime-structure-chain.md)

This plan assumes these files exist:

- `src/main/proxy/toolRuntime/control/index.ts`
- `src/main/proxy/toolRuntime/data/types.ts`
- `src/main/proxy/toolRuntime/data/protocols/managedXmlStructure.ts`
- `src/main/proxy/toolRuntime/data/validation/ToolCallValidator.ts`
- `src/main/proxy/toolRuntime/data/index.ts`

## Scope

This plan implements:

- `StructuralRepair` result types.
- Deterministic managed XML structural rewrap.
- Tests proving repair does not add, remove, rename, normalize, or semantically rewrite payloads.
- Tests proving repaired text must re-enter selected `ProtocolAdapter` and `ToolCallValidator`.
- `ToolCallAssembler` as the only OpenAI `tool_calls` generation point.

This plan intentionally does not implement:

- Model repair/rewrite.
- `RepairPolicy`.
- `ToolTurnRunner`.
- `OpenAIResponseMapper`.
- `StreamGate`.
- Integration into `ToolCallingEngine`, `forwarder`, or provider adapters.

## File Structure

- Modify: `src/main/proxy/toolRuntime/data/types.ts`
  - Add repair result and assembler input types.
- Create: `src/main/proxy/toolRuntime/data/repair/StructuralRepair.ts`
  - Owns deterministic canonical rewrap from `MalformedToolIntent`.
- Create: `src/main/proxy/toolRuntime/data/assembly/ToolCallAssembler.ts`
  - Owns conversion from `ValidatedCallStructure[]` to OpenAI-compatible `ToolCall[]`.
- Modify: `src/main/proxy/toolRuntime/data/index.ts`
  - Re-export repair and assembler APIs.
- Create: `tests/tool-runtime/data/structural-repair.test.ts`
  - Verifies semantics-preserving repair and revalidation.
- Create: `tests/tool-runtime/data/assembler.test.ts`
  - Verifies assembler output and strict non-repair behavior.

## Boundary Rules

- `StructuralRepair` may import `MalformedToolIntent` and `StructuralRepairResult`.
- `StructuralRepair` must not import `ToolCall`, `NormalizedToolDefinition`, `ToolPlan`, `ToolCallValidator`, or protocol registry.
- `StructuralRepair` must not accept raw model output.
- `StructuralRepair` must not parse tool names from strings.
- `StructuralRepair` must not add, remove, reorder, or rename parameters.
- `StructuralRepair` must not normalize JSON or XML-decode payloads.
- `ToolCallAssembler` is the only new file in this batch allowed to import `ToolCall` from `src/main/proxy/types.ts`.
- `ToolCallAssembler` must not import `ProtocolAdapter`, `StructuralRepair`, or `ToolCallValidator`.

---

### Task 1: StructuralRepair Types and Deterministic Rewrap

**Files:**
- Modify: `src/main/proxy/toolRuntime/data/types.ts`
- Create: `src/main/proxy/toolRuntime/data/repair/StructuralRepair.ts`
- Modify: `src/main/proxy/toolRuntime/data/index.ts`
- Create: `tests/tool-runtime/data/structural-repair.test.ts`

- [ ] **Step 1: Write the failing structural repair tests**

Create `tests/tool-runtime/data/structural-repair.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  managedXmlStructureAdapter,
  repairStructure,
  validateToolCallStructure,
} from '../../../src/main/proxy/toolRuntime/data/index.ts'
import type { MalformedToolIntent } from '../../../src/main/proxy/toolRuntime/data/index.ts'
import type { ToolPlan } from '../../../src/main/proxy/toolRuntime/control/index.ts'
import type { NormalizedToolDefinition } from '../../../src/main/proxy/toolCalling/types.ts'

const bashTool: NormalizedToolDefinition = {
  name: 'bash',
  description: 'Run a shell command',
  parameters: {
    type: 'object',
    properties: {
      argument: { type: 'string' },
    },
    required: ['argument'],
  },
  source: 'openai',
}

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

const malformedIntent: MalformedToolIntent = {
  selectedProtocol: 'managed_xml',
  toolName: 'bash',
  parameters: [{
    name: 'argument',
    rawPayload: 'Get-ChildItem D:\\\\ | Select-Object Name',
    payloadEncoding: 'cdata',
  }],
  rawContainerFingerprint: 'fingerprint-1',
  failureKind: 'mixed_protocol_container',
}

test('deterministic repair rewraps malformed intent into managed XML', () => {
  const result = repairStructure(malformedIntent)

  assert.deepEqual(result, {
    status: 'repaired',
    protocol: 'managed_xml',
    method: 'deterministic_rewrap',
    repairedText: '<|CHAT2API|tool_calls><|CHAT2API|invoke name="bash"><|CHAT2API|parameter name="argument"><![CDATA[Get-ChildItem D:\\\\ | Select-Object Name]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
  })
})

test('repair preserves tool name, parameter name, and raw payload exactly', () => {
  const payload = '{"argument":"keep <xml> & JSON exactly", "trailing": true}'
  const intent: MalformedToolIntent = {
    ...malformedIntent,
    toolName: 'bash',
    parameters: [{
      name: 'argument',
      rawPayload: payload,
      payloadEncoding: 'cdata',
    }],
  }

  const result = repairStructure(intent)
  assert.equal(result.status, 'repaired')
  if (result.status !== 'repaired') throw new Error('expected repaired')

  assert.match(result.repairedText, /<\|CHAT2API\|invoke name="bash">/)
  assert.match(result.repairedText, /<\|CHAT2API\|parameter name="argument">/)
  assert.equal(result.repairedText.includes(`<![CDATA[${payload}]]>`), true)
})

test('repair escapes only container attribute names, not payload contents', () => {
  const intent: MalformedToolIntent = {
    ...malformedIntent,
    toolName: 'tool"name&<>',
    parameters: [{
      name: 'arg"name&<>',
      rawPayload: 'payload & <tag attr="value">',
      payloadEncoding: 'cdata',
    }],
  }

  const result = repairStructure(intent)
  assert.equal(result.status, 'repaired')
  if (result.status !== 'repaired') throw new Error('expected repaired')

  assert.match(result.repairedText, /name="tool&quot;name&amp;&lt;&gt;"/)
  assert.match(result.repairedText, /name="arg&quot;name&amp;&lt;&gt;"/)
  assert.equal(result.repairedText.includes('<![CDATA[payload & <tag attr="value">]]>'), true)
})

test('repair rejects unsupported protocols instead of guessing a format', () => {
  const result = repairStructure({
    ...malformedIntent,
    selectedProtocol: 'managed_bracket',
  })

  assert.deepEqual(result, {
    status: 'not_repairable',
    reason: 'Unsupported repair protocol: managed_bracket',
  })
})

test('repair rejects malformed intent with no parameters', () => {
  const result = repairStructure({
    ...malformedIntent,
    parameters: [],
  })

  assert.deepEqual(result, {
    status: 'not_repairable',
    reason: 'Cannot repair a tool call with no extracted parameters',
  })
})

test('repaired text must re-enter adapter and validator before becoming valid structure', () => {
  const repair = repairStructure(malformedIntent)
  assert.equal(repair.status, 'repaired')
  if (repair.status !== 'repaired') throw new Error('expected repaired')

  const reparsed = managedXmlStructureAdapter.extractStructure(repair.repairedText)
  const validation = validateToolCallStructure({ plan, protocolResult: reparsed, tools: [bashTool] })

  assert.equal(validation.status, 'valid_structure')
  if (validation.status !== 'valid_structure') throw new Error('expected valid structure')

  assert.deepEqual(validation.validated, [{
    callIndex: 0,
    toolName: 'bash',
    parameters: [{
      name: 'argument',
      rawPayload: 'Get-ChildItem D:\\\\ | Select-Object Name',
      payloadEncoding: 'cdata',
    }],
  }])
})
```

- [ ] **Step 2: Run the structural repair tests to verify they fail**

Run:

```powershell
node --test tests/tool-runtime/data/structural-repair.test.ts
```

Expected: FAIL with missing export `repairStructure`.

- [ ] **Step 3: Add repair result types**

Append these types to `src/main/proxy/toolRuntime/data/types.ts`:

```ts
export type StructuralRepairResult =
  | {
      status: 'repaired'
      protocol: ToolProtocolId
      repairedText: string
      method: 'deterministic_rewrap'
    }
  | {
      status: 'not_repairable'
      reason: string
    }
```

- [ ] **Step 4: Implement deterministic StructuralRepair**

Create `src/main/proxy/toolRuntime/data/repair/StructuralRepair.ts`:

```ts
import type { MalformedToolIntent, StructuralRepairResult } from '../types.ts'

const CHAT2API_START = '<|CHAT2API|tool_calls>'
const CHAT2API_END = '</|CHAT2API|tool_calls>'

export function repairStructure(intent: MalformedToolIntent): StructuralRepairResult {
  if (intent.selectedProtocol !== 'managed_xml') {
    return {
      status: 'not_repairable',
      reason: `Unsupported repair protocol: ${intent.selectedProtocol}`,
    }
  }

  if (intent.parameters.length === 0) {
    return {
      status: 'not_repairable',
      reason: 'Cannot repair a tool call with no extracted parameters',
    }
  }

  const params = intent.parameters
    .map((parameter) => {
      return `<|CHAT2API|parameter name="${escapeXmlAttribute(parameter.name)}">${wrapPayload(parameter.rawPayload, parameter.payloadEncoding)}</|CHAT2API|parameter>`
    })
    .join('')

  return {
    status: 'repaired',
    protocol: intent.selectedProtocol,
    method: 'deterministic_rewrap',
    repairedText: `${CHAT2API_START}<|CHAT2API|invoke name="${escapeXmlAttribute(intent.toolName)}">${params}</|CHAT2API|invoke>${CHAT2API_END}`,
  }
}

function wrapPayload(payload: string, encoding: MalformedToolIntent['parameters'][number]['payloadEncoding']): string {
  if (encoding === 'cdata') {
    return `<![CDATA[${payload}]]>`
  }

  return escapeXmlText(payload)
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
```

- [ ] **Step 5: Export StructuralRepair**

Modify `src/main/proxy/toolRuntime/data/index.ts`:

```ts
export * from './types.ts'
export * from './protocols/ProtocolAdapter.ts'
export * from './protocols/managedXmlStructure.ts'
export * from './protocols/registry.ts'
export * from './validation/ToolCallValidator.ts'
export * from './repair/StructuralRepair.ts'
```

- [ ] **Step 6: Run repair tests**

Run:

```powershell
node --test tests/tool-runtime/data/structural-repair.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 1**

Run:

```powershell
git add src/main/proxy/toolRuntime/data/types.ts src/main/proxy/toolRuntime/data/repair/StructuralRepair.ts src/main/proxy/toolRuntime/data/index.ts tests/tool-runtime/data/structural-repair.test.ts
git commit -m "feat: add deterministic structural repair"
```

Expected: commit includes only repair-related files.

---

### Task 2: ToolCallAssembler as the Only Tool Call Generator

**Files:**
- Modify: `src/main/proxy/toolRuntime/data/types.ts`
- Create: `src/main/proxy/toolRuntime/data/assembly/ToolCallAssembler.ts`
- Modify: `src/main/proxy/toolRuntime/data/index.ts`
- Create: `tests/tool-runtime/data/assembler.test.ts`

- [ ] **Step 1: Write the failing assembler tests**

Create `tests/tool-runtime/data/assembler.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'

import { assembleOpenAIToolCalls } from '../../../src/main/proxy/toolRuntime/data/index.ts'
import type { ValidatedCallStructure } from '../../../src/main/proxy/toolRuntime/data/index.ts'
import type { NormalizedToolDefinition } from '../../../src/main/proxy/toolCalling/types.ts'

const tools: NormalizedToolDefinition[] = [{
  name: 'bash',
  description: 'Run a shell command',
  parameters: {
    type: 'object',
    properties: {
      argument: { type: 'string' },
    },
    required: ['argument'],
  },
  source: 'openai',
}]

test('assembler converts validated structure into OpenAI tool_calls', () => {
  const validated: ValidatedCallStructure[] = [{
    callIndex: 0,
    toolName: 'bash',
    parameters: [{
      name: 'argument',
      rawPayload: 'pwd',
      payloadEncoding: 'cdata',
    }],
  }]

  const calls = assembleOpenAIToolCalls({ validated, tools })

  assert.deepEqual(calls, [{
    id: 'call_0',
    index: 0,
    type: 'function',
    function: {
      name: 'bash',
      arguments: JSON.stringify({ argument: 'pwd' }),
    },
  }])
})

test('assembler preserves raw payload content without JSON repair', () => {
  const payload = '{"unterminated": true'
  const validated: ValidatedCallStructure[] = [{
    callIndex: 0,
    toolName: 'bash',
    parameters: [{
      name: 'argument',
      rawPayload: payload,
      payloadEncoding: 'cdata',
    }],
  }]

  const calls = assembleOpenAIToolCalls({ validated, tools })
  assert.equal(calls[0].function.arguments, JSON.stringify({ argument: payload }))
})

test('assembler keeps repeated parameter names as arrays without inventing names', () => {
  const validated: ValidatedCallStructure[] = [{
    callIndex: 0,
    toolName: 'bash',
    parameters: [
      { name: 'argument', rawPayload: 'one', payloadEncoding: 'text' },
      { name: 'argument', rawPayload: 'two', payloadEncoding: 'text' },
    ],
  }]

  const calls = assembleOpenAIToolCalls({ validated, tools })
  assert.equal(calls[0].function.arguments, JSON.stringify({ argument: ['one', 'two'] }))
})

test('assembler rejects validated structure for undeclared tool', () => {
  const validated: ValidatedCallStructure[] = [{
    callIndex: 0,
    toolName: 'python',
    parameters: [{
      name: 'argument',
      rawPayload: 'print(1)',
      payloadEncoding: 'text',
    }],
  }]

  assert.throws(
    () => assembleOpenAIToolCalls({ validated, tools }),
    /Cannot assemble undeclared tool python/,
  )
})

test('assembler does not add missing required parameters', () => {
  const validated: ValidatedCallStructure[] = [{
    callIndex: 0,
    toolName: 'bash',
    parameters: [],
  }]

  const calls = assembleOpenAIToolCalls({ validated, tools })
  assert.equal(calls[0].function.arguments, '{}')
})
```

- [ ] **Step 2: Run assembler tests to verify they fail**

Run:

```powershell
node --test tests/tool-runtime/data/assembler.test.ts
```

Expected: FAIL with missing export `assembleOpenAIToolCalls`.

- [ ] **Step 3: Add assembler input type**

Append this type to `src/main/proxy/toolRuntime/data/types.ts`:

```ts
export interface ToolCallAssemblerInput {
  validated: ValidatedCallStructure[]
  tools: NormalizedToolDefinition[]
}
```

- [ ] **Step 4: Implement ToolCallAssembler**

Create `src/main/proxy/toolRuntime/data/assembly/ToolCallAssembler.ts`:

```ts
import type { ToolCall } from '../../../types.ts'
import type { ToolCallAssemblerInput, ValidatedParameterStructure } from '../types.ts'

export function assembleOpenAIToolCalls(input: ToolCallAssemblerInput): ToolCall[] {
  return input.validated.map((call) => {
    if (!input.tools.some((tool) => tool.name === call.toolName)) {
      throw new Error(`Cannot assemble undeclared tool ${call.toolName}`)
    }

    return {
      id: `call_${call.callIndex}`,
      index: call.callIndex,
      type: 'function',
      function: {
        name: call.toolName,
        arguments: JSON.stringify(parametersToObject(call.parameters)),
      },
    }
  })
}

function parametersToObject(parameters: ValidatedParameterStructure[]): Record<string, unknown> {
  return parameters.reduce<Record<string, unknown>>((acc, parameter) => {
    const value = unwrapParameterPayload(parameter)
    const existing = acc[parameter.name]

    if (existing === undefined) {
      return { ...acc, [parameter.name]: value }
    }

    if (Array.isArray(existing)) {
      return { ...acc, [parameter.name]: [...existing, value] }
    }

    return { ...acc, [parameter.name]: [existing, value] }
  }, {})
}

function unwrapParameterPayload(parameter: ValidatedParameterStructure): string {
  return parameter.rawPayload
}
```

- [ ] **Step 5: Export ToolCallAssembler**

Modify `src/main/proxy/toolRuntime/data/index.ts`:

```ts
export * from './types.ts'
export * from './protocols/ProtocolAdapter.ts'
export * from './protocols/managedXmlStructure.ts'
export * from './protocols/registry.ts'
export * from './validation/ToolCallValidator.ts'
export * from './repair/StructuralRepair.ts'
export * from './assembly/ToolCallAssembler.ts'
```

- [ ] **Step 6: Run assembler tests**

Run:

```powershell
node --test tests/tool-runtime/data/assembler.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

Run:

```powershell
git add src/main/proxy/toolRuntime/data/types.ts src/main/proxy/toolRuntime/data/assembly/ToolCallAssembler.ts src/main/proxy/toolRuntime/data/index.ts tests/tool-runtime/data/assembler.test.ts
git commit -m "feat: add OpenAI tool call assembler"
```

Expected: commit includes only assembler-related files.

---

### Task 3: End-to-End Structure Chain Regression

**Files:**
- Create: `tests/tool-runtime/data/repair-assembler-chain.test.ts`

- [ ] **Step 1: Write the end-to-end chain test**

Create `tests/tool-runtime/data/repair-assembler-chain.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assembleOpenAIToolCalls,
  managedXmlStructureAdapter,
  repairStructure,
  validateToolCallStructure,
} from '../../../src/main/proxy/toolRuntime/data/index.ts'
import type { ToolPlan } from '../../../src/main/proxy/toolRuntime/control/index.ts'
import type { NormalizedToolDefinition } from '../../../src/main/proxy/toolCalling/types.ts'

const bashTool: NormalizedToolDefinition = {
  name: 'bash',
  description: 'Run a shell command',
  parameters: {
    type: 'object',
    properties: {
      argument: { type: 'string' },
    },
    required: ['argument'],
  },
  source: 'openai',
}

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

test('mixed protocol output repairs structurally, revalidates, then assembles tool_calls', () => {
  const raw = '<|CHAT2API|tool_calls><|CHAT2API|invoke name="bash"><|CHAT2API|parameter name="argument"><![CDATA[pwd]]></arg_value></tool_call>'
  const firstParse = managedXmlStructureAdapter.extractStructure(raw)
  const firstValidation = validateToolCallStructure({ plan, protocolResult: firstParse, tools: [bashTool] })

  assert.equal(firstValidation.status, 'invalid_structure')
  if (firstValidation.status !== 'invalid_structure') throw new Error('expected invalid structure')
  assert.equal('tool_calls' in firstValidation, false)
  assert.equal('toolCalls' in firstValidation, false)

  assert.ok(firstValidation.malformedIntent)
  const repair = repairStructure(firstValidation.malformedIntent)
  assert.equal(repair.status, 'repaired')
  if (repair.status !== 'repaired') throw new Error('expected repaired')

  const secondParse = managedXmlStructureAdapter.extractStructure(repair.repairedText)
  const secondValidation = validateToolCallStructure({ plan, protocolResult: secondParse, tools: [bashTool] })

  assert.equal(secondValidation.status, 'valid_structure')
  if (secondValidation.status !== 'valid_structure') throw new Error('expected valid structure')

  const calls = assembleOpenAIToolCalls({ validated: secondValidation.validated, tools: [bashTool] })
  assert.deepEqual(calls, [{
    id: 'call_0',
    index: 0,
    type: 'function',
    function: {
      name: 'bash',
      arguments: JSON.stringify({ argument: 'pwd' }),
    },
  }])
})
```

- [ ] **Step 2: Run the end-to-end chain test**

Run:

```powershell
node --test tests/tool-runtime/data/repair-assembler-chain.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run all runtime tests**

Run:

```powershell
node --test tests/tool-runtime/control/*.test.ts tests/tool-runtime/data/*.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run focused TypeScript check**

Run:

```powershell
npx tsc --noEmit --target ES2020 --module ESNext --moduleResolution bundler --strict --skipLibCheck --allowImportingTsExtensions src\main\proxy\toolRuntime\control\types.ts src\main\proxy\toolRuntime\control\executionProfiles.ts src\main\proxy\toolRuntime\control\ToolPlanner.ts src\main\proxy\toolRuntime\control\ToolStateMachine.ts src\main\proxy\toolRuntime\control\index.ts src\main\proxy\toolRuntime\data\types.ts src\main\proxy\toolRuntime\data\protocols\ProtocolAdapter.ts src\main\proxy\toolRuntime\data\protocols\managedXmlStructure.ts src\main\proxy\toolRuntime\data\protocols\registry.ts src\main\proxy\toolRuntime\data\validation\ToolCallValidator.ts src\main\proxy\toolRuntime\data\repair\StructuralRepair.ts src\main\proxy\toolRuntime\data\assembly\ToolCallAssembler.ts src\main\proxy\toolRuntime\data\index.ts tests\tool-runtime\control\execution-profiles.test.ts tests\tool-runtime\control\tool-planner.test.ts tests\tool-runtime\control\tool-state-machine.test.ts tests\tool-runtime\data\managed-xml-structure.test.ts tests\tool-runtime\data\protocol-registry.test.ts tests\tool-runtime\data\validator.test.ts tests\tool-runtime\data\structural-repair.test.ts tests\tool-runtime\data\assembler.test.ts tests\tool-runtime\data\repair-assembler-chain.test.ts
```

Expected: PASS, or only pre-existing errors outside `src/main/proxy/toolRuntime` and `tests/tool-runtime`.

- [ ] **Step 5: Commit Task 3**

Run:

```powershell
git add tests/tool-runtime/data/repair-assembler-chain.test.ts
git commit -m "test: cover structural repair assembly chain"
```

Expected: commit includes only the end-to-end chain test.

---

## Batch Verification

After Tasks 1-3 are complete, run:

```powershell
node --test tests/tool-runtime/control/*.test.ts tests/tool-runtime/data/*.test.ts
```

Expected: all runtime control/data tests pass.

Then run the focused TypeScript command from Task 3 Step 4.

Do not run the full AGENTS final gate for this batch. This batch still does not alter the live forwarding/tool-calling path.

## Self-Review Checklist

- `StructuralRepair` accepts only `MalformedToolIntent`, not raw model output.
- `StructuralRepair` does not import validator, protocol registry, tool definitions, or `ToolCall`.
- `StructuralRepair` does not add, remove, rename, reorder, normalize, or semantically rewrite payloads.
- Repaired text re-enters `managedXmlStructureAdapter` and `validateToolCallStructure` before assembly.
- `ToolCallAssembler` is the only new file importing `ToolCall`.
- `ToolCallAssembler` does not import repair, validation, or protocol adapters.
- Mixed protocol output cannot become OpenAI `tool_calls` until it passes parse -> validate -> repair -> parse -> validate -> assemble.
- Existing `ToolCallingEngine`, provider adapters, stream parsers, and forwarder are untouched.
