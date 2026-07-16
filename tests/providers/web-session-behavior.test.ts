/**
 * Node H1 — Deterministic Web Session Behavior Tests
 *
 * Verify session identity derivation and tool catalog independence.
 * These tests cover the 5 missing scenarios from the session economy plan.
 *
 * Run: node --test tests/providers/web-session-behavior.test.ts
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { deriveOpenAISessionIdentity } from '../../src/main/proxy/routes/openaiSession.ts'
import {
  deriveChildProxyContext,
  forkProviderConversationContext,
} from '../../src/main/proxy/sessionBoundary.ts'
import { ProviderRuntime } from '../../src/main/proxy/services/ProviderRuntime.ts'
import { conversationStateCache } from '../../src/main/proxy/services/providerConversationState.ts'
import { createToolCatalogStore } from '../../src/main/proxy/toolCalling/catalog.ts'
import { createFileCatalogPersistence } from '../../src/main/proxy/toolCalling/catalogPersistence.ts'
import type { ProxyContext } from '../../src/main/proxy/types.ts'
import type { ChatCompletionRequest, ChatMessage } from '../../src/main/proxy/types.ts'
import fs from 'fs'
import os from 'os'
import path from 'path'

// ── Helpers ──────────────────────────────────────────────────────────

function makeRequest(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: 'qwen3-coder',
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
    ],
    stream: false,
    ...overrides,
  }
}

function makeContext(overrides: Partial<ProxyContext> = {}): ProxyContext {
  return {
    requestId: 'req-test',
    providerId: 'qwen',
    accountId: 'acc-test',
    model: 'qwen3-coder',
    actualModel: 'qwen3-coder',
    startTime: 1,
    isStream: false,
    toolCatalogSessionKey: 'openai-chat:tool-catalog-abc',
    providerConversationSessionKey: 'openai-chat:provider-session-xyz',
    providerSessionEpoch: 'main',
    sessionBoundaryReason: 'normal',
    ...overrides,
  }
}

// ── Test 1: Normal continuation reuses provider session identity ─────

test('normal continuation reuses provider session identity', () => {
  const req1 = makeRequest({
    user: 'session-abc-123',
    messages: [
      { role: 'user', content: 'First message' },
    ],
  })

  const req2 = makeRequest({
    user: 'session-abc-123',
    messages: [
      { role: 'user', content: 'First message' },
      { role: 'assistant', content: 'Response to first' },
      { role: 'user', content: 'Follow-up question' },
    ],
  })

  const id1 = deriveOpenAISessionIdentity({ request: req1 })
  const id2 = deriveOpenAISessionIdentity({ request: req2 })

  assert.equal(id1.sessionBoundaryReason, 'normal',
    'first request should be normal continuation')
  assert.equal(id2.sessionBoundaryReason, 'normal',
    'follow-up should be normal continuation')
  assert.equal(id1.providerConversationSessionKey, id2.providerConversationSessionKey,
    'same user field should produce same provider session key')
  assert.equal(id1.toolCatalogSessionKey, id2.toolCatalogSessionKey,
    'same user field should produce same tool catalog key')
})

test('normal continuation with different user values forks identity', () => {
  const req1 = makeRequest({
    user: 'session-alpha',
    messages: [{ role: 'user', content: 'A' }],
  })
  const req2 = makeRequest({
    user: 'session-beta',
    messages: [{ role: 'user', content: 'B' }],
  })

  const id1 = deriveOpenAISessionIdentity({ request: req1 })
  const id2 = deriveOpenAISessionIdentity({ request: req2 })

  assert.notEqual(id1.providerConversationSessionKey, id2.providerConversationSessionKey,
    'different user values should produce different provider session keys')
  assert.notEqual(id1.toolCatalogSessionKey, id2.toolCatalogSessionKey,
    'different user values should produce different tool catalog keys')
})

// ── Test 2: Compact forks provider session but keeps tool catalog ────

test('compact forks provider session but keeps tool catalog identity', () => {
  const baseReq = makeRequest({
    user: 'session-compact-test',
    messages: [
      { role: 'user', content: 'Initial request' },
    ],
  })

  const compactReq = makeRequest({
    user: 'session-compact-test',
    messages: [
      { role: 'system', content: '[prior conversation summary: the user asked about X and received answer Y. The task is to continue debugging.]' },
      { role: 'user', content: 'Continue the task' },
    ],
  })

  const baseId = deriveOpenAISessionIdentity({ request: baseReq })
  const compactId = deriveOpenAISessionIdentity({ request: compactReq })

  assert.equal(baseId.sessionBoundaryReason, 'normal')
  assert.equal(compactId.sessionBoundaryReason, 'client_compact',
    'compact marker should trigger client_compact boundary')
  assert.equal(baseId.toolCatalogSessionKey, compactId.toolCatalogSessionKey,
    'tool catalog identity must survive compact fork')
  assert.notEqual(baseId.providerConversationSessionKey, compactId.providerConversationSessionKey,
    'provider session identity must fork on compact')
  assert.ok(
    compactId.providerConversationSessionKey.includes(':compact:'),
    `forked key should contain :compact: segment, got ${compactId.providerConversationSessionKey}`
  )
})

test('forkProviderConversationContext for server_summary keeps separate identity', () => {
  const context = makeContext()
  const forked = forkProviderConversationContext(context, {
    reason: 'server_summary',
    epochSource: { model: 'qwen3-coder', messageCount: 50 },
  })

  assert.notEqual(forked.providerConversationSessionKey, context.providerConversationSessionKey)
  assert.ok(forked.providerConversationSessionKey.includes(':server_summary:'))
  assert.equal(forked.parentProviderConversationSessionKey, context.providerConversationSessionKey)
  assert.equal(forked.toolCatalogSessionKey, context.toolCatalogSessionKey,
    'tool catalog identity must survive server_summary fork')
})

test('server_summary epoch ignores raw message content churn and stays tied to logical compact metadata', () => {
  const context = makeContext()
  const forkA = forkProviderConversationContext(context, {
    reason: 'server_summary',
    epochSource: {
      model: 'qwen3-coder',
      originalMessageCount: 32,
      finalMessageCount: 8,
      summaryKinds: ['prior_summary', 'completed_tool_handoff'],
      workflowToolNames: ['read', 'bash'],
    },
  })
  const forkB = forkProviderConversationContext(context, {
    reason: 'server_summary',
    epochSource: {
      model: 'qwen3-coder',
      originalMessageCount: 32,
      finalMessageCount: 8,
      summaryKinds: ['prior_summary', 'completed_tool_handoff'],
      workflowToolNames: ['read', 'bash'],
      rawMessages: [
        { role: 'tool', content: 'THIS_FIELD_SHOULD_NOT_BE_PART_OF_REAL_EPOCH_SOURCE_A' },
        { role: 'tool', content: 'THIS_FIELD_SHOULD_NOT_BE_PART_OF_REAL_EPOCH_SOURCE_B' },
      ],
    },
  })

  assert.equal(forkA.providerConversationSessionKey, forkB.providerConversationSessionKey)
  assert.equal(forkA.providerSessionEpoch, forkB.providerSessionEpoch)
})

// ── Test 3: Tool child keeps tool catalog identity but forks provider ─

test('tool child keeps tool catalog identity but forks provider identity', () => {
  const baseReq = makeRequest({
    user: 'session-toolchild-test',
    messages: [
      { role: 'user', content: 'Read the file' },
    ],
  })

  const toolWorkflowReq = makeRequest({
    user: 'session-toolchild-test',
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Read the file' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'read', arguments: '{"filePath":"/tmp/a"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'file contents here' },
      { role: 'user', content: 'Now edit it' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_2',
          type: 'function',
          function: { name: 'write', arguments: '{"filePath":"/tmp/a","content":"new"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_2', content: '<|chat2api|tool_result>{"status":"completed"}' },
    ],
  })

  const baseId = deriveOpenAISessionIdentity({ request: baseReq })
  const toolId = deriveOpenAISessionIdentity({ request: toolWorkflowReq })

  assert.equal(toolId.sessionBoundaryReason, 'tool_child',
    'active tool workflow should be classified as tool_child')
  assert.equal(baseId.toolCatalogSessionKey, toolId.toolCatalogSessionKey,
    'tool catalog identity must survive tool child fork')
  assert.notEqual(baseId.providerConversationSessionKey, toolId.providerConversationSessionKey,
    'provider session identity must fork for tool child')
  assert.ok(
    toolId.providerConversationSessionKey.includes(':tool:'),
    `forked key should contain :tool: segment, got ${toolId.providerConversationSessionKey}`
  )
})

// ── Test 4: Subagent child forks provider identity once per run ──────

test('subagent child forks provider identity', () => {
  const baseReq = makeRequest({
    user: 'session-subagent-test',
    messages: [{ role: 'user', content: 'Base request' }],
  })

  const subagentReq = makeRequest({
    user: 'session-subagent-test',
    messages: [{ role: 'user', content: 'Subagent task' }],
  })

  const baseId = deriveOpenAISessionIdentity({ request: baseReq })
  const subagentId = deriveOpenAISessionIdentity({
    request: subagentReq,
    headers: { 'x-subagent-id': 'agent-run-42' },
  })

  assert.equal(subagentId.sessionBoundaryReason, 'subagent_child',
    'subagent header should trigger subagent_child boundary')
  assert.equal(baseId.toolCatalogSessionKey, subagentId.toolCatalogSessionKey,
    'tool catalog identity must survive subagent fork')
  assert.notEqual(baseId.providerConversationSessionKey, subagentId.providerConversationSessionKey,
    'provider session identity must fork for subagent')
  assert.ok(
    subagentId.providerConversationSessionKey.includes(':subagent:'),
    `forked key should contain :subagent: segment`
  )
})

test('subagent child with same run id produces consistent identity', () => {
  const req = makeRequest({
    user: 'session-subagent-consistent',
    messages: [{ role: 'user', content: 'Task' }],
  })

  const id1 = deriveOpenAISessionIdentity({
    request: req,
    headers: { 'x-agent-run-id': 'run-consistent-1' },
  })
  const id2 = deriveOpenAISessionIdentity({
    request: req,
    headers: { 'x-agent-run-id': 'run-consistent-1' },
  })

  assert.equal(id1.providerConversationSessionKey, id2.providerConversationSessionKey,
    'same subagent run id should produce consistent provider key')
  assert.equal(id1.sessionBoundaryReason, 'subagent_child')
  assert.equal(id2.sessionBoundaryReason, 'subagent_child')
})

test('deriveChildProxyContext forks child provider identity without reusing the parent epoch', () => {
  const parent = makeContext({
    providerConversationSessionKey: 'openai-chat:provider-session-parent',
    providerSessionEpoch: 'main',
    sessionBoundaryReason: 'normal',
  })

  const toolChild = deriveChildProxyContext(parent, {
    reason: 'tool_child',
    epochSource: { workflowId: 'wf-1', toolName: 'read' },
  })
  const subagentChild = deriveChildProxyContext(parent, {
    reason: 'subagent_child',
    epochSource: { runId: 'run-1' },
  })

  assert.equal(toolChild.parentProviderConversationSessionKey, parent.providerConversationSessionKey)
  assert.equal(subagentChild.parentProviderConversationSessionKey, parent.providerConversationSessionKey)
  assert.equal(toolChild.toolCatalogSessionKey, parent.toolCatalogSessionKey)
  assert.equal(subagentChild.toolCatalogSessionKey, parent.toolCatalogSessionKey)
  assert.equal(toolChild.sessionBoundaryReason, 'tool_child')
  assert.equal(subagentChild.sessionBoundaryReason, 'subagent_child')
  assert.notEqual(toolChild.providerConversationSessionKey, parent.providerConversationSessionKey)
  assert.notEqual(subagentChild.providerConversationSessionKey, parent.providerConversationSessionKey)
  assert.notEqual(toolChild.providerConversationSessionKey, subagentChild.providerConversationSessionKey)
  assert.notEqual(toolChild.providerSessionEpoch, parent.providerSessionEpoch)
  assert.notEqual(subagentChild.providerSessionEpoch, parent.providerSessionEpoch)
  assert.match(toolChild.providerSessionEpoch ?? '', /^tool_child:/)
  assert.match(subagentChild.providerSessionEpoch ?? '', /^subagent_child:/)
})

test('ProviderRuntime child boundaries do not read fallback provider state from the parent tool session key', () => {
  conversationStateCache.clear()
  conversationStateCache.set('tool:main', {
    qwenSessionId: 'stale-parent-tool-session',
    qwenParentReqId: 'stale-parent-tool-parent',
    lastUsedAt: Date.now(),
  })

  const runtime = new ProviderRuntime()

  const toolChildState = runtime.readSessionState({
    conversationStateKey: 'provider:tool-child',
    toolSessionKey: 'tool:main',
    context: makeContext({
      providerConversationSessionKey: 'provider:tool-child',
      parentProviderConversationSessionKey: 'provider:main',
      providerSessionEpoch: 'tool_child:child-1',
      sessionBoundaryReason: 'tool_child',
    }),
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'read', arguments: '{"filePath":"tests/agent-capability/input.txt"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'input body' },
    ],
    providerStateShape: 'qwen',
  })

  const subagentChildState = runtime.readSessionState({
    conversationStateKey: 'provider:subagent-child',
    toolSessionKey: 'tool:main',
    context: makeContext({
      providerConversationSessionKey: 'provider:subagent-child',
      parentProviderConversationSessionKey: 'provider:main',
      providerSessionEpoch: 'subagent_child:child-2',
      sessionBoundaryReason: 'subagent_child',
    }),
    messages: [{ role: 'user', content: 'bounded child task' }],
    providerStateShape: 'qwen',
  })

  assert.equal(toolChildState, undefined)
  assert.equal(subagentChildState, undefined)
})

test('ProviderRuntime child boundaries write only to the child key and parent handoff key', () => {
  conversationStateCache.clear()
  conversationStateCache.set('tool:main', {
    qwenSessionId: 'stale-parent-tool-session',
    qwenParentReqId: 'stale-parent-tool-parent',
    lastUsedAt: Date.now(),
  })

  const runtime = new ProviderRuntime()
  runtime.writeSessionState({
    conversationStateKey: 'provider:tool-child',
    toolSessionKey: 'tool:main',
    context: makeContext({
      providerConversationSessionKey: 'provider:tool-child',
      parentProviderConversationSessionKey: 'provider:main',
      providerSessionEpoch: 'tool_child:child-1',
      sessionBoundaryReason: 'tool_child',
    }),
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'read', arguments: '{"filePath":"tests/agent-capability/input.txt"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'input body' },
    ],
    update: {
      qwenSessionId: 'fresh-child-session',
      qwenParentReqId: 'fresh-child-parent',
    },
    parentHandoff: {
      kind: 'tool_child',
      status: 'ok',
      summary: 'Child read completed.',
      evidence: [{ label: 'tool', value: 'read:call_1' }],
    },
  })

  assert.equal(conversationStateCache.get('provider:tool-child')?.qwenSessionId, 'fresh-child-session')
  assert.equal(conversationStateCache.get('provider:tool-child')?.qwenParentReqId, 'fresh-child-parent')
  assert.equal(conversationStateCache.get('provider:main')?.childSessionHandoff?.summary, 'Child read completed.')
  assert.equal(conversationStateCache.get('tool:main')?.qwenSessionId, 'stale-parent-tool-session')
  assert.equal(conversationStateCache.get('tool:main')?.qwenParentReqId, 'stale-parent-tool-parent')
})

test('ProviderRuntime child boundary write attaches childProviderSessionId to the stored parent handoff', () => {
  conversationStateCache.clear()

  const runtime = new ProviderRuntime()
  runtime.writeSessionState({
    conversationStateKey: 'provider:tool-child',
    toolSessionKey: 'tool:main',
    context: makeContext({
      providerConversationSessionKey: 'provider:tool-child',
      parentProviderConversationSessionKey: 'provider:main',
      providerSessionEpoch: 'tool_child:child-attach',
      sessionBoundaryReason: 'tool_child',
    }),
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'read', arguments: '{"filePath":"tests/agent-capability/input.txt"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'input body' },
    ],
    update: {
      qwenSessionId: 'fresh-child-session',
      qwenParentReqId: 'fresh-child-parent',
    },
    parentHandoff: {
      kind: 'tool_child',
      status: 'ok',
      summary: 'Child read completed.',
      evidence: [{ label: 'tool', value: 'read:call_1' }],
    },
  })

  assert.equal(conversationStateCache.get('provider:main')?.childSessionHandoff?.childProviderSessionId, 'fresh-child-session')
})

// ── Test 5: Tool definitions survive omitted-tools follow-up turns ────

test('tool definitions survive omitted-tools follow-up turns', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1-tool-catalog-'))
  const filePath = path.join(tmpDir, 'catalog.json')
  const persistence = createFileCatalogPersistence(filePath)
  const store = createToolCatalogStore(persistence)

  const sessionId = 'openai-chat:session-omit-tools'

  // Turn 1: tools are provided
  const result1 = store.resolveSnapshot({
    sessionId,
    requestTools: [
      { name: 'bash', description: 'Run shell', parameters: { type: 'object', properties: {}, required: [] }, source: 'openai' },
      { name: 'read', description: 'Read file', parameters: { type: 'object', properties: {}, required: [] }, source: 'openai' },
    ],
    hasManagedToolHistory: false,
    historyToolNames: [],
  })

  assert.equal(result1.blocked, false)
  assert.equal(result1.snapshot!.tools.length, 2)
  assert.equal(result1.diagnostics.source, 'current_request')

  // Turn 2: tools NOT provided in request, but history has tool messages
  const result2 = store.resolveSnapshot({
    sessionId,
    requestTools: [],
    hasManagedToolHistory: true,
    historyToolNames: ['bash', 'read'],
  })

  assert.equal(result2.blocked, false)
  assert.equal(result2.diagnostics.source, 'session_catalog',
    'should resolve from persisted session catalog when request omits tools')
  assert.equal(result2.snapshot!.tools.length, 2,
    'both tools should survive the omitted-tools turn')
  assert.equal(result2.snapshot!.tools[0].name, 'bash')
  assert.equal(result2.snapshot!.tools[1].name, 'read')

  // Turn 3: tools still omitted, history still has tool messages
  const result3 = store.resolveSnapshot({
    sessionId,
    requestTools: [],
    hasManagedToolHistory: true,
    historyToolNames: ['bash', 'read'],
  })

  assert.equal(result3.blocked, false)
  assert.equal(result3.diagnostics.source, 'session_catalog',
    'third turn without tools should still resolve from session catalog')
  assert.equal(result3.snapshot!.tools.length, 2)

  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('tool definitions survive when only history names are available (degraded)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1-tool-degraded-'))
  const filePath = path.join(tmpDir, 'catalog.json')
  const persistence = createFileCatalogPersistence(filePath)
  const store = createToolCatalogStore(persistence)

  const sessionId = 'openai-chat:session-degraded'

  // No prior session — fall back to history extraction
  const result = store.resolveSnapshot({
    sessionId,
    requestTools: [],
    hasManagedToolHistory: true,
    historyToolNames: ['bash', 'read', 'write'],
  })

  assert.equal(result.blocked, false)
  assert.equal(result.diagnostics.source, 'restored_from_history',
    'without prior session, should fall back to history extraction')
  assert.equal(result.snapshot!.tools.length, 3)
  assert.equal(result.snapshot!.tools[0].name, 'bash')
  assert.equal(result.snapshot!.tools[1].name, 'read')
  assert.equal(result.snapshot!.tools[2].name, 'write')

  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('ProviderRuntime compact boundaries do not read fallback provider state from the tool session key', () => {
  conversationStateCache.clear()
  conversationStateCache.set('tool:main', {
    qwenSessionId: 'stale-tool-session',
    qwenParentReqId: 'stale-tool-parent',
    lastUsedAt: Date.now(),
  })

  const runtime = new ProviderRuntime()

  const state = runtime.readSessionState({
    conversationStateKey: 'provider:server-summary',
    toolSessionKey: 'tool:main',
    context: makeContext({
      providerConversationSessionKey: 'provider:server-summary',
      parentProviderConversationSessionKey: 'provider:main',
      sessionBoundaryReason: 'server_summary',
    }),
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'read', arguments: '{"filePath":"tests/agent-capability/input.txt"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'input body' },
    ],
    providerStateShape: 'qwen',
  })

  assert.equal(state, undefined)
})

test('ProviderRuntime compact boundaries write only to the compact epoch key and do not mirror to the fallback tool key', () => {
  conversationStateCache.clear()
  conversationStateCache.set('tool:main', {
    qwenSessionId: 'stale-tool-session',
    qwenParentReqId: 'stale-tool-parent',
    lastUsedAt: Date.now(),
  })

  const runtime = new ProviderRuntime()
  runtime.writeSessionState({
    conversationStateKey: 'provider:server-summary',
    toolSessionKey: 'tool:main',
    context: makeContext({
      providerConversationSessionKey: 'provider:server-summary',
      parentProviderConversationSessionKey: 'provider:main',
      sessionBoundaryReason: 'server_summary',
    }),
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'read', arguments: '{"filePath":"tests/agent-capability/input.txt"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'input body' },
    ],
    update: {
      qwenSessionId: 'fresh-compact-session',
      qwenParentReqId: 'fresh-compact-parent',
    },
  })

  assert.equal(conversationStateCache.get('provider:server-summary')?.qwenSessionId, 'fresh-compact-session')
  assert.equal(conversationStateCache.get('provider:server-summary')?.qwenParentReqId, 'fresh-compact-parent')
  assert.equal(conversationStateCache.get('tool:main')?.qwenSessionId, 'stale-tool-session')
  assert.equal(conversationStateCache.get('tool:main')?.qwenParentReqId, 'stale-tool-parent')
})
