import test from 'node:test'
import assert from 'node:assert/strict'
import { renderFinalPrompt, type PromptTemplate } from '../../src/main/proxy/adapters/renderFinalPrompt.ts'

test('prefix template puts tool contract before conversation', () => {
  const result = renderFinalPrompt({
    systemText: 'You are helpful.',
    summaryText: '[Prior conversation summary]',
    toolContractText: '## Available Tools\nTool `read`',
    conversationText: 'User: read a file',
    template: 'prefix',
  })

  const sysIdx = result.indexOf('You are helpful.')
  const summaryIdx = result.indexOf('[Prior conversation summary]')
  const toolsIdx = result.indexOf('## Available Tools')
  const convIdx = result.indexOf('User: read a file')

  assert.ok(sysIdx < summaryIdx, 'system before summary')
  assert.ok(summaryIdx < toolsIdx, 'summary before tools')
  assert.ok(toolsIdx < convIdx, 'tools before conversation')
})

test('suffix template puts tool contract after conversation', () => {
  const result = renderFinalPrompt({
    systemText: 'You are helpful.',
    summaryText: null,
    toolContractText: '## Available Tools',
    conversationText: 'User: read a file',
    template: 'suffix',
  })

  const sysIdx = result.indexOf('You are helpful.')
  const convIdx = result.indexOf('User: read a file')
  const toolsIdx = result.indexOf('## Available Tools')

  assert.ok(sysIdx < convIdx, 'system before conversation')
  assert.ok(convIdx < toolsIdx, 'tools after conversation')
})

test('null systemText is omitted', () => {
  const result = renderFinalPrompt({
    systemText: null,
    summaryText: null,
    toolContractText: '## Available Tools',
    conversationText: 'hello',
    template: 'prefix',
  })

  assert.ok(!result.includes('null'))
  assert.ok(result.startsWith('## Available Tools'))
})

test('null toolContractText does not crash', () => {
  const result = renderFinalPrompt({
    systemText: 'sys',
    summaryText: null,
    toolContractText: null,
    conversationText: 'hello',
    template: 'suffix',
  })

  assert.ok(result.includes('sys'))
  assert.ok(result.includes('hello'))
  assert.ok(!result.includes('null'))
})

test('custom separator', () => {
  const result = renderFinalPrompt({
    systemText: 'sys',
    summaryText: null,
    toolContractText: 'tools',
    conversationText: 'conv',
    template: 'prefix',
    separator: '\n---\n',
  })

  assert.ok(result.includes('\n---\n'))
})
