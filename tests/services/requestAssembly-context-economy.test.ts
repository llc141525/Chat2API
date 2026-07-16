import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildRequestAssembly,
  selectProviderMessagesForAssembly,
} from '../../src/main/proxy/RequestAssembly.ts'
import { buildLocalWorkflowDigest } from '../../src/main/proxy/services/workflowStateDigest.ts'
import { buildQwenAssemblyRequestBodyForTest } from '../../src/main/proxy/adapters/qwen.ts'

test('buildRequestAssembly prefers explicit workflowDigest and strips historical config', () => {
  const digest = buildLocalWorkflowDigest([
    { role: 'user', content: 'Continue the long task.' },
  ], 'client_compact')
  const assembly = buildRequestAssembly({
    messages: [
      { role: 'system', content: 'You are opencode.' },
      { role: 'system', content: '## Available Tools\nTool `read`' },
      { role: 'user', content: 'Continue the long task.' },
    ],
    toolManifest: null,
    summaryText: 'legacy summary must lose priority',
    workflowDigest: digest,
  })

  assert.equal(assembly.workflowDigest, digest)
  assert.match(assembly.summaryText ?? '', /Workflow state digest/)
  assert.doesNotMatch(assembly.summaryText ?? '', /legacy summary/)
  assert.deepEqual(assembly.messages.map(message => message.role), ['user'])
})

test('client compact boundary automatically produces typed workflow state', () => {
  const assembly = buildRequestAssembly({
    messages: [
      { role: 'system', content: 'You are opencode.\n## Available Tools\nTool `read`: read files' },
      { role: 'user', content: 'Continue the provider context economy implementation.' },
    ],
    toolManifest: null,
    sessionBoundaryReason: 'client_compact',
  })

  assert.equal(assembly.workflowDigest?.source, 'client_compact')
  assert.match(assembly.workflowDigest?.userGoal ?? '', /context economy/)
  assert.match(assembly.summaryText ?? '', /Workflow state digest/)
  assert.doesNotMatch(assembly.summaryText ?? '', /You are opencode|## Available Tools/)
})

test('provider selection preserves a short user task that merely names a configuration marker', () => {
  const task = 'Fix the repeated ## Available Tools marker without changing unrelated behavior.'
  const assembly = buildRequestAssembly({
    messages: [{ role: 'user', content: task }],
    toolManifest: null,
  })

  assert.equal(assembly.messages[0]?.content, task)
})

test('compatibility summary extraction emits a structured legacy diagnostic', () => {
  const warnings: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => warnings.push(args)
  try {
    buildRequestAssembly({
      messages: [{ role: 'system', content: '[Prior conversation summary] Keep task alpha.' }],
      toolManifest: null,
    })
  } finally {
    console.warn = originalWarn
  }

  assert.ok(warnings.some(args => String(args[0]).includes('compatibility_summary_extraction')))
  assert.equal(warnings.some(args => JSON.stringify(args).includes('Keep task alpha')), false)
})

test('provider selection keeps current tool metadata but strips raw historical contract', () => {
  const assembly = buildRequestAssembly({
    messages: [
      { role: 'system', content: '## Available Tools\nTool `read`' },
      { role: 'user', content: 'Read the current file.' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"filePath":"a.ts"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
    ],
    toolManifest: null,
  })

  const selected = selectProviderMessagesForAssembly(assembly)
  assert.equal(selected.some(message => String(message.content).includes('## Available Tools')), false)
  assert.equal(selected.some(message => message.tool_calls?.[0]?.id === 'call_1'), true)
  assert.equal(selected.some(message => message.tool_call_id === 'call_1'), true)
})

test('qwen provider body does not replay raw prompt-embedded config through content or ori_query', () => {
  const rawUserPayload = [
    'You are opencode.',
    '## Available Tools',
    'Tool `read`: read a file',
    'Continue the long task from the workflow digest.',
  ].join('\n')
  const assembly = buildRequestAssembly({
    messages: [{ role: 'user', content: rawUserPayload }],
    toolManifest: { renderedPrompt: 'Tool Contract Header\n## Available Tools\nTool `read`: read a file' } as any,
  })
  const body = buildQwenAssemblyRequestBodyForTest({
    assembly,
    request: { model: 'Qwen3-Max', messages: [{ role: 'user', content: rawUserPayload }], promptRefreshMode: 'full' },
    actualModel: 'Qwen3-Max',
    sessionId: 'fresh-session',
    reqId: 'req-1',
    timestamp: 1,
    enableThinking: false,
    enableWebSearch: false,
  })

  const content = String(body.messages[0]?.content ?? '')
  const oriQuery = String(body.messages[0]?.meta_data?.ori_query ?? '')
  assert.equal((content.match(/## Available Tools/g) ?? []).length, 1)
  assert.doesNotMatch(oriQuery, /You are opencode|## Available Tools/)
  assert.match(oriQuery, /Continue the long task/)
})
