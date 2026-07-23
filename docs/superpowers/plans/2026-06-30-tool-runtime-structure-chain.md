# Tool Runtime Structure Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the second batch of the Chat2API single truth tool runtime: selected-protocol structural extraction and structural validation without producing OpenAI `tool_calls`.

**Architecture:** This batch adds the data-plane structure chain under `src/main/proxy/toolRuntime/data`. `ProtocolAdapter` converts selected protocol text into structural facts only. `ToolCallValidator` converts structural facts into validity verdicts only. Neither layer creates OpenAI `tool_calls`, repairs output, calls models, maps responses, or falls back to another protocol.

**Tech Stack:** TypeScript, Node.js built-in test runner (`node --test`), existing Chat2API tool definition types.

---

## Scope

This plan implements the second implementation batch from [`docs/superpowers/specs/2026-06-30-chat2api-tool-runtime-litellm-design.md`](../specs/2026-06-30-chat2api-tool-runtime-litellm-design.md):

- Shared structure-chain types.
- A selected-protocol registry.
- Managed XML structural extraction.
- Tool structural validation.

This plan intentionally does not implement:

- `StructuralRepair`.
- `ToolCallAssembler`.
- `OpenAIResponseMapper`.
- `StreamGate`.
- `ToolTurnRunner`.
- Integration into `ToolCallingEngine`, `forwarder`, or provider adapters.
- Any parser fallback from managed XML into bracket/OpenCode/legacy formats.

## File Structure

- Create: `src/main/proxy/toolRuntime/data/types.ts`
  - Owns structural extraction, validation, and failure types.
- Create: `src/main/proxy/toolRuntime/data/protocols/ProtocolAdapter.ts`
  - Defines the protocol adapter interface.
- Create: `src/main/proxy/toolRuntime/data/protocols/managedXmlStructure.ts`
  - Extracts Chat2API managed XML into structural facts only.
- Create: `src/main/proxy/toolRuntime/data/protocols/registry.ts`
  - Looks up the selected protocol adapter. No fallback behavior.
- Create: `src/main/proxy/toolRuntime/data/validation/ToolCallValidator.ts`
  - Validates extracted structures against the immutable `ToolPlan` and declared tools.
- Create: `src/main/proxy/toolRuntime/data/index.ts`
  - Re-exports data-plane APIs.
- Create: `tests/tool-runtime/data/managed-xml-structure.test.ts`
  - Tests structural extraction and mixed-protocol detection.
- Create: `tests/tool-runtime/data/protocol-registry.test.ts`
  - Tests selected-protocol lookup and unsupported protocol rejection.
- Create: `tests/tool-runtime/data/validator.test.ts`
  - Tests valid structure, plain text, unknown names, missing required params, and repairable malformed intent.

## Boundary Rules

- `ProtocolAdapter` may extract `rawToolName`, `rawName`, `rawPayload`, `payloadEncoding`, and source spans.
- `ProtocolAdapter` must not check allowed tool names or schemas.
- `ToolCallValidator` may compare extracted names and required parameter presence.
- `ToolCallValidator` must not produce OpenAI `tool_calls`.
- No component in this batch may import `ToolCall` from `src/main/proxy/types.ts`.
- No component in this batch may call `buildToolCall`, `parseToolCallsFromText`, or legacy `toolParser` utilities.

---

### Task 1: Shared Data-Plane Types and Protocol Interface

**Files:**
- Create: `src/main/proxy/toolRuntime/data/types.ts`
- Create: `src/main/proxy/toolRuntime/data/protocols/ProtocolAdapter.ts`
- Create: `src/main/proxy/toolRuntime/data/index.ts`
- Create: `tests/tool-runtime/data/protocol-registry.test.ts`

- [ ] **Step 1: Write the failing registry/interface test**

Create `tests/tool-runtime/data/protocol-registry.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getStructureProtocolAdapter,
  managedXmlStructureAdapter,
} from '../../../src/main/proxy/toolRuntime/data/index.ts'

test('managed_xml adapter is available by selected protocol id', () => {
  const adapter = getStructureProtocolAdapter('managed_xml')

  assert.equal(adapter.id, 'managed_xml')
  assert.equal(adapter, managedXmlStructureAdapter)
})

test('unsupported selected protocol is rejected instead of falling back', () => {
  assert.throws(
    () => getStructureProtocolAdapter('managed_bracket'),
    /Unsupported structure protocol: managed_bracket/,
  )
})
```

- [ ] **Step 2: Run the registry test to verify it fails**

Run:

```powershell
node --test tests/tool-runtime/data/protocol-registry.test.ts
```

Expected: FAIL with a module resolution error for `src/main/proxy/toolRuntime/data/index.ts`.

- [ ] **Step 3: Create shared structural types**

Create `src/main/proxy/toolRuntime/data/types.ts`:

```ts
import type { ToolProtocolId, NormalizedToolDefinition } from '../../toolCalling/types.ts'
import type { ToolPlan } from '../control/types.ts'

export type PayloadEncoding = 'cdata' | 'text' | 'json_text'

export interface TextSpan {
  start: number
  end: number
}

export interface ExtractedParameterStructure {
  rawName: string
  rawPayload: string
  payloadEncoding: PayloadEncoding
  rawSpan: TextSpan
}

export interface ExtractedCallStructure {
  callIndex: number
  rawToolName: string
  rawParameters: ExtractedParameterStructure[]
  rawSpan: TextSpan
}

export type ProtocolContainerWarningKind =
  | 'foreign_protocol_marker'
  | 'missing_container_close'
  | 'missing_invoke_close'
  | 'missing_parameter_close'
  | 'malformed_parameter'
  | 'fenced_example'

export interface ProtocolContainerWarning {
  kind: ProtocolContainerWarningKind
  marker?: string
  span?: TextSpan
}

export type StructuralContainerFailureKind =
  | 'mixed_protocol_container'
  | 'unterminated_container'
  | 'malformed_container'
  | 'malformed_argument_container'
  | 'argument_payload_not_extractable'
  | 'fenced_example'
  | 'no_tool_intent'

export interface MalformedToolIntent {
  selectedProtocol: ToolProtocolId
  toolName: string
  parameters: Array<{
    name: string
    rawPayload: string
    payloadEncoding: PayloadEncoding
  }>
  rawContainerFingerprint: string
  failureKind: StructuralContainerFailureKind
}

export type ProtocolStructureResult =
  | {
      kind: 'no_intent'
      protocol: ToolProtocolId
      content: string
    }
  | {
      kind: 'container'
      protocol: ToolProtocolId
      extractedCalls: ExtractedCallStructure[]
      rawMatches: string[]
      cleanContent: string
      warnings: ProtocolContainerWarning[]
    }
  | {
      kind: 'malformed_container'
      protocol: ToolProtocolId
      warnings: ProtocolContainerWarning[]
      malformedIntent?: MalformedToolIntent
      rawOutputFingerprint: string
    }

export type ToolStructureFailureKind =
  | 'mixed_protocol_container'
  | 'unterminated_container'
  | 'malformed_container'
  | 'malformed_argument_container'
  | 'argument_payload_not_extractable'
  | 'unknown_tool_name'
  | 'schema_validation_failed'
  | 'fenced_example'
  | 'no_tool_intent'

export interface ToolStructureFailure {
  kind: ToolStructureFailureKind
  selectedProtocol: ToolProtocolId | null
  detail: string
  toolName?: string
}

export interface ValidatedParameterStructure {
  name: string
  rawPayload: string
  payloadEncoding: PayloadEncoding
}

export interface ValidatedCallStructure {
  callIndex: number
  toolName: string
  parameters: ValidatedParameterStructure[]
}

export type ToolValidationOutcome =
  | {
      status: 'valid_structure'
      validated: ValidatedCallStructure[]
      cleanContent: string | null
    }
  | {
      status: 'plain_text'
      content: string
    }
  | {
      status: 'invalid_structure'
      failure: ToolStructureFailure
      malformedIntent?: MalformedToolIntent
    }

export interface ToolCallValidatorInput {
  plan: ToolPlan
  protocolResult: ProtocolStructureResult
  tools: NormalizedToolDefinition[]
}
```

- [ ] **Step 4: Create the protocol adapter interface**

Create `src/main/proxy/toolRuntime/data/protocols/ProtocolAdapter.ts`:

```ts
import type { ToolProtocolId } from '../../../toolCalling/types.ts'
import type { ProtocolStructureResult } from '../types.ts'

export interface ProtocolIntentDetection {
  matched: boolean
  partial: boolean
  markerStart?: number
}

export interface StructureProtocolAdapter {
  id: ToolProtocolId
  detectIntent(rawOutput: string): ProtocolIntentDetection
  extractStructure(rawOutput: string): ProtocolStructureResult
}
```

- [ ] **Step 5: Create placeholder data index**

Create `src/main/proxy/toolRuntime/data/index.ts`:

```ts
export * from './types.ts'
export * from './protocols/ProtocolAdapter.ts'
export * from './protocols/managedXmlStructure.ts'
export * from './protocols/registry.ts'
```

This test still fails until Task 2 creates `managedXmlStructure.ts` and `registry.ts`.

---

### Task 2: Managed XML Structural Extraction

**Files:**
- Create: `src/main/proxy/toolRuntime/data/protocols/managedXmlStructure.ts`
- Create: `src/main/proxy/toolRuntime/data/protocols/registry.ts`
- Create: `tests/tool-runtime/data/managed-xml-structure.test.ts`
- Modify: `tests/tool-runtime/data/protocol-registry.test.ts` only if imports need formatting.

- [ ] **Step 1: Write the failing managed XML structure tests**

Create `tests/tool-runtime/data/managed-xml-structure.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'

import { managedXmlStructureAdapter } from '../../../src/main/proxy/toolRuntime/data/index.ts'

test('valid Chat2API managed XML extracts call structure only', () => {
  const raw = [
    'before ',
    '<|CHAT2API|tool_calls>',
    '<|CHAT2API|invoke name="bash">',
    '<|CHAT2API|parameter name="argument"><![CDATA[Get-ChildItem D:\\\\]]></|CHAT2API|parameter>',
    '</|CHAT2API|invoke>',
    '</|CHAT2API|tool_calls>',
    ' after',
  ].join('')

  const result = managedXmlStructureAdapter.extractStructure(raw)

  assert.equal(result.kind, 'container')
  assert.equal(result.protocol, 'managed_xml')
  assert.equal(result.cleanContent, 'before  after')
  assert.deepEqual(result.warnings, [])

  assert.equal(result.extractedCalls.length, 1)
  assert.equal(result.extractedCalls[0].callIndex, 0)
  assert.equal(result.extractedCalls[0].rawToolName, 'bash')
  assert.equal(result.extractedCalls[0].rawParameters.length, 1)
  assert.deepEqual(result.extractedCalls[0].rawParameters[0], {
    rawName: 'argument',
    rawPayload: 'Get-ChildItem D:\\\\',
    payloadEncoding: 'cdata',
    rawSpan: result.extractedCalls[0].rawParameters[0].rawSpan,
  })
})

test('plain text has no tool intent', () => {
  const result = managedXmlStructureAdapter.extractStructure('hello <xml> but no marker')

  assert.deepEqual(result, {
    kind: 'no_intent',
    protocol: 'managed_xml',
    content: 'hello <xml> but no marker',
  })
})

test('fenced tool example is treated as no intent', () => {
  const result = managedXmlStructureAdapter.extractStructure([
    'Example:',
    '```xml',
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="bash"></|CHAT2API|invoke></|CHAT2API|tool_calls>',
    '```',
  ].join('\n'))

  assert.equal(result.kind, 'no_intent')
})

test('mixed Chat2API and OpenCode closing tags creates malformed structural intent', () => {
  const raw = '<|CHAT2API|tool_calls><|CHAT2API|invoke name="bash"><|CHAT2API|parameter name="argument"><![CDATA[Get-ChildItem D:\\\\]]></arg_value></tool_call>'
  const result = managedXmlStructureAdapter.extractStructure(raw)

  assert.equal(result.kind, 'malformed_container')
  assert.equal(result.protocol, 'managed_xml')
  assert.equal(result.warnings.some((warning) => warning.kind === 'foreign_protocol_marker'), true)
  assert.deepEqual(result.malformedIntent, {
    selectedProtocol: 'managed_xml',
    toolName: 'bash',
    parameters: [{
      name: 'argument',
      rawPayload: 'Get-ChildItem D:\\\\',
      payloadEncoding: 'cdata',
    }],
    rawContainerFingerprint: result.malformedIntent?.rawContainerFingerprint,
    failureKind: 'mixed_protocol_container',
  })
})

test('bracket protocol block is not parsed as managed XML fallback', () => {
  const raw = '[function_calls]\n[call:bash]{"argument":"pwd"}[/call]\n[/function_calls]'
  const result = managedXmlStructureAdapter.extractStructure(raw)

  assert.equal(result.kind, 'no_intent')
})

test('unterminated Chat2API container creates malformed result without tool calls', () => {
  const raw = '<|CHAT2API|tool_calls><|CHAT2API|invoke name="bash"><|CHAT2API|parameter name="argument">pwd'
  const result = managedXmlStructureAdapter.extractStructure(raw)

  assert.equal(result.kind, 'malformed_container')
  assert.equal(result.malformedIntent?.toolName, 'bash')
  assert.equal(result.malformedIntent?.parameters[0].name, 'argument')
  assert.equal(result.malformedIntent?.parameters[0].rawPayload, 'pwd')
  assert.equal(result.malformedIntent?.failureKind, 'unterminated_container')
})
```

- [ ] **Step 2: Run the managed XML tests to verify they fail**

Run:

```powershell
node --test tests/tool-runtime/data/managed-xml-structure.test.ts tests/tool-runtime/data/protocol-registry.test.ts
```

Expected: FAIL because `managedXmlStructure.ts` and `registry.ts` do not exist.

- [ ] **Step 3: Implement managed XML structural extraction**

Create `src/main/proxy/toolRuntime/data/protocols/managedXmlStructure.ts`:

```ts
import type { ToolProtocolId } from '../../../toolCalling/types.ts'
import type {
  ExtractedCallStructure,
  ExtractedParameterStructure,
  MalformedToolIntent,
  PayloadEncoding,
  ProtocolContainerWarning,
  ProtocolStructureResult,
} from '../types.ts'
import type { ProtocolIntentDetection, StructureProtocolAdapter } from './ProtocolAdapter.ts'

const PROTOCOL: ToolProtocolId = 'managed_xml'
const CHAT2API_START = '<|CHAT2API|tool_calls>'
const CHAT2API_END = '</|CHAT2API|tool_calls>'
const INVOKE_OPEN = /<\|CHAT2API\|invoke\s+name="([^"]+)"\s*>/g
const PARAM_OPEN = /<\|CHAT2API\|parameter\s+name="([^"]+)"\s*>/g
const FOREIGN_MARKERS = ['</arg_value>', '</tool_call>', '[function_calls]', '[/function_calls]', '[/call]']

export const managedXmlStructureAdapter: StructureProtocolAdapter = {
  id: PROTOCOL,

  detectIntent(rawOutput: string): ProtocolIntentDetection {
    const stripped = stripFencedCodeBlocks(rawOutput)
    const index = stripped.indexOf(CHAT2API_START)
    if (index !== -1) return { matched: true, partial: false, markerStart: index }

    for (let start = 0; start < stripped.length; start += 1) {
      const suffix = stripped.slice(start)
      if (CHAT2API_START.startsWith(suffix)) {
        return { matched: false, partial: true, markerStart: start }
      }
    }

    return { matched: false, partial: false }
  },

  extractStructure(rawOutput: string): ProtocolStructureResult {
    const parseable = stripFencedCodeBlocks(rawOutput)
    if (!parseable.includes(CHAT2API_START)) {
      return { kind: 'no_intent', protocol: PROTOCOL, content: rawOutput }
    }

    const warnings = detectForeignMarkers(parseable)
    const start = parseable.indexOf(CHAT2API_START)
    const end = parseable.indexOf(CHAT2API_END, start + CHAT2API_START.length)

    if (end === -1 || warnings.length > 0) {
      return malformed(parseable, warnings, end === -1 ? 'unterminated_container' : 'mixed_protocol_container')
    }

    const blockEnd = end + CHAT2API_END.length
    const rawBlock = parseable.slice(start, blockEnd)
    const inner = parseable.slice(start + CHAT2API_START.length, end)
    const extractedCalls = extractCalls(inner, start + CHAT2API_START.length)

    if (extractedCalls.length === 0) {
      return malformed(parseable, [{
        kind: 'malformed_parameter',
        span: { start, end: blockEnd },
      }], 'malformed_container')
    }

    return {
      kind: 'container',
      protocol: PROTOCOL,
      extractedCalls,
      rawMatches: [rawBlock],
      cleanContent: parseable.slice(0, start) + parseable.slice(blockEnd),
      warnings,
    }
  },
}

function extractCalls(inner: string, offset: number): ExtractedCallStructure[] {
  const calls: ExtractedCallStructure[] = []
  let invokeMatch: RegExpExecArray | null
  INVOKE_OPEN.lastIndex = 0

  while ((invokeMatch = INVOKE_OPEN.exec(inner)) !== null) {
    const invokeStart = offset + invokeMatch.index
    const bodyStart = INVOKE_OPEN.lastIndex
    const close = inner.indexOf('</|CHAT2API|invoke>', bodyStart)
    if (close === -1) continue

    const body = inner.slice(bodyStart, close)
    const invokeEnd = offset + close + '</|CHAT2API|invoke>'.length
    calls.push({
      callIndex: calls.length,
      rawToolName: decodeXmlAttribute(invokeMatch[1]),
      rawParameters: extractParameters(body, offset + bodyStart),
      rawSpan: { start: invokeStart, end: invokeEnd },
    })
  }

  return calls
}

function extractParameters(body: string, offset: number): ExtractedParameterStructure[] {
  const parameters: ExtractedParameterStructure[] = []
  let paramMatch: RegExpExecArray | null
  PARAM_OPEN.lastIndex = 0

  while ((paramMatch = PARAM_OPEN.exec(body)) !== null) {
    const paramStart = offset + paramMatch.index
    const payloadStart = PARAM_OPEN.lastIndex
    const close = body.indexOf('</|CHAT2API|parameter>', payloadStart)
    if (close === -1) continue

    const rawBody = body.slice(payloadStart, close)
    const { rawPayload, payloadEncoding } = unwrapPayload(rawBody)
    parameters.push({
      rawName: decodeXmlAttribute(paramMatch[1]),
      rawPayload,
      payloadEncoding,
      rawSpan: { start: paramStart, end: offset + close + '</|CHAT2API|parameter>'.length },
    })
  }

  return parameters
}

function malformed(
  parseable: string,
  warnings: ProtocolContainerWarning[],
  failureKind: MalformedToolIntent['failureKind'],
): ProtocolStructureResult {
  const malformedIntent = extractMalformedIntent(parseable, failureKind)

  return {
    kind: 'malformed_container',
    protocol: PROTOCOL,
    warnings,
    ...(malformedIntent ? { malformedIntent } : {}),
    rawOutputFingerprint: fingerprint(parseable),
  }
}

function extractMalformedIntent(
  parseable: string,
  failureKind: MalformedToolIntent['failureKind'],
): MalformedToolIntent | undefined {
  INVOKE_OPEN.lastIndex = 0
  const invoke = INVOKE_OPEN.exec(parseable)
  if (!invoke) return undefined

  const params = extractMalformedParameters(parseable)
  if (params.length === 0) return undefined

  return {
    selectedProtocol: PROTOCOL,
    toolName: decodeXmlAttribute(invoke[1]),
    parameters: params,
    rawContainerFingerprint: fingerprint(parseable),
    failureKind,
  }
}

function extractMalformedParameters(parseable: string): MalformedToolIntent['parameters'] {
  const parameters: MalformedToolIntent['parameters'] = []
  let match: RegExpExecArray | null
  PARAM_OPEN.lastIndex = 0

  while ((match = PARAM_OPEN.exec(parseable)) !== null) {
    const payloadStart = PARAM_OPEN.lastIndex
    const close = findAnyClose(parseable, payloadStart)
    const rawBody = close === -1 ? parseable.slice(payloadStart) : parseable.slice(payloadStart, close)
    const { rawPayload, payloadEncoding } = unwrapPayload(rawBody)

    parameters.push({
      name: decodeXmlAttribute(match[1]),
      rawPayload,
      payloadEncoding,
    })
  }

  return parameters
}

function findAnyClose(value: string, start: number): number {
  const closers = ['</|CHAT2API|parameter>', '</arg_value>', '</parameter>', '</tool_call>']
    .map((marker) => value.indexOf(marker, start))
    .filter((index) => index !== -1)

  return closers.length === 0 ? -1 : Math.min(...closers)
}

function unwrapPayload(value: string): { rawPayload: string; payloadEncoding: PayloadEncoding } {
  const cdata = value.match(/^\s*<!\[CDATA\[([\s\S]*?)(?:\]\]>)?\s*$/)
  if (cdata) return { rawPayload: cdata[1], payloadEncoding: 'cdata' }

  return { rawPayload: decodeXmlText(value.trim()), payloadEncoding: 'text' }
}

function detectForeignMarkers(value: string): ProtocolContainerWarning[] {
  return FOREIGN_MARKERS.flatMap((marker) => {
    const index = value.indexOf(marker)
    return index === -1
      ? []
      : [{ kind: 'foreign_protocol_marker' as const, marker, span: { start: index, end: index + marker.length } }]
  })
}

function stripFencedCodeBlocks(value: string): string {
  return value.replace(/```[\s\S]*?```/g, '')
}

function decodeXmlAttribute(value: string): string {
  return decodeXmlText(value.replace(/&quot;/g, '"').replace(/&apos;/g, "'"))
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function fingerprint(value: string): string {
  return `${value.length}:${value.slice(0, 32)}:${value.slice(-32)}`
}
```

- [ ] **Step 4: Implement selected-protocol registry**

Create `src/main/proxy/toolRuntime/data/protocols/registry.ts`:

```ts
import type { ToolProtocolId } from '../../../toolCalling/types.ts'
import type { StructureProtocolAdapter } from './ProtocolAdapter.ts'
import { managedXmlStructureAdapter } from './managedXmlStructure.ts'

const adapters: Partial<Record<ToolProtocolId, StructureProtocolAdapter>> = {
  managed_xml: managedXmlStructureAdapter,
}

export function getStructureProtocolAdapter(protocol: ToolProtocolId): StructureProtocolAdapter {
  const adapter = adapters[protocol]
  if (!adapter) {
    throw new Error(`Unsupported structure protocol: ${protocol}`)
  }

  return adapter
}
```

- [ ] **Step 5: Run managed XML and registry tests**

Run:

```powershell
node --test tests/tool-runtime/data/managed-xml-structure.test.ts tests/tool-runtime/data/protocol-registry.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

Run:

```powershell
git add src/main/proxy/toolRuntime/data/types.ts src/main/proxy/toolRuntime/data/protocols/ProtocolAdapter.ts src/main/proxy/toolRuntime/data/protocols/managedXmlStructure.ts src/main/proxy/toolRuntime/data/protocols/registry.ts src/main/proxy/toolRuntime/data/index.ts tests/tool-runtime/data/managed-xml-structure.test.ts tests/tool-runtime/data/protocol-registry.test.ts
git commit -m "feat: add managed xml structure extraction"
```

Expected: commit includes only Task 1 and Task 2 data-plane files if Task 1 was not committed separately.

---

### Task 3: ToolCallValidator Structural Verdicts

**Files:**
- Create: `src/main/proxy/toolRuntime/data/validation/ToolCallValidator.ts`
- Modify: `src/main/proxy/toolRuntime/data/index.ts`
- Create: `tests/tool-runtime/data/validator.test.ts`

- [ ] **Step 1: Write the failing validator tests**

Create `tests/tool-runtime/data/validator.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  managedXmlStructureAdapter,
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

test('plain text protocol result becomes plain_text validation outcome', () => {
  const protocolResult = managedXmlStructureAdapter.extractStructure('hello')
  const outcome = validateToolCallStructure({ plan, protocolResult, tools: [bashTool] })

  assert.deepEqual(outcome, {
    status: 'plain_text',
    content: 'hello',
  })
})

test('valid structure returns validated structure but no OpenAI tool calls', () => {
  const protocolResult = managedXmlStructureAdapter.extractStructure(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="bash"><|CHAT2API|parameter name="argument"><![CDATA[pwd]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
  )
  const outcome = validateToolCallStructure({ plan, protocolResult, tools: [bashTool] })

  assert.equal(outcome.status, 'valid_structure')
  if (outcome.status !== 'valid_structure') throw new Error('expected valid structure')

  assert.deepEqual(outcome.validated, [{
    callIndex: 0,
    toolName: 'bash',
    parameters: [{
      name: 'argument',
      rawPayload: 'pwd',
      payloadEncoding: 'cdata',
    }],
  }])
  assert.equal('tool_calls' in outcome, false)
  assert.equal('toolCalls' in outcome, false)
})

test('unknown tool name is blocked without fallback', () => {
  const protocolResult = managedXmlStructureAdapter.extractStructure(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="python"><|CHAT2API|parameter name="argument">print(1)</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
  )
  const outcome = validateToolCallStructure({ plan, protocolResult, tools: [bashTool] })

  assert.equal(outcome.status, 'invalid_structure')
  if (outcome.status !== 'invalid_structure') throw new Error('expected invalid structure')

  assert.deepEqual(outcome.failure, {
    kind: 'unknown_tool_name',
    selectedProtocol: 'managed_xml',
    detail: 'Tool python is not allowed by the current plan',
    toolName: 'python',
  })
})

test('missing required parameter is blocked as schema validation failed', () => {
  const protocolResult = managedXmlStructureAdapter.extractStructure(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="bash"><|CHAT2API|parameter name="other">pwd</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
  )
  const outcome = validateToolCallStructure({ plan, protocolResult, tools: [bashTool] })

  assert.equal(outcome.status, 'invalid_structure')
  if (outcome.status !== 'invalid_structure') throw new Error('expected invalid structure')

  assert.equal(outcome.failure.kind, 'schema_validation_failed')
  assert.equal(outcome.failure.toolName, 'bash')
  assert.match(outcome.failure.detail, /Missing required parameter argument/)
})

test('mixed protocol malformed intent is invalid structure and preserves repair facts', () => {
  const protocolResult = managedXmlStructureAdapter.extractStructure(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="bash"><|CHAT2API|parameter name="argument"><![CDATA[pwd]]></arg_value></tool_call>',
  )
  const outcome = validateToolCallStructure({ plan, protocolResult, tools: [bashTool] })

  assert.equal(outcome.status, 'invalid_structure')
  if (outcome.status !== 'invalid_structure') throw new Error('expected invalid structure')

  assert.equal(outcome.failure.kind, 'mixed_protocol_container')
  assert.equal(outcome.malformedIntent?.toolName, 'bash')
  assert.deepEqual(outcome.malformedIntent?.parameters, [{
    name: 'argument',
    rawPayload: 'pwd',
    payloadEncoding: 'cdata',
  }])
})

test('validator rejects protocol result that does not match selected plan protocol', () => {
  const protocolResult = managedXmlStructureAdapter.extractStructure('hello')
  const mismatchedPlan: ToolPlan = {
    ...plan,
    protocol: 'managed_bracket',
    diagnostics: {
      ...plan.diagnostics,
      protocol: 'managed_bracket',
    },
  }

  const outcome = validateToolCallStructure({ plan: mismatchedPlan, protocolResult, tools: [bashTool] })

  assert.equal(outcome.status, 'invalid_structure')
  if (outcome.status !== 'invalid_structure') throw new Error('expected invalid structure')

  assert.equal(outcome.failure.kind, 'malformed_container')
  assert.equal(outcome.failure.detail, 'Protocol result managed_xml does not match selected protocol managed_bracket')
})
```

- [ ] **Step 2: Run validator tests to verify they fail**

Run:

```powershell
node --test tests/tool-runtime/data/validator.test.ts
```

Expected: FAIL with missing export `validateToolCallStructure`.

- [ ] **Step 3: Implement structural validator**

Create `src/main/proxy/toolRuntime/data/validation/ToolCallValidator.ts`:

```ts
import type { NormalizedToolDefinition } from '../../../toolCalling/types.ts'
import type {
  ExtractedCallStructure,
  ToolCallValidatorInput,
  ToolStructureFailure,
  ToolValidationOutcome,
  ValidatedCallStructure,
} from '../types.ts'

export function validateToolCallStructure(input: ToolCallValidatorInput): ToolValidationOutcome {
  const selectedProtocol = input.plan.protocol
  if (input.protocolResult.protocol !== selectedProtocol) {
    return invalid({
      kind: 'malformed_container',
      selectedProtocol,
      detail: `Protocol result ${input.protocolResult.protocol} does not match selected protocol ${selectedProtocol}`,
    })
  }

  if (input.protocolResult.kind === 'no_intent') {
    return { status: 'plain_text', content: input.protocolResult.content }
  }

  if (input.protocolResult.kind === 'malformed_container') {
    return {
      status: 'invalid_structure',
      failure: {
        kind: input.protocolResult.malformedIntent?.failureKind ?? 'malformed_container',
        selectedProtocol,
        detail: `Malformed ${selectedProtocol ?? 'unknown'} tool container`,
        toolName: input.protocolResult.malformedIntent?.toolName,
      },
      ...(input.protocolResult.malformedIntent ? { malformedIntent: input.protocolResult.malformedIntent } : {}),
    }
  }

  const validated: ValidatedCallStructure[] = []
  for (const call of input.protocolResult.extractedCalls) {
    const toolName = call.rawToolName
    if (!input.plan.allowedToolNames.includes(toolName)) {
      return invalid({
        kind: 'unknown_tool_name',
        selectedProtocol,
        detail: `Tool ${toolName} is not allowed by the current plan`,
        toolName,
      })
    }

    const tool = input.tools.find((candidate) => candidate.name === toolName)
    if (!tool) {
      return invalid({
        kind: 'unknown_tool_name',
        selectedProtocol,
        detail: `Tool ${toolName} is not declared in tool definitions`,
        toolName,
      })
    }

    const missing = missingRequiredParameters(call, tool)
    if (missing.length > 0) {
      return invalid({
        kind: 'schema_validation_failed',
        selectedProtocol,
        detail: `Missing required parameter ${missing.join(', ')}`,
        toolName,
      })
    }

    validated.push({
      callIndex: call.callIndex,
      toolName,
      parameters: call.rawParameters.map((parameter) => ({
        name: parameter.rawName,
        rawPayload: parameter.rawPayload,
        payloadEncoding: parameter.payloadEncoding,
      })),
    })
  }

  return {
    status: 'valid_structure',
    validated,
    cleanContent: input.protocolResult.cleanContent.trim() || null,
  }
}

function missingRequiredParameters(
  call: ExtractedCallStructure,
  tool: NormalizedToolDefinition,
): string[] {
  const required = Array.isArray(tool.parameters?.required) ? tool.parameters.required : []
  const present = new Set(call.rawParameters.map((parameter) => parameter.rawName))

  return required.filter((name) => !present.has(name))
}

function invalid(failure: ToolStructureFailure): ToolValidationOutcome {
  return {
    status: 'invalid_structure',
    failure,
  }
}
```

- [ ] **Step 4: Export validator**

Modify `src/main/proxy/toolRuntime/data/index.ts`:

```ts
export * from './types.ts'
export * from './protocols/ProtocolAdapter.ts'
export * from './protocols/managedXmlStructure.ts'
export * from './protocols/registry.ts'
export * from './validation/ToolCallValidator.ts'
```

- [ ] **Step 5: Run all data-plane tests**

Run:

```powershell
node --test tests/tool-runtime/data/*.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run first batch plus second batch tests**

Run:

```powershell
node --test tests/tool-runtime/control/*.test.ts tests/tool-runtime/data/*.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run focused TypeScript check for new runtime files**

Run:

```powershell
npx tsc --noEmit --target ES2020 --module ESNext --moduleResolution bundler --strict --skipLibCheck --allowImportingTsExtensions src\main\proxy\toolRuntime\control\types.ts src\main\proxy\toolRuntime\control\executionProfiles.ts src\main\proxy\toolRuntime\control\ToolPlanner.ts src\main\proxy\toolRuntime\control\ToolStateMachine.ts src\main\proxy\toolRuntime\control\index.ts src\main\proxy\toolRuntime\data\types.ts src\main\proxy\toolRuntime\data\protocols\ProtocolAdapter.ts src\main\proxy\toolRuntime\data\protocols\managedXmlStructure.ts src\main\proxy\toolRuntime\data\protocols\registry.ts src\main\proxy\toolRuntime\data\validation\ToolCallValidator.ts src\main\proxy\toolRuntime\data\index.ts tests\tool-runtime\control\execution-profiles.test.ts tests\tool-runtime\control\tool-planner.test.ts tests\tool-runtime\control\tool-state-machine.test.ts tests\tool-runtime\data\managed-xml-structure.test.ts tests\tool-runtime\data\protocol-registry.test.ts tests\tool-runtime\data\validator.test.ts
```

Expected: PASS, or only pre-existing errors outside `src/main/proxy/toolRuntime` and `tests/tool-runtime`.

- [ ] **Step 8: Commit Task 3**

Run:

```powershell
git add src/main/proxy/toolRuntime/data/validation/ToolCallValidator.ts src/main/proxy/toolRuntime/data/index.ts tests/tool-runtime/data/validator.test.ts
git commit -m "feat: add tool structure validator"
```

Expected: commit includes only Task 3 validator files.

---

## Batch Verification

After Tasks 1-3 are complete, run:

```powershell
node --test tests/tool-runtime/control/*.test.ts tests/tool-runtime/data/*.test.ts
```

Expected: all control-plane and data-plane tests pass.

Then run the focused TypeScript command from Task 3 Step 7.

Do not run the full AGENTS final gate for this batch. This batch still does not alter the live forwarding/tool-calling path.

## Self-Review Checklist

- `ProtocolAdapter` produces structure facts only.
- `ToolCallValidator` produces verdicts only.
- No file in this batch imports `ToolCall` from `src/main/proxy/types.ts`.
- No file in this batch calls legacy `buildToolCall`, `parseToolCallsFromText`, or old `toolParser` APIs.
- `managed_xml` never falls back to bracket/OpenCode parsing.
- Mixed protocol output is `invalid_structure`, not a tool call.
- Missing required parameters are blocked and not repaired.
- Existing `ToolCallingEngine`, provider adapters, stream parsers, and forwarder are untouched.
