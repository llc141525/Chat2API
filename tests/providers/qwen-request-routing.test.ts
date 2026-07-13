import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildQwenChatRequestBodyForTest,
} from '../../src/main/proxy/adapters/qwen.ts'
import { createContextManagementService } from '../../src/main/proxy/services/contextManagementService.ts'
import { ToolCallingEngine } from '../../src/main/proxy/toolCalling/ToolCallingEngine.ts'
import type { ChatCompletionRequest, ChatMessage } from '../../src/main/proxy/types.ts'
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
  // Tool contract now lives in toolManifest.renderedPrompt, not in messages
  assert.ok(transformed.toolManifest, 'toolManifest should be present')
  assert.match(transformed.toolManifest!.renderedPrompt, /## Available Tools/)
  assert.match(transformed.toolManifest!.renderedPrompt, /<\|CHAT2API\|tool_calls>/)
  assert.match(transformed.toolManifest!.renderedPrompt, /default_api:read_file/)
  assert.match(body.messages[0].content, /修复 glm 无法使用工具的问题/)
})

test('Qwen request body preserves tool contract after low-threshold summary compaction', async () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are a coding assistant.' },
    { role: 'user', content: 'turn 1: remember the project is Chat2API' },
    { role: 'assistant', content: 'Noted.' },
    { role: 'user', content: 'turn 2: continue' },
    { role: 'assistant', content: 'Continuing.' },
    { role: 'user', content: 'turn 3: run a real read tool now' },
  ]
  const contextService = createContextManagementService({
    enabled: true,
    strategies: {
      slidingWindow: { enabled: false, maxMessages: 4 },
      tokenLimit: { enabled: false, maxTokens: 4000 },
      summary: { enabled: true, keepRecentMessages: 3 },
    },
    executionOrder: ['summary'],
  }, async () => 'Earlier turns established the Chat2API task. Do not describe tools.')

  const compacted = await contextService.process(messages)
  assert.equal(compacted.summaryGenerated, true)
  assert.ok(compacted.messages.some(
    (message) => message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('[Prior conversation summary'),
  ))

  const engine = new ToolCallingEngine()
  const request: ChatCompletionRequest = {
    model: 'Qwen3.7-Max',
    messages: compacted.messages,
    tools: [
      {
        type: 'function',
        function: {
          name: 'read',
          description: 'Read a file',
          parameters: {
            type: 'object',
            properties: { filePath: { type: 'string' } },
            required: ['filePath'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'bash',
          description: 'Run a shell command',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
        },
      },
    ] as any,
    stream: true,
  }

  const transformed = engine.transformRequest({
    request,
    provider: qwenProvider,
    actualModel: 'Qwen3.7-Max',
    toolSessionKey: 'qwen-low-threshold-summary-test',
  })
  const body = buildQwenChatRequestBodyForTest({
    request: {
      model: 'Qwen3.7-Max',
      messages: transformed.messages as any,
      stream: true,
    },
    actualModel: 'Qwen3.7-Max',
    sessionId: 'session',
    reqId: 'req',
    timestamp: 1,
    enableThinking: false,
    enableWebSearch: false,
  })

  const content = body.messages[0].content
  // Summary text is still embedded in messages (by context management)
  assert.match(content, /\[Prior conversation summary/)
  // Tool contract now lives in toolManifest.renderedPrompt, not in messages
  assert.ok(transformed.toolManifest, 'toolManifest should be present')
  const renderedPrompt = transformed.toolManifest!.renderedPrompt
  assert.match(renderedPrompt, /## Available Tools/)
  assert.match(renderedPrompt, /catalog_fingerprint:/)
  assert.match(renderedPrompt, /allowed_tools: bash, read/)
  assert.match(renderedPrompt, /<\|CHAT2API\|tool_calls>/)
  assert.match(renderedPrompt, /Tool `read`: Read a file/)
  assert.match(renderedPrompt, /Tool `bash`: Run a shell command/)
  assert.equal(body.messages[0].meta_data.ori_query, 'turn 3: run a real read tool now')
})

test('Qwen request body concatenates multiple system messages instead of keeping only the last one', () => {
  const body = buildQwenChatRequestBodyForTest({
    request: {
      model: 'Qwen3.7-Max',
      stream: true,
      messages: [
        { role: 'system', content: 'base system instruction' },
        { role: 'system', content: '[Prior conversation summary]\nsummary text' },
        { role: 'system', content: '## Available Tools\ncatalog_fingerprint: fp\n<|CHAT2API|tool_calls>' },
        { role: 'user', content: 'please read a file' },
      ] as any,
    },
    actualModel: 'Qwen3.7-Max',
    sessionId: 'session',
    reqId: 'req',
    timestamp: 1,
    enableThinking: false,
    enableWebSearch: false,
  })

  const content = body.messages[0].content
  assert.match(content, /base system instruction/)
  assert.match(content, /\[Prior conversation summary]/)
  assert.match(content, /## Available Tools/)
  assert.ok(
    content.indexOf('[Prior conversation summary]') < content.indexOf('## Available Tools'),
    'tool contract should remain after summary when multiple system messages are present',
  )
})
