# Tool Availability Catalog Phase 1: ToolCatalogStore Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this phase task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Source Spec:** [`docs/superpowers/specs/2026-06-30-tool-availability-catalog-design.md`](../specs/2026-06-30-tool-availability-catalog-design.md)

**Parent Index:** [`docs/superpowers/plans/2026-06-30-tool-availability-catalog.md`](./2026-06-30-tool-availability-catalog.md)

## Phase Isolation Rule

- This document contains only Phase 1: ToolCatalogStore Core.
- Do not implement files or steps from other Phase 7 plan documents while executing or validating this phase.
- If working tree changes from another phase already exist, leave them unvalidated until their own phase review.

### Task 1: ToolCatalogStore Core

**Files:**
- Create: `tests/tool-calling/tool-catalog.test.ts`
- Create: `src/main/proxy/toolCalling/catalog.ts`
- Modify: `src/main/proxy/toolCalling/types.ts`

- [ ] **Step 1: Write failing catalog tests**

Create `tests/tool-calling/tool-catalog.test.ts`:

```ts
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

  const before = result.snapshot!.allowedToolNames
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
})

test('omitted tools with managed history and no catalog block', () => {
  const result = createToolCatalogStore().resolveSnapshot({
    sessionId: 's-missing',
    requestTools: [],
    hasManagedToolHistory: true,
    historyToolNames: ['bash'],
  })

  assert.equal(result.blocked, true)
  assert.equal(result.snapshot, undefined)
  assert.deepEqual(result.diagnostics.driftKinds, ['missing_current_tools_without_catalog'])
  assert.equal(result.diagnostics.reason, 'managed_history_requires_catalog')
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

test('request-scoped resolution works without a session id but does not persist', () => {
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
  assert.equal(second.blocked, true)
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
```

- [ ] **Step 2: Run the failing catalog tests**

Run:

```powershell
node --test tests/tool-calling/tool-catalog.test.ts
```

Expected: FAIL with module resolution error for `src/main/proxy/toolCalling/catalog.ts`.

- [ ] **Step 3: Extend shared tool-calling types**

Modify `src/main/proxy/toolCalling/types.ts` by adding these exports after `NormalizedToolResult`:

```ts
export type ToolCatalogSource = 'current_request' | 'session_catalog' | 'none'

export type ToolCatalogDriftKind =
  | 'added_tool'
  | 'removed_tool'
  | 'schema_changed'
  | 'missing_current_tools_with_session_catalog'
  | 'missing_current_tools_without_catalog'
  | 'history_references_unknown_tool'

export interface ToolCatalogSnapshot {
  sessionId: string | null
  fingerprint: string
  tools: NormalizedToolDefinition[]
  allowedToolNames: string[]
  schemaHashes: Record<string, string>
  source: 'current_request' | 'session_catalog'
  createdTurnIndex: number
  updatedTurnIndex: number
}

export interface ToolCatalogDiagnostics {
  source: ToolCatalogSource
  fingerprint?: string
  driftKinds: ToolCatalogDriftKind[]
  blocked: boolean
  reason?: string
}
```

Then extend `ToolCallDiagnostics`:

```ts
  catalogSource?: ToolCatalogSource
  catalogFingerprint?: string
  catalogDriftKinds?: ToolCatalogDriftKind[]
  catalogBlocked?: boolean
```

Then extend `ToolCallingPlan`:

```ts
  catalogSnapshot?: ToolCatalogSnapshot
  catalogDiagnostics: ToolCatalogDiagnostics
  availabilityRetryAllowed: boolean
  availabilityRetryAttempted?: boolean
```

- [ ] **Step 4: Implement ToolCatalogStore**

Create `src/main/proxy/toolCalling/catalog.ts`:

```ts
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

interface StoredCatalog {
  snapshot: ToolCatalogSnapshot
  turnIndex: number
}

export interface ToolCatalogStore {
  resolveSnapshot(input: ToolCatalogResolveInput): ToolCatalogResolution
  clearSession(sessionId: string): void
}

export function createToolCatalogStore(): ToolCatalogStore {
  const sessions = new Map<string, StoredCatalog>()
  let requestTurnIndex = 0

  function resolveSnapshot(input: ToolCatalogResolveInput): ToolCatalogResolution {
    const requestTools = normalizeTools(input.requestTools)
    const historyToolNames = [...new Set(input.historyToolNames)].sort()
    const existing = input.sessionId ? sessions.get(input.sessionId) : undefined

    if (requestTools.length === 0) {
      if (existing) {
        const snapshot = freezeSnapshot({
          ...existing.snapshot,
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

    const nextBase = buildSnapshot({
      sessionId: input.sessionId,
      tools: requestTools,
      source: 'current_request',
      createdTurnIndex: existing?.snapshot.createdTurnIndex ?? ++requestTurnIndex,
      updatedTurnIndex: ++requestTurnIndex,
    })
    const driftKinds = classifyDrift(existing?.snapshot, nextBase, historyToolNames)
    const blockReason = getBlockReason(driftKinds, existing?.snapshot, nextBase, historyToolNames)

    if (blockReason) {
      return {
        snapshot: existing?.snapshot,
        blocked: true,
        diagnostics: {
          source: existing ? 'session_catalog' : 'current_request',
          fingerprint: existing?.snapshot.fingerprint,
          driftKinds,
          blocked: true,
          reason: blockReason,
        },
      }
    }

    if (input.sessionId) {
      sessions.set(input.sessionId, { snapshot: nextBase, turnIndex: nextBase.updatedTurnIndex })
    }

    return {
      snapshot: nextBase,
      blocked: false,
      diagnostics: {
        source: 'current_request',
        fingerprint: nextBase.fingerprint,
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
      parameters: cloneRecord(tool.parameters),
      source: tool.source,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
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

function freezeSnapshot(snapshot: ToolCatalogSnapshot): ToolCatalogSnapshot {
  const tools = snapshot.tools.map((tool) => Object.freeze({
    ...tool,
    parameters: deepFreeze(cloneRecord(tool.parameters)),
  }))
  return Object.freeze({
    ...snapshot,
    tools: Object.freeze(tools) as unknown as NormalizedToolDefinition[],
    allowedToolNames: Object.freeze([...snapshot.allowedToolNames]) as unknown as string[],
    schemaHashes: Object.freeze({ ...snapshot.schemaHashes }),
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
  const historyNames = new Set(historyToolNames)
  if (driftKinds.includes('history_references_unknown_tool')) return 'history_references_unknown_tool'

  if (driftKinds.includes('removed_tool') && previous) {
    const nextNames = new Set(next.allowedToolNames)
    if (previous.allowedToolNames.some((name) => !nextNames.has(name) && historyNames.has(name))) {
      return 'historical_tool_removed'
    }
  }

  if (driftKinds.includes('schema_changed') && previous) {
    for (const name of next.allowedToolNames) {
      if (historyNames.has(name) && previous.schemaHashes[name] !== next.schemaHashes[name]) {
        return 'historical_tool_schema_changed'
      }
    }
  }

  return undefined
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value ?? {}))
}

function hashStable(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(stableStringify(value))
    .digest('hex')
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested)
    }
  }
  return value
}
```

- [ ] **Step 5: Run catalog tests**

Run:

```powershell
node --test tests/tool-calling/tool-catalog.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit catalog core**

```powershell
git add src/main/proxy/toolCalling/types.ts src/main/proxy/toolCalling/catalog.ts tests/tool-calling/tool-catalog.test.ts
git commit -m "feat: add tool catalog snapshots"
```

---
