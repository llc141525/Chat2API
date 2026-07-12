import test from 'node:test'
import assert from 'node:assert/strict'

import { SummaryStrategy } from '../../src/main/proxy/services/contextManagementService.ts'
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

test('SummaryStrategy: subkind is summary_generator_missing when no generator and messages exceed limit', async () => {
  const strategy = new SummaryStrategy({ enabled: true, keepRecentMessages: 4 })
  const messages = makeConversation(8)
  const result = await strategy.execute(messages)

  assert.equal(result.trimmed, true)
  assert.equal(result.subkind, 'summary_generator_missing',
    `Expected summary_generator_missing subkind, got: ${result.subkind}`)
})

test('SummaryStrategy: subkind is summary_generator_failed when generator throws', async () => {
  const failingGenerator = async (_msgs: ChatMessage[]) => {
    throw new Error('LLM API timeout')
  }
  const strategy = new SummaryStrategy({ enabled: true, keepRecentMessages: 4 }, failingGenerator)
  const messages = makeConversation(8)
  const result = await strategy.execute(messages)

  assert.equal(result.trimmed, true)
  assert.equal(result.subkind, 'summary_generator_failed',
    `Expected summary_generator_failed subkind, got: ${result.subkind}`)
})

test('SummaryStrategy: empty summary output is treated as summary_generator_failed', async () => {
  const emptyGenerator = async (_msgs: ChatMessage[]) => '   '
  const strategy = new SummaryStrategy({ enabled: true, keepRecentMessages: 4 }, emptyGenerator)
  const messages = makeConversation(8)
  const result = await strategy.execute(messages)

  assert.equal(result.trimmed, true)
  assert.equal(result.subkind, 'summary_generator_failed',
    `Expected summary_generator_failed for empty summary output, got: ${result.subkind}`)
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
