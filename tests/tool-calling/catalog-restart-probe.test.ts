/**
 * GLM adapter restart probe: simulates the exact bug scenario through ToolCallingEngine.
 *
 * Scenario: OpenCode session with tools → app restart → follow-up message.
 * Without persistence: tools restored with empty descriptions → model can't call them.
 * With persistence: catalog survives on disk → full tool definitions survive restart.
 *
 * Run: node --test tests/tool-calling/catalog-restart-probe.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { ToolCallingEngine } from '../../src/main/proxy/toolCalling/ToolCallingEngine.ts'
import {
  createToolCatalogStore,
  __resetCatalogStoreForTest,
} from '../../src/main/proxy/toolCalling/catalog.ts'
import { createFileCatalogPersistence } from '../../src/main/proxy/toolCalling/catalogPersistence.ts'
import type { ChatCompletionRequest } from '../../src/main/proxy/types.ts'
import type { Provider } from '../../src/main/store/types.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProvider(id = 'glm'): Provider {
  return {
    id,
    name: id,
    type: 'builtin',
    authType: 'userToken',
    apiEndpoint: 'https://api.example.com',
    headers: {},
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  } as Provider
}

const readFileTool = {
  type: 'function' as const,
  function: {
    name: 'read_file',
    description: 'Read the contents of a file at the given path.',
    parameters: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: 'Path to the file to read' },
        offset: { type: 'number', description: 'Line number to start reading from' },
        limit: { type: 'number', description: 'Maximum number of lines to read' },
      },
      required: ['file_path'],
    },
  },
}

const bashTool = {
  type: 'function' as const,
  function: {
    name: 'bash',
    description: 'Execute a shell command within the project environment.',
    parameters: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        description: { type: 'string', description: 'Human-readable description of the command' },
      },
      required: ['command'],
    },
  },
}

const writeTool = {
  type: 'function' as const,
  function: {
    name: 'write',
    description: 'Write content to a file, creating it if it does not exist.',
    parameters: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: 'Path to the file to write' },
        content: { type: 'string', description: 'Content to write to the file' },
      },
      required: ['file_path', 'content'],
    },
  },
}

const grepTool = {
  type: 'function' as const,
  function: {
    name: 'grep',
    description: 'Search for a pattern in files using ripgrep.',
    parameters: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'Regular expression pattern to search for' },
        path: { type: 'string', description: 'Directory or file to search in' },
      },
      required: ['pattern'],
    },
  },
}

const ALL_TOOLS = [readFileTool, bashTool, writeTool, grepTool]

function firstTurnRequest(): ChatCompletionRequest {
  return {
    model: 'glm-5',
    messages: [{ role: 'user', content: 'read the README, then write a summary' }],
    tools: ALL_TOOLS,
  }
}

function multiTurnMessages(): ChatCompletionRequest['messages'] {
  return [
    { role: 'system', content: 'You are a helpful assistant.' },
    {
      role: 'assistant',
      content: null as any,
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"README.md"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '# Project README\n\nHello world.' },
    {
      role: 'assistant',
      content: null as any,
      tool_calls: [
        { id: 'call_2', type: 'function', function: { name: 'write', arguments: '{"file_path":"summary.md","content":"summary"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_2', content: 'File written.' },
    { role: 'assistant', content: 'Done. I read the README and wrote a summary.' },
    { role: 'user', content: 'now also grep for TODOs and run the build' },
  ]
}

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-restart-'))
  return path.join(dir, 'tool-catalogs.json')
}

// ---------------------------------------------------------------------------
// PROBE 1: Bug — without persistence, through GLM adapter
// ---------------------------------------------------------------------------
test('GLM adapter: WITHOUT persistence → restored_from_history stubs (THE BUG)', () => {
  // Ensure in-memory store (no persistence)
  __resetCatalogStoreForTest(createToolCatalogStore())

  const engine = new ToolCallingEngine()

  // Turn 1: first request has tools
  const turn1 = engine.transformRequest({
    request: firstTurnRequest(),
    provider: makeProvider('glm'),
    actualModel: 'glm-5',
    requestId: 'glm-bug-turn1',
  })
  assert.equal(turn1.plan.mode, 'managed')
  assert.equal(turn1.plan.catalogDiagnostics.source, 'current_request')
  assert.equal(turn1.plan.catalogSnapshot!.tools.length, 4)

  // --- APP RESTART (new in-memory store) ---
  __resetCatalogStoreForTest(createToolCatalogStore())

  // Turn 2: OpenCode sends follow-up with multi-turn history, no tools in request
  const turn2 = engine.transformRequest({
    request: {
      model: 'glm-5',
      messages: multiTurnMessages(),
      tools: undefined, // continuation — no tools
    },
    provider: makeProvider('glm'),
    actualModel: 'glm-5',
    requestId: 'glm-bug-turn2',
  })

  assert.equal(turn2.plan.mode, 'managed')
  assert.equal(turn2.plan.catalogDiagnostics.source, 'restored_from_history',
    'BUG: falls back to restored_from_history because memory is empty')

  console.log('\n=== GLM WITHOUT persistence (the bug) ===')
  for (const tool of turn2.plan.catalogSnapshot!.tools) {
    console.log(`  ${tool.name}: description="${tool.description}" (${tool.description.length} chars)` +
      ` | schema_keys=${Object.keys(tool.parameters.properties ?? {}).length}`)
    assert.equal(tool.description, '',
      `BUG: "${tool.name}" has empty description — model sees "No description"`)
  }
  console.log('  VERDICT: Model cannot call tools effectively after restart.\n')
})

// ---------------------------------------------------------------------------
// PROBE 2: Fix — with persistence, through GLM adapter
// ---------------------------------------------------------------------------
test('GLM adapter: WITH persistence → session_catalog survives restart (THE FIX)', () => {
  const filePath = tempFile()

  // --- First app session: create persisted store, set as global ---
  const store1 = createToolCatalogStore(createFileCatalogPersistence(filePath))
  __resetCatalogStoreForTest(store1)

  const engine = new ToolCallingEngine()

  // Turn 1: first request has tools → catalog built AND persisted to disk
  const turn1 = engine.transformRequest({
    request: firstTurnRequest(),
    provider: makeProvider('glm'),
    actualModel: 'glm-5',
    requestId: 'glm-fix-r1',
    toolSessionKey: 'opencode-session-persist',
  })
  assert.equal(turn1.plan.mode, 'managed')
  assert.equal(turn1.plan.catalogDiagnostics.source, 'current_request')
  const fp1 = turn1.plan.catalogSnapshot!.fingerprint
  console.log(`  Turn 1: fingerprint=${fp1.slice(0, 12)}..., tools=4`)

  // --- APP RESTART: new store from same disk file ---
  const store2 = createToolCatalogStore(createFileCatalogPersistence(filePath))
  __resetCatalogStoreForTest(store2)

  // Turn 2: continuation, no tools in request — SAME toolSessionKey as Turn 1
  const turn2 = engine.transformRequest({
    request: {
      model: 'glm-5',
      messages: multiTurnMessages(),
      tools: undefined,
    },
    provider: makeProvider('glm'),
    actualModel: 'glm-5',
    requestId: 'glm-fix-r2',
    toolSessionKey: 'opencode-session-persist',
  })

  assert.equal(turn2.plan.mode, 'managed')
  assert.equal(turn2.plan.catalogDiagnostics.source, 'session_catalog',
    'FIX: hits session_catalog from disk, NOT restored_from_history')
  assert.equal(turn2.plan.catalogSnapshot!.fingerprint, fp1,
    'Fingerprint matches Turn 1 — same catalog')
  assert.equal(turn2.plan.catalogSnapshot!.tools.length, 4)

  console.log('\n=== GLM WITH persistence (the fix) ===')
  let allGood = true
  for (const tool of turn2.plan.catalogSnapshot!.tools) {
    const hasDesc = tool.description.length > 0
    const keys = Object.keys(tool.parameters.properties ?? {})
    console.log(`  ${tool.name}: description="${tool.description.slice(0, 50)}..." | schema_keys=[${keys.join(', ')}]`)
    if (!hasDesc || keys.length === 0) allGood = false
  }
  assert.ok(allGood, 'All tools have full descriptions and real schemas')
  console.log('  VERDICT: Model sees full tool definitions — can call tools after restart.\n')
})

// ---------------------------------------------------------------------------
// PROBE 3: GLM adapter — tool prompt is present and injects correctly after restart
// ---------------------------------------------------------------------------
test('GLM adapter: tool prompt is injected correctly after persisted restart', () => {
  const filePath = tempFile()

  // Turn 1
  const store1 = createToolCatalogStore(createFileCatalogPersistence(filePath))
  __resetCatalogStoreForTest(store1)
  const engine = new ToolCallingEngine()
  engine.transformRequest({
    request: firstTurnRequest(),
    provider: makeProvider('glm'),
    actualModel: 'glm-5',
    requestId: 'glm-prompt-r1',
    toolSessionKey: 'opencode-session-prompt',
  })

  // Restart
  const store2 = createToolCatalogStore(createFileCatalogPersistence(filePath))
  __resetCatalogStoreForTest(store2)

  // Turn 2 with multi-turn history — SAME toolSessionKey
  const turn2 = engine.transformRequest({
    request: {
      model: 'glm-5',
      messages: multiTurnMessages(),
      tools: undefined,
    },
    provider: makeProvider('glm'),
    actualModel: 'glm-5',
    requestId: 'glm-prompt-r2',
    toolSessionKey: 'opencode-session-prompt',
  })

  assert.equal(turn2.plan.shouldInjectPrompt, true)
  assert.equal(turn2.plan.shouldParseResponse, true)

  // Verify the prompt was injected into messages
  const allContent = turn2.messages
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n')
  assert.ok(allContent.includes('## Available Tools'), 'Tool prompt header present')
  assert.ok(allContent.includes('Tool Contract Header'), 'Contract header present')
  assert.ok(allContent.includes('catalog_fingerprint:'), 'Fingerprint line present')

  // Verify each tool name appears in the prompt
  for (const name of ['read_file', 'bash', 'write', 'grep']) {
    assert.ok(allContent.includes(name), `Tool "${name}" appears in prompt`)
  }

  // Verify tool descriptions are in the prompt (not stubs)
  assert.ok(allContent.includes('Read the contents of a file'),
    'read_file description in prompt')
  assert.ok(allContent.includes('Execute a shell command'),
    'bash description in prompt')

  console.log('  Prompt injection verified: Contract Header + full tool descriptions present.\n')
})

// ---------------------------------------------------------------------------
// PROBE 4: All 5 adapters — restart with persistence
// ---------------------------------------------------------------------------
const ADAPTERS = ['glm', 'qwen', 'minimax', 'kimi', 'deepseek']

for (const providerId of ADAPTERS) {
  test(`${providerId} adapter: persisted catalog survives restart`, () => {
    const filePath = tempFile()

    const sessionKey = `opencode-${providerId}-persist`

    // Turn 1
    const store1 = createToolCatalogStore(createFileCatalogPersistence(filePath))
    __resetCatalogStoreForTest(store1)
    const engine = new ToolCallingEngine()
    engine.transformRequest({
      request: {
        model: `${providerId}-default`,
        messages: [{ role: 'user', content: 'hello' }],
        tools: ALL_TOOLS,
      },
      provider: makeProvider(providerId),
      actualModel: `${providerId}-default`,
      requestId: `${providerId}-r1`,
      toolSessionKey: sessionKey,
    })

    // Restart
    const store2 = createToolCatalogStore(createFileCatalogPersistence(filePath))
    __resetCatalogStoreForTest(store2)

    const turn2 = engine.transformRequest({
      request: {
        model: `${providerId}-default`,
        messages: multiTurnMessages(),
        tools: undefined,
      },
      provider: makeProvider(providerId),
      actualModel: `${providerId}-default`,
      requestId: `${providerId}-r2`,
      toolSessionKey: sessionKey,
    })

    assert.equal(turn2.plan.mode, 'managed',
      `${providerId}: mode should be managed`)
    assert.equal(turn2.plan.catalogDiagnostics.source, 'session_catalog',
      `${providerId}: should hit session_catalog from disk`)

    const tools = turn2.plan.catalogSnapshot!.tools
    assert.ok(tools.length >= 4)
    for (const tool of tools) {
      assert.ok(tool.description.length > 0,
        `${providerId}: "${tool.name}" has non-empty description`)
    }
  })
}

// ---------------------------------------------------------------------------
// PROBE 5: 3-turn within-same-session (NO restart) — simulates user's report
// ---------------------------------------------------------------------------
test('GLM adapter: 3-turn conversation within same session — tools survive all turns', () => {
  // Use in-memory store (no persistence needed for same-process)
  __resetCatalogStoreForTest(createToolCatalogStore())

  const engine = new ToolCallingEngine()
  const sessionKey = 'opencode-glm-session-3turns'

  // Turn 1: initial request WITH tools
  const t1 = engine.transformRequest({
    request: {
      model: 'glm-5',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'read the README file' },
      ],
      tools: ALL_TOOLS,
    },
    provider: makeProvider('glm'),
    actualModel: 'glm-5',
    requestId: 'glm-3turn-r1',
    toolSessionKey: sessionKey,
  })
  assert.equal(t1.plan.catalogDiagnostics.source, 'current_request')
  assert.equal(t1.plan.catalogSnapshot!.tools.length, 4)
  const fp1 = t1.plan.catalogSnapshot!.fingerprint
  console.log(`  Turn 1: source=${t1.plan.catalogDiagnostics.source}, fingerprint=${fp1.slice(0, 12)}...`)

  // Turn 2: multi-turn continuation WITH tools (simulating OpenCode sends tools every turn)
  const t2 = engine.transformRequest({
    request: {
      model: 'glm-5',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'read the README file' },
        {
          role: 'assistant',
          content: null as any,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"README.md"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '# Project\n\nHello world.' },
        { role: 'user', content: 'now write a summary' },
      ],
      tools: ALL_TOOLS,
    },
    provider: makeProvider('glm'),
    actualModel: 'glm-5',
    requestId: 'glm-3turn-r2',
    toolSessionKey: sessionKey,
  })
  assert.equal(t2.plan.catalogDiagnostics.source, 'current_request')
  assert.equal(t2.plan.catalogSnapshot!.tools.length, 4)
  console.log(`  Turn 2: source=${t2.plan.catalogDiagnostics.source}, fingerprint=${t2.plan.catalogSnapshot!.fingerprint.slice(0, 12)}...`)

  // Turn 3: continuation WITHOUT tools (simulates OpenCode may not send tools in late turns)
  const t3 = engine.transformRequest({
    request: {
      model: 'glm-5',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'read the README file' },
        {
          role: 'assistant',
          content: null as any,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"README.md"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '# Project\n\nHello world.' },
        {
          role: 'assistant',
          content: null as any,
          tool_calls: [
            { id: 'call_2', type: 'function', function: { name: 'write', arguments: '{"file_path":"summary.md","content":"ok"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_2', content: 'File written.' },
        { role: 'assistant', content: 'Done.' },
        { role: 'user', content: 'now also grep for TODOs and run the build' },
      ],
      tools: undefined, // ← OpenCode might NOT send tools in late turns
    },
    provider: makeProvider('glm'),
    actualModel: 'glm-5',
    requestId: 'glm-3turn-r3',
    toolSessionKey: sessionKey,
  })

  console.log(`  Turn 3: source=${t3.plan.catalogDiagnostics.source}`)
  console.log(`  Turn 3: shouldInjectPrompt=${t3.plan.shouldInjectPrompt}`)
  console.log(`  Turn 3: mode=${t3.plan.mode}`)

  // This is the key assertion: Turn 3 should find the session catalog
  if (t3.plan.catalogDiagnostics.source === 'restored_from_history') {
    console.log('\n  *** BUG REPRODUCED: Turn 3 with tools=undefined hits restored_from_history! ***')
    console.log('  This means the in-memory session catalog was NOT found.')
    console.log('  Tools will have empty descriptions — model cannot call them effectively.\n')
    for (const tool of t3.plan.catalogSnapshot?.tools ?? []) {
      console.log(`    ${tool.name}: description="${tool.description.slice(0, 40)}" | keys=${Object.keys(tool.parameters.properties ?? {}).length}`)
    }
    // The bug is that restored_from_history creates stubs
    assert.equal(t3.plan.mode, 'managed')
    // Fail with clear message
    assert.equal(t3.plan.catalogDiagnostics.source, 'session_catalog',
      'BUG: Turn 3 should hit session_catalog, not restored_from_history. ' +
      'This means the in-memory catalog was lost between turns.')
  } else {
    console.log(`  Turn 3 tools:`)
    for (const tool of t3.plan.catalogSnapshot?.tools ?? []) {
      console.log(`    ${tool.name}: desc="${tool.description.slice(0, 50)}..." | schemas=${Object.keys(tool.parameters.properties ?? {}).length}`)
      assert.ok(tool.description.length > 0, `"${tool.name}" should have non-empty description`)
    }
    console.log('  VERDICT: Tools survive all 3 turns within same session.\n')
  }
})

// ---------------------------------------------------------------------------
// PROBE 6: Turn 3 WITHOUT toolSessionKey → session mismatch (real-world risk)
// ---------------------------------------------------------------------------
test('GLM adapter: turn 3 without toolSessionKey → session mismatch causes restored_from_history', () => {
  __resetCatalogStoreForTest(createToolCatalogStore())
  const engine = new ToolCallingEngine()

  // Turn 1: WITH toolSessionKey
  engine.transformRequest({
    request: {
      model: 'glm-5',
      messages: [{ role: 'user', content: 'hello' }],
      tools: ALL_TOOLS,
    },
    provider: makeProvider('glm'),
    actualModel: 'glm-5',
    requestId: 'glm-key-r1',
    toolSessionKey: 'proper-session-key',
  })

  // Turn 3: WITHOUT toolSessionKey → falls back to requestId
  const t3 = engine.transformRequest({
    request: {
      model: 'glm-5',
      messages: multiTurnMessages(),
      tools: undefined,
    },
    provider: makeProvider('glm'),
    actualModel: 'glm-5',
    requestId: 'glm-key-r3', // ← different from Turn 1's requestId AND no toolSessionKey
    // No toolSessionKey!
  })

  console.log(`\n  Turn 3 WITHOUT toolSessionKey:`)
  console.log(`    source = ${t3.plan.catalogDiagnostics.source}`)
  console.log(`    sessionId used = requestId = "glm-key-r3" (DIFFERENT from Turn 1's "proper-session-key")`)

  if (t3.plan.catalogDiagnostics.source === 'restored_from_history') {
    console.log('  *** RISK CONFIRMED: Without toolSessionKey, each turn uses requestId as sessionId.')
    console.log('  Different requestIds = different sessions = catalog NOT found.')
    console.log('  The forwarder uses buildToolCatalogSessionKey which IS consistent,')
    console.log('  but any code path that omits toolSessionKey will hit this bug.\n')
  }
})
