import test from 'node:test'
import assert from 'node:assert/strict'

import { SlidingWindowStrategy } from '../../src/main/proxy/services/contextManagementService.ts'
import { buildRequestAssembly } from '../../src/main/proxy/RequestAssembly.ts'
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

function assertContractAvailableForExtractionButNotProviderVisible(messages: ChatMessage[], marker: string): void {
  assert.ok(findInResult(messages, marker), `${marker} must remain available until catalog extraction`)
  const assembly = buildRequestAssembly({ messages, toolManifest: null })
  assert.equal(findInResult(assembly.messages, marker), false, `${marker} must not remain in provider-visible history`)
}

// Use a window size smaller than the conversation to force trimming
const WINDOW = { enabled: true, maxMessages: 6 }

// ── Tool definition signature coverage ────────────────────────────────────────

test('SlidingWindow keeps OpenCode catalog extractable while assembly strips its history', () => {
  const toolDefContent = '## Available Tools\nTool `bash`: Execute a shell command'
  const conversation = makeConversation(toolDefContent)
  const strategy = new SlidingWindowStrategy(WINDOW)
  const result = strategy.execute(conversation)
  assertContractAvailableForExtractionButNotProviderVisible(result.messages, '## Available Tools')
})

test('SlidingWindow preserves Chat2API managed XML tool_calls marker', () => {
  const toolDefContent = '<|CHAT2API|tool_calls><|CHAT2API|invoke name="bash">...</|CHAT2API|invoke></|CHAT2API|tool_calls>'
  const conversation = makeConversation(toolDefContent)
  const strategy = new SlidingWindowStrategy(WINDOW)
  const result = strategy.execute(conversation)
  assert.ok(findInResult(result.messages, '<|CHAT2API|tool_calls>'),
    'Chat2API marker message must be preserved')
})

test('SlidingWindow keeps Cline catalog extractable while assembly strips its history', () => {
  const toolDefContent = '# TOOL USE\nYou can use tools in this conversation'
  const conversation = makeConversation(toolDefContent)
  const strategy = new SlidingWindowStrategy(WINDOW)
  const result = strategy.execute(conversation)
  assertContractAvailableForExtractionButNotProviderVisible(result.messages, 'TOOL USE')
})

test('SlidingWindow keeps Cherry Studio catalog extractable while assembly strips its history', () => {
  const toolDefContent = '<tools><tool name="bash"><description>Execute command</description></tool></tools>'
  const conversation = makeConversation(toolDefContent)
  const strategy = new SlidingWindowStrategy(WINDOW)
  const result = strategy.execute(conversation)
  assertContractAvailableForExtractionButNotProviderVisible(result.messages, '<tools>')
})

test('SlidingWindow keeps Kilocode catalog extractable while assembly strips its history', () => {
  const toolDefContent = '## Tools\nTool definitions:\nbash: Execute commands'
  const conversation = makeConversation(toolDefContent)
  const strategy = new SlidingWindowStrategy(WINDOW)
  const result = strategy.execute(conversation)
  assertContractAvailableForExtractionButNotProviderVisible(result.messages, '## Tools')
})

test('SlidingWindow keeps Tool Use catalog extractable while assembly strips its history', () => {
  const toolDefContent = '## Tool Use\nWhen using tools, follow this format'
  const conversation = makeConversation(toolDefContent)
  const strategy = new SlidingWindowStrategy(WINDOW)
  const result = strategy.execute(conversation)
  assertContractAvailableForExtractionButNotProviderVisible(result.messages, '## Tool Use')
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
