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

const configureTool: NormalizedToolDefinition = {
  name: 'configure',
  description: 'Apply structured settings',
  parameters: {
    type: 'object',
    properties: {
      options: {
        type: 'object',
        properties: {
          mode: { type: 'string' },
        },
        required: ['mode'],
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: ['options', 'tags'],
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

const configurePlan: ToolPlan = {
  ...plan,
  allowedToolNames: ['configure'],
  diagnostics: {
    ...plan.diagnostics,
    allowedToolNames: ['configure'],
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

test('object parameter with non-json text is rejected before OpenAI tool call assembly', () => {
  const protocolResult = managedXmlStructureAdapter.extractStructure(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="configure"><|CHAT2API|parameter name="options">not json</|CHAT2API|parameter><|CHAT2API|parameter name="tags">["safe"]</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
  )
  const outcome = validateToolCallStructure({
    plan: configurePlan,
    protocolResult,
    tools: [configureTool],
  })

  assert.equal(outcome.status, 'invalid_structure')
  if (outcome.status !== 'invalid_structure') throw new Error('expected invalid structure')
  assert.equal(outcome.failure.kind, 'schema_validation_failed')
  assert.equal(outcome.failure.toolName, 'configure')
  assert.match(outcome.failure.detail, /options/)
})

test('array parameter with scalar text is rejected before OpenAI tool call assembly', () => {
  const protocolResult = managedXmlStructureAdapter.extractStructure(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="configure"><|CHAT2API|parameter name="options">{"mode":"safe"}</|CHAT2API|parameter><|CHAT2API|parameter name="tags">safe</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
  )
  const outcome = validateToolCallStructure({
    plan: configurePlan,
    protocolResult,
    tools: [configureTool],
  })

  assert.equal(outcome.status, 'invalid_structure')
  if (outcome.status !== 'invalid_structure') throw new Error('expected invalid structure')
  assert.equal(outcome.failure.kind, 'schema_validation_failed')
  assert.equal(outcome.failure.toolName, 'configure')
  assert.match(outcome.failure.detail, /tags/)
})

test('valid object and array payloads are accepted for complex schemas', () => {
  const protocolResult = managedXmlStructureAdapter.extractStructure(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="configure"><|CHAT2API|parameter name="options">{"mode":"safe"}</|CHAT2API|parameter><|CHAT2API|parameter name="tags">["safe","fast"]</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
  )
  const outcome = validateToolCallStructure({
    plan: configurePlan,
    protocolResult,
    tools: [configureTool],
  })

  assert.equal(outcome.status, 'valid_structure')
})

test('json-looking text remains valid when schema says string', () => {
  const protocolResult = managedXmlStructureAdapter.extractStructure(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="bash"><|CHAT2API|parameter name="argument"><![CDATA[{"not":"parsed"}]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
  )
  const outcome = validateToolCallStructure({ plan, protocolResult, tools: [bashTool] })

  assert.equal(outcome.status, 'valid_structure')
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
