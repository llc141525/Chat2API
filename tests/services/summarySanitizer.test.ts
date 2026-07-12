import test from 'node:test'
import assert from 'node:assert/strict'

import {
  sanitizeMessagesForSummary,
  detectSummaryContamination,
} from '../../src/main/proxy/services/summarySanitizer.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content }
}

// ── sanitizeMessagesForSummary ─────────────────────────────────────────────────

test('sanitizer: drops system messages carrying prompt-embedded catalog signatures', () => {
  const messages: ChatMessage[] = [
    msg('system', 'You are a helpful assistant.'),
    msg('system', '## Available Tools\nbash: run commands\nfilesystem: read files'),
    msg('user', 'Hello'),
    msg('assistant', 'Hi there'),
  ]

  const { sanitized, droppedCount } = sanitizeMessagesForSummary(messages)

  assert.equal(droppedCount, 1, 'one system message with tool catalog should be dropped')
  assert.ok(
    sanitized.every(m => !(typeof m.content === 'string' && m.content.includes('## Available Tools'))),
    'sanitized output must not contain ## Available Tools'
  )
  assert.ok(
    sanitized.some(m => m.role === 'system' && typeof m.content === 'string' && m.content.includes('You are a helpful assistant')),
    'plain system message must be preserved'
  )
})

test('sanitizer: drops system messages containing <tools>...</tools> blocks', () => {
  const messages: ChatMessage[] = [
    msg('system', 'Base instructions.'),
    msg('system', '<tools><tool name="bash">run commands</tool></tools>'),
    msg('user', 'Do something'),
  ]

  const { sanitized, droppedCount } = sanitizeMessagesForSummary(messages)

  assert.equal(droppedCount, 1)
  assert.ok(!sanitized.some(m => typeof m.content === 'string' && m.content.includes('<tools>')))
})

test('sanitizer: summarizes tool_calls and tool results for workflow continuity', () => {
  const messages: ChatMessage[] = [
    msg('user', 'Run ls'),
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'bash', arguments: '{"command":"ls"}' },
      }],
    },
    {
      role: 'tool',
      content: 'file1.txt\nfile2.txt',
      tool_call_id: 'call_1',
    },
    msg('assistant', 'The directory contains file1.txt and file2.txt.'),
  ]

  const { sanitized, strippedSignatureCount } = sanitizeMessagesForSummary(messages)

  const toolExchanges = sanitized.filter(m => typeof m.content === 'string' && m.content.includes('[tool'))
  assert.equal(toolExchanges.length, 2, 'both tool_calls and tool result must be redacted')
  assert.equal(strippedSignatureCount, 2)
  assert.match(sanitized[1].content as string, /\[tool calls summarized/)
  assert.match(sanitized[1].content as string, /bash\(command="ls"\)/)
  assert.match(sanitized[2].content as string, /\[tool result summarized call_1]/)
  assert.match(sanitized[2].content as string, /file1\.txt/)
  assert.ok(sanitized.some(m => typeof m.content === 'string' && m.content.includes('file1.txt')),
    'final assistant reply must be preserved intact')
})

test('sanitizer: preserves key workflow markers from tool exchanges without keeping raw schemas', () => {
  const messages: ChatMessage[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_long_1',
        type: 'function',
        function: {
          name: 'bash',
          arguments: JSON.stringify({
            command: 'node -e "fs.writeFileSync(\'.agent-probe/long-check-2.txt\', \'CHECK2=42\\n\')"',
            timeout_ms: 10000,
          }),
        },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'call_long_1',
      content: '<path>E:\\Chat2API\\.agent-probe\\long-check-2.txt</path>\n<content>\n1: CHECK2=42\n</content>',
    },
  ]

  const { sanitized } = sanitizeMessagesForSummary(messages)

  assert.match(sanitized[0].content as string, /long-check-2\.txt/)
  assert.match(sanitized[0].content as string, /timeout_ms=10000/)
  assert.doesNotMatch(sanitized[0].content as string, /"type":"function"/)
  assert.match(sanitized[1].content as string, /long-check-2\.txt/)
  assert.match(sanitized[1].content as string, /CHECK2=42/)
})

test('sanitizer: preserves natural-language assistant replies unchanged', () => {
  const reply = 'I understand your question about TypeScript generics. Here is my explanation…'
  const messages: ChatMessage[] = [
    msg('user', 'Explain TypeScript generics'),
    msg('assistant', reply),
  ]

  const { sanitized, droppedCount, strippedSignatureCount } = sanitizeMessagesForSummary(messages)

  assert.equal(droppedCount, 0)
  assert.equal(strippedSignatureCount, 0)
  assert.equal(sanitized.length, 2)
  assert.equal(sanitized[1].content, reply)
})

test('sanitizer: strips <tools> block from assistant content while keeping surrounding prose', () => {
  const messages: ChatMessage[] = [
    msg('assistant', [
      'I can help you with that.',
      '',
      '<tools><tool name="bash">run commands</tool></tools>',
      '',
      'Let me know what you need.',
    ].join('\n')),
  ]

  const { sanitized, strippedSignatureCount } = sanitizeMessagesForSummary(messages)

  assert.equal(strippedSignatureCount, 1)
  const content = sanitized[0].content as string
  assert.ok(!content.includes('<tools>'), 'tool block must be stripped')
  assert.ok(content.includes('I can help'), 'leading prose must be kept')
  assert.ok(content.includes('Let me know'), 'trailing prose must be kept')
})

test('sanitizer: is idempotent — sanitize(sanitize(x)) equals sanitize(x)', () => {
  const messages: ChatMessage[] = [
    msg('system', '## Available Tools\nbash: run shell'),
    msg('user', 'Do something'),
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'c1',
        type: 'function',
        function: { name: 'bash', arguments: '{}' },
      }],
    },
    { role: 'tool', content: 'done', tool_call_id: 'c1' },
    msg('assistant', 'Done.'),
  ]

  const once = sanitizeMessagesForSummary(messages).sanitized
  const twice = sanitizeMessagesForSummary(once).sanitized

  assert.deepEqual(
    twice.map(m => ({ role: m.role, content: m.content })),
    once.map(m => ({ role: m.role, content: m.content })),
    'second sanitization must produce same result as first'
  )
})

// ── detectSummaryContamination ─────────────────────────────────────────────────

test('detectSummaryContamination: clean summary is not flagged', () => {
  const summary = 'User asked about TypeScript generics. Assistant explained bounded type parameters and gave examples.'
  const result = detectSummaryContamination(summary)

  assert.equal(result.contaminated, false)
  assert.equal(result.signatures.length, 0)
})

test('detectSummaryContamination: catches ## Available Tools in summary', () => {
  const summary = [
    'Assistant correctly identified the full available toolset.',
    '## Available Tools',
    '- bash: run commands',
    '- filesystem: read files',
    'Tool context is now established.',
  ].join('\n')

  const result = detectSummaryContamination(summary)

  assert.equal(result.contaminated, true)
  assert.ok(result.signatures.some(h => h.signature === '## Available Tools'))
})

test('detectSummaryContamination: catches <tools> XML block in summary', () => {
  const summary = 'Summary: <tools><tool name="bash">run commands</tool></tools> tools configured.'
  const result = detectSummaryContamination(summary)

  assert.equal(result.contaminated, true)
  assert.ok(result.signatures.some(h => h.signature === '<tools>'))
})

test('detectSummaryContamination: catches managed XML catalog signature', () => {
  const summary = 'The assistant confirmed it can use <|CHAT2API|tool_calls> format for tool invocation.'
  const result = detectSummaryContamination(summary)

  assert.equal(result.contaminated, true)
  assert.ok(result.signatures.some(h => h.signature === '<|CHAT2API|tool_calls>'))
})

test('detectSummaryContamination: catches managed contract-header summary leakage', () => {
  const summary = [
    'Procedural State Summary',
    'Tool Contract Header',
    'contract_header_version: 1',
    'catalog_fingerprint: fp_123',
    'allowed_tools: bash, read',
  ].join('\n')
  const result = detectSummaryContamination(summary)

  assert.equal(result.contaminated, true)
  assert.ok(result.signatures.some(h => h.signature === 'Tool Contract Header'))
  assert.ok(result.signatures.some(h => h.signature === 'allowed_tools:'))
})
