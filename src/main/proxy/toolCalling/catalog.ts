import crypto from 'crypto'

import type {
  NormalizedToolDefinition,
  ToolCatalogDiagnostics,
  ToolCatalogDriftKind,
  ToolCatalogSnapshot,
} from './types.ts'

export interface ToolCatalogResolveInput {
  sessionId: string | null
  requestTools: NormalizedToolDefinition[]
  hasManagedToolHistory: boolean
  historyToolNames: string[]
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

export function createToolCatalogStore(): ToolCatalogStore {
  const sessions = new Map<string, StoredCatalog>()
  let turnCounter = 0

  function resolveSnapshot(input: ToolCatalogResolveInput): ToolCatalogResolution {
    const requestTools = normalizeTools(input.requestTools)
    const historyToolNames = canonicalToolNames(input.historyToolNames)
    const existing = input.sessionId ? sessions.get(input.sessionId)?.snapshot : undefined

    if (requestTools.length === 0) {
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

      if (input.hasManagedToolHistory) {
        return {
          blocked: true,
          diagnostics: {
            source: 'none',
            driftKinds: ['missing_current_tools_without_catalog'],
            blocked: true,
            reason: 'managed_history_requires_catalog',
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

    if (input.sessionId) {
      sessions.set(input.sessionId, { snapshot: nextSnapshot })
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
    },
  }
}

export const toolCatalogStore = createToolCatalogStore()

export function resolveToolCatalog(input: ToolCatalogResolveInput): ToolCatalogResolution {
  return toolCatalogStore.resolveSnapshot(input)
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
  source: 'current_request' | 'session_catalog'
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
    return 'history_references_unknown_tool'
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
