import test from 'node:test'
import assert from 'node:assert/strict'

import { SlidingWindowStrategy } from '../../src/main/proxy/services/contextManagementService.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'

// Verify that containsToolDefinitions (used internally by strategies) correctly
// identifies tool-definition messages from every known client.

function makeConversation(toolDefContent: string, messageCount = 8): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: 'You are a helpful assistant.' }]
  messages.push({ role: 'assistant', content: toolDefContent })
  for (let i = 0; i < messageCount; i++) {
    messages.push({ role: 'user', content: `Question ${i + 1}` })
    messages.push({ role: 'assistant', content: `Answer ${i + 1}` })
  }
  return messages
}

function findInResult(messages: ChatMessage[], content: string): boolean {
  return messages.some(m => typeof m.content === 'string' && m.content.includes(content))
}

// Use a window size smaller than the conversation to force trimming
const WINDOW = { enabled: true, maxMessages: 6 }

// ── Tool definition signature coverage ────────────────────────────────────────

test('SlidingWindow preserves OpenCode ## Available Tools signature', () => {
  const toolDefContent = '## Available Tools\nTool `bash`: Execute a shell command'
  const conversation = makeConversation(toolDefContent)
  const strategy = new SlidingWindowStrategy(WINDOW)
  const result = strategy.execute(conversation)
  assert.ok(findInResult(result.messages, '## Available Tools'),
    '## Available Tools message must be preserved')
})

test('SlidingWindow preserves Chat2API managed XML tool_calls marker', () => {
  const toolDefContent = '<|CHAT2API|tool_calls><|CHAT2API|invoke name="bash">...</|CHAT2API|invoke></|CHAT2API|tool_calls>'
  const conversation = makeConversation(toolDefContent)
  const strategy = new SlidingWindowStrategy(WINDOW)
  const result = strategy.execute(conversation)
  assert.ok(findInResult(result.messages, '<|CHAT2API|tool_calls>'),
    'Chat2API marker message must be preserved')
})

test('SlidingWindow preserves TOOL USE signature (Cline/RooCode style)', () => {
  const toolDefContent = '# TOOL USE\nYou can use tools in this conversation'
  const conversation = makeConversation(toolDefContent)
  const strategy = new SlidingWindowStrategy(WINDOW)
  const result = strategy.execute(conversation)
  assert.ok(findInResult(result.messages, 'TOOL USE'),
    'TOOL USE message must be preserved')
})

test('SlidingWindow preserves Cherry Studio <tools> XML block', () => {
  const toolDefContent = '<tools><tool name="bash"><description>Execute command</description></tool></tools>'
  const conversation = makeConversation(toolDefContent)
  const strategy = new SlidingWindowStrategy(WINDOW)
  const result = strategy.execute(conversation)
  assert.ok(findInResult(result.messages, '<tools>'),
    'Cherry Studio <tools> message must be preserved')
})

test('SlidingWindow preserves ## Tools signature (Kilocode style)', () => {
  const toolDefContent = '## Tools\nTool definitions:\nbash: Execute commands'
  const conversation = makeConversation(toolDefContent)
  const strategy = new SlidingWindowStrategy(WINDOW)
  const result = strategy.execute(conversation)
  assert.ok(findInResult(result.messages, '## Tools'),
    '## Tools message must be preserved')
})

test('SlidingWindow preserves ## Tool Use signature', () => {
  const toolDefContent = '## Tool Use\nWhen using tools, follow this format'
  const conversation = makeConversation(toolDefContent)
  const strategy = new SlidingWindowStrategy(WINDOW)
  const result = strategy.execute(conversation)
  assert.ok(findInResult(result.messages, '## Tool Use'),
    '## Tool Use message must be preserved')
})

test('SlidingWindow preserves function_calls bracket signature', () => {
  const toolDefContent = '[function_calls]\n[call: bash]\necho hello\n[/call]\n[/function_calls]'
  const conversation = makeConversation(toolDefContent)
  const strategy = new SlidingWindowStrategy(WINDOW)
  const result = strategy.execute(conversation)
  assert.ok(findInResult(result.messages, '[function_calls]'),
    '[function_calls] message must be preserved')
})

test('SlidingWindow does NOT preserve non-tool assistant messages', () => {
  // A regular assistant message that has no tool signature should be droppable
  const regularContent = 'I can help you with that! Let me think...'
  const conversation = makeConversation(regularContent)
  const strategy = new SlidingWindowStrategy(WINDOW)
  const result = strategy.execute(conversation)

  // The total count should be less than original (trimming happened)
  assert.ok(result.processedCount < conversation.length,
    `Expected trimming to occur; processedCount=${result.processedCount}, originalCount=${result.originalCount}`)
})
