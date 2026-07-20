import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildWorkflowLedger,
  buildWorkflowLedgerHandoffMessage,
} from '../../src/main/proxy/services/workflowLedger.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'

function makeToolCall(id: string, name: string, args: string) {
  return {
    id,
    type: 'function' as const,
    function: { name, arguments: args },
  }
}

function makeExchange(id: string, name: string, args: string, content = 'ok'): ChatMessage[] {
  return [
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall(id, name, args)],
    },
    {
      role: 'tool',
      tool_call_id: id,
      content,
    },
  ]
}

function makeSkillGroup(skillContent: string): ChatMessage[] {
  return [
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_skill', 'skill', '{"name":"long-conversation-probe"}')],
    },
    {
      role: 'tool',
      tool_call_id: 'call_skill',
      content: `<skill_content>\n${skillContent}\n</skill_content>`,
    },
  ]
}

test('ledger picks bash after first read and exposes exact command argument hint', () => {
  const retainedGroups = [
    makeSkillGroup([
      '1. Use the `read` tool to read `tests/agent-capability/input.txt`.',
      '2. Use the `bash` tool to run:',
      '   `New-Item -ItemType Directory -Force .agent-probe | Out-Null; node -e "require(\'fs\').writeFileSync(\'.agent-probe/long-step-1.txt\', \'ok\')" `',
    ].join('\n')),
  ]
  const completedGroups = [
    makeExchange('call_read_1', 'read', '{"filePath":"tests/agent-capability/input.txt"}', 'input evidence'),
  ]

  const ledger = buildWorkflowLedger({
    groups: completedGroups,
    latestSkillInstructionPinned: true,
    retainedGroups,
  })

  assert.equal(ledger.kind, 'active_skill')
  assert.equal(ledger.nextToolName, 'bash')
  assert.match(String(ledger.nextInstruction), /2\. Use the `bash` tool to run:/)
  assert.match(String(ledger.nextArgumentHint), /^command=/)
  assert.match(String(ledger.nextArgumentHint), /New-Item -ItemType Directory/)
  assert.match(String(ledger.nextArgumentHint), /writeFileSync\('\.agent-probe\/long-step-1\.txt'/)
})

test('ledger recognizes bash as the action in a step that mentions the prior read result', () => {
  const retainedGroups = [
    makeSkillGroup([
      '1. Use the `read` tool to read `tests/agent-capability/input.txt`.',
      '2. After receiving that `read` tool result, emit a `bash` tool call immediately.',
      '3. In that `bash` tool call, run `node tests/agent-capability/compute-result.mjs tests/agent-capability/input.txt`.',
    ].join('\n')),
  ]

  const ledger = buildWorkflowLedger({
    groups: [makeExchange('call_read_1', 'read', '{"filePath":"tests/agent-capability/input.txt"}', 'input evidence')],
    latestSkillInstructionPinned: true,
    retainedGroups,
  })

  assert.equal(ledger.nextToolName, 'bash')
  assert.match(String(ledger.nextInstruction), /emit a `bash` tool call/i)
})

test('ledger picks a later read path after earlier read and bash completions', () => {
  const retainedGroups = [
    makeSkillGroup([
      '1. Use the `read` tool to read `tests/agent-capability/input.txt`.',
      '2. Use the `bash` tool to run:',
      '   `node -e "require(\'fs\').writeFileSync(\'.agent-probe/long-step-1.txt\', \'ok\')" `',
      '3. Use the `read` tool to read `.agent-probe/long-summary.txt`.',
    ].join('\n')),
  ]
  const completedGroups = [
    makeExchange('call_read_1', 'read', '{"filePath":"tests/agent-capability/input.txt"}', 'input evidence'),
    makeExchange('call_bash_1', 'bash', '{"command":"node -e \\"require(\'fs\').writeFileSync(\'.agent-probe/long-step-1.txt\', \'ok\')\\""}', 'created step 1'),
  ]

  const ledger = buildWorkflowLedger({
    groups: completedGroups,
    latestSkillInstructionPinned: true,
    retainedGroups,
  })

  assert.equal(ledger.nextToolName, 'read')
  assert.match(String(ledger.nextInstruction), /3\. Use the `read` tool/)
  assert.equal(ledger.nextArgumentHint, 'filePath=.agent-probe/long-summary.txt')
  assert.doesNotMatch(String(ledger.nextArgumentHint), /tests\/agent-capability\/input\.txt/)
})

test('ledger accounts for every tool call in one parallel assistant exchange', () => {
  const retainedGroups = [
    makeSkillGroup([
      '1. Read `tailwind.config.js`.',
      '2. Read `src/renderer/src/index.css`.',
      '3. Glob `src/renderer/src/**/*.tsx`.',
      '4. Read exactly two component files.',
    ].join('\n')),
  ]
  const parallelGroup: ChatMessage[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        makeToolCall('call_read_tailwind', 'read', '{"filePath":"tailwind.config.js"}'),
        makeToolCall('call_read_css', 'read', '{"filePath":"src/renderer/src/index.css"}'),
        makeToolCall('call_glob_components', 'glob', '{"pattern":"src/renderer/src/**/*.tsx"}'),
      ],
    },
    { role: 'tool', tool_call_id: 'call_read_tailwind', content: 'tailwind evidence' },
    { role: 'tool', tool_call_id: 'call_read_css', content: 'css evidence' },
    { role: 'tool', tool_call_id: 'call_glob_components', content: 'component list' },
  ]

  const ledger = buildWorkflowLedger({
    groups: [parallelGroup],
    latestSkillInstructionPinned: true,
    retainedGroups,
  })

  assert.equal(ledger.completedSteps.length, 3)
  assert.equal(ledger.nextToolName, 'read')
  assert.match(String(ledger.nextInstruction), /4\. Read exactly two component files/)
})

test('ledger does not mark a parallel tool call complete without its matching result', () => {
  const retainedGroups = [
    makeSkillGroup([
      '1. Read `a.txt`.',
      '2. Read `b.txt`.',
    ].join('\n')),
  ]
  const partialParallelGroup: ChatMessage[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        makeToolCall('call_read_a', 'read', '{"filePath":"a.txt"}'),
        makeToolCall('call_read_b', 'read', '{"filePath":"b.txt"}'),
      ],
    },
    { role: 'tool', tool_call_id: 'call_read_a', content: 'a evidence' },
  ]

  const ledger = buildWorkflowLedger({
    groups: [partialParallelGroup],
    latestSkillInstructionPinned: true,
    retainedGroups,
  })

  assert.equal(ledger.completedSteps.length, 1)
  assert.equal(ledger.nextArgumentHint, 'filePath=b.txt')
})

test('ledger renders completed exchange handoff bounded without copying long raw tool output', () => {
  const longToolResult = 'RAW_TOOL_OUTPUT '.repeat(120)
  const groups = [
    makeExchange('call_read_1', 'read', '{"filePath":"a.txt"}', `${longToolResult}one`),
    makeExchange('call_bash_1', 'bash', '{"command":"node build.js"}', `${longToolResult}two`),
    makeExchange('call_read_2', 'read', '{"filePath":"b.txt"}', `${longToolResult}three`),
    makeExchange('call_write_1', 'write', '{"filePath":"c.txt","content":"done"}', `${longToolResult}four`),
  ]

  const message = buildWorkflowLedgerHandoffMessage({ groups })
  const content = String(message.content)

  assert.equal(message.role, 'assistant')
  assert.match(content, /\[Completed tool exchange handoff\]/)
  assert.match(content, /\.\.\. plus 1 earlier completed exchange\(s\)\./)
  assert.equal(content.includes(longToolResult.trim()), false)
  assert.ok(content.length < 900, `expected bounded content, got ${content.length}`)
})
