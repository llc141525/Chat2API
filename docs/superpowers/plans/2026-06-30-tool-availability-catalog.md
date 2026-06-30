# Tool Availability Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-turn immutable tool availability catalog so managed tool sessions stop losing tools such as `bash` and `write` across multi-turn conversations.

**Architecture:** Add `ToolCatalogStore` as the single source of tool availability truth outside `sessionManager`, then route `runtimePlan`, prompt rendering, validation, availability retry, and diagnostics through one immutable `ToolCatalogSnapshot` per tool turn. Keep OpenAI-compatible client boundaries and keep managed XML as the provider prompt protocol for the existing Qwen/GLM/Qwen AI path.

**Tech Stack:** TypeScript, Electron main process, Node.js built-in test runner (`node --test`), existing Chat2API `toolCalling` and `toolRuntime` modules.

---

## Source Spec

Implement [`docs/superpowers/specs/2026-06-30-tool-availability-catalog-design.md`](../specs/2026-06-30-tool-availability-catalog-design.md).

Hard invariant to preserve in every task:

- `ToolCatalogSnapshot` is immutable within one tool turn execution.
- Any catalog change creates a new snapshot with a new fingerprint.
- Prompt rendering, validation, protocol mapping, availability drift detection, retry, and response assembly for one turn must all reference the same snapshot fingerprint.

## Scope

This plan implements:

- `ToolCatalogStore`
- catalog normalization, schema hashes, fingerprints, and drift classification
- `ToolCallingPlan` snapshot fields
- removal of prompt-history tool-name reconstruction as an availability truth source
- managed XML `Tool Contract Header`
- one-shot availability drift retry for non-streaming responses
- structure-only diagnostics events
- deterministic regression tests

This plan intentionally does not implement:

- LiteLLM quality routing
- provider account scoring
- full provider protocol replacement
- native OpenAI tool execution inside Chat2API
- semantic repair, semantic retry, or automatic tool-call generation
- streaming availability retry

## File Structure

- Create: `src/main/proxy/toolCalling/catalog.ts`
  - Owns `ToolCatalogStore`, immutable snapshots, canonical hashes, drift classification, and exported singleton store.
- Create: `src/main/proxy/toolCalling/availabilityDrift.ts`
  - Owns narrow text-only availability drift detection and retry eligibility.
- Modify: `src/main/proxy/toolCalling/types.ts`
  - Adds catalog snapshot and diagnostic fields to `ToolCallingPlan` and `ToolCallDiagnostics`.
- Modify: `src/main/proxy/toolCalling/runtimePlan.ts`
  - Resolves catalog snapshots before planning and stops reconstructing tool definitions from old prompt text.
- Modify: `src/main/proxy/toolCalling/providerProfiles.ts`
  - Adds provider profile contract header version and availability retry capability.
- Modify: `src/main/proxy/toolCalling/protocols/managedXml.ts`
  - Renders the `Tool Contract Header` from the selected snapshot.
- Modify: `src/main/proxy/toolCalling/ToolCallingEngine.ts`
  - Passes session/request catalog identity into planning, renders prompts from the snapshot, validates against snapshot tools, and applies one-shot non-streaming availability retry hook.
- Modify: `src/main/proxy/forwarder.ts`
  - Supplies a stable catalog session key from provider/account/model identity and keeps catalog outside `sessionManager`.
- Modify: `src/main/proxy/toolCalling/diagnostics.ts`
  - Adds structure-only tool catalog diagnostic event recording.
- Test: `tests/tool-calling/tool-catalog.test.ts`
  - Catalog normalization, fingerprints, drift classification, and immutability.
- Test: `tests/tool-calling/runtime-plan.test.ts`
  - Planner catalog reuse/blocking and removal of prompt-history reconstruction.
- Test: `tests/tool-calling/provider-profiles.test.ts`
  - Provider profile contract/retry defaults.
- Test: `tests/tool-calling/tool-engine.test.ts`
  - Prompt header injection, same-fingerprint validation, and non-streaming availability retry.
- Test: `tests/tool-calling/tool-diagnostics.test.ts`
  - Structure-only diagnostics payloads.

## Shared Type Decisions

Add these types to `src/main/proxy/toolCalling/types.ts` or import them from `catalog.ts` where noted:

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

Extend `ToolCallingPlan`:

```ts
catalogSnapshot?: ToolCatalogSnapshot
catalogDiagnostics: ToolCatalogDiagnostics
availabilityRetryAllowed: boolean
availabilityRetryAttempted?: boolean
```

Extend `ToolCallDiagnostics`:

```ts
catalogSource?: ToolCatalogSource
catalogFingerprint?: string
catalogDriftKinds?: ToolCatalogDriftKind[]
catalogBlocked?: boolean
availabilityDriftDetected?: boolean
availabilityRetryResult?: 'skipped' | 'attempted' | 'succeeded' | 'failed'
```

---

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

### Task 2: RuntimePlan Catalog Resolution

**Files:**
- Modify: `src/main/proxy/toolCalling/runtimePlan.ts`
- Modify: `src/main/proxy/toolCalling/ToolCallingEngine.ts`
- Modify: `tests/tool-calling/runtime-plan.test.ts`
- Modify: `tests/tool-calling/tool-engine.test.ts`

- [ ] **Step 1: Add failing runtime plan tests for catalog reuse and blocking**

Append to `tests/tool-calling/runtime-plan.test.ts`:

```ts
test('catalog snapshot drives allowed tools when current request omits tools', () => {
  const sessionId = `runtime-catalog-${Date.now()}-reuse`
  const first = buildToolCallingRuntimePlan({
    requestId: 'catalog-1',
    providerId: 'qwen',
    actualModel: 'qwen3',
    toolSessionKey: sessionId,
    config: {
      enabled: true,
      mode: 'force',
      clientAdapterId: 'standard-openai-tools',
      diagnosticsEnabled: false,
      advanced: { promptPreviewEnabled: false },
    },
    clientRequest: {
      clientAdapterId: 'standard-openai-tools',
      toolSource: 'openai',
      tools,
      toolChoice: { mode: 'auto' },
      diagnostics: { rawToolCount: 1, normalizedToolNames: ['weather-test:get_weather'] },
    },
    messages: [{ role: 'user', content: 'weather' }],
  })
  const second = buildToolCallingRuntimePlan({
    requestId: 'catalog-2',
    providerId: 'qwen',
    actualModel: 'qwen3',
    toolSessionKey: sessionId,
    config: {
      enabled: true,
      mode: 'force',
      clientAdapterId: 'standard-openai-tools',
      diagnosticsEnabled: false,
      advanced: { promptPreviewEnabled: false },
    },
    clientRequest: {
      clientAdapterId: 'standard-openai-tools',
      toolSource: 'none',
      tools: [],
      toolChoice: { mode: 'auto' },
      diagnostics: { rawToolCount: 0, normalizedToolNames: [] },
    },
    messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather-test:get_weather', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
    ],
  })

  assert.equal(second.mode, 'managed')
  assert.equal(second.shouldInjectPrompt, true)
  assert.equal(second.catalogSnapshot?.source, 'session_catalog')
  assert.equal(second.catalogSnapshot?.fingerprint, first.catalogSnapshot?.fingerprint)
  assert.deepEqual([...second.allowedToolNames], ['weather-test:get_weather'])
})

test('managed history without request tools or catalog blocks instead of reconstructing prompt tool names', () => {
  assert.throws(() => buildToolCallingRuntimePlan({
    requestId: 'catalog-missing',
    providerId: 'qwen',
    actualModel: 'qwen3',
    toolSessionKey: `runtime-catalog-${Date.now()}-missing`,
    config: {
      enabled: true,
      mode: 'force',
      clientAdapterId: 'standard-openai-tools',
      diagnosticsEnabled: false,
      advanced: { promptPreviewEnabled: false },
    },
    clientRequest: {
      clientAdapterId: 'standard-openai-tools',
      toolSource: 'none',
      tools: [],
      toolChoice: { mode: 'auto' },
      diagnostics: { rawToolCount: 0, normalizedToolNames: [] },
    },
    messages: [{
      role: 'system',
      content: '<|CHAT2API|tool_calls><|CHAT2API|invoke name="bash"></|CHAT2API|tool_calls>',
    }],
  }), /managed_history_requires_catalog/)
})
```

- [ ] **Step 2: Run runtime plan tests to verify failure**

Run:

```powershell
node --test tests/tool-calling/runtime-plan.test.ts
```

Expected: FAIL because `toolSessionKey` is not accepted and catalog fields are absent.

- [ ] **Step 3: Update runtimePlan input and catalog resolution**

Modify `src/main/proxy/toolCalling/runtimePlan.ts`:

```ts
import { resolveToolCatalog } from './catalog.ts'
```

Add `toolSessionKey?: string | null` to `buildToolCallingRuntimePlan` input.

Replace the existing `tools`, `toolNames`, and `allowedTools` setup with:

```ts
  const requestTools = input.clientRequest.tools
  const forcedName = input.clientRequest.toolChoice.forcedName
  const hasManagedHistory = hasExistingManagedXmlContext(input.messages)
  const historyToolNames = extractHistoryToolNames(input.messages)
  const catalogResolution = resolveToolCatalog({
    sessionId: input.toolSessionKey ?? null,
    requestTools,
    hasManagedToolHistory: hasManagedHistory,
    historyToolNames,
  })

  if (catalogResolution.blocked) {
    throw new Error(catalogResolution.diagnostics.reason ?? 'tool_catalog_blocked')
  }

  const catalogSnapshot = catalogResolution.snapshot
  const catalogTools = catalogSnapshot?.tools ?? []
  const toolNames = new Set(catalogTools.map((tool) => tool.name))
```

Then keep forced-tool validation, but validate against `catalogTools`:

```ts
  if (input.clientRequest.toolChoice.mode === 'forced' && forcedName && !toolNames.has(forcedName)) {
    throw new Error(`Forced tool ${forcedName} is not declared`)
  }

  const allowedToolNames = forcedName ? new Set([forcedName]) : toolNames
  const allowedTools = forcedName ? catalogTools.filter((tool) => tool.name === forcedName) : catalogTools
```

Remove the old `effectiveTools` and `extractToolNamesFromMessages` fallback. The returned plan must use `allowedTools` and `allowedToolNames`:

```ts
    tools: allowedTools,
    allowedToolNames,
    catalogSnapshot,
    catalogDiagnostics: catalogResolution.diagnostics,
    availabilityRetryAllowed: profile.availabilityDriftRetry === 'enabled',
```

Add diagnostics fields:

```ts
      catalogSource: catalogResolution.diagnostics.source,
      catalogFingerprint: catalogSnapshot?.fingerprint,
      catalogDriftKinds: catalogResolution.diagnostics.driftKinds,
      catalogBlocked: catalogResolution.diagnostics.blocked,
```

Replace `extractToolNamesFromMessages` with:

```ts
const TOOL_CALL_NAME_REGEX = /"name"\s*:\s*"([^"]+)"/g
const MANAGED_INVOKE_NAME_REGEX = /<\|CHAT2API\|invoke\s+name="([^"]+)"/g

function extractHistoryToolNames(messages?: ChatMessage[]): string[] {
  if (!messages) return []
  const names = new Set<string>()

  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const call of msg.tool_calls) {
        if (call.function?.name) names.add(call.function.name)
      }
    }
    if (msg.role === 'system' && typeof msg.content === 'string') {
      collectRegexMatches(msg.content, MANAGED_INVOKE_NAME_REGEX, names)
    }
    if (msg.role === 'assistant' && typeof msg.content === 'string') {
      collectRegexMatches(msg.content, MANAGED_INVOKE_NAME_REGEX, names)
      collectRegexMatches(msg.content, TOOL_CALL_NAME_REGEX, names)
    }
  }

  return [...names].sort()
}

function collectRegexMatches(text: string, regex: RegExp, output: Set<string>): void {
  regex.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    output.add(match[1])
  }
}
```

- [ ] **Step 4: Update provider profile type for retry flag**

Modify `src/main/proxy/toolCalling/providerProfiles.ts`:

```ts
  contractHeaderVersion: number
  availabilityDriftRetry: 'enabled' | 'disabled'
```

Add to `chat2ApiXmlHistoryProfile`:

```ts
  contractHeaderVersion: 1,
  availabilityDriftRetry: 'enabled',
```

- [ ] **Step 5: Update ToolCallingEngine transform input**

Modify `src/main/proxy/toolCalling/ToolCallingEngine.ts` `transformRequest` input type:

```ts
    toolSessionKey?: string | null
```

Pass it into `buildToolCallingRuntimePlan`:

```ts
      toolSessionKey: input.toolSessionKey ?? input.requestId ?? null,
```

- [ ] **Step 6: Add ToolCallingEngine regression for no prompt reconstruction**

Append to `tests/tool-calling/tool-engine.test.ts`:

```ts
test('managed history without catalog is blocked instead of reconstructing tools from old prompt', () => {
  const engine = new ToolCallingEngine()

  assert.throws(() => engine.transformRequest({
    request: request({
      tools: undefined,
      messages: [{
        role: 'system',
        content: '<|CHAT2API|tool_calls><|CHAT2API|invoke name="bash"></|CHAT2API|tool_calls>',
      }],
    }),
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: `engine-catalog-${Date.now()}-missing`,
  }), /managed_history_requires_catalog/)
})
```

- [ ] **Step 7: Run focused tests**

Run:

```powershell
node --test tests/tool-calling/tool-catalog.test.ts tests/tool-calling/runtime-plan.test.ts tests/tool-calling/tool-engine.test.ts tests/tool-calling/provider-profiles.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit runtime plan integration**

```powershell
git add src/main/proxy/toolCalling/runtimePlan.ts src/main/proxy/toolCalling/ToolCallingEngine.ts src/main/proxy/toolCalling/providerProfiles.ts tests/tool-calling/runtime-plan.test.ts tests/tool-calling/tool-engine.test.ts
git commit -m "feat: plan tool turns from catalog snapshots"
```

---

### Task 3: Tool Contract Header Rendering

**Files:**
- Modify: `src/main/proxy/toolCalling/protocols/managedXml.ts`
- Modify: `src/main/proxy/toolCalling/ToolCallingEngine.ts`
- Modify: `tests/tool-calling/tool-engine.test.ts`
- Modify: `tests/tool-calling/provider-profiles.test.ts`

- [ ] **Step 1: Add failing prompt header test**

Append to `tests/tool-calling/tool-engine.test.ts`:

```ts
test('managed prompt includes Tool Contract Header from catalog snapshot', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: `engine-catalog-${Date.now()}-header`,
  })

  const content = result.messages[0].content as string
  assert.match(content, /Tool Contract Header/)
  assert.match(content, /contract_header_version: 1/)
  assert.match(content, new RegExp(`catalog_fingerprint: ${result.plan.catalogSnapshot?.fingerprint}`))
  assert.match(content, /allowed_tools: default_api:list_dir, default_api:read_file/)
  assert.match(content, /The tools listed in this contract are available for this turn/)
})
```

- [ ] **Step 2: Run the failing header test**

Run:

```powershell
node --test tests/tool-calling/tool-engine.test.ts
```

Expected: FAIL because the prompt does not contain `Tool Contract Header`.

- [ ] **Step 3: Add contract render input to managed XML protocol**

Modify `src/main/proxy/toolCalling/protocols/managedXml.ts` by adding:

```ts
export interface ManagedXmlContractHeaderInput {
  catalogFingerprint: string
  allowedToolNames: string[]
  protocol: string
  contractHeaderVersion: number
}

export function renderManagedXmlContractHeader(input: ManagedXmlContractHeaderInput): string {
  return [
    'Tool Contract Header',
    `contract_header_version: ${input.contractHeaderVersion}`,
    `protocol: ${input.protocol}`,
    `catalog_fingerprint: ${input.catalogFingerprint}`,
    `allowed_tools: ${input.allowedToolNames.join(', ')}`,
    'The tools listed in this contract are available for this turn because they were provided by the runtime.',
  ].join('\n')
}
```

Do not add drift recovery instructions to this header.

- [ ] **Step 4: Render prompt from catalog snapshot in ToolCallingEngine**

Modify `src/main/proxy/toolCalling/ToolCallingEngine.ts`:

```ts
import { getProviderToolProfile } from './providerProfiles.ts'
import { renderManagedXmlContractHeader } from './protocols/managedXml.ts'
```

Change the render call:

```ts
      messages: injectPrompt(request.messages, renderPrompt(plan, this.config)),
```

Replace `renderPrompt` with:

```ts
function renderPrompt(
  plan: ToolCallingPlan,
  config: ToolCallingConfig,
): string {
  const prompt = getToolProtocol(plan.protocol).renderPrompt(plan.tools)
  const profile = getProviderToolProfile(plan.providerId)
  const contractHeader = plan.catalogSnapshot
    ? renderManagedXmlContractHeader({
        catalogFingerprint: plan.catalogSnapshot.fingerprint,
        allowedToolNames: plan.catalogSnapshot.allowedToolNames,
        protocol: plan.protocol,
        contractHeaderVersion: profile.contractHeaderVersion,
      })
    : ''
  const fullPrompt = contractHeader ? `${contractHeader}\n\n${prompt}` : prompt
  const customPromptTemplate = config.diagnosticsEnabled
    ? config.advanced.customPromptTemplate
    : undefined
  if (!customPromptTemplate) return fullPrompt

  return customPromptTemplate
    .replace(/\{\{tools\}\}/g, fullPrompt)
    .replace(/\{\{tool_names\}\}/g, plan.tools.map((tool) => tool.name).join(', '))
    .replace(/\{\{format\}\}/g, plan.protocol)
}
```

- [ ] **Step 5: Add provider profile defaults test**

Append to `tests/tool-calling/provider-profiles.test.ts`:

```ts
test('managed provider profiles expose contract header and availability retry defaults', () => {
  for (const providerId of ['qwen', 'qwen-ai', 'glm']) {
    const profile = getProviderToolProfile(providerId)
    assert.equal(profile.preferredManagedProtocol, 'managed_xml')
    assert.equal(profile.contractHeaderVersion, 1)
    assert.equal(profile.availabilityDriftRetry, 'enabled')
  }
})
```

- [ ] **Step 6: Run focused tests**

Run:

```powershell
node --test tests/tool-calling/provider-profiles.test.ts tests/tool-calling/tool-engine.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit contract header rendering**

```powershell
git add src/main/proxy/toolCalling/protocols/managedXml.ts src/main/proxy/toolCalling/ToolCallingEngine.ts tests/tool-calling/tool-engine.test.ts tests/tool-calling/provider-profiles.test.ts
git commit -m "feat: inject tool contract header"
```

---

### Task 4: Non-Streaming Availability Drift Retry

**Files:**
- Create: `src/main/proxy/toolCalling/availabilityDrift.ts`
- Modify: `src/main/proxy/toolCalling/types.ts`
- Modify: `src/main/proxy/toolCalling/ToolCallingEngine.ts`
- Modify: `tests/tool-calling/tool-engine.test.ts`

- [ ] **Step 1: Add failing availability drift unit behavior through engine**

Append to `tests/tool-calling/tool-engine.test.ts`:

```ts
test('non-stream response denying an available tool marks one availability retry request', () => {
  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: `engine-catalog-${Date.now()}-drift`,
  })
  const result: any = {
    choices: [{
      message: {
        role: 'assistant',
        content: 'I cannot use default_api:read_file because that tool is not available in this conversation.',
      },
      finish_reason: 'stop',
    }],
  }

  const retry = engine.applyNonStreamResponse(result, transformed.plan)

  assert.equal(retry?.type, 'availability_retry')
  assert.equal(retry?.catalogFingerprint, transformed.plan.catalogSnapshot?.fingerprint)
  assert.equal(transformed.plan.availabilityRetryAttempted, true)
  assert.equal(transformed.plan.diagnostics.availabilityDriftDetected, true)
  assert.equal(transformed.plan.diagnostics.availabilityRetryResult, 'attempted')
})

test('availability drift retry does not trigger twice for one plan', () => {
  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: `engine-catalog-${Date.now()}-drift-once`,
  })
  const result: any = {
    choices: [{
      message: {
        role: 'assistant',
        content: 'The default_api:read_file tool does not exist.',
      },
      finish_reason: 'stop',
    }],
  }

  const first = engine.applyNonStreamResponse(result, transformed.plan)
  const second = engine.applyNonStreamResponse(result, transformed.plan)

  assert.equal(first?.type, 'availability_retry')
  assert.equal(second, undefined)
  assert.equal(transformed.plan.diagnostics.availabilityRetryResult, 'skipped')
})

test('availability drift retry does not trigger when valid tool_calls were parsed', () => {
  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: `engine-catalog-${Date.now()}-drift-valid`,
  })
  const result: any = {
    choices: [{
      message: {
        role: 'assistant',
        content: '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="argument"><![CDATA[{}]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
      },
      finish_reason: 'stop',
    }],
  }

  const retry = engine.applyNonStreamResponse(result, transformed.plan)

  assert.equal(retry, undefined)
  assert.equal(result.choices[0].finish_reason, 'tool_calls')
  assert.equal(transformed.plan.diagnostics.availabilityDriftDetected, undefined)
})
```

- [ ] **Step 2: Run failing engine tests**

Run:

```powershell
node --test tests/tool-calling/tool-engine.test.ts
```

Expected: FAIL because `applyNonStreamResponse` returns `void` and no retry detector exists.

- [ ] **Step 3: Add availability drift types**

Modify `src/main/proxy/toolCalling/types.ts`:

```ts
export interface AvailabilityRetryRequest {
  type: 'availability_retry'
  catalogFingerprint: string
  clarification: string
}
```

Extend `ToolCallDiagnostics`:

```ts
  availabilityDriftDetected?: boolean
  availabilityRetryResult?: 'skipped' | 'attempted' | 'succeeded' | 'failed'
```

- [ ] **Step 4: Implement drift detector**

Create `src/main/proxy/toolCalling/availabilityDrift.ts`:

```ts
import type { ToolCallingPlan } from './types.ts'

export interface AvailabilityDriftDetection {
  detected: boolean
  deniedToolName?: string
}

const UNAVAILABLE_PATTERNS = [
  /\btool(?:s)?\b[\s\S]{0,80}\b(?:not available|unavailable|not provided|not found|does not exist|don't exist|do not exist)\b/i,
  /\b(?:not available|unavailable|not provided|not found|does not exist|don't exist|do not exist)\b[\s\S]{0,80}\btool(?:s)?\b/i,
  /不存在.{0,20}工具|工具.{0,20}不存在|没有.{0,20}工具|未提供.{0,20}工具/i,
]

export function detectAvailabilityDrift(plan: ToolCallingPlan, rawAssistantText: string): AvailabilityDriftDetection {
  if (!plan.catalogSnapshot || plan.catalogSnapshot.allowedToolNames.length === 0) {
    return { detected: false }
  }

  const matched = UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(rawAssistantText))
  if (!matched) return { detected: false }

  const lowerText = rawAssistantText.toLowerCase()
  const deniedToolName = plan.catalogSnapshot.allowedToolNames.find((name) => lowerText.includes(name.toLowerCase()))
  if (deniedToolName) {
    return { detected: true, deniedToolName }
  }

  return { detected: true }
}

export function buildAvailabilityRetryClarification(plan: ToolCallingPlan): string {
  return [
    'Tool availability clarification:',
    `catalog_fingerprint: ${plan.catalogSnapshot?.fingerprint ?? ''}`,
    `available_tools: ${plan.catalogSnapshot?.allowedToolNames.join(', ') ?? ''}`,
    'The runtime-provided catalog in this clarification is authoritative for this turn. Use only tools listed in that catalog when a tool call is needed.',
  ].join('\n')
}
```

- [ ] **Step 5: Return retry request from non-stream response mapping**

Modify `src/main/proxy/toolCalling/ToolCallingEngine.ts`:

```ts
import { buildAvailabilityRetryClarification, detectAvailabilityDrift } from './availabilityDrift.ts'
import type { AvailabilityRetryRequest } from './types.ts'
```

Change method signature:

```ts
  applyNonStreamResponse(result: any, plan: ToolCallingPlan): AvailabilityRetryRequest | undefined {
```

For early non-parse return:

```ts
    if (!plan.shouldParseResponse) return undefined
```

After the `plain_text` branch sets parser diagnostics, add:

```ts
      return maybeBuildAvailabilityRetry(message.content, plan)
```

After successful tool call assembly, set retry result if needed:

```ts
    if (plan.availabilityRetryAttempted) {
      plan.diagnostics.availabilityRetryResult = 'succeeded'
    }
```

Add helper:

```ts
function maybeBuildAvailabilityRetry(content: string, plan: ToolCallingPlan): AvailabilityRetryRequest | undefined {
  if (!plan.availabilityRetryAllowed || plan.availabilityRetryAttempted || !plan.catalogSnapshot) {
    if (plan.availabilityRetryAttempted) {
      plan.diagnostics.availabilityRetryResult = 'skipped'
    }
    return undefined
  }

  const detection = detectAvailabilityDrift(plan, content)
  if (!detection.detected) return undefined

  plan.availabilityRetryAttempted = true
  plan.diagnostics.availabilityDriftDetected = true
  plan.diagnostics.availabilityRetryResult = 'attempted'

  return {
    type: 'availability_retry',
    catalogFingerprint: plan.catalogSnapshot.fingerprint,
    clarification: buildAvailabilityRetryClarification(plan),
  }
}
```

This task only creates the retry request object. It does not perform a second provider call yet.

- [ ] **Step 6: Run focused tests**

Run:

```powershell
node --test tests/tool-calling/tool-engine.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit availability drift detector**

```powershell
git add src/main/proxy/toolCalling/availabilityDrift.ts src/main/proxy/toolCalling/ToolCallingEngine.ts src/main/proxy/toolCalling/types.ts tests/tool-calling/tool-engine.test.ts
git commit -m "feat: detect tool availability drift"
```

---

### Task 5: Forwarder Retry Hook and Diagnostics

**Files:**
- Modify: `src/main/proxy/forwarder.ts`
- Modify: `src/main/proxy/toolCalling/diagnostics.ts`
- Modify: `src/main/proxy/toolCalling/ToolCallingEngine.ts`
- Create: `tests/tool-calling/tool-diagnostics.test.ts`

- [ ] **Step 1: Add failing diagnostics tests**

Create `tests/tool-calling/tool-diagnostics.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  clearToolDiagnosticEvents,
  getToolDiagnosticEvents,
  recordToolDiagnosticEvent,
} from '../../src/main/proxy/toolCalling/diagnostics.ts'

test('tool diagnostic events store structure facts without arguments or full schemas', () => {
  clearToolDiagnosticEvents()
  recordToolDiagnosticEvent({
    type: 'tool_catalog_resolved',
    requestId: 'r1',
    providerId: 'qwen',
    model: 'qwen3',
    catalogFingerprint: 'abc',
    toolNames: ['bash'],
    schemaHashes: { bash: 'hash' },
    argumentsText: '{"argument":"rm -rf /"}',
    fullSchema: { type: 'object', properties: { argument: { type: 'string' } } },
    prompt: 'secret prompt',
  } as any)

  const events = getToolDiagnosticEvents()
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'tool_catalog_resolved')
  assert.deepEqual(events[0].toolNames, ['bash'])
  assert.equal((events[0] as any).argumentsText, undefined)
  assert.equal((events[0] as any).fullSchema, undefined)
  assert.equal((events[0] as any).prompt, undefined)
})
```

- [ ] **Step 2: Run failing diagnostics test**

Run:

```powershell
node --test tests/tool-calling/tool-diagnostics.test.ts
```

Expected: FAIL because the event functions do not exist.

- [ ] **Step 3: Add diagnostic event store**

Modify `src/main/proxy/toolCalling/diagnostics.ts`:

```ts
export type ToolDiagnosticEventType =
  | 'tool_catalog_resolved'
  | 'tool_catalog_drift_detected'
  | 'tool_contract_injected'
  | 'tool_availability_drift_detected'
  | 'tool_availability_retry_result'
  | 'provider_empty_output'

export interface ToolDiagnosticEvent {
  type: ToolDiagnosticEventType
  requestId?: string
  providerId?: string
  model?: string
  catalogSource?: string
  catalogFingerprint?: string
  toolNames?: string[]
  schemaHashes?: Record<string, string>
  driftKinds?: string[]
  protocol?: string
  headerVersion?: number
  retryResult?: 'skipped' | 'attempted' | 'succeeded' | 'failed'
  responseMode?: 'streaming' | 'non_streaming'
  timestamp: number
}

const MAX_TOOL_DIAGNOSTIC_EVENTS = 200
let toolDiagnosticEvents: ToolDiagnosticEvent[] = []

export function recordToolDiagnosticEvent(event: Omit<ToolDiagnosticEvent, 'timestamp'>): ToolDiagnosticEvent {
  const safeEvent: ToolDiagnosticEvent = {
    type: event.type,
    requestId: event.requestId,
    providerId: event.providerId,
    model: event.model,
    catalogSource: event.catalogSource,
    catalogFingerprint: event.catalogFingerprint,
    toolNames: event.toolNames ? [...event.toolNames] : undefined,
    schemaHashes: event.schemaHashes ? { ...event.schemaHashes } : undefined,
    driftKinds: event.driftKinds ? [...event.driftKinds] : undefined,
    protocol: event.protocol,
    headerVersion: event.headerVersion,
    retryResult: event.retryResult,
    responseMode: event.responseMode,
    timestamp: Date.now(),
  }

  toolDiagnosticEvents = [...toolDiagnosticEvents, safeEvent].slice(-MAX_TOOL_DIAGNOSTIC_EVENTS)
  return safeEvent
}

export function getToolDiagnosticEvents(): ToolDiagnosticEvent[] {
  return toolDiagnosticEvents.map((event) => ({
    ...event,
    toolNames: event.toolNames ? [...event.toolNames] : undefined,
    schemaHashes: event.schemaHashes ? { ...event.schemaHashes } : undefined,
    driftKinds: event.driftKinds ? [...event.driftKinds] : undefined,
  }))
}

export function clearToolDiagnosticEvents(): void {
  toolDiagnosticEvents = []
}
```

- [ ] **Step 4: Record catalog/header/retry events in engine**

Modify `src/main/proxy/toolCalling/ToolCallingEngine.ts`:

```ts
import { recordToolDiagnosticEvent } from './diagnostics.ts'
```

After planning in `transformRequest`, record catalog resolution:

```ts
    if (plan.catalogSnapshot) {
      recordToolDiagnosticEvent({
        type: 'tool_catalog_resolved',
        requestId,
        providerId: provider.id,
        model: actualModel,
        catalogSource: plan.catalogDiagnostics.source,
        catalogFingerprint: plan.catalogSnapshot.fingerprint,
        toolNames: plan.catalogSnapshot.allowedToolNames,
        schemaHashes: plan.catalogSnapshot.schemaHashes,
        driftKinds: plan.catalogDiagnostics.driftKinds,
        responseMode: request.stream ? 'streaming' : 'non_streaming',
      })
      if (plan.catalogDiagnostics.driftKinds.length > 0) {
        recordToolDiagnosticEvent({
          type: 'tool_catalog_drift_detected',
          requestId,
          providerId: provider.id,
          model: actualModel,
          catalogFingerprint: plan.catalogSnapshot.fingerprint,
          driftKinds: plan.catalogDiagnostics.driftKinds,
          responseMode: request.stream ? 'streaming' : 'non_streaming',
        })
      }
    }
```

When injecting prompt, record:

```ts
      recordToolDiagnosticEvent({
        type: 'tool_contract_injected',
        requestId,
        providerId: provider.id,
        model: actualModel,
        catalogFingerprint: plan.catalogSnapshot?.fingerprint,
        toolNames: plan.catalogSnapshot?.allowedToolNames,
        protocol: plan.protocol,
        headerVersion: getProviderToolProfile(plan.providerId).contractHeaderVersion,
        responseMode: request.stream ? 'streaming' : 'non_streaming',
      })
```

Inside `maybeBuildAvailabilityRetry`, record:

```ts
  recordToolDiagnosticEvent({
    type: 'tool_availability_drift_detected',
    requestId: plan.diagnostics.requestId,
    providerId: plan.providerId,
    model: plan.diagnostics.actualModel ?? plan.diagnostics.model,
    catalogFingerprint: plan.catalogSnapshot.fingerprint,
    toolNames: plan.catalogSnapshot.allowedToolNames,
    responseMode: 'non_streaming',
  })
  recordToolDiagnosticEvent({
    type: 'tool_availability_retry_result',
    requestId: plan.diagnostics.requestId,
    providerId: plan.providerId,
    model: plan.diagnostics.actualModel ?? plan.diagnostics.model,
    catalogFingerprint: plan.catalogSnapshot.fingerprint,
    retryResult: 'attempted',
    responseMode: 'non_streaming',
  })
```

- [ ] **Step 5: Add forwarder retry helper for non-streaming managed requests**

Modify `src/main/proxy/forwarder.ts` `applyToolCallsToResponse` so it returns the retry request:

```ts
  private applyToolCallsToResponse(result: any, transformed: ToolCallingTransformResult) {
    const engine = new ToolCallingEngine(storeManager.getConfig().toolCallingConfig)
    return engine.applyNonStreamResponse(result, transformed.plan)
  }
```

Add this helper method to `RequestForwarder`:

```ts
  private buildAvailabilityRetryRequest(
    originalRequest: ChatCompletionRequest,
    transformed: ToolCallingTransformResult,
    clarification: string
  ): ChatCompletionRequest {
    return {
      ...originalRequest,
      stream: false,
      messages: [
        ...transformed.messages,
        {
          role: 'system',
          content: clarification,
        },
      ],
      tools: transformed.tools,
    }
  }
```

The helper preserves the original transformed messages and appends only the bounded structural clarification returned by `ToolCallingEngine`. It does not add tool arguments, choose a tool, or change the catalog snapshot.

- [ ] **Step 6: Pass toolSessionKey from forwarder transform call**

Modify `src/main/proxy/forwarder.ts` by adding this method to `RequestForwarder`:

```ts
  private buildToolCatalogSessionKey(provider: Provider, account: Account, actualModel: string): string {
    return `${provider.id}:${account.id}:${actualModel}`
  }
```

Then modify `transformRequestForPromptToolUse` input:

```ts
  private transformRequestForPromptToolUse(
    request: ChatCompletionRequest,
    provider?: Provider,
    toolSessionKey?: string | null
  ): ToolCallingTransformResult {
```

Pass:

```ts
      toolSessionKey: toolSessionKey ?? undefined,
```

Update each provider-specific transform call from:

```ts
const transformed = this.transformRequestForPromptToolUse(request, provider)
```

to:

```ts
const transformed = this.transformRequestForPromptToolUse(
  request,
  provider,
  this.buildToolCatalogSessionKey(provider, account, actualModel)
)
```

Apply that exact call shape in these methods:

- `forwardDeepSeek`
- `forwardGLM`
- `forwardKimi`
- `forwardQwen`
- `forwardQwenAi`
- `forwardZai`
- `forwardMiniMax`
- `forwardMimo`
- `forwardPerplexity`

Do not derive the catalog key from prompt text, model output, or provider response content. The key is intentionally independent of `sessionManager`; later work may replace it with a more precise client/session id when one is available at this boundary.

For the first implementation, keep the existing call sites unchanged so they pass `undefined` and use request-scoped catalog unless a later forward path already has a concrete session id in scope. Do not derive the catalog key from prompt text or provider output.

- [ ] **Step 7: Wire one-shot non-streaming retry for Qwen**

Modify `src/main/proxy/forwarder.ts` inside `forwardQwen`, replacing:

```ts
      const result = await handler.handleNonStream(response.data, response)

      this.applyToolCallsToResponse(result, transformed)
```

with:

```ts
      let result = await handler.handleNonStream(response.data, response)

      const retry = this.applyToolCallsToResponse(result, transformed)
      if (retry && transformed.plan.catalogSnapshot?.fingerprint === retry.catalogFingerprint) {
        const retryRequest = this.buildAvailabilityRetryRequest(request, transformed, retry.clarification)
        const retryResponse = await adapter.chatCompletion({
          model: actualModel,
          originalModel: request.model,
          messages: retryRequest.messages as any,
          stream: false,
          temperature: request.temperature,
          enableThinking: !!request.reasoning_effort,
          enableWebSearch: !!request.web_search,
        })
        const retryHandler = new QwenStreamHandler(actualModel, deleteSessionCallback, transformed.plan)
        result = await retryHandler.handleNonStream(retryResponse.response.data, retryResponse.response)
        this.applyToolCallsToResponse(result, transformed)
      }
```

This retry uses the same `transformed.plan` and therefore the same immutable catalog fingerprint. It is non-streaming only and cannot retry a second time because `plan.availabilityRetryAttempted` is already true.

- [ ] **Step 8: Wire one-shot non-streaming retry for GLM**

Modify `src/main/proxy/forwarder.ts` inside `forwardGLM`, replacing:

```ts
      const result = await handler.handleNonStream(response.data, response)

      this.applyToolCallsToResponse(result, transformed)
```

with:

```ts
      let result = await handler.handleNonStream(response.data, response)

      const retry = this.applyToolCallsToResponse(result, transformed)
      if (retry && transformed.plan.catalogSnapshot?.fingerprint === retry.catalogFingerprint) {
        const retryRequest = this.buildAvailabilityRetryRequest(request, transformed, retry.clarification)
        const retryResponse = await adapter.chatCompletion({
          model: actualModel,
          originalModel: request.model,
          messages: retryRequest.messages as any,
          stream: false,
          temperature: request.temperature,
          web_search: request.web_search,
          reasoning_effort: request.reasoning_effort,
          deep_research: request.deep_research,
        })
        const retryHandler = new GLMStreamHandler(actualModel, undefined, undefined, transformed.plan as any)
        result = await retryHandler.handleNonStream(retryResponse.response.data, retryResponse.response)
        this.applyToolCallsToResponse(result, transformed)
      }
```

- [ ] **Step 9: Wire one-shot non-streaming retry for DeepSeek**

Modify `src/main/proxy/forwarder.ts` inside `forwardDeepSeek`, replacing:

```ts
      const result = await handler.handleNonStream(response.data, response)
      
      this.applyToolCallsToResponse(result, transformed)
```

with:

```ts
      let result = await handler.handleNonStream(response.data, response)

      const retry = this.applyToolCallsToResponse(result, transformed)
      if (retry && transformed.plan.catalogSnapshot?.fingerprint === retry.catalogFingerprint) {
        const retryRequest = this.buildAvailabilityRetryRequest(request, transformed, retry.clarification)
        const retryResponse = await adapter.chatCompletion({
          model: request.model,
          messages: retryRequest.messages as any,
          stream: false,
          temperature: request.temperature,
          web_search: request.web_search,
          reasoning_effort: request.reasoning_effort,
        })
        const retryHandler = new DeepSeekStreamHandler(
          actualModel,
          retryResponse.sessionId,
          deleteSessionCallback,
          retryRequest.web_search,
          retryRequest.reasoning_effort,
          transformed.plan,
          request.model
        )
        result = await retryHandler.handleNonStream(retryResponse.response.data, retryResponse.response)
        this.applyToolCallsToResponse(result, transformed)
      }
```

- [ ] **Step 10: Wire one-shot non-streaming retry for Qwen AI**

Modify `src/main/proxy/forwarder.ts` inside `forwardQwenAi`, replacing:

```ts
      const result = await handler.handleNonStream(response.data)

      this.applyToolCallsToResponse(result, transformed)
```

with:

```ts
      let result = await handler.handleNonStream(response.data)

      const retry = this.applyToolCallsToResponse(result, transformed)
      if (retry && transformed.plan.catalogSnapshot?.fingerprint === retry.catalogFingerprint) {
        const retryRequest = this.buildAvailabilityRetryRequest(request, transformed, retry.clarification)
        const retryResponse = await adapter.chatCompletion({
          model: actualModel,
          originalModel: request.model,
          messages: retryRequest.messages as any,
          stream: false,
          temperature: request.temperature,
          enable_thinking: !!request.reasoning_effort,
        })
        const retryHandler = new QwenAiStreamHandler(actualModel, undefined, transformed.plan as any)
        retryHandler.setChatId(retryResponse.chatId)
        result = await retryHandler.handleNonStream(retryResponse.response.data)
        this.applyToolCallsToResponse(result, transformed)
      }
```

- [ ] **Step 11: Verify forwarder retry code typechecks**

Run:

```powershell
npm run build
```

Expected: PASS. If this fails in one provider-specific retry block, fix that block by matching the exact adapter method arguments and response property names already used by the first-call path in the same `forward*` method. Do not add a generic provider abstraction in this task.

- [ ] **Step 12: Run diagnostics and focused regression tests**

Run:

```powershell
node --test tests/tool-calling/tool-diagnostics.test.ts tests/tool-calling/tool-engine.test.ts tests/tool-calling/runtime-plan.test.ts
```

Expected: PASS.

- [ ] **Step 13: Commit diagnostics and forwarder retry hook**

```powershell
git add src/main/proxy/forwarder.ts src/main/proxy/toolCalling/diagnostics.ts src/main/proxy/toolCalling/ToolCallingEngine.ts tests/tool-calling/tool-diagnostics.test.ts
git commit -m "feat: record tool catalog diagnostics"
```

---

### Task 6: Final Regression and Probe Prep

**Files:**
- Modify tests only if failures expose missing catalog assertions:
  - `tests/providers/context-tool-metadata.test.ts`
  - `tests/providers/qwen-request-routing.test.ts`
  - `tests/providers/glm-tool-calling.test.ts`
  - `tests/tool-calling/tool-stream-parser.test.ts`

- [ ] **Step 1: Run all deterministic tool-calling tests**

Run:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run existing tool-runtime tests**

Run:

```powershell
node --test tests/tool-runtime/control/*.test.ts tests/tool-runtime/data/*.test.ts tests/tool-runtime/integration/*.test.ts tests/tool-runtime/runner/*.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run build**

Run:

```powershell
npm run build
```

Expected: PASS.

- [ ] **Step 4: Start app for OpenCode probe**

Run:

```powershell
npm run dev:win 2>&1 | Tee-Object -FilePath .\dev.log
```

Expected: app starts and proxy is reachable. Keep this process running until the probe completes.

- [ ] **Step 5: Run OpenCode probe for Qwen**

In another terminal:

```powershell
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "qwen3.7"
```

Expected:

- `.agent-probe/result.json` matches deterministic local hash/length/line expectations.
- `.agent-probe/opencode-events.ndjson` contains the `agent-capability-probe` skill invocation.
- event stream contains at least two non-skill tool calls.
- at least one tool call occurs after the first tool result/observation.
- final assistant text contains `CAPABILITY_PROBE_DONE`.

- [ ] **Step 6: Inspect diagnostics for tool availability**

Review the latest app logs or any exposed debug output and confirm these structural facts appear during managed tool turns:

- `tool_catalog_resolved`
- `tool_contract_injected`
- same `catalogFingerprint` through the turn
- no tool arguments in diagnostic event payloads

- [ ] **Step 7: Commit any test-only adjustments**

If Steps 1-6 required deterministic test changes:

```powershell
git add tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts tests/providers/glm-tool-calling.test.ts tests/tool-calling/tool-stream-parser.test.ts
git commit -m "test: cover tool catalog regression gate"
```

If no files changed, do not create an empty commit.

## Self-Review Checklist

- Task 1 implements the independent `ToolCatalogStore`, snapshots, fingerprints, drift classification, and immutability.
- Task 2 routes `runtimePlan` through snapshots and removes prompt-history reconstruction as an availability truth source.
- Task 3 adds the `Tool Contract Header` without drift recovery instructions.
- Task 4 adds bounded non-streaming availability drift detection and one retry request object.
- Task 5 records structure-only diagnostics and passes session identity without moving catalog ownership into `sessionManager`.
- Task 6 runs deterministic regressions, build, and model probe.
- No task adds semantic repair, parser fallback, tool execution inside Chat2API, or LiteLLM routing.
