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
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_skill_1',
        type: 'function',
        function: { name: 'skill', arguments: '{"name":"checkpoint-probe"}' },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'call_skill_1',
      content: [
        '<skill_content name="checkpoint-probe">',
        '1. Re-open the generated checkpoint file before continuing.',
        '2. Re-emit the exact completion marker at the end.',
        '</skill_content>',
      ].join('\n'),
    },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_read_3', type: 'function', function: { name: 'read', arguments: '{"filePath":".agent-probe/long-step-1.txt"}' } }] },
    { role: 'tool', tool_call_id: 'call_read_3', content: 'checkpoint body' },
    { role: 'user', content: 'Continue exactly.' },
    { role: 'assistant', content: 'Acknowledged.' },
  ]
}

test('summary compaction only pins the most recent skill instruction exchange', async () => {
  const service = new ContextManagementService({
    enabled: true,
    strategies: {
      slidingWindow: { enabled: false, maxMessages: 20 },
      tokenLimit: { enabled: false, maxTokens: 4000 },
      summary: { enabled: true, keepRecentMessages: 6, summaryPrompt: 'Summarize progress only.' },
    },
    executionOrder: ['summary'],
  }, async () => 'Probe is in progress.')

  const result = await service.process(buildLongSkillHistory())

  const pinnedSkillAssistant = result.messages.find((message) =>
    message.role === 'assistant'
      && (message.tool_calls ?? []).some((call) => call.id === 'call_skill_1'),
  )
  const pinnedSkillResult = result.messages.find((message) =>
    message.role === 'tool' && message.tool_call_id === 'call_skill_1',
  )
  const droppedHistoricalSkillResult = result.messages.find((message) =>
    message.role === 'tool' && message.tool_call_id === 'call_skill_0',
  )

  assert.ok(pinnedSkillAssistant, 'most recent skill assistant turn must survive summary compaction')
  assert.ok(pinnedSkillResult, 'most recent skill tool_result turn must survive summary compaction')
  assert.equal(droppedHistoricalSkillResult, undefined, 'older skill tool_result should no longer stay pinned forever')
  assert.match(String(pinnedSkillResult!.content), /checkpoint file/i)
  assert.ok(result.messages.length <= 11, `expected bounded summary output, got ${result.messages.length} messages`)
})

test('token limit compaction only pins the most recent skill instruction exchange', async () => {
  const service = new ContextManagementService({
    enabled: true,
    strategies: {
      slidingWindow: { enabled: false, maxMessages: 20 },
      tokenLimit: { enabled: true, maxTokens: 170 },
      summary: { enabled: false, keepRecentMessages: 20 },
    },
    executionOrder: ['tokenLimit'],
  })

  const result = await service.process(buildLongSkillHistory())

  const pinnedSkillAssistant = result.messages.find((message) =>
    message.role === 'assistant'
      && (message.tool_calls ?? []).some((call) => call.id === 'call_skill_1'),
  )
  const pinnedSkillResult = result.messages.find((message) =>
    message.role === 'tool' && message.tool_call_id === 'call_skill_1',
  )
  assert.ok(pinnedSkillAssistant, 'most recent skill assistant turn must survive token compaction')
  assert.ok(pinnedSkillResult, 'most recent skill tool_result turn must survive token compaction')
})

test('active workflow keeps the latest skill instruction exchange exact without pinning older skill history forever', async () => {
  const service = new ContextManagementService({
    enabled: true,
    strategies: {
      slidingWindow: { enabled: true, maxMessages: 6 },
      tokenLimit: { enabled: false, maxTokens: 4000 },
      summary: { enabled: true, keepRecentMessages: 2, summaryPrompt: 'Summarize progress only.' },
    },
    executionOrder: ['summary', 'slidingWindow'],
  }, async () => 'Probe is in progress.')

  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are a coding assistant.' },
    { role: 'assistant', content: '## Available Tools\n- skill\n- read\n- bash' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_skill_0',
        type: 'function',
        function: { name: 'skill', arguments: '{"name":"old-probe"}' },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'call_skill_0',
      content: '<skill_content name="old-probe">old instructions</skill_content>',
    },
    { role: 'assistant', content: 'Progress update after old probe.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_skill_1',
        type: 'function',
        function: { name: 'skill', arguments: '{"name":"long-conversation-probe"}' },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'call_skill_1',
      content: [
        '<skill_content name="long-conversation-probe">',
        '1. Read input.',
        '2. Write long-step-1.',
        '3. Read payload.',
        '</skill_content>',
      ].join('\n'),
    },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_read_1',
        type: 'function',
        function: { name: 'read', arguments: '{"filePath":"tests/agent-capability/input.txt"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_read_1', content: 'input body' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_bash_1',
        type: 'function',
        function: { name: 'bash', arguments: '{"command":"write long-step-1"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_bash_1', content: 'created long-step-1' },
  ]

  const result = await service.process(messages)

  const latestSkillAssistant = result.messages.find((message) =>
    message.role === 'assistant'
      && (message.tool_calls ?? []).some((call) => call.id === 'call_skill_1'),
  )
  const latestSkillResult = result.messages.find((message) =>
    message.role === 'tool' && message.tool_call_id === 'call_skill_1',
  )
  const oldSkillResult = result.messages.find((message) =>
    message.role === 'tool' && message.tool_call_id === 'call_skill_0',
  )
  const rawSkillResults = result.messages.filter((message) =>
    message.role === 'tool'
      && (message.tool_call_id === 'call_skill_0' || message.tool_call_id === 'call_skill_1'),
  )

  assert.ok(latestSkillAssistant, 'latest active skill assistant turn must survive exactly')
  assert.ok(latestSkillResult, 'latest active skill tool_result must survive exactly')
  assert.ok(rawSkillResults.length <= 2, `expected bounded raw skill history, got ${rawSkillResults.length}`)
  assert.match(String(oldSkillResult?.content ?? ''), /old instructions|^$/)
  assert.match(String(latestSkillResult?.content), /Read payload\./)
  assert.ok(result.messages.length <= 10, `expected bounded output, got ${result.messages.length} messages`)
})

test('active workflow adds a bounded progress handoff after the pinned skill exchange when older ordinary steps are summarized', async () => {
  const service = new ContextManagementService({
    enabled: true,
    strategies: {
      slidingWindow: { enabled: true, maxMessages: 6 },
      tokenLimit: { enabled: false, maxTokens: 4000 },
      summary: { enabled: true, keepRecentMessages: 2, summaryPrompt: 'Summarize progress only.' },
    },
    executionOrder: ['summary', 'slidingWindow'],
  }, async () => 'Probe is in progress.')

  const verboseToolResult = 'VERBOSE_TOOL_RESULT '.repeat(60)
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are a coding assistant.' },
    { role: 'assistant', content: '## Available Tools\n- skill\n- read\n- bash' },
    { role: 'user', content: 'Run the long conversation probe.' },
    { role: 'assistant', content: 'WARMUP_ACK_1' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_skill_live',
        type: 'function',
        function: { name: 'skill', arguments: '{"name":"long-conversation-probe"}' },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'call_skill_live',
      content: [
        '<skill_content name="long-conversation-probe">',
        '1. Read tests/agent-capability/input.txt exactly once.',
        '2. Use bash to write .agent-probe/long-step-1.txt.',
        '3. Read tests/agent-capability/long-conversation-payload.txt.',
        '</skill_content>',
      ].join('\n'),
    },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_read_input',
        type: 'function',
        function: { name: 'read', arguments: '{"filePath":"tests/agent-capability/input.txt"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_read_input', content: `${verboseToolResult} input body` },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_bash_step_1',
        type: 'function',
        function: { name: 'bash', arguments: '{"filePath":".agent-probe/long-step-1.txt","command":"write long-step-1"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_bash_step_1', content: `${verboseToolResult} created long-step-1` },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_read_payload',
        type: 'function',
        function: { name: 'read', arguments: '{"filePath":"tests/agent-capability/long-conversation-payload.txt"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_read_payload', content: 'payload body' },
  ]

  const result = await service.process(messages)
  const progressHandoff = result.messages.find((message) =>
    message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('[Active skill workflow state checkpoint]'),
  )
  const rawSkillAssistant = result.messages.find((message) =>
    message.role === 'assistant'
      && (message.tool_calls ?? []).some((call) => call.id === 'call_skill_live'),
  )
  const rawSkillResult = result.messages.find((message) =>
    message.role === 'tool' && message.tool_call_id === 'call_skill_live',
  )

  assert.ok(rawSkillAssistant, 'latest raw skill assistant must still survive')
  assert.ok(rawSkillResult, 'latest raw skill result must still survive')
  assert.ok(progressHandoff, 'expected bounded active skill workflow progress handoff to be present')
  assert.match(String(progressHandoff?.content), /1\. read completed/i)
  assert.match(String(progressHandoff?.content), /2\. bash completed/i)
  assert.match(String(progressHandoff?.content), /tests\/agent-capability\/input\.txt/i)
  assert.match(String(progressHandoff?.content), /\.agent-probe\/long-step-1\.txt/i)
  assert.match(String(progressHandoff?.content), /latest pinned skill instructions remain authoritative/i)
  assert.match(String(progressHandoff?.content), /do not repeat completed reads or bash writes/i)
  assert.match(String(progressHandoff?.content), /continue with the first not-yet-completed skill instruction/i)
  assert.equal(
    String(progressHandoff?.content).includes(verboseToolResult.trim()),
    false,
    'progress handoff must not include full raw tool output',
  )
  assert.equal(
    result.messages.some((message) =>
      message.role === 'assistant'
      && typeof message.content === 'string'
      && message.content.includes('[Active skill workflow')),
    false,
    'active-skill workflow checkpoint must not appear as ordinary assistant content',
  )
})

test('active workflow hands off completed work when the model repeats the same skill before compaction', async () => {
  const service = new ContextManagementService({
    enabled: true,
    strategies: {
      slidingWindow: { enabled: true, maxMessages: 6 },
      tokenLimit: { enabled: false, maxTokens: 4000 },
      summary: { enabled: true, keepRecentMessages: 2, summaryPrompt: 'Summarize progress only.' },
    },
    executionOrder: ['summary', 'slidingWindow'],
  }, async () => 'Probe is in progress.')

  const skillResult = (id: string) => ({
    role: 'tool' as const,
    tool_call_id: id,
    content: '<skill_content>\n1. Read input.txt.\n2. Write notes.txt.\n</skill_content>',
  })
  const skillCall = (id: string) => ({
    role: 'assistant' as const,
    content: null,
    tool_calls: [{
      id,
      type: 'function' as const,
      function: { name: 'skill', arguments: '{"name":"probe"}' },
    }],
  })
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are a coding assistant.' },
    { role: 'user', content: 'Run the probe.' },
    skillCall('call_skill_1'),
    skillResult('call_skill_1'),
    skillCall('call_skill_2'),
    skillResult('call_skill_2'),
  ]

  const result = await service.process(messages)
  const checkpoint = result.messages.find((message) =>
    message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('[Active skill workflow state checkpoint]'),
  )

  assert.ok(checkpoint, 'repeated skill history must produce a bounded progress checkpoint')
  assert.match(String(checkpoint?.content), /skill completed/i)
  assert.match(String(checkpoint?.content), /Required next action: call the read tool/i)
})

test('active workflow keeps a truly partial post-skill tool boundary raw while summarizing completed ordinary steps', async () => {
  const service = new ContextManagementService({
    enabled: true,
    strategies: {
      slidingWindow: { enabled: true, maxMessages: 6 },
      tokenLimit: { enabled: false, maxTokens: 4000 },
      summary: { enabled: true, keepRecentMessages: 2, summaryPrompt: 'Summarize progress only.' },
    },
    executionOrder: ['summary', 'slidingWindow'],
  }, async () => 'Probe is in progress.')

  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are a coding assistant.' },
    { role: 'assistant', content: '## Available Tools\n- skill\n- read\n- bash' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_skill_live',
        type: 'function',
        function: { name: 'skill', arguments: '{"name":"long-conversation-probe"}' },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'call_skill_live',
      content: '<skill_content>1. read input 2. write step 1 3. continue</skill_content>',
    },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_read_input',
        type: 'function',
        function: { name: 'read', arguments: '{"filePath":"tests/agent-capability/input.txt"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_read_input', content: 'input body' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_bash_step_1',
        type: 'function',
        function: { name: 'bash', arguments: '{"command":"write long-step-1"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_bash_step_1', content: 'created long-step-1' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_bash_step_2',
        type: 'function',
        function: { name: 'bash', arguments: '{"command":"write long-step-2"}' },
      }],
    },
  ]

  const result = await service.process(messages)
  const progressHandoff = result.messages.find((message) =>
    message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('[Active skill workflow state checkpoint]'),
  )
  const partialAssistant = result.messages.find((message) =>
    message.role === 'assistant'
      && (message.tool_calls ?? []).some((call) => call.id === 'call_bash_step_2'),
  )

  assert.ok(progressHandoff, 'expected completed ordinary steps to collapse into progress handoff')
  assert.ok(partialAssistant, 'expected partial post-skill assistant tool_call to remain raw')
  assert.equal(
    result.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_bash_step_2'),
    false,
    'partial boundary should remain unresolved without a fabricated tool result',
  )
  assert.equal(
    result.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_read_input'),
    false,
    'completed ordinary read step should be summarized away',
  )
  assert.equal(
    result.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_bash_step_1'),
    false,
    'completed ordinary bash step should be summarized away',
  )
})
