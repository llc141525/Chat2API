# Tool Runtime StreamGate and ResponseMapper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the fourth batch of the Chat2API single truth tool runtime: stream gating and OpenAI response mapping.

**Architecture:** `StreamGate` is an I/O data-plane component. It either passes text chunks through or buffers all chunks for tool requests; it does not parse, validate, repair, assemble, or map. `OpenAIResponseMapper` accepts already-classified runtime outputs and maps them into OpenAI-compatible non-stream and stream response objects.

**Tech Stack:** TypeScript, Node.js built-in test runner (`node --test`), existing Chat2API `ChatCompletionResponse` and `ToolCall` types.

---

## Prerequisites

Complete these earlier plans first:

- [`docs/superpowers/plans/2026-06-30-tool-runtime-control-plane.md`](./2026-06-30-tool-runtime-control-plane.md)
- [`docs/superpowers/plans/2026-06-30-tool-runtime-structure-chain.md`](./2026-06-30-tool-runtime-structure-chain.md)
- [`docs/superpowers/plans/2026-06-30-tool-runtime-repair-assembler.md`](./2026-06-30-tool-runtime-repair-assembler.md)

## Scope

This plan implements:

- `StreamGate` v1 modes:
  - `pass_through`
  - `full_buffer`
  - `incremental_safe_buffer` interface shape only
- `StreamGateFacts`
- OpenAI non-stream response mapping
- OpenAI stream chunk object mapping
- Safe blocked malformed response mapping

This plan intentionally does not implement:

- Streaming SSE serialization.
- Provider stream consumption.
- Incremental marker heuristics beyond facts shape.
- Runner integration.
- `ToolCallingEngine`, `forwarder`, or provider adapter changes.

## File Structure

- Modify: `src/main/proxy/toolRuntime/data/types.ts`
  - Add stream gate and response mapping types.
- Create: `src/main/proxy/toolRuntime/data/stream/StreamGate.ts`
  - Owns chunk pass-through/buffering facts.
- Create: `src/main/proxy/toolRuntime/data/mapping/OpenAIResponseMapper.ts`
  - Owns non-stream and stream-compatible OpenAI response object mapping.
- Modify: `src/main/proxy/toolRuntime/data/index.ts`
  - Re-export stream and mapper APIs.
- Create: `tests/tool-runtime/data/stream-gate.test.ts`
  - Tests pass-through, full-buffer, split marker buffering, and facts shape.
- Create: `tests/tool-runtime/data/response-mapper.test.ts`
  - Tests tool calls, plain text, and blocked malformed mapping.

## Boundary Rules

- `StreamGate` must not import protocol adapters, validator, repair, assembler, or response mapper.
- `StreamGate` must not produce `ToolCall[]`.
- `OpenAIResponseMapper` must not parse raw model output.
- `OpenAIResponseMapper` must not validate, repair, or assemble tool calls.
- `OpenAIResponseMapper` only accepts mapping input kinds that already contain final data.

---

### Task 1: StreamGate Types and Behavior

**Files:**
- Modify: `src/main/proxy/toolRuntime/data/types.ts`
- Create: `src/main/proxy/toolRuntime/data/stream/StreamGate.ts`
- Modify: `src/main/proxy/toolRuntime/data/index.ts`
- Create: `tests/tool-runtime/data/stream-gate.test.ts`

- [ ] **Step 1: Write the failing StreamGate tests**

Create `tests/tool-runtime/data/stream-gate.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createStreamGateState,
  finishStreamGate,
  ingestStreamChunk,
} from '../../../src/main/proxy/toolRuntime/data/index.ts'

test('pass_through releases chunks immediately and records escaped ranges', () => {
  let state = createStreamGateState('pass_through')
  const first = ingestStreamChunk(state, 'hello ')
  state = first.state
  const second = ingestStreamChunk(state, 'world')
  state = second.state
  const finished = finishStreamGate(state)

  assert.deepEqual(first.releasedChunks, ['hello '])
  assert.deepEqual(second.releasedChunks, ['world'])
  assert.equal(finished.rawOutput, 'hello world')
  assert.equal(finished.facts.hasEscapedToClient, true)
  assert.deepEqual(finished.facts.escapedRanges, [
    { start: 0, end: 6, classification: 'plain_text' },
    { start: 6, end: 11, classification: 'plain_text' },
  ])
})

test('full_buffer releases nothing until finish and reports no escaped bytes', () => {
  let state = createStreamGateState('full_buffer')
  const first = ingestStreamChunk(state, '<|CHAT2API|tool')
  state = first.state
  const second = ingestStreamChunk(state, '_calls>')
  state = second.state
  const finished = finishStreamGate(state)

  assert.deepEqual(first.releasedChunks, [])
  assert.deepEqual(second.releasedChunks, [])
  assert.equal(finished.rawOutput, '<|CHAT2API|tool_calls>')
  assert.equal(finished.facts.hasEscapedToClient, false)
  assert.deepEqual(finished.facts.escapedRanges, [])
})

test('full_buffer records marker facts even when marker is split across chunks', () => {
  let state = createStreamGateState('full_buffer')
  state = ingestStreamChunk(state, 'prefix <|CHAT2API|tool').state
  state = ingestStreamChunk(state, '_calls> suffix').state
  const finished = finishStreamGate(state)

  assert.deepEqual(finished.facts.detectedMarkers, [{
    protocol: 'managed_xml',
    marker: '<|CHAT2API|tool_calls>',
    offset: 7,
    confidence: 'full',
  }])
})

test('incremental_safe_buffer is accepted as an interface mode but does not release chunks in v1', () => {
  let state = createStreamGateState('incremental_safe_buffer')
  const update = ingestStreamChunk(state, 'hello')
  state = update.state
  const finished = finishStreamGate(state)

  assert.deepEqual(update.releasedChunks, [])
  assert.equal(finished.rawOutput, 'hello')
  assert.equal(finished.facts.mode, 'incremental_safe_buffer')
  assert.equal(finished.facts.hasEscapedToClient, false)
})
```

- [ ] **Step 2: Run StreamGate tests to verify they fail**

Run:

```powershell
node --test tests/tool-runtime/data/stream-gate.test.ts
```

Expected: FAIL with missing exports for `createStreamGateState`, `ingestStreamChunk`, and `finishStreamGate`.

- [ ] **Step 3: Add StreamGate types**

Append to `src/main/proxy/toolRuntime/data/types.ts`:

```ts
import type { StreamGateMode } from '../control/types.ts'

export type EscapedRangeClassification = 'plain_text' | 'unknown'

export interface StreamGateFacts {
  mode: StreamGateMode
  hasEscapedToClient: boolean
  escapedRanges: Array<{
    start: number
    end: number
    classification: EscapedRangeClassification
  }>
  detectedMarkers: Array<{
    protocol: ToolProtocolId
    marker: string
    offset: number
    confidence: 'partial' | 'full'
  }>
  bufferedRawOutput: string
}

export interface StreamGateState {
  mode: StreamGateMode
  buffer: string
  releasedLength: number
  escapedRanges: StreamGateFacts['escapedRanges']
}

export interface StreamGateUpdate {
  state: StreamGateState
  releasedChunks: string[]
}

export interface StreamGateFinishResult {
  rawOutput: string
  facts: StreamGateFacts
  releasedChunks: string[]
}
```

- [ ] **Step 4: Implement StreamGate**

Create `src/main/proxy/toolRuntime/data/stream/StreamGate.ts`:

```ts
import type { StreamGateMode } from '../../control/types.ts'
import type {
  StreamGateFacts,
  StreamGateFinishResult,
  StreamGateState,
  StreamGateUpdate,
} from '../types.ts'

const MANAGED_XML_TOOL_CALLS = '<|CHAT2API|tool_calls>'

export function createStreamGateState(mode: StreamGateMode): StreamGateState {
  return {
    mode,
    buffer: '',
    releasedLength: 0,
    escapedRanges: [],
  }
}

export function ingestStreamChunk(state: StreamGateState, chunk: string): StreamGateUpdate {
  const nextBuffer = state.buffer + chunk

  if (state.mode === 'pass_through') {
    const start = state.releasedLength
    const end = start + chunk.length
    return {
      state: {
        ...state,
        buffer: nextBuffer,
        releasedLength: end,
        escapedRanges: [
          ...state.escapedRanges,
          { start, end, classification: 'plain_text' },
        ],
      },
      releasedChunks: [chunk],
    }
  }

  return {
    state: {
      ...state,
      buffer: nextBuffer,
    },
    releasedChunks: [],
  }
}

export function finishStreamGate(state: StreamGateState): StreamGateFinishResult {
  return {
    rawOutput: state.buffer,
    releasedChunks: [],
    facts: {
      mode: state.mode,
      hasEscapedToClient: state.escapedRanges.length > 0,
      escapedRanges: [...state.escapedRanges],
      detectedMarkers: detectMarkers(state.buffer),
      bufferedRawOutput: state.buffer,
    },
  }
}

function detectMarkers(buffer: string): StreamGateFacts['detectedMarkers'] {
  const full = buffer.indexOf(MANAGED_XML_TOOL_CALLS)
  if (full !== -1) {
    return [{
      protocol: 'managed_xml',
      marker: MANAGED_XML_TOOL_CALLS,
      offset: full,
      confidence: 'full',
    }]
  }

  for (let index = 0; index < buffer.length; index += 1) {
    const suffix = buffer.slice(index)
    if (MANAGED_XML_TOOL_CALLS.startsWith(suffix)) {
      return [{
        protocol: 'managed_xml',
        marker: MANAGED_XML_TOOL_CALLS,
        offset: index,
        confidence: 'partial',
      }]
    }
  }

  return []
}
```

- [ ] **Step 5: Export StreamGate**

Modify `src/main/proxy/toolRuntime/data/index.ts`:

```ts
export * from './types.ts'
export * from './protocols/ProtocolAdapter.ts'
export * from './protocols/managedXmlStructure.ts'
export * from './protocols/registry.ts'
export * from './validation/ToolCallValidator.ts'
export * from './repair/StructuralRepair.ts'
export * from './assembly/ToolCallAssembler.ts'
export * from './stream/StreamGate.ts'
```

- [ ] **Step 6: Run StreamGate tests**

Run:

```powershell
node --test tests/tool-runtime/data/stream-gate.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 1**

Run:

```powershell
git add src/main/proxy/toolRuntime/data/types.ts src/main/proxy/toolRuntime/data/stream/StreamGate.ts src/main/proxy/toolRuntime/data/index.ts tests/tool-runtime/data/stream-gate.test.ts
git commit -m "feat: add tool runtime stream gate"
```

Expected: commit includes only StreamGate-related files.

---

### Task 2: OpenAIResponseMapper

**Files:**
- Modify: `src/main/proxy/toolRuntime/data/types.ts`
- Create: `src/main/proxy/toolRuntime/data/mapping/OpenAIResponseMapper.ts`
- Modify: `src/main/proxy/toolRuntime/data/index.ts`
- Create: `tests/tool-runtime/data/response-mapper.test.ts`

- [ ] **Step 1: Write the failing mapper tests**

Create `tests/tool-runtime/data/response-mapper.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  mapNonStreamOpenAIResponse,
  mapStreamOpenAIResponseChunks,
} from '../../../src/main/proxy/toolRuntime/data/index.ts'
import type { ToolCall } from '../../../src/main/proxy/types.ts'

const toolCalls: ToolCall[] = [{
  id: 'call_0',
  index: 0,
  type: 'function',
  function: {
    name: 'bash',
    arguments: '{"argument":"pwd"}',
  },
}]

const meta = {
  id: 'chatcmpl-test',
  model: 'qwen-test',
  created: 123,
}

test('non-stream maps valid tool calls to assistant tool_calls', () => {
  const response = mapNonStreamOpenAIResponse({
    ...meta,
    input: { kind: 'valid_tool_calls', toolCalls },
  })

  assert.equal(response.object, 'chat.completion')
  assert.deepEqual(response.choices[0], {
    index: 0,
    message: {
      role: 'assistant',
      content: null,
      tool_calls: toolCalls,
    },
    finish_reason: 'tool_calls',
  })
})

test('non-stream maps plain text to assistant content', () => {
  const response = mapNonStreamOpenAIResponse({
    ...meta,
    input: { kind: 'plain_text', content: 'hello' },
  })

  assert.deepEqual(response.choices[0], {
    index: 0,
    message: {
      role: 'assistant',
      content: 'hello',
    },
    finish_reason: 'stop',
  })
})

test('non-stream maps blocked malformed to safe assistant content', () => {
  const response = mapNonStreamOpenAIResponse({
    ...meta,
    input: {
      kind: 'blocked_malformed',
      safeMessage: 'blocked',
    },
  })

  assert.equal(response.choices[0].message?.content, 'blocked')
  assert.equal(response.choices[0].finish_reason, 'stop')
})

test('stream maps tool calls to role chunk, tool chunk, and terminal chunk', () => {
  const chunks = mapStreamOpenAIResponseChunks({
    ...meta,
    input: { kind: 'valid_tool_calls', toolCalls },
  })

  assert.deepEqual(chunks.map((chunk) => chunk.choices[0]), [
    {
      index: 0,
      delta: { role: 'assistant' },
      finish_reason: null,
    },
    {
      index: 0,
      delta: { tool_calls: toolCalls },
      finish_reason: null,
    },
    {
      index: 0,
      delta: {},
      finish_reason: 'tool_calls',
    },
  ])
})

test('stream maps text into role chunk, content chunk, and stop chunk', () => {
  const chunks = mapStreamOpenAIResponseChunks({
    ...meta,
    input: { kind: 'plain_text', content: 'hello' },
  })

  assert.deepEqual(chunks.map((chunk) => chunk.choices[0]), [
    {
      index: 0,
      delta: { role: 'assistant' },
      finish_reason: null,
    },
    {
      index: 0,
      delta: { content: 'hello' },
      finish_reason: null,
    },
    {
      index: 0,
      delta: {},
      finish_reason: 'stop',
    },
  ])
})
```

- [ ] **Step 2: Run mapper tests to verify they fail**

Run:

```powershell
node --test tests/tool-runtime/data/response-mapper.test.ts
```

Expected: FAIL with missing mapper exports.

- [ ] **Step 3: Add mapper types**

Append to `src/main/proxy/toolRuntime/data/types.ts`:

```ts
import type { ChatCompletionResponse, ToolCall } from '../../types.ts'

export type ToolRuntimeMappingInput =
  | { kind: 'valid_tool_calls'; toolCalls: ToolCall[] }
  | { kind: 'plain_text'; content: string }
  | { kind: 'blocked_malformed'; safeMessage: string }

export interface OpenAIResponseMapperInput {
  id: string
  model: string
  created: number
  input: ToolRuntimeMappingInput
}

export type OpenAIStreamChunk = ChatCompletionResponse
```

- [ ] **Step 4: Implement OpenAIResponseMapper**

Create `src/main/proxy/toolRuntime/data/mapping/OpenAIResponseMapper.ts`:

```ts
import type {
  ChatCompletionChoice,
  ChatCompletionResponse,
} from '../../../types.ts'
import type { OpenAIResponseMapperInput, OpenAIStreamChunk } from '../types.ts'

export function mapNonStreamOpenAIResponse(input: OpenAIResponseMapperInput): ChatCompletionResponse {
  return {
    id: input.id,
    object: 'chat.completion',
    created: input.created,
    model: input.model,
    choices: [mapNonStreamChoice(input)],
  }
}

export function mapStreamOpenAIResponseChunks(input: OpenAIResponseMapperInput): OpenAIStreamChunk[] {
  const base = {
    id: input.id,
    object: 'chat.completion.chunk' as const,
    created: input.created,
    model: input.model,
  }

  const roleChunk: OpenAIStreamChunk = {
    ...base,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  }

  if (input.input.kind === 'valid_tool_calls') {
    return [
      roleChunk,
      {
        ...base,
        choices: [{ index: 0, delta: { tool_calls: input.input.toolCalls }, finish_reason: null }],
      },
      {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      },
    ]
  }

  const content = input.input.kind === 'plain_text'
    ? input.input.content
    : input.input.safeMessage

  return [
    roleChunk,
    {
      ...base,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
  ]
}

function mapNonStreamChoice(input: OpenAIResponseMapperInput): ChatCompletionChoice {
  if (input.input.kind === 'valid_tool_calls') {
    return {
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: input.input.toolCalls,
      },
      finish_reason: 'tool_calls',
    }
  }

  return {
    index: 0,
    message: {
      role: 'assistant',
      content: input.input.kind === 'plain_text' ? input.input.content : input.input.safeMessage,
    },
    finish_reason: 'stop',
  }
}
```

- [ ] **Step 5: Export mapper**

Modify `src/main/proxy/toolRuntime/data/index.ts`:

```ts
export * from './types.ts'
export * from './protocols/ProtocolAdapter.ts'
export * from './protocols/managedXmlStructure.ts'
export * from './protocols/registry.ts'
export * from './validation/ToolCallValidator.ts'
export * from './repair/StructuralRepair.ts'
export * from './assembly/ToolCallAssembler.ts'
export * from './stream/StreamGate.ts'
export * from './mapping/OpenAIResponseMapper.ts'
```

- [ ] **Step 6: Run mapper tests**

Run:

```powershell
node --test tests/tool-runtime/data/response-mapper.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

Run:

```powershell
git add src/main/proxy/toolRuntime/data/types.ts src/main/proxy/toolRuntime/data/mapping/OpenAIResponseMapper.ts src/main/proxy/toolRuntime/data/index.ts tests/tool-runtime/data/response-mapper.test.ts
git commit -m "feat: add OpenAI response mapper"
```

Expected: commit includes only mapper-related files.

---

## Batch Verification

After Tasks 1-2 are complete, run:

```powershell
node --test tests/tool-runtime/control/*.test.ts tests/tool-runtime/data/*.test.ts
```

Expected: all runtime tests pass.

Then run:

```powershell
npx tsc --noEmit --target ES2020 --module ESNext --moduleResolution bundler --strict --skipLibCheck --allowImportingTsExtensions src\main\proxy\toolRuntime\control\types.ts src\main\proxy\toolRuntime\control\executionProfiles.ts src\main\proxy\toolRuntime\control\ToolPlanner.ts src\main\proxy\toolRuntime\control\ToolStateMachine.ts src\main\proxy\toolRuntime\control\index.ts src\main\proxy\toolRuntime\data\types.ts src\main\proxy\toolRuntime\data\protocols\ProtocolAdapter.ts src\main\proxy\toolRuntime\data\protocols\managedXmlStructure.ts src\main\proxy\toolRuntime\data\protocols\registry.ts src\main\proxy\toolRuntime\data\validation\ToolCallValidator.ts src\main\proxy\toolRuntime\data\repair\StructuralRepair.ts src\main\proxy\toolRuntime\data\assembly\ToolCallAssembler.ts src\main\proxy\toolRuntime\data\stream\StreamGate.ts src\main\proxy\toolRuntime\data\mapping\OpenAIResponseMapper.ts src\main\proxy\toolRuntime\data\index.ts tests\tool-runtime\control\execution-profiles.test.ts tests\tool-runtime\control\tool-planner.test.ts tests\tool-runtime\control\tool-state-machine.test.ts tests\tool-runtime\data\managed-xml-structure.test.ts tests\tool-runtime\data\protocol-registry.test.ts tests\tool-runtime\data\validator.test.ts tests\tool-runtime\data\structural-repair.test.ts tests\tool-runtime\data\assembler.test.ts tests\tool-runtime\data\repair-assembler-chain.test.ts tests\tool-runtime\data\stream-gate.test.ts tests\tool-runtime\data\response-mapper.test.ts
```

Expected: PASS, or only pre-existing errors outside `src/main/proxy/toolRuntime` and `tests/tool-runtime`.

Do not run the full AGENTS final gate for this batch. This batch still does not alter the live forwarding/tool-calling path.

## Self-Review Checklist

- `StreamGate` does not parse, validate, repair, assemble, or map.
- `full_buffer` releases no chunks.
- `pass_through` records escaped ranges.
- `incremental_safe_buffer` is represented but not enabled as live incremental logic.
- `OpenAIResponseMapper` receives only final mapping inputs.
- `OpenAIResponseMapper` does not inspect raw protocol text or validation failures.
- Existing `ToolCallingEngine`, provider adapters, stream parsers, and forwarder are untouched.
