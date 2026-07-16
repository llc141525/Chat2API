import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildLocalWorkflowDigest,
  renderWorkflowDigestForProvider,
} from '../../src/main/proxy/services/workflowStateDigest.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'

test('buildLocalWorkflowDigest extracts bounded task state and records omitted config/tool bytes', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: `You are opencode.\n## Available Tools\n${'schema '.repeat(200)}` },
    { role: 'user', content: 'Fix provider context growth and keep Qwen long tasks working.' },
    { role: 'assistant', content: 'Confirmed: src/main/proxy/forwarder.ts is the shared entry point. Next: update RequestAssembly.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_read', type: 'function', function: { name: 'read', arguments: '{"filePath":"src/main/proxy/RequestAssembly.ts"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_read', content: 'x'.repeat(5000) },
  ]

  const digest = buildLocalWorkflowDigest(messages, 'local_fallback')
  const rendered = renderWorkflowDigestForProvider(digest)

  assert.match(digest.userGoal ?? '', /context growth/)
  assert.ok(digest.inspectedFiles.includes('src/main/proxy/RequestAssembly.ts'))
  assert.ok(digest.activeToolCallIds.includes('call_read'))
  assert.ok(digest.omitted.runtimeConfig > 0)
  assert.ok(digest.omitted.toolContract > 0)
  assert.ok(digest.omitted.toolPayloadBytes >= 5000)
  assert.ok(rendered.length <= 4000)
  assert.doesNotMatch(rendered, /You are opencode|## Available Tools|schema schema/)
})

test('workflow digest recovers the task tail from a mixed runtime-config user payload', () => {
  const digest = buildLocalWorkflowDigest([{
    role: 'user',
    content: [
      'You are opencode.',
      '## Available Tools',
      'Tool `read`: read a file',
      'Continue implementing provider context economy across Qwen and GLM.',
    ].join('\n'),
  }], 'client_compact')

  assert.match(digest.userGoal ?? '', /Continue implementing provider context economy/)
  assert.doesNotMatch(digest.userGoal ?? '', /You are opencode|## Available Tools|Tool `read`/)
})

test('workflow digest preserves a user goal that merely mentions a configuration marker', () => {
  const task = 'Remove duplicated superpowers instructions from provider history.'
  const digest = buildLocalWorkflowDigest([{ role: 'user', content: task }], 'client_compact')

  assert.equal(digest.userGoal, task)
})

test('workflow digest skips warmup noise as userGoal', () => {
  const digest = buildLocalWorkflowDigest([
    { role: 'user', content: 'Compaction warmup turn 1. Reply exactly WARMUP_ACK_1 and do not use tools.' },
    { role: 'assistant', content: 'WARMUP_ACK_1' },
    { role: 'user', content: 'Compaction warmup turn 2. Reply exactly WARMUP_ACK_2 and do not use tools.' },
    { role: 'assistant', content: 'WARMUP_ACK_2' },
    { role: 'user', content: 'Continue the context economy implementation.' },
    { role: 'assistant', content: 'Confirmed: the summary quality gate is rejecting compact input as too_contaminated.' },
  ], 'local_fallback')

  assert.match(digest.userGoal ?? '', /Continue the context economy/)
  assert.doesNotMatch(digest.userGoal ?? '', /warmup|WARMUP_ACK|Reply exactly/i)
})

test('workflow digest filters out short ACK echoes from confirmed facts', () => {
  const digest = buildLocalWorkflowDigest([
    { role: 'user', content: 'Compaction warmup turn 1. Reply exactly WARMUP_ACK_1 and do not use tools.' },
    { role: 'assistant', content: 'WARMUP_ACK_1' },
    { role: 'user', content: 'Compaction warmup turn 2. Reply exactly WARMUP_ACK_2 and do not use tools.' },
    { role: 'assistant', content: 'WARMUP_ACK_2' },
    { role: 'user', content: 'Fix the context economy regression.' },
    { role: 'assistant', content: 'The root cause is in the summary quality gate threshold filtering compact input.' },
  ], 'local_fallback')

  assert.equal(digest.confirmedFacts.length, 1)
  assert.match(digest.confirmedFacts[0] ?? '', /root cause.*summary quality gate/)
  for (const fact of digest.confirmedFacts) {
    assert.doesNotMatch(fact, /WARMUP_ACK|Reply exactly/i)
  }
})
