import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { createToolCatalogStore, type ToolCatalogStore } from '../../src/main/proxy/toolCalling/catalog.ts'
import { createFileCatalogPersistence } from '../../src/main/proxy/toolCalling/catalogPersistence.ts'
import type { NormalizedToolDefinition, ToolCatalogResolveInput } from '../../src/main/proxy/toolCalling/types.ts'

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

const tempDirs: string[] = []

after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-persist-'))
  tempDirs.push(dir)
  return path.join(dir, 'tool-catalogs.json')
}

function createPersistedStore(filePath: string): ToolCatalogStore {
  return createToolCatalogStore(createFileCatalogPersistence(filePath))
}

test('persisted catalog survives store recreation (simulates app restart)', () => {
  const filePath = tempFile()

  // First "app session": build catalog
  const store1 = createPersistedStore(filePath)
  store1.resolveSnapshot({
    sessionId: 's-restart',
    requestTools: [bashTool, writeTool],
    hasManagedToolHistory: false,
    historyToolNames: [],
  })

  // Simulate restart: new store instance reads from same file
  const store2 = createPersistedStore(filePath)
  const result = store2.resolveSnapshot({
    sessionId: 's-restart',
    requestTools: [],
    hasManagedToolHistory: true,
    historyToolNames: ['bash', 'write'],
  })

  assert.equal(result.blocked, false)
  assert.equal(result.snapshot?.source, 'session_catalog')
  assert.equal(result.snapshot!.tools.length, 2)
  assert.equal(result.snapshot!.tools[0].name, 'bash')
  assert.equal(result.snapshot!.tools[0].description, 'Run a shell command')
  assert.equal(result.snapshot!.tools[1].name, 'write')
  assert.equal(result.snapshot!.tools[1].description, 'Write a file')
})

test('restored_from_history is still the fallback when no persisted state exists', () => {
  const filePath = tempFile()
  const store = createPersistedStore(filePath)

  const result = store.resolveSnapshot({
    sessionId: 's-never-seen',
    requestTools: [],
    hasManagedToolHistory: true,
    historyToolNames: ['bash'],
  })

  assert.equal(result.blocked, false)
  assert.equal(result.diagnostics.source, 'restored_from_history')
  assert.equal(result.snapshot!.tools[0].name, 'bash')
  assert.equal(result.snapshot!.tools[0].description, '')
})

test('clearSession removes from both memory and disk', () => {
  const filePath = tempFile()

  const store1 = createPersistedStore(filePath)
  store1.resolveSnapshot({
    sessionId: 's-clear',
    requestTools: [bashTool],
    hasManagedToolHistory: false,
    historyToolNames: [],
  })
  store1.clearSession('s-clear')

  // New store instance should not find the cleared session
  const store2 = createPersistedStore(filePath)
  const result = store2.resolveSnapshot({
    sessionId: 's-clear',
    requestTools: [],
    hasManagedToolHistory: true,
    historyToolNames: ['bash'],
  })

  assert.equal(result.diagnostics.source, 'restored_from_history')
})

test('persisted tools carry full parameter schemas after restart', () => {
  const filePath = tempFile()

  const store1 = createPersistedStore(filePath)
  store1.resolveSnapshot({
    sessionId: 's-schema',
    requestTools: [bashTool],
    hasManagedToolHistory: false,
    historyToolNames: [],
  })

  const store2 = createPersistedStore(filePath)
  const result = store2.resolveSnapshot({
    sessionId: 's-schema',
    requestTools: [],
    hasManagedToolHistory: true,
    historyToolNames: ['bash'],
  })

  const tool = result.snapshot!.tools[0]
  assert.equal(tool.description, 'Run a shell command')
  assert.equal(tool.parameters.type, 'object')
  assert.ok(tool.parameters.properties)
  assert.deepEqual(tool.parameters.required, ['argument'])
})
