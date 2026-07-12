import crypto from 'crypto'
import path from 'path'

import { createFileCatalogPersistence } from './catalogPersistence.ts'

import type {
  NormalizedToolDefinition,
  SessionCatalogPolicy,
  ToolCatalogDiagnostics,
  ToolCatalogDriftKind,
  ToolCatalogSnapshot,
} from './types.ts'
import type { CatalogPersistenceStore } from './catalogPersistence.ts'

export interface ToolCatalogResolveInput {
  sessionId: string | null
  requestTools: NormalizedToolDefinition[]
  promptEmbeddedTools?: NormalizedToolDefinition[]
  hasManagedToolHistory: boolean
  historyToolNames: string[]
  sessionCatalogPolicy?: SessionCatalogPolicy
}

export interface ToolCatalogResolution {
  snapshot?: ToolCatalogSnapshot
  diagnostics: ToolCatalogDiagnostics
  blocked: boolean
}

export interface ToolCatalogStore {
  resolveSnapshot(input: ToolCatalogResolveInput): ToolCatalogResolution
  clearSession(sessionId: string): void
}

interface StoredCatalog {
  snapshot: ToolCatalogSnapshot
}

export function createToolCatalogStore(persistence?: CatalogPersistenceStore): ToolCatalogStore {
  const sessions = new Map<string, StoredCatalog>()
  let turnCounter = 0

  // Hydrate from disk on construction
  if (persistence) {
    for (const [sessionId, snapshot] of persistence.loadAll()) {
      sessions.set(sessionId, { snapshot })
    }
  }

  function resolveSnapshot(input: ToolCatalogResolveInput): ToolCatalogResolution {
    const requestTools = normalizeTools(input.requestTools)
    const historyToolNames = canonicalToolNames(input.historyToolNames)
    const existing = input.sessionId ? sessions.get(input.sessionId)?.snapshot : undefined
    const sessionCatalogPolicy = input.sessionCatalogPolicy ?? 'reuse-subset-ok'

    if (requestTools.length === 0) {
      // Session catalog wins for later turns of the same session
      if (existing) {
        const snapshot = freezeSnapshot({
          ...existing,
          source: 'session_catalog',
        })
        return {
          snapshot,
          blocked: false,
          diagnostics: {
            source: 'session_catalog',
            fingerprint: snapshot.fingerprint,
            driftKinds: ['missing_current_tools_with_session_catalog'],
            blocked: false,
          },
        }
      }

      // Prompt-embedded catalog: client inlined tools in system prompt text
      const embeddedTools = input.promptEmbeddedTools ? normalizeTools(input.promptEmbeddedTools) : []
      if (embeddedTools.length > 0) {
        const snapshot = buildSnapshot({
          sessionId: input.sessionId,
          tools: embeddedTools,
          source: 'prompt_embedded',
          createdTurnIndex: ++turnCounter,
          updatedTurnIndex: ++turnCounter,
        })
        if (input.sessionId) {
          sessions.set(input.sessionId, { snapshot })
          persistence?.save(input.sessionId, snapshot)
        }
        return {
          snapshot,
          blocked: false,
          diagnostics: {
            source: 'prompt_embedded',
            fingerprint: snapshot.fingerprint,
            driftKinds: ['prompt_embedded_only_catalog'],
            blocked: false,
          },
        }
      }

      if (input.hasManagedToolHistory && input.historyToolNames.length > 0) {
        const stubTools: NormalizedToolDefinition[] = input.historyToolNames.map((name) => ({
          name,
          description: '',
          parameters: { type: 'object', additionalProperties: true },
          source: 'openai' as const,
        }))
        const snapshot = buildSnapshot({
          sessionId: input.sessionId,
          tools: stubTools,
          source: 'restored_from_history',
          createdTurnIndex: ++turnCounter,
          updatedTurnIndex: ++turnCounter,
        })
        if (input.sessionId) {
          sessions.set(input.sessionId, { snapshot })
          persistence?.save(input.sessionId, snapshot)
        }
        return {
          snapshot,
          blocked: false,
          diagnostics: {
            source: 'restored_from_history',
            fingerprint: snapshot.fingerprint,
            driftKinds: ['restored_from_history'],
            blocked: false,
          },
        }
      }

      return {
        blocked: false,
        diagnostics: {
          source: 'none',
          driftKinds: [],
          blocked: false,
          reason: 'no_tools',
        },
      }
    }

    const nextSnapshot = buildSnapshot({
      sessionId: input.sessionId,
      tools: requestTools,
      source: 'current_request',
      createdTurnIndex: existing?.createdTurnIndex ?? ++turnCounter,
      updatedTurnIndex: ++turnCounter,
    })
    const driftKinds = classifyDrift(existing, nextSnapshot, historyToolNames)
    const blockReason = getBlockReason(driftKinds, existing, nextSnapshot, historyToolNames)

    if (blockReason) {
      return {
        snapshot: existing,
        blocked: true,
        diagnostics: {
          source: existing ? 'session_catalog' : 'current_request',
          fingerprint: existing?.fingerprint,
          driftKinds,
          blocked: true,
          reason: blockReason,
        },
      }
    }

    if (shouldReuseSessionCatalog(existing, nextSnapshot, sessionCatalogPolicy)) {
      const snapshot = freezeSnapshot({
        ...existing,
        source: 'session_catalog',
      })
      return {
        snapshot,
        blocked: false,
        diagnostics: {
          source: 'session_catalog',
          fingerprint: snapshot.fingerprint,
          driftKinds: ['current_request_subset_of_session_catalog'],
          blocked: false,
        },
      }
    }

    if (input.sessionId) {
      sessions.set(input.sessionId, { snapshot: nextSnapshot })
      persistence?.save(input.sessionId, nextSnapshot)
    }

    return {
      snapshot: nextSnapshot,
      blocked: false,
      diagnostics: {
        source: 'current_request',
        fingerprint: nextSnapshot.fingerprint,
        driftKinds,
        blocked: false,
      },
    }
  }

  return {
    resolveSnapshot,
    clearSession(sessionId: string) {
      sessions.delete(sessionId)
      persistence?.delete(sessionId)
    },
  }
}

let persistedStore: ToolCatalogStore | undefined

export function getPersistedToolCatalogStore(userDataPath: string): ToolCatalogStore {
  if (!persistedStore) {
    const filePath = path.join(userDataPath, 'tool-catalogs.json')
    persistedStore = createToolCatalogStore(createFileCatalogPersistence(filePath))
  }
  return persistedStore
}

let toolCatalogStore: ToolCatalogStore = createToolCatalogStore()

export function initPersistedCatalogStore(userDataPath: string): void {
  try {
    toolCatalogStore = getPersistedToolCatalogStore(userDataPath)
  } catch (err) {
    console.error('Failed to initialize persisted catalog store, using in-memory:', err)
  }
}

export function resolveToolCatalog(input: ToolCatalogResolveInput): ToolCatalogResolution {
  return toolCatalogStore.resolveSnapshot(input)
}

export function __resetCatalogStoreForTest(newStore?: ToolCatalogStore): void {
  toolCatalogStore = newStore ?? createToolCatalogStore()
}

function normalizeTools(tools: NormalizedToolDefinition[]): NormalizedToolDefinition[] {
  return tools
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: cloneJson(tool.parameters),
      source: tool.source,
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function canonicalToolNames(names: string[]): string[] {
  return [...new Set(names)].sort()
}

function buildSnapshot(input: {
  sessionId: string | null
  tools: NormalizedToolDefinition[]
  source: 'current_request' | 'session_catalog' | 'prompt_embedded' | 'restored_from_history'
  createdTurnIndex: number
  updatedTurnIndex: number
}): ToolCatalogSnapshot {
  const schemaHashes = Object.fromEntries(
    input.tools.map((tool) => [tool.name, hashStable(tool.parameters)]),
  )
  const allowedToolNames = input.tools.map((tool) => tool.name)
  const fingerprint = hashStable({
    tools: input.tools.map((tool) => ({
      name: tool.name,
      source: tool.source,
      schemaHash: schemaHashes[tool.name],
    })),
    allowedToolNames,
  })

  return freezeSnapshot({
    sessionId: input.sessionId,
    fingerprint,
    tools: input.tools,
    allowedToolNames,
    schemaHashes,
    source: input.source,
    createdTurnIndex: input.createdTurnIndex,
    updatedTurnIndex: input.updatedTurnIndex,
  })
}

function classifyDrift(
  previous: ToolCatalogSnapshot | undefined,
  next: ToolCatalogSnapshot,
  historyToolNames: string[],
): ToolCatalogDriftKind[] {
  if (!previous) return []

  const driftKinds = new Set<ToolCatalogDriftKind>()
  const previousNames = new Set(previous.allowedToolNames)
  const nextNames = new Set(next.allowedToolNames)

  for (const name of nextNames) {
    if (!previousNames.has(name)) driftKinds.add('added_tool')
  }

  for (const name of previousNames) {
    if (!nextNames.has(name)) driftKinds.add('removed_tool')
  }

  for (const name of nextNames) {
    if (previousNames.has(name) && previous.schemaHashes[name] !== next.schemaHashes[name]) {
      driftKinds.add('schema_changed')
    }
  }

  for (const name of historyToolNames) {
    if (!previousNames.has(name) && !nextNames.has(name)) {
      driftKinds.add('history_references_unknown_tool')
    }
  }

  return [...driftKinds]
}

function getBlockReason(
  driftKinds: ToolCatalogDriftKind[],
  previous: ToolCatalogSnapshot | undefined,
  next: ToolCatalogSnapshot,
  historyToolNames: string[],
): string | undefined {
  if (driftKinds.includes('history_references_unknown_tool')) {
    const unknownNames = historyToolNames.filter(
      (name) => !previous?.allowedToolNames.includes(name) && !next.allowedToolNames.includes(name),
    )
    console.warn(
      `[catalog] History references unknown tool names, not blocking catalog update. ` +
      `Unknown names: [${unknownNames.join(', ')}]`,
    )
    // Warn only — don't block catalog update
  }

  if (driftKinds.includes('removed_tool')) {
    const nextNames = new Set(next.allowedToolNames)
    if (historyToolNames.some((name) => !nextNames.has(name))) {
      return 'historical_tool_removed'
    }
  }

  if (driftKinds.includes('schema_changed') && previous) {
    for (const name of historyToolNames) {
      if (previous.schemaHashes[name] && previous.schemaHashes[name] !== next.schemaHashes[name]) {
        return 'historical_tool_schema_changed'
      }
    }
  }

  return undefined
}

function shouldReuseSessionCatalog(
  previous: ToolCatalogSnapshot | undefined,
  next: ToolCatalogSnapshot,
  policy: SessionCatalogPolicy,
): boolean {
  if (!previous) return false
  if (policy !== 'reuse-subset-ok') return false
  if (next.allowedToolNames.length >= previous.allowedToolNames.length) return false

  for (const tool of next.tools) {
    if (!previous.allowedToolNames.includes(tool.name)) return false
    if (previous.schemaHashes[tool.name] !== next.schemaHashes[tool.name]) return false
  }

  return true
}

function freezeSnapshot(snapshot: ToolCatalogSnapshot): ToolCatalogSnapshot {
  const tools = snapshot.tools.map((tool) => Object.freeze({
    ...tool,
    parameters: deepFreeze(cloneJson(tool.parameters)),
  }))

  return Object.freeze({
    ...snapshot,
    tools: Object.freeze(tools),
    allowedToolNames: Object.freeze([...snapshot.allowedToolNames]),
    schemaHashes: Object.freeze({ ...snapshot.schemaHashes }),
  })
}

function hashStable(value: unknown): string {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex')
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function cloneJson<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object') return value

  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child)
  }
  return value
}
