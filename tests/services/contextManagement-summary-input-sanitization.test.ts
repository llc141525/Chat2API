/**
 * Integration test: SummaryStrategy must not expose tool catalog content to the generator.
 *
 * Fixture shape drawn from opencode诊断报告.md evidence — all content synthetic/redacted:
 * - A system message that carried the injected tool catalog
 * - An assistant turn that hallucinated a tool list in narrative prose
 * - The summary generator is a spy that captures its input
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { SummaryStrategy } from '../../src/main/proxy/services/contextManagementService.ts'
import { sanitizeMessagesForSummary } from '../../src/main/proxy/services/summarySanitizer.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content }
}

function buildContaminatedHistory(): ChatMessage[] {
  return [
    // System message carrying the injected tool catalog (should be dropped by sanitizer)
    msg('system', '## Available Tools\nbash: PowerShell 7+ on Windows\nfilesystem: read/write files\nWebFetch: fetch URLs'),
    msg('user', 'What tools do you have?'),
    // Assistant hallucinated an authoritative-sounding list (structural signatures in prose)
    msg('assistant', [
      'I have access to the following tools:',
      '',
      '## Available Tools',
      '- Bash (PowerShell 7+ on Windows)',
      '- Filesystem',
      '- Burp Suite MCP',
      '- GitHub Integration',
      '- WebFetch',
      '',
      'Tool context is now established.',
    ].join('\n')),
    msg('user', 'Run ls in the project root'),
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_bash_1',
        type: 'function',
        function: { name: 'bash', arguments: '{"command":"ls"}' },
      }],
    },
    { role: 'tool', content: 'src/ tests/ package.json', tool_call_id: 'call_bash_1' },
    msg('assistant', 'The project root contains src/, tests/, and package.json.'),
    msg('user', 'Thank you'),
    msg('assistant', 'You are welcome.'),
  ]
}

test('sanitizer strips all tool catalog signatures before passing history to summary generator', () => {
  const history = buildContaminatedHistory()
  const { sanitized, droppedCount, strippedSignatureCount } = sanitizeMessagesForSummary(history)

  // Must have removed at least the tool catalog system message and the assistant catalog section
  assert.ok(droppedCount >= 1, `Expected at least 1 dropped message, got ${droppedCount}`)
  assert.ok(strippedSignatureCount >= 1, `Expected at least 1 stripped signature, got ${strippedSignatureCount}`)

  // No remaining message should carry ## Available Tools
  for (const m of sanitized) {
    const content = typeof m.content === 'string' ? m.content : ''
    assert.ok(
      !content.includes('## Available Tools'),
      `Found "## Available Tools" in sanitized ${m.role} message: ${content.slice(0, 80)}`
    )
  }
})

test('sanitizer keeps workflow-relevant tool exchange markers for the summary generator', () => {
  const history: ChatMessage[] = [
    msg('user', 'Continue the probe'),
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_probe_1',
        type: 'function',
        function: {
          name: 'bash',
          arguments: JSON.stringify({
            command: 'node -e "fs.writeFileSync(\'.agent-probe/long-check-2.txt\', \'CHECK2=48\\n\')"',
          }),
        },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'call_probe_1',
      content: '<path>E:\\Chat2API\\.agent-probe\\long-check-2.txt</path>\n<content>\n1: CHECK2=48\n</content>',
    },
  ]

  const { sanitized } = sanitizeMessagesForSummary(history)

  assert.match(sanitized[1].content as string, /bash/)
  assert.match(sanitized[1].content as string, /long-check-2\.txt/)
  assert.match(sanitized[2].content as string, /CHECK2=48/)
})

test('SummaryStrategy never exposes tool catalog signatures to the generator', async () => {
  const capturedInputs: ChatMessage[][] = []

  const spyGenerator = async (messages: ChatMessage[], _prompt?: string): Promise<string> => {
    capturedInputs.push([...messages])
    return `Summary of ${messages.length} messages.`
  }

  const strategy = new SummaryStrategy(
    { enabled: true, keepRecentMessages: 3 },
    spyGenerator
  )

  const history = buildContaminatedHistory()
  await strategy.execute(history)

  assert.equal(capturedInputs.length, 1, 'generator should be called exactly once')
  const generatorInput = capturedInputs[0]

  for (const m of generatorInput) {
    const content = typeof m.content === 'string' ? m.content : ''
    assert.ok(
      !content.includes('## Available Tools'),
      `Generator received "## Available Tools" in ${m.role} message`
    )
    assert.ok(
      !content.includes('<tools>'),
      `Generator received "<tools>" in ${m.role} message`
    )
  }
})

test('SummaryStrategy uses local fallback summary when contamination detected in output', async () => {
  // A generator that replicates a tool catalog signature in its summary output
  const contaminatedGenerator = async (_messages: ChatMessage[]): Promise<string> => {
    return [
      'Prior context: assistant identified the toolset.',
      '## Available Tools',
      '- bash: run commands',
      'Tool context established.',
    ].join('\n')
  }

  const strategy = new SummaryStrategy(
    { enabled: true, keepRecentMessages: 3 },
    contaminatedGenerator
  )

  const history = buildContaminatedHistory()
  const result = await strategy.execute(history)

  assert.equal(result.subkind, 'summary_fallback_local',
    `Expected summary_fallback_local subkind, got: ${result.subkind}`)

  // Fallback must not include the contaminated generator output.
  const summaryMsg = result.messages.find(
    m => typeof m.content === 'string' && m.content.includes('[Prior conversation summary')
  )
  assert.ok(summaryMsg, 'local fallback summary must appear in fallback result')
  assert.ok(
    !(summaryMsg!.content as string).includes('## Available Tools'),
    'contaminated summary output must not appear in fallback result',
  )
  assert.ok(
    (summaryMsg!.content as string).includes('Local fallback summary'),
    'fallback result should identify local summary source',
  )
})

test('sanitizer drops a mixed runtime/tool system payload even when a protocol marker takes classifier precedence', () => {
  const history: ChatMessage[] = [
    msg('system', [
      'Working directory: E:\\Chat2API',
      'superpowers: active workflow instructions',
      'SUBAGENT-STOP: do not continue the child session',
      'Tool Contract Header',
      'catalog_fingerprint: test-catalog',
      '<|CHAT2API|tool_calls>',
    ].join('\n')),
    msg('user', 'Summarize the confirmed task progress.'),
  ]

  const { sanitized, droppedCount } = sanitizeMessagesForSummary(history)

  assert.equal(droppedCount, 1)
  assert.deepEqual(sanitized, [history[1]])
})

test('sanitizer drops runtime workflow directives that have no explicit tool-catalog header', () => {
  const history: ChatMessage[] = [
    msg('system', [
      'Working directory: E:\\Chat2API',
      'superpowers: follow the active workflow before responding',
      'SUBAGENT-STOP: stop when the child workflow settles',
    ].join('\n')),
    msg('user', 'Summarize only the work completed so far.'),
  ]

  const { sanitized, droppedCount } = sanitizeMessagesForSummary(history)

  assert.equal(droppedCount, 1)
  assert.deepEqual(sanitized, [history[1]])
})

test('sanitizer recognizes runtime configuration carried in text content parts', () => {
  const history: ChatMessage[] = [
    {
      role: 'system',
      content: [
        { type: 'text', text: 'Working directory: E:\\Chat2API' },
        { type: 'text', text: 'superpowers: active workflow instructions' },
        { type: 'text', text: 'SUBAGENT-STOP: stop when the child workflow settles' },
      ],
    },
    msg('user', 'Summarize the confirmed task progress.'),
  ]

  const { sanitized, droppedCount } = sanitizeMessagesForSummary(history)

  assert.equal(droppedCount, 1)
  assert.deepEqual(sanitized, [history[1]])
})

test('sanitizer drops an old user-role runtime payload while retaining the real user task', () => {
  const history: ChatMessage[] = [
    msg('user', [
      'Working directory: E:\\Chat2API',
      'superpowers: active workflow instructions',
      'SUBAGENT-STOP: stop when the child workflow settles',
      'This message defines the client runtime, not the task.',
    ].join('\n')),
    msg('user', 'Implement the requested fix and preserve the verified result.'),
  ]

  const { sanitized, droppedCount } = sanitizeMessagesForSummary(history)

  assert.equal(droppedCount, 1)
  assert.deepEqual(sanitized, [history[1]])
})

test('sanitizer retains an ordinary user question that mentions runtime terms', () => {
  const history: ChatMessage[] = [
    msg('user', 'What do superpowers and SUBAGENT-STOP mean in this project?'),
  ]

  const { sanitized, droppedCount } = sanitizeMessagesForSummary(history)

  assert.equal(droppedCount, 0)
  assert.deepEqual(sanitized, history)
})

test('SummaryStrategy injects sanitized summary as isolated system narrative', async () => {
  const generator = async (msgs: ChatMessage[]) => `Summary of ${msgs.length} messages.`
  const strategy = new SummaryStrategy(
    { enabled: true, keepRecentMessages: 3 },
    generator
  )

  const history = buildContaminatedHistory()
  const result = await strategy.execute(history)

  const summaryMsg = result.messages.find(
    m => typeof m.content === 'string' && m.content.includes('[Prior conversation summary')
  )
  assert.ok(summaryMsg, 'summary message must be present')
  assert.equal(summaryMsg!.role, 'system', 'summary must remain in system role')
  assert.ok(
    (summaryMsg!.content as string).includes('non-authoritative narrative'),
    'isolated summary must include isolation header'
  )
})
