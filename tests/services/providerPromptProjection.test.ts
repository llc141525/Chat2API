import test from 'node:test'
import assert from 'node:assert/strict'

import { buildRequestAssembly } from '../../src/main/proxy/RequestAssembly.ts'
import { projectRequestAssemblyForPromptMode } from '../../src/main/proxy/services/providerPromptProjection.ts'

function assembly() {
  return buildRequestAssembly({
    messages: [
      { role: 'user', content: 'Old user turn.' },
      { role: 'assistant', content: 'Old assistant turn.' },
      { role: 'user', content: 'Current user turn.' },
    ],
    toolManifest: {
      renderedPrompt: 'Tool Contract Header\n## Available Tools\nTool `read`: read files',
    } as any,
    summaryText: '[Workflow state digest] Continue task alpha.',
  })
}

test('full and tool-ready modes preserve the authoritative assembly', () => {
  const source = assembly()
  assert.equal(projectRequestAssemblyForPromptMode(source, 'full'), source)
  assert.equal(projectRequestAssemblyForPromptMode(source, 'tool_ready'), source)
})

test('minimal mode sends only the current delta and omits summary and tool catalog replay', () => {
  const projected = projectRequestAssemblyForPromptMode(assembly(), 'minimal')

  assert.ok(projected.messages.length >= 1, 'minimal keeps at least the current turn')
  assert.ok(projected.messages.some(message => message.content === 'Current user turn.'), 'minimal includes the current turn')
  assert.equal(projected.summaryText, null)
  assert.ok(projected.toolManifest, 'minimal must keep toolManifest — managed XML tools are prompt-embedded')
})

test('minimal mode preserves a coherent active tool exchange tail', () => {
  const source = buildRequestAssembly({
    messages: [
      { role: 'user', content: 'Old turn.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"filePath":"a.ts"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
      { role: 'user', content: 'Continue after the tool result.' },
    ],
    toolManifest: { renderedPrompt: 'current contract' } as any,
  })
  const projected = projectRequestAssemblyForPromptMode(source, 'minimal')

  assert.ok(projected.messages.length >= 3, 'minimal keeps recent tool exchange')
  assert.ok(projected.messages.some(message => message.role === 'tool'), 'minimal preserves tool results')
  assert.ok(projected.messages.some(message => message.tool_calls?.[0]?.id === 'call_1'), 'minimal preserves tool call ids')
  assert.ok(projected.messages.some(message => message.tool_call_id === 'call_1'), 'minimal preserves tool result ids')
})

test('digest mode keeps bounded recent state plus the typed digest and current catalog', () => {
  const source = assembly()
  const projected = projectRequestAssemblyForPromptMode(source, 'digest')

  assert.ok(projected.messages.length <= 4)
  assert.equal(projected.summaryText, source.summaryText)
  assert.equal(projected.toolManifest, source.toolManifest)
})
