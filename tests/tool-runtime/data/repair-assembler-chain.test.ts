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
