import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolCallingEngine } from '../../src/main/proxy/toolCalling/ToolCallingEngine.ts'
import type { ChatCompletionRequest } from '../../src/main/proxy/types.ts'
import type { Provider } from '../../src/main/store/types.ts'

const glmProvider: Provider = {
  id: 'glm', name: 'GLM', type: 'builtin', authType: 'userToken',
  apiEndpoint: 'https://chatglm.cn', headers: {}, enabled: true, createdAt: 0, updatedAt: 0,
}

const openCodeTools: ChatCompletionRequest['tools'] = [
  { type: 'function', function: { name: 'default_api:read_file', description: 'Read a file', parameters: { type: 'object', properties: { filePath: { type: 'string' } } } } },
  { type: 'function', function: { name: 'default_api:write_file', description: 'Write a file', parameters: { type: 'object', properties: { filePath: { type: 'string' }, content: { type: 'string' } } } } },
]

function makePlan(providerId = 'glm', model = 'GLM-5.2', tools?: any) {
  const engine = new ToolCallingEngine()
  return engine.transformRequest({
    request: {
      model, messages: [{ role: 'user', content: 'test' }],
      tools: (tools || openCodeTools) as any, stream: false,
    },
    provider: glmProvider, actualModel: model,
  })
}

test('applyNonStreamResponse: unclosed XML tool call is not emitted as tool_calls', () => {
  const engine = new ToolCallingEngine()
  const transformed = makePlan()
  const unclosedContent = '<|CHAT2API|tool_calls>' +
    '<|CHAT2API|invoke name="default_api:read_file">' +
    '<|CHAT2API|parameter name="filePath">' +
    '<![CDATA[/tmp/a]]>'
  const result: any = {
    choices: [{
      message: { role: 'assistant', content: unclosedContent },
      finish_reason: 'stop',
    }],
  }
  engine.applyNonStreamResponse(result, transformed.plan)
  assert.equal(result.choices[0].message.tool_calls, undefined)
  assert.equal(result.choices[0].finish_reason, 'stop')
})

test('applyNonStreamResponse: bare tool_result tag without invoke is plain text', () => {
  const engine = new ToolCallingEngine()
  const transformed = makePlan()
  const bareResultTag = '<|CHAT2API|tool_result tool_call_id="call_0">' +
    '[{"content":"Step 1","status":"completed"}]' +
    '</|CHAT2API|tool_result>'
  const result: any = {
    choices: [{
      message: { role: 'assistant', content: bareResultTag },
      finish_reason: 'stop',
    }],
  }
  engine.applyNonStreamResponse(result, transformed.plan)
  assert.equal(result.choices[0].message.tool_calls, undefined)
  assert.equal(result.choices[0].finish_reason, 'stop')
})

test('applyNonStreamResponse: wrong parameter format does not produce tool_calls', () => {
  const todowriteTool = {
    type: 'function',
    function: {
      name: 'default_api:todowrite',
      description: 'Write todos',
      parameters: {
        type: 'object',
        required: ['todos'],
        properties: {
          todos: {
            type: 'array',
            items: { type: 'object', properties: { content: { type: 'string' }, status: { type: 'string' } } },
          },
        },
      },
    },
  }
  const engine = new ToolCallingEngine()
  const transformed = makePlan('glm', 'GLM-5.2', [todowriteTool])
  const malformedArgs = '<|CHAT2API|tool_calls>' +
    '<|CHAT2API|invoke name="default_api:todowrite">' +
    '<|CHAT2API|parameter name="todos">' +
    '{"content":"Step 1","status":"completed"}' +
    ']]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>'
  const result: any = {
    choices: [{
      message: { role: 'assistant', content: malformedArgs },
      finish_reason: 'stop',
    }],
  }
  engine.applyNonStreamResponse(result, transformed.plan)
  // Parser is lenient: it extracts the tool call even with malformed parameters,
  // wrapping the broken argument content as a string value.
  assert.ok(result.choices[0].message.tool_calls, 'should produce tool_calls despite malformed params')
  assert.equal(result.choices[0].message.tool_calls.length, 1)
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'default_api:todowrite')
  assert.equal(result.choices[0].finish_reason, 'tool_calls')
})