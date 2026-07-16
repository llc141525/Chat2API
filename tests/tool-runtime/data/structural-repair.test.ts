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
    rawPayload: 'Get-ChildItem D:\\ | Select-Object Name',
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
    repairedText: '<|CHAT2API|tool_calls><|CHAT2API|invoke name="bash"><|CHAT2API|parameter name="argument"><![CDATA[Get-ChildItem D:\\ | Select-Object Name]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
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
      rawPayload: 'Get-ChildItem D:\\ | Select-Object Name',
      payloadEncoding: 'cdata',
    }],
  }])
})
