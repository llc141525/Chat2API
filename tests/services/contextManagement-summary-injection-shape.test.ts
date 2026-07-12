import test from 'node:test'
import assert from 'node:assert/strict'

import { SummaryStrategy } from '../../src/main/proxy/services/contextManagementService.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content }
}

function makeConversation(): ChatMessage[] {
  const messages: ChatMessage[] = [msg('system', 'You are a helpful assistant.')]
  for (let i = 0; i < 8; i++) {
    messages.push(msg('user', `Question ${i + 1}`))
    messages.push(msg('assistant', `Answer ${i + 1}`))
  }
  return messages
}

const dummyGenerator = async (msgs: ChatMessage[]) => `Summary of ${msgs.length} messages.`

test('summary injection uses the isolated system narrative shape', async () => {
  const strategy = new SummaryStrategy(
    { enabled: true, keepRecentMessages: 4 },
    dummyGenerator
  )

  const result = await strategy.execute(makeConversation())

  const summaryMsg = result.messages.find(
    m => typeof m.content === 'string' && m.content.includes('[Prior conversation summary')
  )
  assert.ok(summaryMsg, 'summary message must exist')
  assert.equal(summaryMsg!.role, 'system', 'summary must remain isolated in the system layer')
  assert.ok((summaryMsg!.content as string).includes('non-authoritative narrative'))
  assert.equal(result.subkind, 'summary_success')
})

test('summary injection appears before the first recent message', async () => {
  const strategy = new SummaryStrategy(
    { enabled: true, keepRecentMessages: 4 },
    dummyGenerator
  )

  const conversation = makeConversation()
  const result = await strategy.execute(conversation)

  const summaryMsg = result.messages.find(
    m => typeof m.content === 'string' && m.content.includes('[Prior conversation summary')
  )
  assert.ok(summaryMsg, 'summary message must exist')
  assert.equal(summaryMsg!.role, 'system', 'summary must remain in the system layer')

  const summaryIdx = result.messages.findIndex(
    m => typeof m.content === 'string' && m.content.includes('[Prior conversation summary')
  )
  assert.ok(summaryIdx !== -1, 'summary must be present')

  // There should be recent messages after the summary
  const remaining = result.messages.slice(summaryIdx + 1)
  assert.ok(remaining.some(m => m.role === 'user'), 'user messages must follow summary')
})
