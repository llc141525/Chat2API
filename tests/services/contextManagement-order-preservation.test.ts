import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SlidingWindowStrategy,
  TokenLimitStrategy,
  SummaryStrategy,
} from '../../src/main/proxy/services/contextManagementService.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'

// Build a conversation where tool-definition messages appear mid-conversation
// (not at position 0), and verify that strategies preserve their relative order.

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content }
}

function systemMsg(content: string): ChatMessage {
  return msg('system', content)
}

function toolDefMsg(content: string): ChatMessage {
  // Include one of the GENERAL_TOOL_SIGNATURES so containsToolDefinitions returns true
  return msg('assistant', `## Available Tools\n${content}`)
}

// Build a conversation: sys → user1 → assistant1 → toolDef → user2 → assistant2 → user3 → assistant3
function makeConversation(): ChatMessage[] {
  return [
    systemMsg('You are a helpful assistant.'),
    msg('user', 'First question'),
    msg('assistant', 'First answer'),
    toolDefMsg('bash: run commands'),
    msg('user', 'Second question'),
    msg('assistant', 'Second answer'),
    msg('user', 'Third question'),
    msg('assistant', 'Third answer'),
    msg('user', 'Fourth question'),
    msg('assistant', 'Fourth answer'),
    msg('user', 'Fifth question'),
    msg('assistant', 'Fifth answer'),
    msg('user', 'Sixth question'),
    msg('assistant', 'Sixth answer'),
    msg('user', 'Seventh question'),
    msg('assistant', 'Seventh answer'),
  ]
}

function toolDefIndex(messages: ChatMessage[]): number {
  return messages.findIndex(m => typeof m.content === 'string' && m.content.includes('## Available Tools'))
}

function systemIndex(messages: ChatMessage[]): number {
  return messages.findIndex(m => m.role === 'system')
}

function makeActiveToolWorkflowConversation(): ChatMessage[] {
  return [
    systemMsg('You are a helpful assistant.'),
    msg('user', 'Question 1'),
    msg('assistant', 'Answer 1'),
    msg('user', 'Question 1.5'),
    msg('assistant', 'Answer 1.5'),
    msg('user', 'Question 1.75'),
    msg('assistant', 'Answer 1.75'),
    msg('user', 'Question 2'),
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'read', arguments: '{"filePath":"tests/agent-capability/input.txt"}' },
      }],
    },
    {
      role: 'tool',
      content: 'file body',
      tool_call_id: 'call_1',
    },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_2',
        type: 'function',
        function: { name: 'bash', arguments: '{"command":"echo done"}' },
      }],
    },
    {
      role: 'tool',
      content: 'done',
      tool_call_id: 'call_2',
    },
  ]
}

// SlidingWindow ────────────────────────────────────────────────────────────────

test('SlidingWindow: tool-definition message stays at its original relative position', () => {
  const conversation = makeConversation()
  const origToolDefIndex = toolDefIndex(conversation)
  assert.ok(origToolDefIndex > 0, 'toolDef must not be the first message in test fixture')

  const strategy = new SlidingWindowStrategy({ enabled: true, maxMessages: 6 })
  const result = strategy.execute(conversation)

  const resultToolIdx = toolDefIndex(result.messages)
  assert.ok(resultToolIdx !== -1, 'tool-def message must be preserved')

  const resultSystemIdx = systemIndex(result.messages)
  assert.ok(resultSystemIdx !== -1, 'system message must be preserved')

  // System message must still come before the tool-def message (original order)
  assert.ok(resultSystemIdx < resultToolIdx,
    `Expected system(${resultSystemIdx}) < toolDef(${resultToolIdx}) — protected messages must keep original order`)
})

test('SlidingWindow: non-protected messages appear in original order (not shuffled)', () => {
  const conversation = makeConversation()
  const strategy = new SlidingWindowStrategy({ enabled: true, maxMessages: 7 })
  const result = strategy.execute(conversation)

  // All output messages must be a subsequence of the input (no reordering)
  let inputCursor = 0
  for (const outMsg of result.messages) {
    while (inputCursor < conversation.length && conversation[inputCursor] !== outMsg) {
      inputCursor += 1
    }
    assert.ok(inputCursor < conversation.length,
      `Output message "${outMsg.content}" not found in original conversation (or appeared out of order)`)
    inputCursor += 1
  }
})

test('SlidingWindow: active tool-workflow suffix is preserved intact', () => {
  const conversation = makeActiveToolWorkflowConversation()
  const strategy = new SlidingWindowStrategy({ enabled: true, maxMessages: 4 })
  const result = strategy.execute(conversation)

  const workflowMessages = result.messages.filter(
    message => message.role === 'assistant' || message.role === 'tool'
  )

  assert.deepEqual(
    workflowMessages.slice(-4).map(message => ({
      role: message.role,
      toolCallId: message.tool_call_id ?? null,
      toolCalls: (message.tool_calls ?? []).map(call => call.id),
      content: message.content,
    })),
    conversation.slice(-4).map(message => ({
      role: message.role,
      toolCallId: message.tool_call_id ?? null,
      toolCalls: (message.tool_calls ?? []).map(call => call.id),
      content: message.content,
    })),
  )
})

// TokenLimit ───────────────────────────────────────────────────────────────────

test('TokenLimit: tool-definition message stays at its original relative position', () => {
  const conversation = makeConversation()

  const strategy = new TokenLimitStrategy({ enabled: true, maxTokens: 100 })
  const result = strategy.execute(conversation)

  const resultToolIdx = toolDefIndex(result.messages)
  assert.ok(resultToolIdx !== -1, 'tool-def message must be preserved')

  const resultSystemIdx = systemIndex(result.messages)
  assert.ok(resultSystemIdx !== -1, 'system message must be preserved')

  assert.ok(resultSystemIdx < resultToolIdx,
    `Expected system(${resultSystemIdx}) < toolDef(${resultToolIdx})`)
})

test('TokenLimit: output messages form an order-preserving subsequence of input', () => {
  const conversation = makeConversation()
  const strategy = new TokenLimitStrategy({ enabled: true, maxTokens: 80 })
  const result = strategy.execute(conversation)

  let inputCursor = 0
  for (const outMsg of result.messages) {
    while (inputCursor < conversation.length && conversation[inputCursor] !== outMsg) {
      inputCursor += 1
    }
    assert.ok(inputCursor < conversation.length,
      `Output message not found in original conversation or appeared out of order`)
    inputCursor += 1
  }
})

test('TokenLimit: active tool-workflow suffix is preserved intact', () => {
  const conversation = makeActiveToolWorkflowConversation()
  const strategy = new TokenLimitStrategy({ enabled: true, maxTokens: 20 })
  const result = strategy.execute(conversation)

  assert.deepEqual(
    result.messages.slice(-5).map(message => ({
      role: message.role,
      toolCallId: message.tool_call_id ?? null,
      toolCalls: (message.tool_calls ?? []).map(call => call.id),
      content: message.content,
    })),
    conversation.slice(-5).map(message => ({
      role: message.role,
      toolCallId: message.tool_call_id ?? null,
      toolCalls: (message.tool_calls ?? []).map(call => call.id),
      content: message.content,
    })),
  )
})

// SummaryStrategy ──────────────────────────────────────────────────────────────

test('SummaryStrategy: protected messages stay at original positions relative to summary', async () => {
  const conversation = makeConversation()

  const dummyGenerator = async (messages: ChatMessage[]) =>
    `Summary of ${messages.length} messages.`

  const strategy = new SummaryStrategy({ enabled: true, keepRecentMessages: 4 }, dummyGenerator)
  const result = await strategy.execute(conversation)

  const resultToolIdx = toolDefIndex(result.messages)
  assert.ok(resultToolIdx !== -1, 'tool-def message must survive summary compaction')

  const resultSystemIdx = systemIndex(result.messages)
  assert.ok(resultSystemIdx !== -1, 'system message must survive summary compaction')

  // System message must still precede the tool-def message
  assert.ok(resultSystemIdx < resultToolIdx,
    `Expected system(${resultSystemIdx}) < toolDef(${resultToolIdx}) in summary output`)
})

test('SummaryStrategy: active tool-workflow suffix is never summarized away', async () => {
  const conversation = makeActiveToolWorkflowConversation()
  const dummyGenerator = async (messages: ChatMessage[]) =>
    `Summary of ${messages.length} messages.`

  const strategy = new SummaryStrategy({ enabled: true, keepRecentMessages: 2 }, dummyGenerator)
  const result = await strategy.execute(conversation)

  assert.equal(
    result.messages.some(message => typeof message.content === 'string' && message.content.includes('[Prior conversation summary')),
    true,
    'expected summary compaction to happen',
  )

  assert.deepEqual(
    result.messages.slice(-5).map(message => ({
      role: message.role,
      toolCallId: message.tool_call_id ?? null,
      toolCalls: (message.tool_calls ?? []).map(call => call.id),
      content: message.content,
    })),
    conversation.slice(-5).map(message => ({
      role: message.role,
      toolCallId: message.tool_call_id ?? null,
      toolCalls: (message.tool_calls ?? []).map(call => call.id),
      content: message.content,
    })),
  )
})

test('SummaryStrategy: oversized active tool batch keeps only the newest bounded tool subset', async () => {
  const toolCalls = Array.from({ length: 9 }, (_, index) => ({
    id: `call_active_${index}`,
    type: 'function' as const,
    function: { name: 'read', arguments: `{"filePath":"active-${index}.txt"}` },
  }))

  const conversation: ChatMessage[] = [
    systemMsg('You are a helpful assistant.'),
    msg('user', 'Earlier question'),
    msg('assistant', 'Earlier answer'),
    msg('user', 'Run the big batch'),
    { role: 'assistant', content: null, tool_calls: toolCalls },
    ...toolCalls.map((call, index) => ({
      role: 'tool' as const,
      tool_call_id: call.id,
      content: `batch result ${index}`,
    })),
  ]

  const dummyGenerator = async (messages: ChatMessage[]) =>
    `Summary of ${messages.length} messages.`

  const strategy = new SummaryStrategy({ enabled: true, keepRecentMessages: 2 }, dummyGenerator)
  const result = await strategy.execute(conversation)

  const activeAssistant = result.messages.find(
    message => message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0
  )
  const activeToolIds = (activeAssistant?.tool_calls ?? []).map(call => call.id)
  const activeToolResults = result.messages.filter(
    message => message.role === 'tool' && typeof message.tool_call_id === 'string'
  )

  assert.equal(result.subkind, 'summary_skipped_active_tool_workflow')
  assert.ok(activeAssistant, 'expected active assistant tool call message to survive')
  assert.ok(activeToolIds.length > 0 && activeToolIds.length < toolCalls.length,
    `expected bounded active tool subset, got ${activeToolIds.length} ids`)
  assert.deepEqual(activeToolIds, toolCalls.slice(-activeToolIds.length).map(call => call.id))
  assert.deepEqual(activeToolResults.map(message => message.tool_call_id), activeToolIds)
  assert.ok(result.messages.length <= 10, `expected bounded summary output, got ${result.messages.length} messages`)
})

test('SummaryStrategy: active tool handoff skips external summary generator', async () => {
  let generatorCalls = 0
  const toolCalls = Array.from({ length: 8 }, (_, index) => ({
    id: `call_handoff_${index}`,
    type: 'function' as const,
    function: { name: index === 0 ? 'skill' : 'bash', arguments: index === 0 ? '{"name":"long-conversation-probe"}' : `{"command":"step ${index}"}` },
  }))
  const conversation: ChatMessage[] = [
    systemMsg('You are a helpful assistant.'),
    msg('user', 'Run long workflow'),
    ...toolCalls.flatMap((call, index) => [
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: [call],
      },
      {
        role: 'tool' as const,
        tool_call_id: call.id,
        content: index === 0
          ? '<skill_content name="long-conversation-probe">instructions</skill_content>'
          : `completed step ${index}`,
      },
    ]),
  ]

  const strategy = new SummaryStrategy({ enabled: true, keepRecentMessages: 2 }, async () => {
    generatorCalls += 1
    return 'This should not be called during active tool handoff.'
  })
  const result = await strategy.execute(conversation)

  assert.equal(generatorCalls, 0)
  assert.equal(result.subkind, 'summary_skipped_active_tool_workflow')
  assert.equal(
    result.messages.some(message =>
      typeof message.content === 'string'
      && (
        message.content.includes('[Completed tool exchange handoff]')
        || message.content.includes('[Active skill workflow state checkpoint]')
      )
    ),
    true,
  )
})
