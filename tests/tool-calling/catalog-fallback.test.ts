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
    properties: { command: { type: 'string' } },
    required: ['command'],
  },
  source: 'openai',
}

const writeTool: NormalizedToolDefinition = {
  name: 'write',
  description: 'Write a file',
  parameters: {
    type: 'object',
    properties: { filePath: { type: 'string' } },
    required: ['filePath'],
  },
  source: 'openai',
}

test('session miss with managed history restores tools from history tool names', () => {
  const result = createToolCatalogStore().resolveSnapshot({
    sessionId: 'new-session',
    requestTools: [],
    hasManagedToolHistory: true,
    historyToolNames: ['bash', 'write'],
  })

  assert.equal(result.blocked, false)
  assert.equal(result.snapshot?.source, 'restored_from_history')
  assert.deepEqual(result.snapshot?.allowedToolNames, ['bash', 'write'])
  assert.ok(result.diagnostics.driftKinds.includes('restored_from_history'))
})

test('restored snapshot provides stub tool definitions from names', () => {
  const result = createToolCatalogStore().resolveSnapshot({
    sessionId: 'stub-session',
    requestTools: [],
    hasManagedToolHistory: true,
    historyToolNames: ['bash'],
  })

  assert.equal(result.blocked, false)
  assert.ok(result.snapshot !== undefined)
  assert.equal(result.snapshot.tools.length, 1)
  assert.equal(result.snapshot.tools[0].name, 'bash')
  assert.equal(result.snapshot.tools[0].source, 'openai')
})

test('restored snapshot has stable fingerprint', () => {
  const store = createToolCatalogStore()
  const first = store.resolveSnapshot({
    sessionId: 'stable-session',
    requestTools: [],
    hasManagedToolHistory: true,
    historyToolNames: ['bash', 'write'],
  })
  const second = store.resolveSnapshot({
    sessionId: 'stable-session',
    requestTools: [],
    hasManagedToolHistory: true,
    historyToolNames: ['bash', 'write'],
  })

  assert.equal(first.blocked, false)
  assert.equal(second.blocked, false)
  assert.equal(first.snapshot?.fingerprint, second.snapshot?.fingerprint)
})

test('stub schema uses additionalProperties:true to avoid rejecting historical args', () => {
  const result = createToolCatalogStore().resolveSnapshot({
    sessionId: 'schema-safe',
    requestTools: [],
    hasManagedToolHistory: true,
    historyToolNames: ['bash'],
  })

  const stubSchema = result.snapshot!.tools[0].parameters
  assert.deepEqual(stubSchema, { type: 'object', additionalProperties: true })
})

test('restored snapshot promotes to session store for subsequent turns', () => {
  const store = createToolCatalogStore()
  const first = store.resolveSnapshot({
    sessionId: 'promote-session',
    requestTools: [],
    hasManagedToolHistory: true,
    historyToolNames: ['bash'],
  })

  assert.equal(first.snapshot?.source, 'restored_from_history')

  // Second turn with same session: should find existing catalog, not restore again
  const second = store.resolveSnapshot({
    sessionId: 'promote-session',
    requestTools: [],
    hasManagedToolHistory: true,
    historyToolNames: ['bash'],
  })

  assert.equal(second.blocked, false)
  assert.equal(second.diagnostics.source, 'session_catalog',
    'Second turn should reuse session catalog, not restore from history again')
  assert.equal(second.snapshot?.fingerprint, first.snapshot?.fingerprint)
})

test('session catalog keeps full tool set even when later history only mentions one tool', () => {
  const store = createToolCatalogStore()
  const first = store.resolveSnapshot({
    sessionId: 'full-catalog-session',
    requestTools: [bashTool, writeTool],
    hasManagedToolHistory: false,
    historyToolNames: [],
  })

  const second = store.resolveSnapshot({
    sessionId: 'full-catalog-session',
    requestTools: [],
    hasManagedToolHistory: true,
    historyToolNames: ['bash'],
  })

  assert.equal(first.blocked, false)
  assert.equal(second.blocked, false)
  assert.equal(second.diagnostics.source, 'session_catalog')
  assert.deepEqual(second.snapshot?.allowedToolNames, ['bash', 'write'])
  assert.equal(second.snapshot?.tools.find((tool) => tool.name === 'write')?.description, writeTool.description)
})

test('history-only recovery cannot restore unobserved tools from an earlier full tool list', () => {
  const result = createToolCatalogStore().resolveSnapshot({
    sessionId: 'history-only-subset',
    requestTools: [],
    hasManagedToolHistory: true,
    historyToolNames: ['bash'],
  })

  assert.equal(result.blocked, false)
  assert.equal(result.diagnostics.source, 'restored_from_history')
  assert.deepEqual(result.snapshot?.allowedToolNames, ['bash'])
  assert.equal(
    result.snapshot?.allowedToolNames.includes('write'),
    false,
    'Without a session catalog or current request tools, the fallback only sees tools already present in history',
  )
})

test('session miss without managed history and without tools returns no_tools (not blocked)', () => {
  const result = createToolCatalogStore().resolveSnapshot({
    sessionId: 'no-history',
    requestTools: [],
    hasManagedToolHistory: false,
    historyToolNames: [],
  })

  assert.equal(result.blocked, false)
  assert.equal(result.snapshot, undefined)
  assert.equal(result.diagnostics.reason, 'no_tools')
})
