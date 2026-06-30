import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildQwenChatRequestBodyForTest,
} from '../../src/main/proxy/adapters/qwen.ts'
import { ToolCallingEngine } from '../../src/main/proxy/toolCalling/ToolCallingEngine.ts'
import type { ChatCompletionRequest } from '../../src/main/proxy/types.ts'
import type { Provider } from '../../src/main/store/types.ts'

const qwenProvider: Provider = {
  id: 'qwen',
  name: 'Qwen',
  type: 'builtin',
  authType: 'userToken',
  apiEndpoint: 'https://qianwen.com',
  headers: {},
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1
}

test('Qwen request body keeps router query as the latest real user message', () => {
  const engine = new ToolCallingEngine()
  const request: ChatCompletionRequest = {
    model: 'Qwen3-Max',
    messages: [
      { role: 'system', content: 'You are a coding assistant.' },
      { role: 'user', content: '修复 glm 无法使用工具的问题, 地址在E:\\Chat2API' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'default_api:read_file',
          description: 'Read a file',
          parameters: {
            type: 'object',
            properties: { filePath: { type: 'string' } },
            required: ['filePath'],
          },
        },
      },
    ] as any,
    stream: true,
  }

  const transformed = engine.transformRequest({ request, provider: qwenProvider, actualModel: 'Qwen3-Max' })
  const body = buildQwenChatRequestBodyForTest({
    request: {
      model: 'Qwen3-Max',
      messages: transformed.messages as any,
      stream: true,
    },
    actualModel: 'Qwen3-Max',
    sessionId: 'session',
    reqId: 'req',
    timestamp: 1,
    enableThinking: false,
    enableWebSearch: false,
  })

  assert.equal(
    body.messages[0].meta_data.ori_query,
    '修复 glm 无法使用工具的问题, 地址在E:\\Chat2API',
  )
  assert.equal(body.messages.length, 1)
  assert.equal(countOccurrences(body.messages[0].content, '## Available Tools'), 1)
  assert.equal(countOccurrences(body.messages[0].content, '<|CHAT2API|tool_calls>'), 1)
  assert.match(body.messages[0].content, /default_api:read_file/)
  assert.match(body.messages[0].content, /修复 glm 无法使用工具的问题/)
})
