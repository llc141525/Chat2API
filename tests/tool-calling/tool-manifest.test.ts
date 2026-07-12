import test from 'node:test'
import assert from 'node:assert/strict'
import { createToolManifest, type ToolManifest, type CreateToolManifestInput } from '../../src/main/proxy/toolCalling/ToolManifest.ts'
import { buildRequestAssembly, type RequestAssembly } from '../../src/main/proxy/RequestAssembly.ts'

test('createToolManifest returns immutable copy', () => {
  const input: CreateToolManifestInput = {
    protocol: 'managed_xml',
    catalogFingerprint: 'fp-001',
    allowedToolNames: ['bash', 'read'],
    tools: [
      { name: 'bash', description: 'Run command', parameters: {}, source: 'openai' },
      { name: 'read', description: 'Read file', parameters: {}, source: 'openai' },
    ],
    renderedPrompt: '## Available Tools\n...',
    contractHeaderVersion: 1,
  }

  const manifest = createToolManifest(input)

  assert.equal(manifest.protocol, 'managed_xml')
  assert.equal(manifest.catalogFingerprint, 'fp-001')
  assert.deepEqual(manifest.allowedToolNames, ['bash', 'read'])
  assert.equal(manifest.tools.length, 2)
  assert.equal(manifest.renderedPrompt, '## Available Tools\n...')
  assert.equal(manifest.contractHeaderVersion, 1)

  // Verify immutability: mutating input does not affect manifest
  input.allowedToolNames.push('write')
  assert.equal(manifest.allowedToolNames.length, 2)
})

test('createToolManifest preserves tool order', () => {
  const input: CreateToolManifestInput = {
    protocol: 'managed_bracket',
    catalogFingerprint: 'fp-002',
    allowedToolNames: ['z_tool', 'a_tool', 'm_tool'],
    tools: [
      { name: 'z_tool', description: '', parameters: {}, source: 'openai' },
      { name: 'a_tool', description: '', parameters: {}, source: 'openai' },
      { name: 'm_tool', description: '', parameters: {}, source: 'openai' },
    ],
    renderedPrompt: '',
    contractHeaderVersion: 1,
  }

  const manifest = createToolManifest(input)
  assert.deepEqual(manifest.allowedToolNames, ['z_tool', 'a_tool', 'm_tool'])
})

test('createToolManifest deduplicates allowedToolNames', () => {
  const input: CreateToolManifestInput = {
    protocol: 'managed_xml',
    catalogFingerprint: 'fp-003',
    allowedToolNames: ['bash', 'read', 'bash', 'write', 'read'],
    tools: [
      { name: 'bash', description: '', parameters: {}, source: 'openai' },
      { name: 'read', description: '', parameters: {}, source: 'openai' },
      { name: 'write', description: '', parameters: {}, source: 'openai' },
    ],
    renderedPrompt: '',
    contractHeaderVersion: 1,
  }

  const manifest = createToolManifest(input)
  assert.deepEqual(manifest.allowedToolNames, ['bash', 'read', 'write'])
})

test('buildRequestAssembly with all fields', () => {
  const manifest: ToolManifest = {
    protocol: 'managed_xml',
    catalogFingerprint: 'fp',
    allowedToolNames: ['read'],
    tools: [],
    renderedPrompt: 'prompt',
    contractHeaderVersion: 1,
  }

  const messages: any[] = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'hello' },
  ]

  const assembly = buildRequestAssembly({
    messages,
    toolManifest: manifest,
    summaryText: 'Earlier conversation summary.',
    contextResult: {
      summaryGenerated: true,
      strategyResults: [
        { strategyName: 'summary', trimmed: true },
      ],
      originalCount: 10,
      finalCount: 4,
    },
  })

  assert.equal(assembly.messages, messages)
  assert.equal(assembly.toolManifest, manifest)
  assert.equal(assembly.summaryText, 'Earlier conversation summary.')
  assert.equal(assembly.metadata.contextManagementApplied, true)
  assert.deepEqual(assembly.metadata.strategiesExecuted, ['summary'])
  assert.equal(assembly.metadata.originalMessageCount, 10)
  assert.equal(assembly.metadata.finalMessageCount, 4)
})

test('buildRequestAssembly with minimal fields', () => {
  const messages: any[] = [{ role: 'user', content: 'hi' }]

  const assembly = buildRequestAssembly({
    messages,
    toolManifest: null,
  })

  assert.equal(assembly.messages, messages)
  assert.equal(assembly.toolManifest, null)
  assert.equal(assembly.summaryText, null)
  assert.equal(assembly.metadata.contextManagementApplied, false)
  assert.deepEqual(assembly.metadata.strategiesExecuted, [])
  assert.equal(assembly.metadata.originalMessageCount, 1)
  assert.equal(assembly.metadata.finalMessageCount, 1)
})

test('buildRequestAssembly with contextResult no trimmed strategies', () => {
  const messages: any[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
  ]

  const assembly = buildRequestAssembly({
    messages,
    toolManifest: null,
    contextResult: {
      summaryGenerated: false,
      strategyResults: [
        { strategyName: 'slidingWindow', trimmed: false },
        { strategyName: 'tokenLimit', trimmed: false },
      ],
      originalCount: 5,
      finalCount: 5,
    },
  })

  assert.equal(assembly.metadata.contextManagementApplied, false)
  assert.deepEqual(assembly.metadata.strategiesExecuted, [])
  assert.equal(assembly.metadata.originalMessageCount, 5)
  assert.equal(assembly.metadata.finalMessageCount, 5)
})
