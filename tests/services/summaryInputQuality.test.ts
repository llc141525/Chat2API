import test from 'node:test'
import assert from 'node:assert/strict'

import { evaluateSummaryInputQuality } from '../../src/main/proxy/services/summaryInputQuality.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'

test('summaryInputQuality rejects placeholder-only sanitized history', () => {
  const messages: ChatMessage[] = [
    { role: 'assistant', content: '[tool calls summarized for workflow continuity] read(filePath="a.ts")' },
    { role: 'tool', tool_call_id: 'call_1', content: '[tool result summarized call_1] result received' },
  ]

  const quality = evaluateSummaryInputQuality(messages)
  assert.equal(quality.shouldCallProvider, false)
  assert.equal(quality.reason, 'tool_placeholder_only')
})

test('summaryInputQuality rejects skill-document-only history', () => {
  const quality = evaluateSummaryInputQuality([
    { role: 'user', content: '# superpowers\nSkill workflow instructions. SUBAGENT-STOP' },
  ])

  assert.equal(quality.shouldCallProvider, false)
  assert.equal(quality.reason, 'skill_doc_only')
})

test('summaryInputQuality rejects runtime-config-only history', () => {
  const quality = evaluateSummaryInputQuality([
    { role: 'system', content: 'You are opencode.' },
    { role: 'assistant', content: '## Available Tools\nTool `read`' },
  ])

  assert.equal(quality.shouldCallProvider, false)
  assert.equal(quality.reason, 'runtime_config_only')
})

test('summaryInputQuality accepts a real user goal plus workflow facts', () => {
  const quality = evaluateSummaryInputQuality([
    { role: 'user', content: 'Fix provider context growth without losing tool definitions.' },
    { role: 'assistant', content: '[Prior conversation summary] Classifier tests were added.' },
  ])

  assert.equal(quality.shouldCallProvider, true)
  assert.equal(quality.reason, 'has_user_goal_or_workflow_facts')
  assert.ok(quality.estimatedUsefulChars > 0)
})

test('summaryInputQuality rejects heavily contaminated useful text', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: `You are opencode.\n## Available Tools\n${'schema '.repeat(400)}` },
    { role: 'user', content: 'Continue.' },
  ]

  const quality = evaluateSummaryInputQuality(messages)
  assert.equal(quality.shouldCallProvider, false)
  assert.equal(quality.reason, 'too_contaminated')
})
