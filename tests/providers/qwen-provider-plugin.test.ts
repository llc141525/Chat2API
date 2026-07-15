/**
 * Node F Phase 1 — WebProviderPlugin interface contract tests
 *
 * These tests verify the plugin interface contract for the Qwen provider.
 * Run: node --test tests/providers/qwen-provider-plugin.test.ts
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import type { WebProviderPlugin } from '../../src/main/proxy/plugins/WebProviderPlugin.ts'
import type {
  ProviderPluginCapabilities,
  ProviderRuntimeRequest,
} from '../../src/main/proxy/plugins/types.ts'
import type { RequestAssembly } from '../../src/main/proxy/RequestAssembly.ts'

// ── Helpers ──────────────────────────────────────────────────────────

function makeProvider(overrides: Partial<{ id: string; name: string }> = {}) {
  return {
    id: overrides.id ?? 'qwen',
    name: overrides.name ?? 'Qwen',
  }
}

function makeAccount(overrides: Partial<{ ticket: string }> = {}) {
  return {
    id: 'test-account',
    name: 'Test Account',
    credentials: {
      ticket: overrides.ticket ?? 'test-ticket',
    },
  }
}

function makeBasicRequest(overrides: Partial<ProviderRuntimeRequest> = {}): ProviderRuntimeRequest {
  const messages = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hello' },
  ]
  return {
    provider: makeProvider(),
    account: makeAccount(),
    model: 'qwen3-coder',
    messages,
    assembly: makeAssembly(messages),
    stream: false,
    ...overrides,
  }
}

function makeAssembly(messages: ProviderRuntimeRequest['messages'], overrides: Partial<RequestAssembly> = {}): RequestAssembly {
  return {
    messages: messages as any,
    toolManifest: null,
    summaryText: null,
    metadata: {
      contextManagementApplied: false,
      strategiesExecuted: [],
      originalMessageCount: messages.length,
      finalMessageCount: messages.length,
    },
    ...overrides,
  }
}

function bodyContent(body: any): string {
  return String(body?.messages?.[0]?.content ?? '')
}

// ── Plugin loading ───────────────────────────────────────────────────

let plugin: WebProviderPlugin | undefined

async function loadPlugin(): Promise<WebProviderPlugin> {
  if (plugin) return plugin
  const mod = await import('../../src/main/proxy/plugins/QwenProviderPlugin.ts')
  plugin = mod.QwenProviderPlugin as WebProviderPlugin
  return plugin
}

// ── Interface contract tests ─────────────────────────────────────────

test('plugin has required identity fields', async () => {
  const p = await loadPlugin()

  assert.equal(typeof p.id, 'string')
  assert.ok(p.id.length > 0, 'id must not be empty')
  assert.equal(typeof p.version, 'string')
  assert.ok(p.version.length > 0, 'version must not be empty')
})

test('plugin matches qwen provider', async () => {
  const p = await loadPlugin()

  assert.equal(p.matches({ id: 'qwen' }), true)
  assert.equal(p.matches({ id: 'QWEN' }), true, 'should be case-insensitive')
  assert.equal(p.matches({ id: 'glm' }), false)
  assert.equal(p.matches({ id: 'unknown-provider' }), false)
})

test('plugin declares qwen capabilities', async () => {
  const p = await loadPlugin()

  const caps: ProviderPluginCapabilities = p.capabilities

  // Qwen-specific expected capabilities
  assert.equal(caps.supportsProviderSession, true, 'Qwen supports provider sessions')
  assert.equal(caps.supportsParentMessageId, true, 'Qwen supports parent message id')
  assert.equal(caps.supportsDeleteSession, true, 'Qwen supports session deletion')
  assert.equal(caps.supportsStreaming, true, 'Qwen supports streaming')
  assert.equal(caps.supportsNonStreaming, true, 'Qwen supports non-streaming')
  assert.equal(caps.supportsNativeTools, false, 'Qwen uses managed XML tools, not native')
  assert.equal(caps.preferredManagedProtocol, 'managed_xml')
  assert.equal(caps.sessionIdKind, 'session_id')
  assert.equal(caps.transport, 'provider_chat_api')
})

// ── buildRequest tests ───────────────────────────────────────────────

test('buildRequest returns valid ProviderWebRequest', async () => {
  const p = await loadPlugin()
  const input = makeBasicRequest()

  const req = await p.buildRequest(input)

  assert.equal(typeof req.url, 'string')
  assert.ok(req.url.length > 0, 'url must not be empty')
  assert.equal(req.method, 'POST')
  assert.equal(typeof req.sessionId, 'string')
  assert.ok(req.sessionId.length > 0, 'sessionId must not be empty')
  assert.equal(typeof req.reqId, 'string')
  assert.ok(req.reqId.length > 0, 'reqId must not be empty')
  assert.ok(typeof req.headers === 'object' && req.headers !== null)
  assert.ok(req.body !== undefined, 'body must not be undefined')
  assert.equal(req.transportOptions?.responseType, 'stream')
  assert.equal(req.transportOptions?.timeout, 120000)
  assert.equal(req.transportOptions?.decompress, false)
})

test('buildRequest includes cookie header with ticket', async () => {
  const p = await loadPlugin()
  const input = makeBasicRequest({
    account: makeAccount({ ticket: 'my-test-ticket' }),
  })

  const req = await p.buildRequest(input)

  const cookieHeader = Object.entries(req.headers).find(
    ([key]) => key.toLowerCase() === 'cookie'
  )
  assert.ok(cookieHeader, 'must include cookie header')
  assert.ok(
    String(cookieHeader[1]).includes('my-test-ticket'),
    'cookie must contain the ticket value'
  )
  assert.equal(req.headers.Accept, 'application/json, text/event-stream, text/plain, */*')
  assert.equal(req.headers.Origin, 'https://www.qianwen.com')
  assert.equal(req.headers.Referer, 'https://www.qianwen.com/')
  assert.match(String(req.headers['User-Agent'] ?? ''), /Mozilla\/5\.0/)
})

test('buildRequest reuses sessionId when provided', async () => {
  const p = await loadPlugin()
  const input = makeBasicRequest({ sessionId: 'existing-session' })

  const req = await p.buildRequest(input)

  assert.equal(req.sessionId, 'existing-session')
})

test('buildRequest generates new sessionId when not provided', async () => {
  const p = await loadPlugin()
  const input = makeBasicRequest()
  // sessionId is not set

  const req = await p.buildRequest(input)

  assert.ok(req.sessionId.length > 0, 'must generate a sessionId')
  assert.equal((req.body as any).scene_param, 'first_turn')
  assert.equal((req.body as any).parent_req_id, '0')
})

test('buildRequest keeps continuation semantics only when an upstream provider session exists', async () => {
  const p = await loadPlugin()
  const input = makeBasicRequest({
    sessionId: 'existing-provider-session',
    parentReqId: 'existing-parent-req',
  })

  const req = await p.buildRequest(input)

  assert.equal(req.sessionId, 'existing-provider-session')
  assert.equal((req.body as any).scene_param, 'chat')
  assert.equal((req.body as any).parent_req_id, 'existing-parent-req')
})

test('buildRequest preserves real assembly tool manifest, summary, and prompt refresh mode', async () => {
  const p = await loadPlugin()
  const assemblyMessages = [
    { role: 'system', content: '[Active skill workflow state checkpoint]\nRequired next action: call the bash tool' },
    { role: 'user', content: 'Assembly user message should be used.' },
  ]
  const input = makeBasicRequest({
    messages: [
      { role: 'user', content: 'Legacy messages should not be used.' },
    ],
    assembly: makeAssembly(assemblyMessages, {
      toolManifest: {
        protocol: 'managed_xml',
        catalogFingerprint: 'fingerprint-1',
        allowedToolNames: ['bash'],
        tools: [],
        renderedPrompt: 'Tool Contract Header\ncatalog_fingerprint: fingerprint-1\n<|CHAT2API|tool_calls>',
        contractHeaderVersion: 1,
      },
      summaryText: '[Prior conversation summary]\nUser asked for a UI review.',
      metadata: {
        contextManagementApplied: true,
        strategiesExecuted: ['summary'],
        originalMessageCount: 9,
        finalMessageCount: 2,
      },
    }),
    promptRefreshMode: 'tool_ready',
    sessionBoundaryReason: 'server_summary',
  })

  const req = await p.buildRequest(input)
  const content = bodyContent(req.body)

  assert.match(content, /catalog_fingerprint: fingerprint-1/)
  assert.match(content, /\[Prior conversation summary\]/)
  assert.match(content, /Required next action: call the bash tool/)
  assert.match(content, /The runtime generated this checkpoint from completed OpenCode tool events/)
  assert.doesNotMatch(content, /Legacy messages should not be used/)
})

test('buildRequest passes promptRefreshMode through Qwen assembly path', async () => {
  const p = await loadPlugin()
  const input = makeBasicRequest({
    promptRefreshMode: 'minimal',
    assembly: makeAssembly(
      [{ role: 'user', content: 'Minimal prompt turn.' }],
      {
        toolManifest: {
          protocol: 'managed_xml',
          catalogFingerprint: 'minimal-fingerprint',
          allowedToolNames: ['read'],
          tools: [],
          renderedPrompt: 'catalog_fingerprint: minimal-fingerprint\n<|CHAT2API|tool_calls>',
          contractHeaderVersion: 1,
        },
        summaryText: '[Prior conversation summary]\nThis should be omitted in minimal mode.',
      },
    ),
  })

  const req = await p.buildRequest(input)
  const content = bodyContent(req.body)

  assert.match(content, /Minimal prompt turn/)
  assert.match(content, /minimal-fingerprint/, 'tool contract must remain in minimal mode — Qwen uses managed XML, tools are not native')
  assert.doesNotMatch(content, /This should be omitted in minimal mode/)
})

// ── parseNonStream tests ─────────────────────────────────────────────

test('parseNonStream returns valid ProviderRuntimeResult', async () => {
  const p = await loadPlugin()

  const result = await p.parseNonStream({
    status: 200,
    headers: { 'content-type': 'application/json' },
    data: {},
  })

  assert.equal(typeof result.sessionId, 'string')
  assert.equal(typeof result.reqId, 'string')
  assert.equal(result.response.status, 200)
})

// ── No regression: existing tests must still pass ────────────────────

test('plugin can be imported without side effects on existing adapters', async () => {
  // Import the QwenAdapter directly to verify it still works
  const { QwenAdapter } = await import('../../src/main/proxy/adapters/qwen.ts')
  assert.equal(typeof QwenAdapter, 'function')
  assert.ok(QwenAdapter.prototype.constructor === QwenAdapter)
})

// ── Phase 1 guard: forwarder unchanged ───────────────────────────────

test('forwarder does not import plugin types (Phase 2 concern)', async () => {
  // Read the forwarder source and verify it does NOT import from plugins/
  const fs = await import('fs')
  const forwarderSource = fs.readFileSync('src/main/proxy/forwarder.ts', 'utf-8')
  assert.ok(
    !forwarderSource.includes("from './plugins/") && !forwarderSource.includes("from './plugins"),
    'forwarder must not import plugin types in Phase 1'
  )
})
