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
