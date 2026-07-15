import test from 'node:test'
import assert from 'node:assert/strict'

import { createContextManagementService } from '../../src/main/proxy/services/contextManagementService.ts'
import { renderChildSessionHandoffStateMessage } from '../../src/main/proxy/sessionBoundary.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'

function makeToolCall(id: string, name: string, args: string) {
  return {
    id,
    type: 'function' as const,
    function: {
      name,
      arguments: args,
    },
  }
}

test('child session handoff state survives context management as bounded parent-visible state without raw child transcript', async () => {
  const rawChildTranscript = 'RAW_CHILD_TRANSCRIPT '.repeat(120)
  const handoffState = renderChildSessionHandoffStateMessage({
    kind: 'tool_child',
    status: 'ok',
    summary: 'Child workflow completed the bounded read/write task and returned control.',
    evidence: [
      { label: 'tool_result:call_read', value: 'read:call_read' },
      { label: 'tool_result:call_write', value: 'write:call_write' },
    ],
    artifacts: [{ path: '.agent-probe/child-output.txt', purpose: 'tool output target' }],
    nextAction: 'Continue with the parent workflow summary only.',
    childProviderSessionId: 'child-provider-session-1',
  })

  const messages: ChatMessage[] = [
    { role: 'system', content: 'system directive' },
    { role: 'assistant', content: '## Available Tools\n- read\n- write\n- bash' },
    { role: 'user', content: 'continue the parent workflow' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_old', 'read', '{"filePath":"old.txt"}')],
    },
    { role: 'tool', tool_call_id: 'call_old', content: rawChildTranscript },
    { role: 'system', content: handoffState },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_live', 'write', '{"filePath":"current.txt","content":"done"}')],
    },
    { role: 'tool', tool_call_id: 'call_live', content: 'write completed' },
  ]

  const service = createContextManagementService({
    enabled: true,
    strategies: {
      slidingWindow: { enabled: true, maxMessages: 6 },
      tokenLimit: { enabled: false, maxTokens: 4000 },
      summary: { enabled: false, keepRecentMessages: 20 },
    },
    executionOrder: ['slidingWindow'],
  })

  const result = await service.process(messages)
  const handoffMessage = result.messages.find(
    (message) => message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('[Child session handoff state]'),
  )

  assert.ok(handoffMessage, 'expected child handoff state to remain parent-visible')
  assert.match(String(handoffMessage?.content), /\[Child session handoff state\]/)
  assert.match(String(handoffMessage?.content), /Child workflow completed the bounded read\/write task/)
  assert.match(String(handoffMessage?.content), /\.agent-probe\/child-output\.txt/)
  assert.doesNotMatch(String(handoffMessage?.content), /RAW_CHILD_TRANSCRIPT/)
  assert.doesNotMatch(String(handoffMessage?.content), /child-provider-session-1/)
  assert.ok(String(handoffMessage?.content).length < 900, `expected bounded child handoff content, got ${String(handoffMessage?.content).length} chars`)
})

test('sliding window compacts completed old tool exchanges into a bounded handoff summary while preserving the latest active exchange', async () => {
  const completedToolResult = 'OLD_RESULT '.repeat(120)
  const activeToolResult = 'ACTIVE_RESULT '.repeat(20)

  const messages: ChatMessage[] = [
    { role: 'system', content: 'system directive' },
    { role: 'assistant', content: '## Available Tools\n- read\n- write\n- bash' },
    { role: 'user', content: 'Work through the files step by step.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_old_1', 'read', '{"filePath":"long-step-1.txt"}')],
    },
    { role: 'tool', tool_call_id: 'call_old_1', content: `${completedToolResult} step-1` },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_old_2', 'read', '{"filePath":"long-step-2.txt"}')],
    },
    { role: 'tool', tool_call_id: 'call_old_2', content: `${completedToolResult} step-2` },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_old_3', 'bash', '{"command":"node summarize.js"}')],
    },
    { role: 'tool', tool_call_id: 'call_old_3', content: `${completedToolResult} summary-prep` },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_active', 'write', '{"filePath":"long-summary.txt","content":"final"}')],
    },
    { role: 'tool', tool_call_id: 'call_active', content: activeToolResult },
  ]

  const service = createContextManagementService({
    enabled: true,
    strategies: {
      slidingWindow: { enabled: true, maxMessages: 7 },
      tokenLimit: { enabled: false, maxTokens: 4000 },
      summary: { enabled: false, keepRecentMessages: 20 },
    },
    executionOrder: ['slidingWindow'],
  })

  const result = await service.process(messages)

  assert.ok(result.messages.length <= 7, `expected bounded compacted output, got ${result.messages.length} messages`)
  assert.ok(
    result.messages.some((message) => typeof message.content === 'string' && message.content.includes('## Available Tools')),
    'tool definition contract message must be preserved',
  )

  const handoffMessages = result.messages.filter(
    (message) => message.role === 'assistant'
      && typeof message.content === 'string'
      && message.content.includes('[Completed tool exchange handoff]'),
  )
  assert.equal(handoffMessages.length, 1, 'expected one bounded handoff summary for completed exchanges')
  assert.equal(handoffMessages[0].role, 'assistant', 'non-skill completed handoff should keep assistant role')

  const handoffContent = handoffMessages[0].content as string
  assert.match(handoffContent, /read/)
  assert.match(handoffContent, /bash/)
  assert.ok(handoffContent.length < 900, `expected bounded handoff content, got ${handoffContent.length} chars`)
  assert.equal(
    handoffContent.includes(completedToolResult.trim()),
    false,
    'completed raw tool transcript should not be copied into the handoff summary',
  )

  assert.equal(
    result.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_old_1'),
    false,
    'old completed tool result should be summarized away',
  )
  assert.equal(
    result.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_old_2'),
    false,
    'old completed tool result should be summarized away',
  )
  assert.equal(
    result.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_old_3'),
    false,
    'old completed tool result should be summarized away',
  )

  const activeAssistant = result.messages.find(
    (message) => message.role === 'assistant' && message.tool_calls?.[0]?.id === 'call_active',
  )
  const activeTool = result.messages.find(
    (message) => message.role === 'tool' && message.tool_call_id === 'call_active',
  )

  assert.deepEqual(activeAssistant?.tool_calls, messages[9].tool_calls)
  assert.equal(activeTool?.tool_call_id, 'call_active')
  assert.equal(activeTool?.content, activeToolResult)
})

test('summary then sliding window keeps live-like final tool workflow bounded with completed-exchange handoff', async () => {
  const makeWarmupPair = (index: number): ChatMessage[] => [
    { role: 'user', content: `warmup user ${index}` },
    { role: 'assistant', content: `warmup assistant ${index}` },
  ]

  const largeSkillResult = '<skill_content>' + ' follow the probe strictly '.repeat(80) + '</skill_content>'
  const verboseToolResult = 'VERBOSE_TOOL_RESULT '.repeat(90)

  const messages: ChatMessage[] = [
    { role: 'system', content: 'system directive' },
    { role: 'assistant', content: '## Available Tools\n- skill\n- read\n- bash\n- write' },
    ...makeWarmupPair(1),
    ...makeWarmupPair(2),
    ...makeWarmupPair(3),
    ...makeWarmupPair(4),
    ...makeWarmupPair(5),
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_skill_final', 'skill', '{"name":"long-conversation-probe"}')],
    },
    { role: 'tool', tool_call_id: 'call_skill_final', content: largeSkillResult },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_read_1', 'read', '{"filePath":"tests/agent-capability/input.txt"}')],
    },
    { role: 'tool', tool_call_id: 'call_read_1', content: `${verboseToolResult} read-1` },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_bash_1', 'bash', '{"command":"write .agent-probe/long-step-1.txt"}')],
    },
    { role: 'tool', tool_call_id: 'call_bash_1', content: `${verboseToolResult} bash-1` },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_read_2', 'read', '{"filePath":".agent-probe/long-step-1.txt"}')],
    },
    { role: 'tool', tool_call_id: 'call_read_2', content: `${verboseToolResult} read-2` },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_bash_active', 'bash', '{"command":"write .agent-probe/long-summary.txt"}')],
    },
    { role: 'tool', tool_call_id: 'call_bash_active', content: 'created long-summary.txt' },
  ]

  const service = createContextManagementService({
    enabled: true,
    strategies: {
      slidingWindow: { enabled: true, maxMessages: 12 },
      tokenLimit: { enabled: false, maxTokens: 4000 },
      summary: { enabled: true, keepRecentMessages: 6, summaryPrompt: 'Summarize progress only.' },
    },
    executionOrder: ['summary', 'slidingWindow'],
  }, async () => 'Probe progress summary without tool catalog restatement.')

  const result = await service.process(messages)

  const rawAssistantToolMessages = result.messages.filter(
    (message) => message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0,
  )
  const rawToolResultMessages = result.messages.filter(
    (message) => message.role === 'tool' && typeof message.tool_call_id === 'string',
  )
  const handoffMessage = result.messages.find(
    (message) => message.role === 'system'
      && typeof message.content === 'string'
      && (
        message.content.includes('[Completed tool exchange handoff]')
        || message.content.includes('[Active skill workflow state checkpoint]')
      ),
  )

  assert.ok(result.messages.length <= 12, `expected bounded summary->slidingWindow output, got ${result.messages.length} messages`)
  assert.ok(rawAssistantToolMessages.length <= 2, `expected raw assistant tool_call count to converge, got ${rawAssistantToolMessages.length}`)
  assert.ok(rawToolResultMessages.length <= 3, `expected raw tool result count to converge, got ${rawToolResultMessages.length}`)
  assert.equal(
    result.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_read_1'),
    false,
    'summarized read_1 tool result must not survive as raw transcript',
  )
  assert.equal(
    result.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_bash_1'),
    false,
    'summarized bash_1 tool result must not survive as raw transcript',
  )
  assert.equal(
    result.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_read_2'),
    false,
    'summarized read_2 tool result must not survive as raw transcript',
  )
  assert.ok(handoffMessage, 'expected completed exchange handoff summary to be present')
  assert.equal(result.strategyResults[0]?.subkind, 'summary_skipped_active_tool_workflow')
  assert.ok(
    result.messages.some((message) => typeof message.content === 'string' && message.content.includes('## Available Tools')),
    'tool definition/system contract message must be preserved',
  )
  assert.match(String(handoffMessage?.content), /read completed/)
  assert.match(String(handoffMessage?.content), /bash completed/)
  assert.match(String(handoffMessage?.content), /latest pinned skill instructions remain authoritative/i)
  assert.match(String(handoffMessage?.content), /do not repeat completed reads or bash writes/i)
  assert.match(String(handoffMessage?.content), /continue with the first not-yet-completed skill instruction/i)
  assert.equal(
    result.messages.some((message) => message.role === 'assistant'
      && typeof message.content === 'string'
      && message.content.includes('[Active skill workflow')),
    false,
    'active-skill progress handoff must not appear as ordinary assistant content',
  )

  assert.equal(
    result.messages.some((message) => message.role === 'assistant' && message.tool_calls?.[0]?.id === 'call_bash_active'),
    false,
    'completed post-skill bash assistant call should be summarized into progress handoff',
  )
  assert.equal(
    result.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_bash_active'),
    false,
    'completed post-skill bash tool result should be summarized into progress handoff',
  )
  assert.match(String(handoffMessage?.content), /artifact: \.agent-probe\/long-summary\.txt/i)
})

test('summary then sliding window preserves the latest active skill instruction exchange exactly while summarizing completed ordinary tool exchanges after it', async () => {
  const makeWarmupPair = (index: number): ChatMessage[] => [
    { role: 'user', content: `warmup user ${index}` },
    { role: 'assistant', content: `WARMUP_ACK_${index}` },
  ]

  const skillInstructions = [
    '<skill_content name="long-conversation-probe">',
    '1. Read tests/agent-capability/input.txt exactly once.',
    '2. Use bash to write .agent-probe/long-step-1.txt.',
    '3. Read tests/agent-capability/long-conversation-payload.txt.',
    '4. Then create .agent-probe/long-summary.txt and only later emit LONG_CONVERSATION_PROBE_DONE.',
    '</skill_content>',
  ].join('\n')
  const verboseToolResult = 'VERBOSE_TOOL_RESULT '.repeat(80)

  const messages: ChatMessage[] = [
    { role: 'system', content: 'system directive' },
    { role: 'assistant', content: '## Available Tools\n- skill\n- read\n- bash\n- write' },
    ...makeWarmupPair(1),
    ...makeWarmupPair(2),
    ...makeWarmupPair(3),
    ...makeWarmupPair(4),
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_skill_live', 'skill', '{"name":"long-conversation-probe"}')],
    },
    { role: 'tool', tool_call_id: 'call_skill_live', content: skillInstructions },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_read_input', 'read', '{"filePath":"tests/agent-capability/input.txt"}')],
    },
    { role: 'tool', tool_call_id: 'call_read_input', content: `${verboseToolResult} input` },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_bash_step_1', 'bash', '{"command":"write .agent-probe/long-step-1.txt"}')],
    },
    { role: 'tool', tool_call_id: 'call_bash_step_1', content: `${verboseToolResult} step-1` },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_read_payload', 'read', '{"filePath":"tests/agent-capability/long-conversation-payload.txt"}')],
    },
    { role: 'tool', tool_call_id: 'call_read_payload', content: 'payload body' },
  ]

  const service = createContextManagementService({
    enabled: true,
    strategies: {
      slidingWindow: { enabled: true, maxMessages: 10 },
      tokenLimit: { enabled: false, maxTokens: 4000 },
      summary: { enabled: true, keepRecentMessages: 4, summaryPrompt: 'Summarize progress only.' },
    },
    executionOrder: ['summary', 'slidingWindow'],
  }, async () => 'Probe progress summary without tool catalog restatement.')

  const result = await service.process(messages)
  const rawAssistantToolMessages = result.messages.filter(
    (message) => message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0,
  )
  const rawToolResultMessages = result.messages.filter(
    (message) => message.role === 'tool' && typeof message.tool_call_id === 'string',
  )
  const skillAssistant = result.messages.find(
    (message) => message.role === 'assistant' && message.tool_calls?.[0]?.id === 'call_skill_live',
  )
  const skillResult = result.messages.find(
    (message) => message.role === 'tool' && message.tool_call_id === 'call_skill_live',
  )
  assert.ok(result.messages.length <= 10, `expected bounded output, got ${result.messages.length} messages`)
  assert.ok(rawAssistantToolMessages.length <= 1, `expected only pinned skill to remain as a raw assistant tool_call, got ${rawAssistantToolMessages.length}`)
  assert.ok(rawToolResultMessages.length <= 1, `expected only pinned skill to remain as a raw tool result, got ${rawToolResultMessages.length}`)
  assert.deepEqual(skillAssistant?.tool_calls, messages[10].tool_calls)
  assert.equal(skillResult?.tool_call_id, 'call_skill_live')
  assert.match(String(skillResult?.content), /Read tests\/agent-capability\/input\.txt exactly once\./)
  assert.match(String(skillResult?.content), /long-summary\.txt/)
  assert.equal(
    result.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_read_input'),
    false,
    'older ordinary read exchange should be summarized away',
  )
  assert.equal(
    result.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_bash_step_1'),
    false,
    'older ordinary bash exchange should be summarized away',
  )
  assert.equal(
    result.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_read_payload'),
    false,
    'latest completed ordinary read exchange should also be summarized away in active skill mode',
  )
  assert.equal(
    result.messages.some((message) => message.role === 'assistant' && message.tool_calls?.[0]?.id === 'call_read_payload'),
    false,
    'latest completed ordinary assistant tool_call should not remain as a raw boundary in active skill mode',
  )
  assert.ok(
    result.messages.some((message) => message.role === 'system' && typeof message.content === 'string' && message.content.includes('[Active skill workflow state checkpoint]')),
    'expected bounded active skill workflow progress handoff for older ordinary tool exchanges',
  )
  const progressHandoff = result.messages.find(
    (message) => message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('[Active skill workflow state checkpoint]'),
  )
  assert.match(String(progressHandoff?.content), /1\. read completed/i)
  assert.match(String(progressHandoff?.content), /artifact: tests\/agent-capability\/input\.txt/i)
  assert.match(String(progressHandoff?.content), /2\. bash completed/i)
  assert.match(String(progressHandoff?.content), /artifact: \.agent-probe\/long-step-1\.txt/i)
  assert.match(String(progressHandoff?.content), /3\. read completed/i)
  assert.match(String(progressHandoff?.content), /artifact: tests\/agent-capability\/long-conversation-payload\.txt/i)
  assert.match(String(progressHandoff?.content), /Next required skill step: 4\. Then create \.agent-probe\/long-summary\.txt/i)
  assert.match(String(progressHandoff?.content), /latest pinned skill instructions remain authoritative/i)
  assert.match(String(progressHandoff?.content), /Listed read\/bash\/write steps above are already complete\./i)
  assert.match(String(progressHandoff?.content), /continue with the first not-yet-completed skill instruction|Do not re\.\.\./i)
  assert.equal(
    String(progressHandoff?.content).includes(verboseToolResult.trim()),
    false,
    'progress handoff must stay bounded and must not include full raw tool output',
  )
})

test('summary then sliding window turns repeated completed ordinary bash steps into progress handoff instead of leaving the latest bash raw', async () => {
  const skillInstructions = [
    '<skill_content name="long-conversation-probe">',
    '1. Read tests/agent-capability/input.txt exactly once.',
    '2. Use bash to write .agent-probe/long-step-1.txt.',
    '3. Use bash to continue the workflow after long-step-1 is complete.',
    '4. Create .agent-probe/long-summary.txt before the final marker.',
    '</skill_content>',
  ].join('\n')

  const messages: ChatMessage[] = [
    { role: 'system', content: 'system directive' },
    { role: 'assistant', content: '## Available Tools\n- skill\n- read\n- bash' },
    { role: 'user', content: 'Run the long conversation probe.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_skill_live', 'skill', '{"name":"long-conversation-probe"}')],
    },
    { role: 'tool', tool_call_id: 'call_skill_live', content: skillInstructions },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_read_input', 'read', '{"filePath":"tests/agent-capability/input.txt"}')],
    },
    { role: 'tool', tool_call_id: 'call_read_input', content: 'input body' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_bash_step_1', 'bash', '{"command":"write .agent-probe/long-step-1.txt"}')],
    },
    { role: 'tool', tool_call_id: 'call_bash_step_1', content: 'created .agent-probe/long-step-1.txt' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_bash_repeated', 'bash', '{"command":"write .agent-probe/long-step-1.txt"}')],
    },
    { role: 'tool', tool_call_id: 'call_bash_repeated', content: 'created .agent-probe/long-step-1.txt again' },
  ]

  const service = createContextManagementService({
    enabled: true,
    strategies: {
      slidingWindow: { enabled: true, maxMessages: 8 },
      tokenLimit: { enabled: false, maxTokens: 4000 },
      summary: { enabled: true, keepRecentMessages: 4, summaryPrompt: 'Summarize progress only.' },
    },
    executionOrder: ['summary', 'slidingWindow'],
  }, async () => 'Probe progress summary without tool catalog restatement.')

  const result = await service.process(messages)
  const progressHandoff = result.messages.find(
    (message) => message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('[Active skill workflow state checkpoint]'),
  )
  const rawAssistantToolMessages = result.messages.filter(
    (message) => message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0,
  )
  const rawToolResultMessages = result.messages.filter(
    (message) => message.role === 'tool' && typeof message.tool_call_id === 'string',
  )

  assert.ok(progressHandoff, 'expected bounded progress handoff to survive')
  assert.deepEqual(
    rawAssistantToolMessages.map(message => message.tool_calls?.[0]?.id),
    ['call_skill_live'],
    'only the pinned skill instruction should remain as a raw assistant tool_call',
  )
  assert.deepEqual(
    rawToolResultMessages.map(message => message.tool_call_id),
    ['call_skill_live'],
    'only the pinned skill instruction should remain as a raw tool result',
  )
  assert.equal(
    result.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_bash_repeated'),
    false,
    'the repeated completed bash result must not remain as the latest raw boundary',
  )
  assert.equal(
    result.messages.some((message) => message.role === 'assistant' && message.tool_calls?.[0]?.id === 'call_bash_repeated'),
    false,
    'the repeated completed bash assistant tool_call must not remain raw',
  )
  assert.match(String(progressHandoff.content), /bash completed/i)
  assert.match(String(progressHandoff.content), /Next required skill step: 3\. Use bash to continue the workflow after long-step-1 is complete\./i)
  assert.match(String(progressHandoff.content), /latest pinned skill instructions remain authoritative/i)
  assert.match(String(progressHandoff.content), /do not repeat completed reads or bash writes/i)
  assert.match(String(progressHandoff.content), /continue with the first not-yet-completed skill instruction/i)
  assert.match(String(progressHandoff.content), /\.agent-probe\/long-step-1\.txt/i)
})

test('active skill workflow handoff points from completed read to the exact next bash step', async () => {
  const skillInstructions = [
    '<skill_content name="long-conversation-probe">',
    '1. Use the read tool to read tests/agent-capability/input.txt.',
    '2. Use the `bash` tool to run:',
    '   `New-Item -ItemType Directory -Force -Path .agent-probe | Out-Null; node -e "const fs=require(\'fs\');const text=fs.readFileSync(\'tests/agent-capability/input.txt\',\'utf8\');fs.writeFileSync(\'.agent-probe/long-step-1.txt\', \'STEP1=\' + text.length + \'\\n\', \'utf8\');"`',
    '3. Use the read tool to read tests/agent-capability/long-conversation-payload.txt.',
    '</skill_content>',
  ].join('\n')

  const messages: ChatMessage[] = [
    { role: 'system', content: 'system directive' },
    { role: 'assistant', content: '## Available Tools\n- skill\n- read\n- bash' },
    { role: 'user', content: 'Run the long conversation probe.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_skill_live', 'skill', '{"name":"long-conversation-probe"}')],
    },
    { role: 'tool', tool_call_id: 'call_skill_live', content: skillInstructions },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_read_input', 'read', '{"filePath":"tests/agent-capability/input.txt"}')],
    },
    { role: 'tool', tool_call_id: 'call_read_input', content: 'LONG_INPUT_BODY '.repeat(40) },
  ]

  const service = createContextManagementService({
    enabled: true,
    strategies: {
      slidingWindow: { enabled: true, maxMessages: 5 },
      tokenLimit: { enabled: false, maxTokens: 4000 },
      summary: { enabled: true, keepRecentMessages: 3, summaryPrompt: 'Summarize progress only.' },
    },
    executionOrder: ['summary', 'slidingWindow'],
  }, async () => 'Probe progress summary without tool catalog restatement.')

  const result = await service.process(messages)
  const progressHandoff = result.messages.find(
    (message) => message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('[Active skill workflow state checkpoint]'),
  )

  assert.ok(progressHandoff, 'expected bounded progress handoff to survive')
  assert.match(String(progressHandoff?.content), /1\. read completed/i)
  assert.match(String(progressHandoff?.content), /artifact: tests\/agent-capability\/input\.txt/i)
  assert.match(String(progressHandoff?.content), /Next required skill step: 2\. Use the `bash` tool to run:/i)
  assert.match(String(progressHandoff?.content), /New-Item -ItemType Directory -Force -Path \.agent-probe/i)
  assert.match(String(progressHandoff?.content), /writeFileSync\('\.agent-probe\/long-step-1\.txt'/i)
  assert.doesNotMatch(String(progressHandoff?.content), /Next required skill step: 1\. Use the read tool to read tests\/agent-capability\/input\.txt\./i)
  assert.equal(
    String(progressHandoff?.content).includes('LONG_INPUT_BODY '.repeat(8).trim()),
    false,
    'next-step handoff must not copy long raw tool result content',
  )
  assert.ok(String(progressHandoff?.content).length <= 1600, 'handoff should stay bounded')
})

test('active skill workflow recognizes absolute tool paths as completed relative skill steps', async () => {
  const skillInstructions = [
    '<skill_content name="long-conversation-probe">',
    '1. Use the read tool to read tests/agent-capability/input.txt.',
    '2. Use the `bash` tool to run:',
    '   `New-Item -ItemType Directory -Force -Path .agent-probe | Out-Null; node -e "const fs=require(\'fs\');const text=fs.readFileSync(\'tests/agent-capability/input.txt\',\'utf8\');fs.writeFileSync(\'.agent-probe/long-step-1.txt\', \'STEP1=\' + text.length + \'\\n\', \'utf8\');"`',
    '3. Use the read tool to read tests/agent-capability/long-conversation-payload.txt.',
    '</skill_content>',
  ].join('\n')

  const messages: ChatMessage[] = [
    { role: 'system', content: 'system directive' },
    { role: 'assistant', content: '## Available Tools\n- skill\n- read\n- bash' },
    { role: 'user', content: 'Run the long conversation probe.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_skill_live', 'skill', '{"name":"long-conversation-probe"}')],
    },
    { role: 'tool', tool_call_id: 'call_skill_live', content: skillInstructions },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_read_input', 'read', '{"filePath":"E:\\\\Chat2API\\\\tests\\\\agent-capability\\\\input.txt"}')],
    },
    { role: 'tool', tool_call_id: 'call_read_input', content: 'LONG_INPUT_BODY '.repeat(40) },
  ]

  const service = createContextManagementService({
    enabled: true,
    strategies: {
      slidingWindow: { enabled: true, maxMessages: 5 },
      tokenLimit: { enabled: false, maxTokens: 4000 },
      summary: { enabled: true, keepRecentMessages: 3, summaryPrompt: 'Summarize progress only.' },
    },
    executionOrder: ['summary', 'slidingWindow'],
  }, async () => 'Probe progress summary without tool catalog restatement.')

  const result = await service.process(messages)
  const progressHandoff = result.messages.find(
    (message) => message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('[Active skill workflow state checkpoint]'),
  )

  assert.ok(progressHandoff, 'expected bounded progress handoff to survive')
  assert.match(String(progressHandoff?.content), /1\. read completed/i)
  assert.match(String(progressHandoff?.content), /artifact: E:\\Chat2API\\tests\\agent-capability\\input\.txt/i)
  assert.match(String(progressHandoff?.content), /Next required skill step: 2\. Use the `bash` tool to run:/i)
  assert.doesNotMatch(String(progressHandoff?.content), /Next required skill step: 1\. Use the read tool to read tests\/agent-capability\/input\.txt\./i)
})

test('active skill workflow does not mark a later bash step complete just because it reads an old artifact', async () => {
  const step2Command = 'New-Item -ItemType Directory -Force -Path .agent-probe | Out-Null; node -e "const fs=require(\'fs\');const text=fs.readFileSync(\'tests/agent-capability/input.txt\',\'utf8\');fs.writeFileSync(\'.agent-probe/long-step-1.txt\', \'STEP1=\' + text.length + \'\\n\', \'utf8\');"'
  const step4Command = 'node -e "const fs=require(\'fs\');const step1=fs.readFileSync(\'.agent-probe/long-step-1.txt\',\'utf8\').trim();const payload=fs.readFileSync(\'tests/agent-capability/long-conversation-payload.txt\',\'utf8\').split(/\\r?\\n/)[0];fs.writeFileSync(\'.agent-probe/long-step-2.txt\', step1 + \'|STEP2=\' + payload + \'\\n\', \'utf8\');"'
  const step5Command = 'node -e "const {spawnSync}=require(\'child_process\');const fs=require(\'fs\');const run=spawnSync(process.execPath,[\'tests/agent-capability/compute-result.mjs\',\'tests/agent-capability/input.txt\'],{encoding:\'utf8\'});if(run.status!==0){process.stderr.write(run.stderr||\'\');process.exit(run.status||1);}fs.writeFileSync(\'.agent-probe/long-result.json\', run.stdout, \'utf8\');"'
  const skillInstructions = [
    '<skill_content name="long-conversation-probe">',
    '1. Use the `read` tool to read `tests/agent-capability/input.txt`.',
    '2. Use the `bash` tool to run:',
    `   \`${step2Command}\``,
    '3. Use the `read` tool to read `tests/agent-capability/long-conversation-payload.txt`.',
    '4. Use the `bash` tool to run:',
    `   \`${step4Command}\``,
    '5. Use the `bash` tool to run:',
    `   \`${step5Command}\``,
    '</skill_content>',
  ].join('\n')

  const messages: ChatMessage[] = [
    { role: 'system', content: 'system directive' },
    { role: 'assistant', content: '## Available Tools\n- skill\n- read\n- bash' },
    { role: 'user', content: 'Run the long conversation probe.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_skill_live', 'skill', '{"name":"long-conversation-probe"}')],
    },
    { role: 'tool', tool_call_id: 'call_skill_live', content: skillInstructions },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_read_input', 'read', '{"filePath":"tests/agent-capability/input.txt"}')],
    },
    { role: 'tool', tool_call_id: 'call_read_input', content: 'input body' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_bash_step_1', 'bash', JSON.stringify({ command: step2Command }))],
    },
    { role: 'tool', tool_call_id: 'call_bash_step_1', content: 'created .agent-probe/long-step-1.txt' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_read_payload', 'read', '{"filePath":"tests/agent-capability/long-conversation-payload.txt"}')],
    },
    { role: 'tool', tool_call_id: 'call_read_payload', content: 'payload body' },
  ]

  const service = createContextManagementService({
    enabled: true,
    strategies: {
      slidingWindow: { enabled: true, maxMessages: 8 },
      tokenLimit: { enabled: false, maxTokens: 4000 },
      summary: { enabled: true, keepRecentMessages: 4, summaryPrompt: 'Summarize progress only.' },
    },
    executionOrder: ['summary', 'slidingWindow'],
  }, async () => 'Probe progress summary without tool catalog restatement.')

  const result = await service.process(messages)
  const progressHandoff = result.messages.find(
    (message) => message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('[Active skill workflow state checkpoint]'),
  )
  const handoffContent = String(progressHandoff?.content)

  assert.ok(progressHandoff, 'expected bounded progress handoff to survive')
  assert.match(handoffContent, /1\. read completed/i)
  assert.match(handoffContent, /2\. bash completed \| artifact: \.agent-probe\/long-step-1\.txt/i)
  assert.match(handoffContent, /3\. read completed \| artifact: tests\/agent-capability\/long-conversation-payload\.txt/i)
  assert.match(handoffContent, /Next required skill step: 4\. Use the `bash` tool to run:/i)
  assert.match(handoffContent, /readFileSync\('\.agent-probe\/long-step-1\.txt'/i)
  assert.match(handoffContent, /writeFileSync\('\.agent-probe\/long-step-2\.txt'/i)
  assert.doesNotMatch(handoffContent, /Next required skill step: 5\. Use the `bash` tool to run:/i)
  assert.doesNotMatch(handoffContent, /Next required skill step: 1\. Use the `read` tool/i)
})

test('active skill workflow pins the required filePath when the next incomplete step is a later read', async () => {
  const step2Command = 'New-Item -ItemType Directory -Force -Path .agent-probe | Out-Null; node -e "const fs=require(\'fs\');const text=fs.readFileSync(\'tests/agent-capability/input.txt\',\'utf8\');fs.writeFileSync(\'.agent-probe/long-step-1.txt\', \'STEP1=\' + text.length + \'\\n\', \'utf8\');"'
  const step4Command = 'node -e "const fs=require(\'fs\');const step1=fs.readFileSync(\'.agent-probe/long-step-1.txt\',\'utf8\').trim();const payload=fs.readFileSync(\'tests/agent-capability/long-conversation-payload.txt\',\'utf8\').split(/\\r?\\n/)[0];fs.writeFileSync(\'.agent-probe/long-step-2.txt\', step1 + \'|STEP2=\' + payload + \'\\n\', \'utf8\');"'
  const step5Command = 'node -e "const {spawnSync}=require(\'child_process\');const fs=require(\'fs\');const run=spawnSync(process.execPath,[\'tests/agent-capability/compute-result.mjs\',\'tests/agent-capability/input.txt\'],{encoding:\'utf8\'});if(run.status!==0){process.stderr.write(run.stderr||\'\');process.exit(run.status||1);}fs.writeFileSync(\'.agent-probe/long-result.json\', run.stdout, \'utf8\');"'
  const step6Command = 'node -e "const fs=require(\'fs\');const result=JSON.parse(fs.readFileSync(\'.agent-probe/long-result.json\',\'utf8\'));fs.writeFileSync(\'.agent-probe/long-check-1.txt\',\'CHECK1=\' + result.lineCount + \'\\n\',\'utf8\');"'
  const step7Command = 'node -e "const fs=require(\'fs\');const result=JSON.parse(fs.readFileSync(\'.agent-probe/long-result.json\',\'utf8\'));fs.writeFileSync(\'.agent-probe/long-check-2.txt\',\'CHECK2=\' + result.byteLength + \'\\n\',\'utf8\');"'
  const step8Command = 'node -e "const fs=require(\'fs\');const step2=fs.readFileSync(\'.agent-probe/long-step-2.txt\',\'utf8\').trim();fs.writeFileSync(\'.agent-probe/long-summary.txt\', step2 + \'|LONG_CONVERSATION_PROBE_DONE\\n\',\'utf8\');"'
  const skillInstructions = [
    '<skill_content name="long-conversation-probe">',
    '1. Use the `read` tool to read `tests/agent-capability/input.txt`.',
    '2. Use the `bash` tool to run:',
    `   \`${step2Command}\``,
    '3. Use the `read` tool to read `tests/agent-capability/long-conversation-payload.txt`.',
    '4. Use the `bash` tool to run:',
    `   \`${step4Command}\``,
    '5. Use the `bash` tool to run:',
    `   \`${step5Command}\``,
    '6. Use the `bash` tool to run:',
    `   \`${step6Command}\``,
    '7. Use the `bash` tool to run:',
    `   \`${step7Command}\``,
    '8. Use the `bash` tool to run:',
    `   \`${step8Command}\``,
    '9. Use the `read` tool to read `.agent-probe/long-summary.txt`.',
    '</skill_content>',
  ].join('\n')

  const messages: ChatMessage[] = [
    { role: 'system', content: 'system directive' },
    { role: 'assistant', content: '## Available Tools\n- skill\n- read\n- bash' },
    { role: 'user', content: 'Run the long conversation probe.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_skill_live', 'skill', '{"name":"long-conversation-probe"}')],
    },
    { role: 'tool', tool_call_id: 'call_skill_live', content: skillInstructions },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_read_input', 'read', '{"filePath":"tests/agent-capability/input.txt"}')],
    },
    { role: 'tool', tool_call_id: 'call_read_input', content: 'input body' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_bash_step_1', 'bash', JSON.stringify({ command: step2Command }))],
    },
    { role: 'tool', tool_call_id: 'call_bash_step_1', content: 'created .agent-probe/long-step-1.txt' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_read_payload', 'read', '{"filePath":"tests/agent-capability/long-conversation-payload.txt"}')],
    },
    { role: 'tool', tool_call_id: 'call_read_payload', content: 'payload body' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_bash_step_2', 'bash', JSON.stringify({ command: step4Command }))],
    },
    { role: 'tool', tool_call_id: 'call_bash_step_2', content: 'created .agent-probe/long-step-2.txt' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_bash_result', 'bash', JSON.stringify({ command: step5Command }))],
    },
    { role: 'tool', tool_call_id: 'call_bash_result', content: 'created .agent-probe/long-result.json' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_bash_check_1', 'bash', JSON.stringify({ command: step6Command }))],
    },
    { role: 'tool', tool_call_id: 'call_bash_check_1', content: 'created .agent-probe/long-check-1.txt' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_bash_check_2', 'bash', JSON.stringify({ command: step7Command }))],
    },
    { role: 'tool', tool_call_id: 'call_bash_check_2', content: 'created .agent-probe/long-check-2.txt' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_bash_summary', 'bash', JSON.stringify({ command: step8Command }))],
    },
    { role: 'tool', tool_call_id: 'call_bash_summary', content: 'created .agent-probe/long-summary.txt' },
  ]

  const service = createContextManagementService({
    enabled: true,
    strategies: {
      slidingWindow: { enabled: true, maxMessages: 8 },
      tokenLimit: { enabled: false, maxTokens: 4000 },
      summary: { enabled: true, keepRecentMessages: 4, summaryPrompt: 'Summarize progress only.' },
    },
    executionOrder: ['summary', 'slidingWindow'],
  }, async () => 'Probe progress summary without tool catalog restatement.')

  const result = await service.process(messages)
  const progressHandoff = result.messages.find(
    (message) => message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('[Active skill workflow state checkpoint]'),
  )
  const handoffContent = String(progressHandoff?.content)

  assert.ok(progressHandoff, 'expected bounded progress handoff to survive')
  assert.match(handoffContent, /Required next action: call the read tool/i)
  assert.match(handoffContent, /Required next tool arguments: filePath=\.agent-probe\/long-summary\.txt/i)
  assert.match(handoffContent, /Do not call read with any other filePath\./i)
  assert.match(handoffContent, /Next required skill step: 9\. Use the `read` tool to read `\.agent-probe\/long-summary\.txt`\./i)
  assert.doesNotMatch(handoffContent, /Required next tool arguments: filePath=tests\/agent-capability\/input\.txt/i)
  assert.doesNotMatch(handoffContent, /Next required skill step: 1\. Use the `read` tool/i)
  assert.doesNotMatch(handoffContent, /Next required skill step: 3\. Use the `read` tool/i)
})

test('active skill workflow pins the required command when the next incomplete step is a later bash', async () => {
  const step2Command = 'New-Item -ItemType Directory -Force -Path .agent-probe | Out-Null; node -e "const fs=require(\'fs\');const text=fs.readFileSync(\'tests/agent-capability/input.txt\',\'utf8\');fs.writeFileSync(\'.agent-probe/long-step-1.txt\', \'STEP1=\' + text.length + \'\\n\', \'utf8\');"'
  const step4Command = 'node -e "const fs=require(\'fs\');const step1=fs.readFileSync(\'.agent-probe/long-step-1.txt\',\'utf8\').trim();const payload=fs.readFileSync(\'tests/agent-capability/long-conversation-payload.txt\',\'utf8\').split(/\\r?\\n/)[0];fs.writeFileSync(\'.agent-probe/long-step-2.txt\', step1 + \'|STEP2=\' + payload + \'\\n\', \'utf8\');"'
  const step5Command = 'node -e "const {spawnSync}=require(\'child_process\');const fs=require(\'fs\');const run=spawnSync(process.execPath,[\'tests/agent-capability/compute-result.mjs\',\'tests/agent-capability/input.txt\'],{encoding:\'utf8\'});if(run.status!==0){process.stderr.write(run.stderr||\'\');process.exit(run.status||1);}fs.writeFileSync(\'.agent-probe/long-result.json\', run.stdout, \'utf8\');"'
  const step6Command = 'node -e "const fs=require(\'fs\');const result=JSON.parse(fs.readFileSync(\'.agent-probe/long-result.json\',\'utf8\'));fs.writeFileSync(\'.agent-probe/long-check-1.txt\',\'CHECK1=\' + result.lineCount + \'\\n\',\'utf8\');"'
  const step7Command = 'node -e "const fs=require(\'fs\');const result=JSON.parse(fs.readFileSync(\'.agent-probe/long-result.json\',\'utf8\'));fs.writeFileSync(\'.agent-probe/long-check-2.txt\',\'CHECK2=\' + result.byteLength + \'\\n\',\'utf8\');"'
  const step8Command = 'node -e "const fs=require(\'fs\');const step2=fs.readFileSync(\'.agent-probe/long-step-2.txt\',\'utf8\').trim();fs.writeFileSync(\'.agent-probe/long-summary.txt\', step2 + \'|LONG_CONVERSATION_PROBE_DONE\\n\',\'utf8\');"'
  const skillInstructions = [
    '<skill_content name="long-conversation-probe">',
    '1. Use the `read` tool to read `tests/agent-capability/input.txt`.',
    '2. Use the `bash` tool to run:',
    `   \`${step2Command}\``,
    '3. Use the `read` tool to read `tests/agent-capability/long-conversation-payload.txt`.',
    '4. Use the `bash` tool to run:',
    `   \`${step4Command}\``,
    '5. Use the `bash` tool to run:',
    `   \`${step5Command}\``,
    '6. Use the `bash` tool to run:',
    `   \`${step6Command}\``,
    '7. Use the `bash` tool to run:',
    `   \`${step7Command}\``,
    '8. Use the `bash` tool to run:',
    `   \`${step8Command}\``,
    '</skill_content>',
  ].join('\n')

  const messages: ChatMessage[] = [
    { role: 'system', content: 'system directive' },
    { role: 'assistant', content: '## Available Tools\n- skill\n- read\n- bash' },
    { role: 'user', content: 'Run the long conversation probe.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_skill_live', 'skill', '{"name":"long-conversation-probe"}')],
    },
    { role: 'tool', tool_call_id: 'call_skill_live', content: skillInstructions },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_read_input', 'read', '{"filePath":"tests/agent-capability/input.txt"}')],
    },
    { role: 'tool', tool_call_id: 'call_read_input', content: 'input body' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_bash_step_1', 'bash', JSON.stringify({ command: step2Command }))],
    },
    { role: 'tool', tool_call_id: 'call_bash_step_1', content: 'created .agent-probe/long-step-1.txt' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_read_payload', 'read', '{"filePath":"tests/agent-capability/long-conversation-payload.txt"}')],
    },
    { role: 'tool', tool_call_id: 'call_read_payload', content: 'payload body' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_bash_step_2', 'bash', JSON.stringify({ command: step4Command }))],
    },
    { role: 'tool', tool_call_id: 'call_bash_step_2', content: 'created .agent-probe/long-step-2.txt' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_bash_result', 'bash', JSON.stringify({ command: step5Command }))],
    },
    { role: 'tool', tool_call_id: 'call_bash_result', content: 'created .agent-probe/long-result.json' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_bash_check_1', 'bash', JSON.stringify({ command: step6Command }))],
    },
    { role: 'tool', tool_call_id: 'call_bash_check_1', content: 'created .agent-probe/long-check-1.txt' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_bash_check_2', 'bash', JSON.stringify({ command: step7Command }))],
    },
    { role: 'tool', tool_call_id: 'call_bash_check_2', content: 'created .agent-probe/long-check-2.txt' },
  ]

  const service = createContextManagementService({
    enabled: true,
    strategies: {
      slidingWindow: { enabled: true, maxMessages: 8 },
      tokenLimit: { enabled: false, maxTokens: 4000 },
      summary: { enabled: true, keepRecentMessages: 4, summaryPrompt: 'Summarize progress only.' },
    },
    executionOrder: ['summary', 'slidingWindow'],
  }, async () => 'Probe progress summary without tool catalog restatement.')

  const result = await service.process(messages)
  const progressHandoff = result.messages.find(
    (message) => message.role === 'system'
      && typeof message.content === 'string'
      && message.content.includes('[Active skill workflow state checkpoint]'),
  )
  const handoffContent = String(progressHandoff?.content)

  assert.ok(progressHandoff, 'expected bounded progress handoff to survive')
  assert.match(handoffContent, /Required next action: call the bash tool/i)
  assert.match(handoffContent, /Required next tool arguments: command=/i)
  assert.match(handoffContent, /writeFileSync\('\.agent-probe\/long-summary\.txt'/i)
  assert.match(handoffContent, /Do not call bash with any other command\./i)
  assert.match(handoffContent, /Only the bash tool is valid/i)
  assert.match(handoffContent, /Next required skill step: 8\. Use the `bash` tool to run:/i)
  assert.doesNotMatch(handoffContent, /Required next action: call the read tool/i)
  assert.doesNotMatch(handoffContent, /Required next tool arguments: filePath=tests\/agent-capability\/input\.txt/i)
  assert.doesNotMatch(handoffContent, /Next required skill step: 1\. Use the `read` tool/i)
})

test('many summarized tool groups collapse to one handoff anchor plus bounded raw boundary', async () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'system directive' },
    { role: 'assistant', content: '## Available Tools\n- read\n- bash\n- write' },
    { role: 'user', content: 'continue the workflow' },
    ...Array.from({ length: 7 }, (_, index) => ([
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: [makeToolCall(`call_old_${index}`, index % 2 === 0 ? 'read' : 'bash', `{"step":${index}}`)],
      },
      {
        role: 'tool' as const,
        tool_call_id: `call_old_${index}`,
        content: `old-result-${index} `.repeat(40),
      },
    ])).flat(),
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_active_latest', 'write', '{"filePath":"long-summary.txt"}')],
    },
    { role: 'tool', tool_call_id: 'call_active_latest', content: 'created summary' },
  ]

  const service = createContextManagementService({
    enabled: true,
    strategies: {
      slidingWindow: { enabled: true, maxMessages: 10 },
      tokenLimit: { enabled: false, maxTokens: 4000 },
      summary: { enabled: false, keepRecentMessages: 20 },
    },
    executionOrder: ['slidingWindow'],
  })

  const result = await service.process(messages)
  const rawAssistantToolMessages = result.messages.filter(
    (message) => message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0,
  )
  const rawToolResultMessages = result.messages.filter(
    (message) => message.role === 'tool' && typeof message.tool_call_id === 'string',
  )

  assert.ok(rawAssistantToolMessages.length <= 2, `expected bounded raw assistant count, got ${rawAssistantToolMessages.length}`)
  assert.ok(rawToolResultMessages.length <= 3, `expected bounded raw tool result count, got ${rawToolResultMessages.length}`)
  assert.ok(
    result.messages.some((message) => typeof message.content === 'string' && message.content.includes('[Completed tool exchange handoff]')),
    'expected one handoff summary to represent old completed groups',
  )
  for (let index = 0; index < 7; index++) {
    assert.equal(
      result.messages.some((message) => message.role === 'tool' && message.tool_call_id === `call_old_${index}`),
      false,
      `summarized tool result call_old_${index} must not survive`,
    )
  }
  assert.ok(
    result.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_active_latest'),
    'latest active raw tool result must survive',
  )
})

test('summary then sliding window does not resurrect summarized old ids from a partially retained multi-call assistant', async () => {
  const verboseToolResult = 'VERBOSE_TOOL_RESULT '.repeat(80)

  const messages: ChatMessage[] = [
    { role: 'system', content: 'system directive' },
    { role: 'assistant', content: '## Available Tools\n- skill\n- read\n- bash\n- write' },
    { role: 'user', content: 'warmup user 1' },
    { role: 'assistant', content: 'warmup assistant 1' },
    { role: 'user', content: 'warmup user 2' },
    { role: 'assistant', content: 'warmup assistant 2' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_skill_old', 'skill', '{"name":"long-conversation-probe"}')],
    },
    { role: 'tool', tool_call_id: 'call_skill_old', content: '<skill_content>strict probe instructions</skill_content>' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        makeToolCall('call_old_1', 'read', '{"filePath":"old-1.txt"}'),
        makeToolCall('call_old_2', 'bash', '{"command":"echo old-2"}'),
        makeToolCall('call_active_1', 'read', '{"filePath":"active-1.txt"}'),
        makeToolCall('call_active_2', 'write', '{"filePath":"long-step-1.txt","content":"done"}'),
        makeToolCall('call_active_3', 'read', '{"filePath":"active-3.txt"}'),
        makeToolCall('call_active_4', 'bash', '{"command":"echo active-4"}'),
        makeToolCall('call_active_5', 'write', '{"filePath":"long-summary.txt","content":"done"}'),
      ],
    },
    { role: 'tool', tool_call_id: 'call_old_1', content: `${verboseToolResult} old-1` },
    { role: 'tool', tool_call_id: 'call_old_2', content: `${verboseToolResult} old-2` },
    { role: 'tool', tool_call_id: 'call_active_1', content: 'active-1 contents' },
    { role: 'tool', tool_call_id: 'call_active_2', content: 'created long-step-1.txt' },
    { role: 'tool', tool_call_id: 'call_active_3', content: 'active-3 contents' },
    { role: 'tool', tool_call_id: 'call_active_4', content: 'active-4 done' },
    { role: 'tool', tool_call_id: 'call_active_5', content: 'created long-summary.txt' },
  ]

  const service = createContextManagementService({
    enabled: true,
    strategies: {
      slidingWindow: { enabled: true, maxMessages: 8 },
      tokenLimit: { enabled: false, maxTokens: 4000 },
      summary: { enabled: true, keepRecentMessages: 4, summaryPrompt: 'Summarize progress only.' },
    },
    executionOrder: ['summary', 'slidingWindow'],
  }, async () => 'Probe progress summary without tool catalog restatement.')

  const result = await service.process(messages)
  const rawAssistantToolMessages = result.messages.filter(
    (message) => message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0,
  )
  const rawToolResultMessages = result.messages.filter(
    (message) => message.role === 'tool' && typeof message.tool_call_id === 'string',
  )
  const pinnedSkillAssistant = rawAssistantToolMessages.find(
    (message) => (message.tool_calls ?? []).some(call => call.id === 'call_skill_old'),
  )
  const pinnedSkillResult = rawToolResultMessages.find(
    (message) => message.tool_call_id === 'call_skill_old',
  )

  assert.ok(result.messages.length <= 9, `expected bounded output, got ${result.messages.length} messages`)
  assert.ok(pinnedSkillAssistant, 'expected latest procedural skill assistant to survive')
  assert.ok(pinnedSkillResult, 'expected latest procedural skill result to survive')
  assert.deepEqual(
    rawToolResultMessages.map(message => message.tool_call_id),
    ['call_skill_old'],
    'only the latest raw skill instruction result should remain after preservation',
  )
  assert.equal(
    result.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_old_1'),
    false,
    'summarized old tool result call_old_1 must not be resurrected',
  )
  assert.equal(
    result.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_old_2'),
    false,
    'summarized old tool result call_old_2 must not be resurrected',
  )
  assert.ok(
    result.messages.some((message) =>
      typeof message.content === 'string'
      && (
        message.content.includes('[Completed tool exchange handoff]')
        || message.content.includes('[Active skill workflow state checkpoint]')
      )),
    'expected bounded handoff summary to remain present',
  )

  assert.equal(
    result.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_active_5'),
    false,
    'summarized multi-call active tail should remain bounded behind the handoff summary',
  )
})

test('context management diagnostics stay structural and omit content-bearing fields', async () => {
  const logs: string[] = []
  const originalConsoleLog = console.log
  console.log = (...args: unknown[]) => {
    logs.push(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '))
  }

  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system directive' },
      { role: 'assistant', content: '## Available Tools\n- skill\n- read\n- bash' },
      { role: 'user', content: 'warmup user' },
      { role: 'assistant', content: 'warmup assistant' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [makeToolCall('call_skill', 'skill', '{"name":"probe"}')],
      },
      { role: 'tool', tool_call_id: 'call_skill', content: '<skill_content>do things</skill_content>' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [makeToolCall('call_active', 'bash', '{"command":"echo hi"}')],
      },
      { role: 'tool', tool_call_id: 'call_active', content: 'done' },
    ]

    const service = createContextManagementService({
      enabled: true,
      strategies: {
        slidingWindow: { enabled: true, maxMessages: 6 },
        tokenLimit: { enabled: false, maxTokens: 4000 },
        summary: { enabled: true, keepRecentMessages: 2, summaryPrompt: 'Summarize progress only.' },
      },
      executionOrder: ['summary', 'slidingWindow'],
    }, async () => 'clean summary')

    await service.process(messages)
  } finally {
    console.log = originalConsoleLog
  }

  const diagnosticLogs = logs.filter(line =>
    line.includes('[ContextManagementService] Active tool workflow selection:')
    || line.includes('[ContextManagementService] Preserve tool exchange pairs before:')
    || line.includes('[ContextManagementService] Preserve tool exchange pairs after:'),
  )

  assert.ok(diagnosticLogs.length >= 3, `expected diagnostic logs to be emitted, got ${diagnosticLogs.length}`)

  for (const line of diagnosticLogs) {
    assert.doesNotMatch(line, /content/i)
    assert.doesNotMatch(line, /arguments/i)
    assert.doesNotMatch(line, /schema/i)
    assert.doesNotMatch(line, /output/i)
    assert.doesNotMatch(line, /toolNames?/i)
    assert.match(line, /Count|Applied|strategyName|Length|Group/)
  }
})
