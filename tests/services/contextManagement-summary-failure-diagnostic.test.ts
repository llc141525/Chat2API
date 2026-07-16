import test from 'node:test'
import assert from 'node:assert/strict'

import { ContextManagementService, SummaryStrategy } from '../../src/main/proxy/services/contextManagementService.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content }
}

function makeConversation(count = 12): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: 'You are a helpful assistant.' }]
  for (let i = 0; i < count; i++) {
    messages.push(msg('user', `Question ${i + 1}`))
    messages.push(msg('assistant', `Answer ${i + 1}`))
  }
  return messages
}

function findSummaryMessage(messages: ChatMessage[]): ChatMessage | undefined {
  return messages.find(message =>
    typeof message.content === 'string' &&
    message.content.includes('[Prior conversation summary')
  )
}

// ── Summary failure diagnostics ───────────────────────────────────────────────

test('SummaryStrategy: subkind is summary_not_needed when messages <= keepRecent', async () => {
  const strategy = new SummaryStrategy({ enabled: true, keepRecentMessages: 20 })
  const messages = makeConversation(5)
  const result = await strategy.execute(messages)

  assert.equal(result.trimmed, false)
  assert.ok(
    result.subkind === 'summary_not_needed' || result.subkind === undefined,
    `Expected summary_not_needed or undefined, got: ${result.subkind}`,
  )
})

test('SummaryStrategy: local fallback summary is used when no generator and messages exceed limit', async () => {
  const strategy = new SummaryStrategy({ enabled: true, keepRecentMessages: 4 })
  const messages = makeConversation(8)
  const result = await strategy.execute(messages)

  assert.equal(result.trimmed, true)
  assert.equal(result.subkind, 'summary_fallback_local',
    `Expected summary_fallback_local subkind, got: ${result.subkind}`)
  assert.ok(findSummaryMessage(result.messages), 'local fallback summary must be inserted')
})

test('SummaryStrategy: local fallback summary is used when generator throws', async () => {
  const failingGenerator = async (_msgs: ChatMessage[]) => {
    throw new Error('LLM API timeout')
  }
  const strategy = new SummaryStrategy({ enabled: true, keepRecentMessages: 4 }, failingGenerator)
  const messages = makeConversation(8)
  const result = await strategy.execute(messages)

  assert.equal(result.trimmed, true)
  assert.equal(result.subkind, 'summary_fallback_local',
    `Expected summary_fallback_local subkind, got: ${result.subkind}`)
  const summary = findSummaryMessage(result.messages)
  assert.ok(summary, 'local fallback summary must be inserted')
  assert.match(String(summary!.content), /Local fallback summary/)
})

test('SummaryStrategy: empty summary output uses local fallback summary', async () => {
  const emptyGenerator = async (_msgs: ChatMessage[]) => '   '
  const strategy = new SummaryStrategy({ enabled: true, keepRecentMessages: 4 }, emptyGenerator)
  const messages = makeConversation(8)
  const result = await strategy.execute(messages)

  assert.equal(result.trimmed, true)
  assert.equal(result.subkind, 'summary_fallback_local',
    `Expected summary_fallback_local for empty summary output, got: ${result.subkind}`)
  assert.ok(findSummaryMessage(result.messages), 'local fallback summary must be inserted')
})

test('SummaryStrategy: no-conversation summary output uses local fallback summary', async () => {
  const noConversationGenerator = async (_msgs: ChatMessage[]) => 'No conversation to summarize.'
  const strategy = new SummaryStrategy({ enabled: true, keepRecentMessages: 4 }, noConversationGenerator)
  const messages = makeConversation(8)
  const result = await strategy.execute(messages)

  assert.equal(result.trimmed, true)
  assert.equal(result.subkind, 'summary_fallback_local',
    `Expected summary_fallback_local for no-conversation output, got: ${result.subkind}`)
  assert.ok(findSummaryMessage(result.messages), 'local fallback summary must be inserted')
  assert.ok(
    result.messages.every(message => {
      const content = typeof message.content === 'string' ? message.content : ''
      return !content.includes('No conversation to summarize')
    }),
    'no-conversation text must not be inserted as a prior conversation summary',
  )
})

test('ContextManagementService marks local fallback summary as generated for compact epoch routing', async () => {
  const noConversationGenerator = async (_msgs: ChatMessage[]) => 'No conversation to summarize.'
  const service = new ContextManagementService({
    enabled: true,
    strategies: {
      slidingWindow: { enabled: false, maxMessages: 20 },
      tokenLimit: { enabled: false, maxTokens: 4000 },
      summary: { enabled: true, keepRecentMessages: 4 },
    },
    executionOrder: ['summary'],
  }, noConversationGenerator)

  const result = await service.process(makeConversation(8))

  assert.equal(result.summaryGenerated, true)
  assert.equal(result.strategyResults[0]?.subkind, 'summary_fallback_local')
  assert.ok(findSummaryMessage(result.messages), 'local fallback summary must be present in processed messages')
})

test('SummaryStrategy: subkind is summary_success when generator returns valid summary', async () => {
  const successGenerator = async (msgs: ChatMessage[]) => `Summary of ${msgs.length} messages`
  const strategy = new SummaryStrategy({ enabled: true, keepRecentMessages: 4 }, successGenerator)
  const messages = makeConversation(8)
  const result = await strategy.execute(messages)

  assert.equal(result.trimmed, true)
  assert.equal(result.subkind, 'summary_success',
    `Expected summary_success subkind, got: ${result.subkind}`)
})

test('SummaryStrategy: disabled strategy returns not_applicable subkind', async () => {
  const strategy = new SummaryStrategy({ enabled: false, keepRecentMessages: 4 })
  const messages = makeConversation(8)
  const result = await strategy.execute(messages)

  assert.equal(result.trimmed, false)
  assert.ok(
    result.subkind === 'not_applicable' || result.subkind === undefined,
    `Expected not_applicable or undefined for disabled strategy, got: ${result.subkind}`,
  )
})
