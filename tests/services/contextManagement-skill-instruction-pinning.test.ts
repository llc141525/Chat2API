import test from 'node:test'
import assert from 'node:assert/strict'

import { ContextManagementService } from '../../src/main/proxy/services/contextManagementService.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'

function buildLongSkillHistory(): ChatMessage[] {
  return [
    { role: 'system', content: 'You are a coding assistant.' },
    { role: 'user', content: 'Run the long conversation probe.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_skill_0',
        type: 'function',
        function: { name: 'skill', arguments: '{"name":"long-conversation-probe"}' },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'call_skill_0',
      content: [
        '<skill_content name="long-conversation-probe">',
        '1. Use read on tests/agent-capability/input.txt',
        '2. Use bash to write .agent-probe/long-step-1.txt',
        'The final marker is assembled from LONG + CONVERSATION + PROBE + DONE with underscores.',
        '10. Output only the exact final marker assembled from LONG + CONVERSATION + PROBE + DONE with underscores.',
        '</skill_content>',
      ].join('\n'),
    },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_read_1', type: 'function', function: { name: 'read', arguments: '{"filePath":"tests/agent-capability/input.txt"}' } }] },
    { role: 'tool', tool_call_id: 'call_read_1', content: 'input body' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_bash_1', type: 'function', function: { name: 'bash', arguments: '{"command":"write long-step-1"}' } }] },
    { role: 'tool', tool_call_id: 'call_bash_1', content: 'created long-step-1' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_read_2', type: 'function', function: { name: 'read', arguments: '{"filePath":"tests/agent-capability/long-conversation-payload.txt"}' } }] },
    { role: 'tool', tool_call_id: 'call_read_2', content: 'payload body' },
    { role: 'assistant', content: 'Progress update after several steps.' },
    { role: 'user', content: 'Continue exactly.' },
    { role: 'assistant', content: 'Acknowledged.' },
  ]
}

test('summary compaction preserves the original skill instruction exchange', async () => {
  const service = new ContextManagementService({
    enabled: true,
    strategies: {
      slidingWindow: { enabled: false, maxMessages: 20 },
      tokenLimit: { enabled: false, maxTokens: 4000 },
      summary: { enabled: true, keepRecentMessages: 3, summaryPrompt: 'Summarize progress only.' },
    },
    executionOrder: ['summary'],
  }, async () => 'Probe is in progress.')

  const result = await service.process(buildLongSkillHistory())

  const skillAssistant = result.messages.find((message) =>
    message.role === 'assistant'
      && (message.tool_calls ?? []).some((call) => call.function.name === 'skill'),
  )
  const skillResult = result.messages.find((message) =>
    message.role === 'tool' && message.tool_call_id === 'call_skill_0',
  )

  assert.ok(skillAssistant, 'skill tool_call assistant turn must survive summary compaction')
  assert.ok(skillResult, 'skill tool_result turn must survive summary compaction')
  assert.match(String(skillResult!.content), /long-step-1\.txt/)
  assert.match(String(skillResult!.content), /LONG \+ CONVERSATION \+ PROBE \+ DONE/)
})

test('token limit compaction preserves the original skill instruction exchange', async () => {
  const service = new ContextManagementService({
    enabled: true,
    strategies: {
      slidingWindow: { enabled: false, maxMessages: 20 },
      tokenLimit: { enabled: true, maxTokens: 120 },
      summary: { enabled: false, keepRecentMessages: 20 },
    },
    executionOrder: ['tokenLimit'],
  })

  const result = await service.process(buildLongSkillHistory())

  const skillAssistant = result.messages.find((message) =>
    message.role === 'assistant'
      && (message.tool_calls ?? []).some((call) => call.function.name === 'skill'),
  )
  const skillResult = result.messages.find((message) =>
    message.role === 'tool' && message.tool_call_id === 'call_skill_0',
  )

  assert.ok(skillAssistant, 'skill tool_call assistant turn must survive token compaction')
  assert.ok(skillResult, 'skill tool_result turn must survive token compaction')
})
