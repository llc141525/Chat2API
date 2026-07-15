import test from 'node:test'
import assert from 'node:assert/strict'

import { preserveContextManagedMessageMetadata } from '../../src/main/proxy/contextMessageMetadata.ts'
import { createContextManagementService } from '../../src/main/proxy/services/contextManagementService.ts'
import { renderChildSessionHandoffStateMessage } from '../../src/main/proxy/sessionBoundary.ts'
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

test('summary does not summarize away an active tool exchange', async () => {
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

  const assistantIndex = result.messages.findIndex(
    (message) => message.role === 'assistant' && message.tool_calls?.[0]?.id === 'call_summary'
  )
  const toolIndex = result.messages.findIndex(
    (message) => message.role === 'tool' && message.tool_call_id === 'call_summary'
  )

  assert.equal(
    result.messages.some((message) => typeof message.content === 'string' && message.content.includes('[Conversation Summary]')),
    false,
    'active tool workflow should remain unsummarized',
  )
  assert.ok(assistantIndex !== -1, 'expected assistant tool call to be preserved')
  assert.ok(toolIndex !== -1, 'expected tool result to be preserved')
  assert.ok(assistantIndex < toolIndex, 'expected tool exchange order to be preserved')
})

test('sliding window keeps the latest active tool pair without retaining every historical skill exchange', async () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'start' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_skill_old',
        type: 'function',
        function: { name: 'skill', arguments: '{"name":"long-session"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_skill_old', content: '<skill_content>old durable instructions</skill_content>' },
    { role: 'assistant', content: 'step 1 done' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_read_old',
        type: 'function',
        function: { name: 'read', arguments: '{"filePath":"a.txt"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_read_old', content: 'a' },
    { role: 'assistant', content: 'step 2 done' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_skill_recent',
        type: 'function',
        function: { name: 'skill', arguments: '{"name":"current-window"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_skill_recent', content: '<skill_content>recent instructions</skill_content>' },
    { role: 'assistant', content: 'ready for the next tool' },
    { role: 'user', content: 'continue' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_live',
        type: 'function',
        function: { name: 'read', arguments: '{"filePath":"live.txt"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_live', content: 'live body' },
  ]

  const service = createContextManagementService({
    enabled: true,
    strategies: {
      slidingWindow: { enabled: true, maxMessages: 12 },
      tokenLimit: { enabled: false, maxTokens: 4000 },
      summary: { enabled: false, keepRecentMessages: 20 },
    },
    executionOrder: ['slidingWindow'],
  })

  const result = await service.process(messages)

  assert.ok(result.messages.some((message) => message.role === 'assistant' && message.tool_calls?.[0]?.id === 'call_live'))
  assert.ok(result.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_live'))
  assert.ok(result.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_skill_recent'))
  assert.equal(
    result.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_skill_old'),
    false,
    'historical skill instruction exchange should be trimmed once newer windows exist',
  )
  assert.ok(result.messages.length <= 12, `expected sliding window hard cap, got ${result.messages.length} messages`)
})

test('sliding window bounds a many-tool-call active assistant without metadata restoring the whole batch', async () => {
  const toolCalls = Array.from({ length: 10 }, (_, index) => ({
    id: `call_batch_${index}`,
    type: 'function' as const,
    function: { name: 'read', arguments: `{"filePath":"batch-${index}.txt"}` },
  }))

  const messages: ChatMessage[] = [
    { role: 'system', content: 'system' },
    { role: 'assistant', content: 'earlier settled reply' },
    { role: 'user', content: 'continue with the batch' },
    { role: 'assistant', content: null, tool_calls: toolCalls },
    ...toolCalls.map((call, index) => ({
      role: 'tool' as const,
      tool_call_id: call.id,
      content: `result ${index}`,
    })),
  ]

  const service = createContextManagementService({
    enabled: true,
    strategies: {
      slidingWindow: { enabled: true, maxMessages: 8 },
      tokenLimit: { enabled: false, maxTokens: 4000 },
      summary: { enabled: false, keepRecentMessages: 20 },
    },
    executionOrder: ['slidingWindow'],
  })

  const result = await service.process(messages)
  const activeAssistant = result.messages.find(
    (message) => message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0
  )
  const activeToolIds = new Set((activeAssistant?.tool_calls ?? []).map(call => call.id))
  const activeToolResults = result.messages.filter(
    (message) => message.role === 'tool' && typeof message.tool_call_id === 'string'
  )

  assert.ok(activeAssistant, 'expected active assistant tool_call message to survive')
  assert.ok(activeToolIds.size > 0, 'expected bounded active tool_call ids to survive')
  assert.ok(activeToolIds.size < toolCalls.length, 'expected assistant tool_calls to be trimmed to the bounded active subset')
  assert.deepEqual(
    [...activeToolIds],
    toolCalls.slice(-activeToolIds.size).map(call => call.id),
    'expected the newest tool_call ids to be retained',
  )
  assert.deepEqual(
    activeToolResults.map(message => message.tool_call_id),
    [...activeToolIds],
    'tool results must exactly match the trimmed assistant tool_call ids',
  )
  assert.ok(result.messages.length <= 8, `expected hard cap after metadata preservation, got ${result.messages.length} messages`)
})

test('tool catalog metadata remains restorable after a child handoff message is inserted', async () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'system' },
    { role: 'assistant', content: '## Available Tools\n- read\n- bash\n- write' },
    {
      role: 'system',
      content: renderChildSessionHandoffStateMessage({
        kind: 'subagent_child',
        status: 'ok',
        summary: 'Subagent completed a bounded step and returned a compact handoff.',
        evidence: [{ label: 'artifact', value: '.agent-probe/child-output.txt' }],
        nextAction: 'Continue from the bounded handoff only.',
        childProviderSessionId: 'subagent-child-provider-1',
      }),
    },
    { role: 'user', content: 'continue with the restored tool catalog' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_after_handoff',
        type: 'function',
        function: { name: 'write', arguments: '{"filePath":"after.txt","content":"ok"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_after_handoff', content: 'write ok' },
  ]

  const service = createContextManagementService({
    enabled: true,
    strategies: {
      slidingWindow: { enabled: true, maxMessages: 5 },
      tokenLimit: { enabled: false, maxTokens: 4000 },
      summary: { enabled: false, keepRecentMessages: 20 },
    },
    executionOrder: ['slidingWindow'],
  })

  const result = await service.process(messages)
  assert.ok(
    result.messages.some((message) => typeof message.content === 'string' && message.content.includes('## Available Tools')),
    'tool catalog contract message must survive child handoff compaction',
  )
  assert.ok(
    result.messages.some((message) => message.role === 'assistant' && message.tool_calls?.[0]?.id === 'call_after_handoff'),
    'assistant tool call after child handoff must preserve metadata',
  )
  assert.ok(
    result.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_after_handoff'),
    'tool result after child handoff must preserve tool_call_id metadata',
  )
})
