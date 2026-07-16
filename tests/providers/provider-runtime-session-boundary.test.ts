import test from 'node:test'
import assert from 'node:assert/strict'

import { buildRequestAssembly } from '../../src/main/proxy/RequestAssembly.ts'
import { ProviderRuntime } from '../../src/main/proxy/services/ProviderRuntime.ts'
import { conversationStateCache } from '../../src/main/proxy/services/providerConversationState.ts'
import type { ProviderRuntimeRequest } from '../../src/main/proxy/plugins/types.ts'
import type { WebProviderPlugin } from '../../src/main/proxy/plugins/WebProviderPlugin.ts'

function fakePlugin(records: { input?: ProviderRuntimeRequest }): WebProviderPlugin {
  return {
    id: 'qwen',
    version: 'test',
    matches: () => true,
    capabilities: {
      supportsProviderSession: true,
      supportsParentMessageId: true,
      supportsDeleteSession: false,
      supportsStreaming: false,
      supportsNonStreaming: true,
      supportsNativeTools: false,
      preferredManagedProtocol: 'managed_xml',
      sessionIdKind: 'session_id',
      transport: 'provider_chat_api',
    },
    async buildRequest(input) {
      records.input = input
      return {
        url: 'https://example.invalid/chat',
        method: 'POST',
        headers: {},
        body: { session_id: input.sessionId ?? '' },
        sessionId: input.sessionId ?? 'fresh-session',
        reqId: 'req-provider',
      }
    },
    async parseNonStream(input) {
      return { sessionId: '', reqId: '', response: input }
    },
  }
}

function runtimeInput(boundary: 'normal' | 'client_compact' | 'server_summary') {
  const messages = [{ role: 'user' as const, content: 'Continue.' }]
  return {
    request: { model: 'Qwen3-Max', messages, stream: false },
    provider: { id: 'qwen', name: 'Qwen' } as any,
    account: { id: 'acc-1', credentials: {} } as any,
    actualModel: 'Qwen3-Max',
    context: {
      requestId: 'req-1',
      model: 'Qwen3-Max',
      startTime: 1,
      isStream: false,
      toolCatalogSessionKey: 'tool-key',
      providerConversationSessionKey: `provider-key:${boundary}`,
      parentProviderConversationSessionKey: 'provider-key:normal',
      sessionBoundaryReason: boundary,
    },
    assembly: buildRequestAssembly({ messages, toolManifest: null }),
    transformed: {
      messages,
      tools: undefined,
      plan: { mode: 'disabled', protocolId: 'none', shouldParseResponse: false, tools: [] },
    } as any,
    promptRefreshMode: boundary === 'normal' ? 'minimal' as const : 'digest' as const,
    conversationStateKey: `provider-key:${boundary}`,
    toolSessionKey: 'tool-key',
  }
}

test('ProviderRuntime normal request reuses the prior provider session id', async () => {
  conversationStateCache.clear()
  conversationStateCache.set('provider-key:normal', { providerSessionId: 'parent-session', providerParentReqId: 'parent-req', lastUsedAt: Date.now() })
  const records: { input?: ProviderRuntimeRequest } = {}
  const plugin = fakePlugin(records)
  const runtime = new ProviderRuntime({
    pluginResolver: async () => plugin,
    transport: async request => ({ status: 200, headers: {}, data: request.body }),
  })

  await runtime.forward(runtimeInput('normal'))

  assert.equal(records.input?.sessionBoundaryPlan?.providerSessionAction, 'reuse_parent')
  assert.equal(records.input?.sessionId, 'parent-session')
  assert.equal(records.input?.parentReqId, 'parent-req')
})

test('ProviderRuntime applies minimal prompt projection before every provider plugin', async () => {
  conversationStateCache.clear()
  conversationStateCache.set('provider-key:normal', { providerSessionId: 'parent-session', lastUsedAt: Date.now() })
  const records: { input?: ProviderRuntimeRequest } = {}
  const plugin = fakePlugin(records)
  const runtime = new ProviderRuntime({
    pluginResolver: async () => plugin,
    transport: async request => ({ status: 200, headers: {}, data: request.body }),
  })
  const input = runtimeInput('normal')
  input.request.messages = [
    { role: 'user', content: 'Old turn.' },
    { role: 'assistant', content: 'Old response.' },
    { role: 'user', content: 'Current turn.' },
  ]
  input.assembly = buildRequestAssembly({
    messages: input.request.messages,
    toolManifest: { renderedPrompt: 'current tool catalog' } as any,
    summaryText: 'old summary',
  })

  await runtime.forward(input)

  assert.ok(records.input?.assembly.messages.some(message => message.content === 'Current turn.'), 'minimal includes the current turn')
  assert.equal(records.input?.assembly.summaryText, null)
  assert.ok(records.input?.assembly.toolManifest, 'minimal must keep toolManifest — managed XML tools are prompt-embedded')
})

for (const boundary of ['client_compact'] as const) {
  test(`ProviderRuntime ${boundary} omits stale provider session ids`, async () => {
    conversationStateCache.clear()
    conversationStateCache.set(`provider-key:${boundary}`, { providerSessionId: 'stale-session', providerParentReqId: 'stale-req', lastUsedAt: Date.now() })
    const records: { input?: ProviderRuntimeRequest } = {}
    const plugin = fakePlugin(records)
    const runtime = new ProviderRuntime({
      pluginResolver: async () => plugin,
      transport: async request => ({ status: 200, headers: {}, data: request.body }),
    })

    await runtime.forward(runtimeInput(boundary))

    assert.equal(records.input?.sessionBoundaryPlan?.providerSessionAction, 'start_fresh')
    assert.equal(records.input?.sessionId, undefined)
    assert.equal(records.input?.parentReqId, undefined)
  })
}

test('ProviderRuntime server_summary reuses existing provider session on subsequent turns', async () => {
  conversationStateCache.clear()
  conversationStateCache.set('provider-key:server_summary', { providerSessionId: 'existing-session', providerParentReqId: 'existing-req', lastUsedAt: Date.now() })
  const records: { input?: ProviderRuntimeRequest } = {}
  const plugin = fakePlugin(records)
  const runtime = new ProviderRuntime({
    pluginResolver: async () => plugin,
    transport: async request => ({ status: 200, headers: {}, data: request.body }),
  })

  await runtime.forward(runtimeInput('server_summary'))

  assert.equal(records.input?.sessionBoundaryPlan?.providerSessionAction, 'reuse_parent')
  assert.equal(records.input?.sessionId, 'existing-session')
  assert.equal(records.input?.parentReqId, 'existing-req')
})
