# Fix: restored_from_history Stub Tools Lose Description & Schema — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Session miss recovery (`restored_from_history`) restores tools with their full definitions (description + parameter schema), not empty stubs.

**Root Cause:** `catalog.ts:60-65` creates stub tools from history-extracted names only:
```typescript
const stubTools: NormalizedToolDefinition[] = input.historyToolNames.map((name) => ({
  name,
  description: '',                                       // ← lost
  parameters: { type: 'object', additionalProperties: true }, // ← lost
  source: 'openai' as const,
}))
```
The message history contains tool call names and arguments, but not the original JSON Schema definitions. Session Store (in-memory Map) is wiped on app restart. The fix: persist catalog snapshots to disk so restart hydration finds the existing snapshot directly, bypassing the `restored_from_history` stub path entirely.

**Why it regressed:** The new catalog system (`5557eb6`) centralized ALL tool resolution through `resolveSnapshot`. The fallback chain became the primary mechanism for session-miss recovery. The stub quality went from "rarely used" to "primary path after restart."

**Architecture:** Introduce a `CatalogPersistenceStore` abstraction that mirrors the in-memory Map to disk. On construction, `createToolCatalogStore` hydrates from disk. On `sessions.set()`, it also persists. On `clearSession()`, it also deletes from disk.

**Tech Stack:** TypeScript, Node.js `fs` module, JSON file at `<userData>/tool-catalogs.json`

---

## Architecture Constraints

- INV-001 [Single Ownership]: `ToolCallingEngine` is the sole owner of tool prompt injection.
- INV-002 [Stateless Fallback]: Fallback chain must progress `Session Store → Message History → Request Tools → Safe Empty`.
- INV-003 [Delete = Risk]: No deletion without equivalent replacement.
- **New**: INV-005: `restored_from_history` tools must carry full definitions. Empty descriptions are not acceptable.

---

### Task 1: Add Catalog Persistence Layer

**Files:**
- Create: `src/main/proxy/toolCalling/catalogPersistence.ts`
- Modify: `src/main/proxy/toolCalling/catalog.ts`

**Interfaces:**
- Exposes `CatalogPersistenceStore` — save/load/delete/loadAll for `ToolCatalogSnapshot` keyed by sessionId
- Consumed by `createToolCatalogStore` via optional constructor parameter

- [ ] **Step 1: Create the persistence module**

Create `src/main/proxy/toolCalling/catalogPersistence.ts`:

```ts
import fs from 'fs'
import path from 'path'

import type { ToolCatalogSnapshot } from './types.ts'

export interface CatalogPersistenceStore {
  save(sessionId: string, snapshot: ToolCatalogSnapshot): void
  load(sessionId: string): ToolCatalogSnapshot | undefined
  delete(sessionId: string): void
  loadAll(): Map<string, ToolCatalogSnapshot>
}

interface PersistedFile {
  version: 1
  catalogs: Record<string, ToolCatalogSnapshot>
}

export function createFileCatalogPersistence(filePath: string): CatalogPersistenceStore {
  const dir = path.dirname(filePath)

  function readFile(): PersistedFile {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      return JSON.parse(raw)
    } catch {
      return { version: 1, catalogs: {} }
    }
  }

  function writeFile(data: PersistedFile): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    const tmp = filePath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
    fs.renameSync(tmp, filePath)
  }

  return {
    save(sessionId: string, snapshot: ToolCatalogSnapshot) {
      const data = readFile()
      data.catalogs[sessionId] = snapshot
      writeFile(data)
    },

    load(sessionId: string): ToolCatalogSnapshot | undefined {
      const data = readFile()
      return data.catalogs[sessionId]
    },

    delete(sessionId: string) {
      const data = readFile()
      delete data.catalogs[sessionId]
      writeFile(data)
    },

    loadAll(): Map<string, ToolCatalogSnapshot> {
      const data = readFile()
      const map = new Map<string, ToolCatalogSnapshot>()
      for (const [sessionId, snapshot] of Object.entries(data.catalogs)) {
        map.set(sessionId, snapshot)
      }
      return map
    },
  }
}
```

- [ ] **Step 2: Modify createToolCatalogStore to accept optional persistence**

Modify `src/main/proxy/toolCalling/catalog.ts`:

Change the function signature at line 32:

```ts
export function createToolCatalogStore(persistence?: CatalogPersistenceStore): ToolCatalogStore {
  const sessions = new Map<string, StoredCatalog>()

  // Hydrate from disk on construction
  if (persistence) {
    for (const [sessionId, snapshot] of persistence.loadAll()) {
      sessions.set(sessionId, { snapshot })
    }
  }
```

Change the singleton at line 147 to remain as-is (no persistence by default):

```ts
export const toolCatalogStore = createToolCatalogStore()
```

Add import at top:

```ts
import type { CatalogPersistenceStore } from './catalogPersistence.ts'
```

- [ ] **Step 3: Add persistence.save() calls to sessions.set() sites**

In `resolveSnapshot`, find the `restored_from_history` branch where `sessions.set()` is called (line 73-75):

```ts
        if (input.sessionId) {
          sessions.set(input.sessionId, { snapshot })
          persistence?.save(input.sessionId, snapshot)
        }
```

And in the normal-flow `sessions.set()` at line 123-125:

```ts
    if (input.sessionId) {
      sessions.set(input.sessionId, { snapshot: nextSnapshot })
      persistence?.save(input.sessionId, nextSnapshot)
    }
```

- [ ] **Step 4: Add persistence.delete() to clearSession**

In the returned `clearSession` at line 141-143:

```ts
    clearSession(sessionId: string) {
      sessions.delete(sessionId)
      persistence?.delete(sessionId)
    },
```

- [ ] **Step 5: Run existing tests to verify no regression**

```powershell
node --test tests/tool-calling/catalog-fallback.test.ts
node --test tests/tool-calling/tool-catalog.test.ts
```

Expected: ALL PASS. The optional `persistence` parameter defaults to `undefined`, so existing behavior is unchanged.

- [ ] **Step 6: Commit catalog persistence layer**

```powershell
git add src/main/proxy/toolCalling/catalogPersistence.ts src/main/proxy/toolCalling/catalog.ts
git commit -m "feat: add durable catalog persistence layer"
```

---

### Task 2: Wire Persistence Into App Lifecycle

**Files:**
- Modify: `src/main/proxy/toolCalling/catalog.ts` — singleton wiring with Electron `app.getPath`

**Note:** This step assumes the app runs in Electron and has access to `app.getPath('userData')`. If the module is also used in non-Electron contexts (tests), the file-backed store must be guarded.

- [ ] **Step 1: Create the persisted singleton factory**

Add a new export in `src/main/proxy/toolCalling/catalog.ts`:

```ts
import { createFileCatalogPersistence } from './catalogPersistence.ts'

let persistedStore: ToolCatalogStore | undefined

export function getPersistedToolCatalogStore(userDataPath: string): ToolCatalogStore {
  if (!persistedStore) {
    const filePath = path.join(userDataPath, 'tool-catalogs.json')
    persistedStore = createToolCatalogStore(createFileCatalogPersistence(filePath))
  }
  return persistedStore
}
```

Also add `import path from 'path'` at the top (if not already present).

- [ ] **Step 2: Wire in the main process entry point**

In `src/main/index.ts` (or wherever `toolCatalogStore` is first consumed), replace:

```ts
import { toolCatalogStore } from './proxy/toolCalling/catalog.ts'
```

with:

```ts
import { app } from 'electron'
import { getPersistedToolCatalogStore } from './proxy/toolCalling/catalog.ts'

const toolCatalogStore = getPersistedToolCatalogStore(app.getPath('userData'))
```

- [ ] **Step 3: Run full test suite to verify wiring**

```powershell
node --test tests/tool-calling/*.test.ts
```

Expected: ALL PASS. Tests don't call `getPersistedToolCatalogStore`, so they use the in-memory `toolCatalogStore` singleton.

- [ ] **Step 4: Commit app lifecycle wiring**

```powershell
git add src/main/proxy/toolCalling/catalog.ts src/main/index.ts
git commit -m "feat: wire persisted catalog store into app lifecycle"
```

---

### Task 3: Add Persistence-Aware Tests

**Files:**
- Modify: `tests/tool-calling/catalog-fallback.test.ts` — add persistence-aware tests
- Create: `tests/tool-calling/catalog-persistence.test.ts`

- [ ] **Step 1: Write the failing test for persistence recovery**

Create `tests/tool-calling/catalog-persistence.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { createToolCatalogStore } from '../../src/main/proxy/toolCalling/catalog.ts'
import { createFileCatalogPersistence } from '../../src/main/proxy/toolCalling/catalogPersistence.ts'
import type { NormalizedToolDefinition, ToolCatalogStore } from '../../src/main/proxy/toolCalling/catalog.ts'

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

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-persist-'))
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
```

- [ ] **Step 2: Create a minimal in-memory persistence for testing**

Add to `catalogPersistence.ts`:

```ts
export function createMemoryPersistence(): CatalogPersistenceStore {
  const store = new Map<string, ToolCatalogSnapshot>()
  return {
    save(sessionId, snapshot) { store.set(sessionId, snapshot) },
    load(sessionId) { return store.get(sessionId) },
    delete(sessionId) { store.delete(sessionId) },
    loadAll() { return new Map(store) },
  }
}
```

This is useful for tests that don't want filesystem I/O.

- [ ] **Step 3: Run persistence tests**

```powershell
node --test tests/tool-calling/catalog-persistence.test.ts
```

Expected: PASS (all 4 tests).

- [ ] **Step 4: Run full tool-calling test suite**

```powershell
node --test tests/tool-calling/*.test.ts
```

Expected: ALL PASS including existing tests.

- [ ] **Step 5: Commit tests**

```powershell
git add tests/tool-calling/catalog-persistence.test.ts tests/tool-calling/catalog-fallback.test.ts src/main/proxy/toolCalling/catalogPersistence.ts
git commit -m "test: add catalog persistence coverage for restart recovery"
```

---

### Task 4: End-to-End Manual Verification

**Files:** None (manual verification)

- [ ] **Step 1: Start dev server**

```powershell
npm run dev:win 2>&1 | Tee-Object -FilePath .\dev.log
```

- [ ] **Step 2: Establish a tool-using OpenCode session**

Configure a provider, start an OpenCode session, and make a tool call (e.g., `read_file` or `bash`). Verify the tool executes successfully.

- [ ] **Step 3: Restart the app (keep OpenCode session alive)**

Stop the dev server (`Ctrl+C`), restart it. Keep the OpenCode window open — do NOT close the session.

- [ ] **Step 4: Send a follow-up message that needs tools**

In OpenCode, send a message like "read the file again" or "list the directory contents". Verify:
- The model actually calls tools (not just text responses)
- The Contract Header shows `allowed_tools` with correct fingerprint
- No "No description" warnings in the tool definitions
- Tools execute successfully

- [ ] **Step 5: Verify persistence file**

Check `<userData>/tool-catalogs.json` exists and contains the session's tool definitions with full descriptions and schemas.

- [ ] **Step 6: Stop dev server and commit any fixes discovered**

---

## Verification Checklist

Before merging, confirm:

- [ ] `node --test tests/tool-calling/*.test.ts` — ALL PASS
- [ ] `npx eslint src/main/proxy/adapters/` — zero errors (INV-001 enforcement)
- [ ] `npx tsc -p tsconfig.node.json --noEmit` — no new type errors in tool-calling module
- [ ] Manual E2E: restart recovery works, tools have descriptions, model calls tools
- [ ] `tool-catalogs.json` written to correct userData path
- [ ] No regression: fresh session (no persisted state) still falls back to `restored_from_history` with stub tools
