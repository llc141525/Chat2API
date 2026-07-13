import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createToolCatalogStore,
  resolveToolCatalog,
} from '../../src/main/proxy/toolCalling/catalog.ts'
import type { NormalizedToolDefinition } from '../../src/main/proxy/toolCalling/types.ts'

const bashTool: NormalizedToolDefinition = {
  name: 'bash',
  description: 'Run a shell command',
  parameters: {
    type: 'object',
    properties: { argument: { type: 'string' } },
    required: ['argument'],
  },
  source: 'openai',
}

const writeTool: NormalizedToolDefinition = {
  name: 'write',
  description: 'Write a file',
  parameters: {
    type: 'object',
    properties: { filePath: { type: 'string' }, content: { type: 'string' } },
    required: ['filePath', 'content'],
  },
  source: 'openai',
}

test('request tools create an immutable current-request snapshot with stable hashes', () => {
  const store = createToolCatalogStore()
  const result = store.resolveSnapshot({
    sessionId: 's1',
    requestTools: [writeTool, bashTool],
    hasManagedToolHistory: false,
    historyToolNames: [],
  })

  assert.equal(result.blocked, false)
  assert.equal(result.snapshot?.source, 'current_request')
  assert.deepEqual(result.snapshot?.allowedToolNames, ['bash', 'write'])
  assert.equal(typeof result.snapshot?.fingerprint, 'string')
  assert.notEqual(result.snapshot?.fingerprint, '')
  assert.equal(typeof result.snapshot?.schemaHashes.bash, 'string')
  assert.equal(typeof result.snapshot?.schemaHashes.write, 'string')

  const before = result.snapshot!.allowedToolNames as string[]
  assert.throws(() => before.push('mutated'), /Cannot add property|object is not extensible|read only/i)
  assert.deepEqual(result.snapshot?.allowedToolNames, ['bash', 'write'])
})

test('omitted tools reuse an existing session catalog without changing fingerprint', () => {
  const store = createToolCatalogStore()
  const first = store.resolveSnapshot({
    sessionId: 's1',
    requestTools: [bashTool],
    hasManagedToolHistory: false,
    historyToolNames: [],
  })
  const second = store.resolveSnapshot({
    sessionId: 's1',
    requestTools: [],
    hasManagedToolHistory: true,
    historyToolNames: ['bash'],
  })

  assert.equal(second.blocked, false)
  assert.equal(second.snapshot?.source, 'session_catalog')
  assert.equal(second.snapshot?.fingerprint, first.snapshot?.fingerprint)
  assert.deepEqual(second.diagnostics.driftKinds, ['missing_current_tools_with_session_catalog'])
  assert.deepEqual(second.snapshot?.tools[0]?.parameters, bashTool.parameters)
  assert.notEqual(second.snapshot?.tools[0]?.parameters, bashTool.parameters)
})

test('omitted tools with managed history and no catalog restore from history as degraded fallback', () => {
  const result = createToolCatalogStore().resolveSnapshot({
    sessionId: 's-missing',
    requestTools: [],
    hasManagedToolHistory: true,
    historyToolNames: ['bash'],
  })

  assert.equal(result.blocked, false)
  assert.equal(result.snapshot?.source, 'restored_from_history')
  assert.deepEqual(result.snapshot?.allowedToolNames, ['bash'])
  assert.ok(result.diagnostics.driftKinds.includes('restored_from_history'))
  assert.deepEqual(result.snapshot?.tools[0]?.parameters, { type: 'object', additionalProperties: true })
})

test('added tools create a new snapshot and new fingerprint', () => {
  const store = createToolCatalogStore()
  const first = store.resolveSnapshot({
    sessionId: 's1',
    requestTools: [bashTool],
    hasManagedToolHistory: false,
    historyToolNames: [],
  })
  const second = store.resolveSnapshot({
    sessionId: 's1',
    requestTools: [bashTool, writeTool],
    hasManagedToolHistory: true,
    historyToolNames: ['bash'],
  })

  assert.equal(second.blocked, false)
  assert.deepEqual(second.diagnostics.driftKinds, ['added_tool'])
  assert.notEqual(second.snapshot?.fingerprint, first.snapshot?.fingerprint)
  assert.deepEqual(second.snapshot?.allowedToolNames, ['bash', 'write'])
})

test('removed historical tools block instead of silently shrinking availability', () => {
  const store = createToolCatalogStore()
  store.resolveSnapshot({
    sessionId: 's1',
    requestTools: [bashTool, writeTool],
    hasManagedToolHistory: false,
    historyToolNames: [],
  })

  const result = store.resolveSnapshot({
    sessionId: 's1',
    requestTools: [bashTool],
    hasManagedToolHistory: true,
    historyToolNames: ['write'],
  })

  assert.equal(result.blocked, true)
  assert.deepEqual(result.diagnostics.driftKinds, ['removed_tool'])
  assert.equal(result.diagnostics.reason, 'historical_tool_removed')
})

test('same-session subset request reuses the full session catalog instead of shrinking it', () => {
  const store = createToolCatalogStore()
  const first = store.resolveSnapshot({
    sessionId: 'subset-session',
    requestTools: [bashTool, writeTool],
    hasManagedToolHistory: false,
    historyToolNames: [],
  })

  const second = store.resolveSnapshot({
    sessionId: 'subset-session',
    requestTools: [bashTool],
    hasManagedToolHistory: true,
    historyToolNames: [],
  })

  assert.equal(second.blocked, false)
  assert.equal(second.diagnostics.source, 'session_catalog')
  assert.deepEqual(second.diagnostics.driftKinds, ['current_request_subset_of_session_catalog'])
  assert.equal(second.snapshot?.fingerprint, first.snapshot?.fingerprint)
  assert.deepEqual(second.snapshot?.allowedToolNames, ['bash', 'write'])
})

test('restore-only-when-empty policy respects the current subset request instead of reviving the full session catalog', () => {
  const store = createToolCatalogStore()
  store.resolveSnapshot({
    sessionId: 'claude-subset-session',
    requestTools: [bashTool, writeTool],
    hasManagedToolHistory: false,
    historyToolNames: [],
    sessionCatalogPolicy: 'restore-only-when-empty',
  })

  const second = store.resolveSnapshot({
    sessionId: 'claude-subset-session',
    requestTools: [bashTool],
    hasManagedToolHistory: true,
    historyToolNames: [],
    sessionCatalogPolicy: 'restore-only-when-empty',
  })

  assert.equal(second.blocked, false)
  assert.equal(second.diagnostics.source, 'current_request')
  assert.deepEqual(second.diagnostics.driftKinds, ['removed_tool'])
  assert.deepEqual(second.snapshot?.allowedToolNames, ['bash'])
})

test('schema changes for historical tools block', () => {
  const store = createToolCatalogStore()
  store.resolveSnapshot({
    sessionId: 's1',
    requestTools: [bashTool],
    hasManagedToolHistory: false,
    historyToolNames: [],
  })

  const changedBash: NormalizedToolDefinition = {
    ...bashTool,
    parameters: { type: 'object', properties: { command: { type: 'string' } } },
  }
  const result = store.resolveSnapshot({
    sessionId: 's1',
    requestTools: [changedBash],
    hasManagedToolHistory: true,
    historyToolNames: ['bash'],
  })

  assert.equal(result.blocked, true)
  assert.deepEqual(result.diagnostics.driftKinds, ['schema_changed'])
  assert.equal(result.diagnostics.reason, 'historical_tool_schema_changed')
})

test('request-scoped resolution works without a session id and falls back to history', () => {
  const store = createToolCatalogStore()
  const first = store.resolveSnapshot({
    sessionId: null,
    requestTools: [bashTool],
    hasManagedToolHistory: false,
    historyToolNames: [],
  })
  const second = store.resolveSnapshot({
    sessionId: null,
    requestTools: [],
    hasManagedToolHistory: true,
    historyToolNames: ['bash'],
  })

  assert.equal(first.blocked, false)
  assert.equal(first.snapshot?.sessionId, null)
  assert.equal(second.blocked, false)
  assert.equal(second.snapshot?.source, 'restored_from_history')
  assert.deepEqual(second.snapshot?.allowedToolNames, ['bash'])
})

test('resolveToolCatalog uses the shared singleton store', () => {
  const first = resolveToolCatalog({
    sessionId: 'singleton-test',
    requestTools: [bashTool],
    hasManagedToolHistory: false,
    historyToolNames: [],
  })
  const second = resolveToolCatalog({
    sessionId: 'singleton-test',
    requestTools: [],
    hasManagedToolHistory: true,
    historyToolNames: ['bash'],
  })

  assert.equal(second.snapshot?.fingerprint, first.snapshot?.fingerprint)
})

test('blocked resolution fingerprint matches returned snapshot fingerprint', () => {
  const store = createToolCatalogStore()
  store.resolveSnapshot({
    sessionId: 'fingerprint-consistency',
    requestTools: [bashTool],
    hasManagedToolHistory: false,
    historyToolNames: [],
  })

  const changedBash: NormalizedToolDefinition = {
    ...bashTool,
    parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
  }
  const blocked = store.resolveSnapshot({
    sessionId: 'fingerprint-consistency',
    requestTools: [changedBash],
    hasManagedToolHistory: true,
    historyToolNames: ['bash'],
  })

  assert.equal(blocked.blocked, true)
  assert.equal(
    blocked.diagnostics.fingerprint,
    blocked.snapshot?.fingerprint,
    'Blocked resolution must have consistent fingerprint between snapshot and diagnostics',
  )
})
