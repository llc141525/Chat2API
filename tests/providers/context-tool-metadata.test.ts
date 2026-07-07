import test from 'node:test'
import assert from 'node:assert/strict'

import { preserveContextManagedMessageMetadata } from '../../src/main/proxy/contextMessageMetadata.ts'
import { createContextManagementService } from '../../src/main/proxy/services/contextManagementService.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'

test('context management preserves assistant tool_calls and tool_call_id metadata', () => {
  const original: ChatMessage[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'read file' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_0',
          type: 'function',
          function: { name: 'default_api:read_file', arguments: '{"filePath":"/tmp/a"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call_0', content: 'file body' },
    { role: 'user', content: 'continue' },
  ]

  const processed = original.slice(1).map((message) => ({
    role: message.role,
    content: message.content,
  }))

  const restored = preserveContextManagedMessageMetadata(original, processed as ChatMessage[])

  assert.deepEqual(restored[1].tool_calls, original[2].tool_calls)
  assert.equal(restored[2].tool_call_id, 'call_0')
})

test('sliding window keeps assistant tool call when retained tool result references it', async () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'read file' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_keep',
        type: 'function',
        function: { name: 'default_api:read_file', arguments: '{"filePath":"/tmp/a"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_keep', content: 'file body' },
    { role: 'user', content: 'continue' },
  ]

  const service = createContextManagementService({
    enabled: true,
    strategies: {
      slidingWindow: { enabled: true, maxMessages: 3 },
      tokenLimit: { enabled: false, maxTokens: 4000 },
      summary: { enabled: false, keepRecentMessages: 20 },
    },
    executionOrder: ['slidingWindow'],
  })

  const result = await service.process(messages)
  assert.ok(result.messages.some((message) => message.role === 'assistant' && message.tool_calls?.[0]?.id === 'call_keep'))
  assert.ok(result.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_keep'))
})

test('token limit keeps tool result when retained assistant tool call references it', async () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'system' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_token',
        type: 'function',
        function: { name: 'default_api:read_file', arguments: '{"filePath":"/tmp/a"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_token', content: 'file body' },
    { role: 'user', content: 'x'.repeat(200) },
  ]

  const service = createContextManagementService({
    enabled: true,
    strategies: {
      slidingWindow: { enabled: false, maxMessages: 20 },
      tokenLimit: { enabled: true, maxTokens: 50 },
      summary: { enabled: false, keepRecentMessages: 20 },
    },
    executionOrder: ['tokenLimit'],
  })

  const result = await service.process(messages)
  assert.ok(result.messages.some((message) => message.role === 'assistant' && message.tool_calls?.[0]?.id === 'call_token'))
  assert.ok(result.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_token'))
})

test('summary keeps generated summary while restoring related tool exchange pairs', async () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'read file' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_summary',
        type: 'function',
        function: { name: 'default_api:read_file', arguments: '{"filePath":"/tmp/a"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_summary', content: 'file body' },
    { role: 'user', content: 'continue' },
  ]

  const service = createContextManagementService({
    enabled: true,
    strategies: {
      slidingWindow: { enabled: false, maxMessages: 20 },
      tokenLimit: { enabled: false, maxTokens: 4000 },
      summary: { enabled: true, keepRecentMessages: 2 },
    },
    executionOrder: ['summary'],
  }, async () => 'trimmed summary')

  const result = await service.process(messages)

  assert.equal(result.messages[1].content, '[Conversation Summary]\ntrimmed summary')
  assert.equal(result.messages[2].role, 'assistant')
  assert.equal(result.messages[2].tool_calls?.[0]?.id, 'call_summary')
  assert.equal(result.messages[3].role, 'tool')
  assert.equal(result.messages[3].tool_call_id, 'call_summary')
})
