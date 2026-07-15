import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildQwenAssemblyRequestBodyForTest,
  buildQwenChatRequestBodyForTest,
} from '../../src/main/proxy/adapters/qwen.ts'
import { buildRequestAssembly } from '../../src/main/proxy/RequestAssembly.ts'
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
  assert.match(transformed.toolManifest!.renderedPrompt, /parameter name="filePath"/)
  assert.doesNotMatch(transformed.toolManifest!.renderedPrompt, /parameter name="argument"/)
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
  assert.match(renderedPrompt, /Tool `read` exact XML:/)
  assert.match(renderedPrompt, /<\|CHAT2API\|parameter name="filePath"><!\[CDATA\[filePath_value\]\]><\/\|CHAT2API\|parameter>/)
  assert.doesNotMatch(renderedPrompt, /parameter name="argument"/)
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

test('Qwen assembly path keeps summary after base system and before authoritative tool contract', () => {
  const assembly = buildRequestAssembly({
    messages: [
      { role: 'system', content: 'base system instruction' },
      { role: 'system', content: '[Prior conversation summary]\nsummary text' },
      { role: 'user', content: 'please read a file' },
      { role: 'assistant', content: 'working on it' },
    ] as any,
    toolManifest: {
      renderedPrompt: '## Available Tools\ncatalog_fingerprint: fp\n<|CHAT2API|tool_calls>',
    } as any,
    summaryText: '[Prior conversation summary]\nsummary text',
  })

  const body = buildQwenAssemblyRequestBodyForTest({
    assembly,
    request: {
      model: 'Qwen3.7-Max',
      originalModel: 'Qwen3.7-Max',
      stream: true,
      messages: assembly.messages as any,
    },
    actualModel: 'Qwen3.7-Max',
    sessionId: 'session',
    reqId: 'req',
    timestamp: 1,
    enableThinking: false,
    enableWebSearch: false,
  })

  const content = body.messages[0].content as string
  const baseIndex = content.indexOf('base system instruction')
  const summaryIndex = content.indexOf('[Prior conversation summary]')
  const toolIndex = content.indexOf('## Available Tools')
  const conversationIndex = content.indexOf('User: please read a file')

  assert.ok(baseIndex !== -1, 'base system instruction should be present')
  assert.ok(summaryIndex !== -1, 'summary should be present in assembly path')
  assert.ok(toolIndex !== -1, 'tool contract should be present in assembly path')
  assert.ok(conversationIndex !== -1, 'conversation should be present in assembly path')
  assert.ok(baseIndex < summaryIndex, 'base system should appear before summary')
  assert.ok(summaryIndex < toolIndex, 'summary should appear before tool contract')
  assert.ok(toolIndex < conversationIndex, 'tool contract should appear before conversation')
  assert.equal(countOccurrences(content, '[Prior conversation summary]'), 1)
  assert.equal(body.messages[0].meta_data.ori_query, 'please read a file')
})

test('Qwen assembly path extracts summary from system messages when assembly.summaryText is absent', () => {
  const assembly = buildRequestAssembly({
    messages: [
      { role: 'system', content: 'base system instruction' },
      { role: 'system', content: '[Prior conversation summary]\nsummary text from processed messages' },
      { role: 'user', content: 'please inspect this file' },
      { role: 'assistant', content: 'on it' },
    ] as any,
    toolManifest: {
      renderedPrompt: '## Available Tools\ncatalog_fingerprint: fp\n<|CHAT2API|tool_calls>',
    } as any,
  })

  const body = buildQwenAssemblyRequestBodyForTest({
    assembly,
    request: {
      model: 'Qwen3.7-Max',
      originalModel: 'Qwen3.7-Max',
      stream: true,
      messages: assembly.messages as any,
    },
    actualModel: 'Qwen3.7-Max',
    sessionId: 'session',
    reqId: 'req',
    timestamp: 1,
    enableThinking: false,
    enableWebSearch: false,
  })

  const content = body.messages[0].content as string
  const baseIndex = content.indexOf('base system instruction')
  const summaryIndex = content.indexOf('[Prior conversation summary]')
  const toolIndex = content.indexOf('## Available Tools')
  const conversationIndex = content.indexOf('User: please inspect this file')

  assert.ok(baseIndex !== -1, 'base system instruction should be present')
  assert.ok(summaryIndex !== -1, 'summary should be extracted from assembly messages')
  assert.ok(toolIndex !== -1, 'tool contract should be present')
  assert.ok(conversationIndex !== -1, 'conversation should be present')
  assert.ok(baseIndex < summaryIndex, 'base system should appear before extracted summary')
  assert.ok(summaryIndex < toolIndex, 'extracted summary should appear before tool contract')
  assert.ok(toolIndex < conversationIndex, 'tool contract should appear before conversation')
  assert.equal(countOccurrences(content, '[Prior conversation summary]'), 1)
})

test('Qwen assembly path keeps full prompt when provider session is absent', () => {
  const assembly = buildRequestAssembly({
    messages: [
      { role: 'system', content: 'base system instruction' },
      { role: 'system', content: '[Prior conversation summary]\nsummary text' },
      { role: 'user', content: 'early user text to keep' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read', arguments: '{"filePath":"a.txt"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'tool result payload' },
      { role: 'user', content: 'latest user text' },
    ] as any,
    toolManifest: {
      renderedPrompt: '## Available Tools\ncatalog_fingerprint: fp\n<|CHAT2API|tool_calls>',
    } as any,
  })

  const body = buildQwenAssemblyRequestBodyForTest({
    assembly,
    request: {
      model: 'Qwen3.7-Max',
      originalModel: 'Qwen3.7-Max',
      stream: true,
      messages: assembly.messages as any,
    },
    actualModel: 'Qwen3.7-Max',
    sessionId: 'session',
    reqId: 'req',
    timestamp: 1,
    enableThinking: false,
    enableWebSearch: false,
  })

  const content = body.messages[0].content as string
  assert.match(content, /early user text to keep/)
  assert.match(content, /\[Prior conversation summary]/)
  assert.ok(content.indexOf('[Prior conversation summary]') < content.indexOf('## Available Tools'))
  assert.ok(content.indexOf('## Available Tools') < content.indexOf('early user text to keep'))
})

test('Qwen assembly path uses conservative delta when provider session and recent tool suffix exist', () => {
  const assembly = buildRequestAssembly({
    messages: [
      { role: 'system', content: 'base system instruction' },
      { role: 'system', content: '[Prior conversation summary]\nsummary text' },
      { role: 'user', content: 'very early user text to drop' },
      { role: 'assistant', content: 'ordinary assistant text to drop' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read', arguments: '{"filePath":"b.txt"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'tool result payload' },
      { role: 'user', content: 'latest user text to keep' },
    ] as any,
    toolManifest: {
      renderedPrompt: '## Available Tools\ncatalog_fingerprint: fp\n<|CHAT2API|tool_calls>',
    } as any,
  })

  const body = buildQwenAssemblyRequestBodyForTest({
    assembly,
    request: {
      model: 'Qwen3.7-Max',
      originalModel: 'Qwen3.7-Max',
      stream: true,
      sessionId: 'existing-provider-session',
      messages: assembly.messages as any,
    },
    actualModel: 'Qwen3.7-Max',
    sessionId: 'existing-provider-session',
    reqId: 'req',
    parentReqId: 'parent',
    timestamp: 1,
    enableThinking: false,
    enableWebSearch: false,
  })

  const content = body.messages[0].content as string
  assert.doesNotMatch(content, /very early user text to drop/)
  assert.doesNotMatch(content, /ordinary assistant text to drop/)
  assert.match(content, /<\|CHAT2API\|tool_calls>/)
  assert.match(content, /read/)
  assert.match(content, /tool result payload/)
  assert.match(content, /latest user text to keep/)
  assert.ok(content.indexOf('[Prior conversation summary]') < content.indexOf('## Available Tools'))
  assert.ok(content.indexOf('## Available Tools') < content.indexOf('latest user text to keep'))
  assert.equal(body.messages[0].meta_data.ori_query, 'latest user text to keep')
})

test('Qwen assembly path keeps full prompt with provider session when no tool-call suffix exists', () => {
  const assembly = buildRequestAssembly({
    messages: [
      { role: 'system', content: 'base system instruction' },
      { role: 'system', content: '[Prior conversation summary]\nsummary text' },
      { role: 'user', content: 'early ordinary user text' },
      { role: 'assistant', content: 'ordinary assistant reply' },
      { role: 'user', content: 'latest ordinary user text' },
    ] as any,
    toolManifest: {
      renderedPrompt: '## Available Tools\ncatalog_fingerprint: fp\n<|CHAT2API|tool_calls>',
    } as any,
  })

  const body = buildQwenAssemblyRequestBodyForTest({
    assembly,
    request: {
      model: 'Qwen3.7-Max',
      originalModel: 'Qwen3.7-Max',
      stream: true,
      sessionId: 'existing-provider-session',
      messages: assembly.messages as any,
    },
    actualModel: 'Qwen3.7-Max',
    sessionId: 'existing-provider-session',
    reqId: 'req',
    parentReqId: 'parent',
    timestamp: 1,
    enableThinking: false,
    enableWebSearch: false,
  })

  const content = body.messages[0].content as string
  assert.match(content, /early ordinary user text/)
  assert.match(content, /ordinary assistant reply/)
  assert.match(content, /latest ordinary user text/)
  assert.ok(content.indexOf('[Prior conversation summary]') < content.indexOf('## Available Tools'))
  assert.ok(content.indexOf('## Available Tools') < content.indexOf('early ordinary user text'))
})
