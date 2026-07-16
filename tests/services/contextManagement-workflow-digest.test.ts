import test from 'node:test'
import assert from 'node:assert/strict'

import { SummaryStrategy } from '../../src/main/proxy/services/contextManagementService.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'

const messages: ChatMessage[] = [
  { role: 'user', content: 'Keep Qwen long tasks working.' },
  { role: 'assistant', content: 'Confirmed src/main/proxy/forwarder.ts is the entry point.' },
  { role: 'user', content: 'Next: update request assembly.' },
  { role: 'assistant', content: 'Working on it.' },
]

test('SummaryStrategy returns workflowDigest on local fallback', async () => {
  const result = await new SummaryStrategy({ enabled: true, keepRecentMessages: 1 }).execute(messages)

  assert.equal(result.subkind, 'summary_fallback_local')
  assert.equal(result.workflowDigest?.kind, 'workflow_state_digest')
  assert.equal(result.workflowDigest?.source, 'local_fallback')
})

test('SummaryStrategy returns external workflowDigest on usable provider summary', async () => {
  const result = await new SummaryStrategy(
    { enabled: true, keepRecentMessages: 1 },
    async () => 'The shared request assembly must strip runtime config and preserve the current task.',
  ).execute(messages)

  assert.equal(result.subkind, 'summary_success')
  assert.equal(result.workflowDigest?.source, 'external_summary')
  assert.match(result.workflowDigest?.userGoal ?? '', /Qwen long tasks/)
})

test('SummaryStrategy returns local workflowDigest when provider summary is unusable', async () => {
  const result = await new SummaryStrategy(
    { enabled: true, keepRecentMessages: 1 },
    async () => 'No conversation to summarize.',
  ).execute(messages)

  assert.equal(result.subkind, 'summary_fallback_local')
  assert.equal(result.workflowDigest?.source, 'local_fallback')
})
