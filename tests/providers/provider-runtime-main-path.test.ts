import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

import { ProviderRuntime, type ProviderRuntimeTransport } from '../../src/main/proxy/services/ProviderRuntime.ts'
import type { WebProviderPlugin } from '../../src/main/proxy/plugins/WebProviderPlugin.ts'
import type { ProviderRuntimeRequest, ProviderWebRequest } from '../../src/main/proxy/plugins/types.ts'
import { conversationStateCache } from '../../src/main/proxy/services/providerConversationState.ts'
import { ToolCallingEngine } from '../../src/main/proxy/toolCalling/ToolCallingEngine.ts'
import { QwenProviderPlugin } from '../../src/main/proxy/plugins/QwenProviderPlugin.ts'
import { KimiProviderPlugin } from '../../src/main/proxy/plugins/KimiProviderPlugin.ts'

async function collect(stream: Readable): Promise<string> {
  let output = ''
  for await (const chunk of stream) output += chunk.toString()
  return output
}

function makeAssembly(messages: ProviderRuntimeRequest['messages']) {
  return {
    messages: messages as any,
    toolManifest: {
      protocol: 'managed_xml' as const,
      catalogFingerprint: 'runtime-fingerprint',
      allowedToolNames: ['read'],
      tools: [],
      renderedPrompt: 'catalog_fingerprint: runtime-fingerprint\n<|CHAT2API|tool_calls>',
      contractHeaderVersion: 1,
    },
    summaryText: '[Prior conversation summary]\nRuntime summary.',
    metadata: {
      contextManagementApplied: true,
      strategiesExecuted: ['summary'],
      originalMessageCount: 4,
      finalMessageCount: messages.length,
    },
  }
}

function kimiFrame(payload: Record<string, unknown>): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const header = Buffer.alloc(5)
  header.writeUInt8(0, 0)
  header.writeUInt32BE(body.length, 1)
  return Buffer.concat([header, body])
}

function makeRuntimeInput(overrides: Record<string, unknown> = {}) {
  const messages = [{ role: 'user', content: 'Use runtime' }]
  return {
    request: {
      model: 'Qwen3-Max',
      messages,
      stream: false,
      reasoning_effort: 'medium',
      web_search: true,
    },
    account: {
      id: 'acc-runtime',
      providerId: 'qwen',
      name: 'Runtime Account',
      credentials: { ticket: 'ticket' },
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    },
    provider: {
      id: 'qwen',
      name: 'Qwen',
      type: 'builtin',
      authType: 'token',
      apiEndpoint: '',
      headers: {},
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    },
    actualModel: 'Qwen3-Max',
    context: {
      requestId: 'req-runtime',
      providerId: 'qwen',
      accountId: 'acc-runtime',
      model: 'Qwen3-Max',
      actualModel: 'Qwen3-Max',
      startTime: 1,
      isStream: false,
      toolCatalogSessionKey: 'tool-key',
      providerConversationSessionKey: 'provider-key',
      sessionBoundaryReason: 'server_summary',
    },
    assembly: makeAssembly(messages),
    transformed: {
      messages,
      tools: undefined,
      plan: {
        mode: 'disabled',
        protocol: 'managed_xml',
        clientAdapterId: 'standard-openai-tools',
        providerId: 'qwen',
        tools: [],
        shouldInjectPrompt: false,
        shouldParseResponse: false,
        toolChoiceMode: 'auto',
        allowedToolNames: new Set(),
        catalogDiagnostics: { source: 'none', driftKinds: [], blocked: false },
        availabilityRetryAllowed: false,
        contract: {
          turnId: 'turn-runtime',
          sessionId: null,
          providerId: 'qwen',
          model: 'Qwen3-Max',
          protocol: 'managed_xml',
          snapshotFingerprint: null,
          tools: [],
          allowedToolNames: new Set(),
          toolChoiceMode: 'auto',
          shouldInjectPrompt: false,
          shouldParseResponse: false,
          historyMode: 'openai_native',
          emptyOutputPolicy: 'diagnose_and_fail',
          toolSourceChain: ['current_request', 'session_catalog', 'message_history', 'safe_empty'],
        },
        diagnostics: {
          clientAdapterId: 'standard-openai-tools',
          providerId: 'qwen',
          toolSource: 'openai',
          mode: 'disabled',
          protocol: 'managed_xml',
          toolCount: 0,
          injected: false,
          reason: 'runtime-test',
        },
      },
    },
    promptRefreshMode: 'tool_ready',
    conversationStateKey: 'provider-key',
    toolSessionKey: 'tool-key',
    startTime: Date.now(),
    ...overrides,
  } as any
}

function makeFakePlugin(records: { input?: ProviderRuntimeRequest; webRequest?: ProviderWebRequest }): WebProviderPlugin {
  return {
    id: 'qwen',
    version: 'test',
    matches: provider => provider.id === 'qwen',
    capabilities: {
      supportsProviderSession: true,
      supportsParentMessageId: true,
      supportsDeleteSession: true,
      supportsStreaming: true,
      supportsNonStreaming: true,
      supportsNativeTools: false,
      preferredManagedProtocol: 'managed_xml',
      sessionIdKind: 'session_id',
      transport: 'provider_chat_api',
    },
    async buildRequest(input) {
      records.input = input
      const webRequest = {
        url: 'https://runtime.test/chat',
        method: 'POST' as const,
        headers: { 'x-runtime': '1' },
        body: { promptRefreshMode: input.promptRefreshMode, summaryText: input.assembly.summaryText },
        sessionId: input.sessionId || 'runtime-session',
        reqId: 'runtime-req',
      }
      records.webRequest = webRequest
      return webRequest
    },
    async parseNonStream(input) {
      return {
        sessionId: String((input.data as any).sessionId),
        reqId: String((input.data as any).reqId),
        response: input,
      }
    },
    async *parseStream() {
      yield { type: 'session_update', sessionId: 'stream-session' }
      yield { type: 'text_delta', text: 'runtime stream text' }
      yield { type: 'done', finishReason: 'stop' }
    },
  }
}

test('ProviderRuntime.forward runs plugin build, transport, parseNonStream, and session write', async () => {
  conversationStateCache.clear()
  const records: { input?: ProviderRuntimeRequest; webRequest?: ProviderWebRequest } = {}
  const plugin = makeFakePlugin(records)
  const transport: ProviderRuntimeTransport = async (request) => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    data: { ok: true, sessionId: request.sessionId, reqId: request.reqId },
  })
  const runtime = new ProviderRuntime({
    pluginResolver: async () => plugin,
    transport,
  })

  const result = await runtime.forward(makeRuntimeInput())

  assert.equal(result.success, true)
  assert.deepEqual(result.body, { ok: true, sessionId: 'runtime-session', reqId: 'runtime-req' })
  assert.equal(records.input?.assembly.summaryText, '[Prior conversation summary]\nRuntime summary.')
  assert.equal(records.input?.promptRefreshMode, 'tool_ready')
  assert.equal(records.input?.sessionBoundaryReason, 'server_summary')
  assert.equal(records.input?.enableThinking, true)
  assert.equal(records.input?.enableWebSearch, true)
  assert.equal(records.webRequest?.body && (records.webRequest.body as any).promptRefreshMode, 'tool_ready')
  assert.equal(conversationStateCache.get('provider-key')?.qwenSessionId, 'runtime-session')
  assert.equal(conversationStateCache.get('provider-key')?.qwenParentReqId, 'runtime-req')
})

test('ProviderRuntime.writeSessionState attaches the final provider session id onto a parent handoff for child boundaries', () => {
  conversationStateCache.clear()
  const runtime = new ProviderRuntime()

  runtime.writeSessionState({
    conversationStateKey: 'provider:runtime-child',
    toolSessionKey: 'tool-runtime',
    context: {
      requestId: 'req-runtime-child',
      providerId: 'qwen',
      accountId: 'acc-runtime',
      model: 'Qwen3-Max',
      actualModel: 'Qwen3-Max',
      startTime: 1,
      isStream: false,
      toolCatalogSessionKey: 'tool-runtime',
      providerConversationSessionKey: 'provider:runtime-child',
      parentProviderConversationSessionKey: 'provider:runtime-parent',
      providerSessionEpoch: 'tool_child:runtime-child',
      sessionBoundaryReason: 'tool_child',
    },
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_runtime',
          type: 'function',
          function: { name: 'read', arguments: '{"filePath":"tests/agent-capability/input.txt"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_runtime', content: 'runtime tool result' },
    ],
    update: {
      qwenSessionId: 'runtime-child-session',
      qwenParentReqId: 'runtime-child-parent',
    },
    parentHandoff: {
      kind: 'tool_child',
      status: 'ok',
      summary: 'Runtime child completed.',
      evidence: [{ label: 'tool', value: 'read:call_runtime' }],
    },
  })

  assert.equal(
    conversationStateCache.get('provider:runtime-parent')?.childSessionHandoff?.childProviderSessionId,
    'runtime-child-session',
  )
})

test('ProviderRuntime default transport merges plugin transportOptions for stream requests', async () => {
  const calls: any[] = []
  const runtime = new ProviderRuntime({
    axiosInstance: {
      request: async (config: any) => {
        calls.push(config)
        return { status: 200, headers: {}, data: Readable.from([]) }
      },
    } as any,
    pluginResolver: async () => ({
      id: 'test-provider',
      version: 'test',
      matches: () => true,
      capabilities: {
        supportsProviderSession: false,
        supportsParentMessageId: false,
        supportsDeleteSession: false,
        supportsStreaming: true,
        supportsNonStreaming: true,
        supportsNativeTools: false,
        preferredManagedProtocol: 'managed_xml',
        sessionIdKind: 'none',
        transport: 'provider_chat_api',
      },
      async buildRequest() {
        return {
          url: 'https://runtime.test/chat',
          method: 'POST' as const,
          headers: { 'x-runtime': '1' },
          body: { hello: 'world' },
          sessionId: 'runtime-session',
          reqId: 'runtime-req',
          transportOptions: {
            responseType: 'stream' as const,
            timeout: 120000,
            decompress: false,
            validateStatus: () => true,
          },
        }
      },
      async parseNonStream(input: any) {
        return { sessionId: '', reqId: '', response: input }
      },
      async *parseStream() {
        yield { type: 'done', finishReason: 'stop' as const }
      },
    }),
  })

  const result = await runtime.forward(makeRuntimeInput({
    request: { model: 'Qwen3-Max', messages: [{ role: 'user', content: 'stream' }], stream: true },
  }))

  assert.equal(result.success, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].responseType, 'stream')
  assert.equal(calls[0].timeout, 120000)
  assert.equal(calls[0].decompress, false)
  assert.equal(typeof calls[0].validateStatus, 'function')
})

test('ProviderRuntime.forward normalizes plugin stream events into OpenAI SSE', async () => {
  conversationStateCache.clear()
  const plugin = makeFakePlugin({})
  const runtime = new ProviderRuntime({
    pluginResolver: async () => plugin,
    transport: async () => ({ status: 200, headers: {}, data: Readable.from([]) }),
  })

  const result = await runtime.forward(makeRuntimeInput({
    request: { model: 'Qwen3-Max', messages: [{ role: 'user', content: 'stream' }], stream: true },
  }))

  assert.equal(result.success, true)
  assert.ok(result.stream)
  const output = await collect(result.stream as Readable)
  assert.match(output, /runtime stream text/)
  assert.match(output, /"finish_reason":"stop"/)
  assert.match(output, /data: \[DONE\]/)
})

test('ProviderRuntime aggregates provider SSE into non-stream OpenAI tool_calls', async () => {
  conversationStateCache.clear()
  const plugin = makeFakePlugin({})
  plugin.buildRequest = async () => ({
    url: 'https://runtime.test/chat',
    method: 'POST',
    headers: { 'x-runtime': '1' },
    body: {},
    sessionId: 'runtime-session',
    reqId: 'runtime-req',
    transportOptions: { responseType: 'stream' },
  })
  plugin.parseStream = async function* () {
    yield { type: 'session_update', sessionId: 'stream-session', parentId: 'stream-parent' }
    yield {
      type: 'tool_call_delta',
      call: {
        index: 0,
        id: 'call_read',
        function: { name: 'read', arguments: '{"file' },
      },
    }
    yield {
      type: 'tool_call_delta',
      call: {
        index: 0,
        function: { arguments: 'Path":"tests/agent-capability/input.txt"}' },
      },
    }
    yield { type: 'done', finishReason: 'tool_calls' }
  }

  const runtime = new ProviderRuntime({
    pluginResolver: async () => plugin,
    transport: async () => ({ status: 200, headers: {}, data: Readable.from([]) }),
  })

  const result = await runtime.forward(makeRuntimeInput({
    request: { model: 'Qwen3-Max', messages: [{ role: 'user', content: 'stream transport, non-stream response' }], stream: false },
  }))

  assert.equal(result.success, true)
  assert.equal(result.body.choices[0].finish_reason, 'tool_calls')
  assert.equal(result.body.choices[0].message.content, null)
  assert.deepEqual(result.body.choices[0].message.tool_calls, [{
    id: 'call_read',
    type: 'function',
    function: {
      name: 'read',
      arguments: '{"filePath":"tests/agent-capability/input.txt"}',
    },
  }])
  assert.equal(conversationStateCache.get('provider-key')?.conversationId, undefined)
  assert.equal(conversationStateCache.get('provider-key')?.qwenSessionId, 'stream-session')
})

test('ProviderRuntime Qwen pilot stream path converts managed XML into OpenAI tool_call deltas', async () => {
  conversationStateCache.clear()
  const provider = {
    id: 'qwen',
    name: 'Qwen',
    type: 'builtin' as const,
    authType: 'token' as const,
    apiEndpoint: '',
    headers: {},
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  }
  const request = {
    model: 'Qwen3-Max',
    messages: [{ role: 'user' as const, content: 'Read the probe input.' }],
    tools: [{
      type: 'function' as const,
      function: {
        name: 'read',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: { filePath: { type: 'string' } },
          required: ['filePath'],
        },
      },
    }],
    stream: true,
  }
  const transformed = new ToolCallingEngine().transformRequest({
    request: request as any,
    provider: provider as any,
    actualModel: 'Qwen3-Max',
    toolSessionKey: 'runtime-qwen-managed-stream',
  })
  const runtime = new ProviderRuntime({
    pluginResolver: async () => QwenProviderPlugin,
    transport: async () => ({
      status: 200,
      headers: {},
      data: Readable.from([
        [
          'event: message',
          'data: {"communication":{"sessionid":"pilot-session","reqid":"pilot-parent"},"data":{"messages":[{"mime_type":"multi_load/iframe","content":"<|CHAT2API|tool_calls><|CHAT2API|invoke name=\\"read\\"><|CHAT2API|parameter name=\\"filePath\\"><![CDATA[tests/agent-capability/input.txt]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>","status":"complete"}]}}',
          '',
          '',
        ].join('\n'),
      ]),
    }),
  })

  const result = await runtime.forward({
    ...makeRuntimeInput({
      request,
      provider,
      actualModel: 'Qwen3-Max',
      assembly: {
        ...makeAssembly(request.messages as any),
        messages: request.messages as any,
        toolManifest: transformed.toolManifest ?? null,
      },
      transformed,
      context: {
        requestId: 'req-runtime-stream-tool',
        providerId: 'qwen',
        accountId: 'acc-runtime',
        model: 'Qwen3-Max',
        actualModel: 'Qwen3-Max',
        startTime: 1,
        isStream: true,
        toolCatalogSessionKey: 'tool-key',
        providerConversationSessionKey: 'provider-key-stream-tool',
        sessionBoundaryReason: 'normal',
      },
      conversationStateKey: 'provider-key-stream-tool',
      toolSessionKey: 'tool-key',
    }),
  })

  assert.equal(result.success, true)
  const output = await collect(result.stream as Readable)
  assert.match(output, /"tool_calls"/)
  assert.match(output, /"name":"read"/)
  assert.match(output, /"finish_reason":"tool_calls"/)
  assert.doesNotMatch(output, /<\|CHAT2API\|tool_calls>/)
  assert.equal(conversationStateCache.get('provider-key-stream-tool')?.qwenSessionId, 'pilot-session')
  assert.equal(conversationStateCache.get('provider-key-stream-tool')?.qwenParentReqId, 'pilot-parent')
})

test('ProviderRuntime Qwen pilot stream path keeps plain text as content with stop finish', async () => {
  conversationStateCache.clear()
  const runtime = new ProviderRuntime({
    pluginResolver: async () => QwenProviderPlugin,
    transport: async () => ({
      status: 200,
      headers: {},
      data: Readable.from([
        [
          'event: message',
          'data: {"communication":{"sessionid":"plain-session","reqid":"plain-parent"},"data":{"messages":[{"mime_type":"multi_load/iframe","content":"CAPABILITY_PROBE_DONE","status":"complete"}]}}',
          '',
          '',
        ].join('\n'),
      ]),
    }),
  })

  const result = await runtime.forward(makeRuntimeInput({
    request: { model: 'Qwen3-Max', messages: [{ role: 'user', content: 'plain' }], stream: true },
    context: {
      requestId: 'req-runtime-stream-plain',
      providerId: 'qwen',
      accountId: 'acc-runtime',
      model: 'Qwen3-Max',
      actualModel: 'Qwen3-Max',
      startTime: 1,
      isStream: true,
      toolCatalogSessionKey: 'tool-key',
      providerConversationSessionKey: 'provider-key-stream-plain',
      sessionBoundaryReason: 'normal',
    },
    conversationStateKey: 'provider-key-stream-plain',
  }))

  assert.equal(result.success, true)
  const output = await collect(result.stream as Readable)
  assert.match(output, /CAPABILITY_PROBE_DONE/)
  assert.match(output, /"finish_reason":"stop"/)
  assert.doesNotMatch(output, /"tool_calls"/)
  assert.equal(conversationStateCache.get('provider-key-stream-plain')?.qwenSessionId, 'plain-session')
  assert.equal(conversationStateCache.get('provider-key-stream-plain')?.qwenParentReqId, 'plain-parent')
})

test('ProviderRuntime Qwen pilot stream bridge prefers the raw transport response shape', async () => {
  conversationStateCache.clear()
  const runtime = new ProviderRuntime({
    pluginResolver: async () => QwenProviderPlugin,
    transport: async () => ({
      status: 200,
      headers: { 'content-encoding': 'identity' },
      data: Readable.from([
        [
          'event: message',
          'data: {"communication":{"sessionid":"raw-shape-session","reqid":"raw-shape-parent"},"data":{"messages":[{"mime_type":"multi_load/iframe","content":"<|CHAT2API|tool_calls><|CHAT2API|invoke name=\\"read\\"><|CHAT2API|parameter name=\\"filePath\\"><![CDATA[tests/agent-capability/input.txt]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>","status":"complete"}]}}',
          '',
          '',
        ].join('\n'),
      ]),
      request: { traceId: 'raw-shape-only' },
      config: { responseType: 'stream' },
    } as any),
  })

  const provider = {
    id: 'qwen',
    name: 'Qwen',
    type: 'builtin' as const,
    authType: 'token' as const,
    apiEndpoint: '',
    headers: {},
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  }
  const request = {
    model: 'Qwen3-Max',
    messages: [{ role: 'user' as const, content: 'Read the probe input.' }],
    tools: [{
      type: 'function' as const,
      function: {
        name: 'read',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: { filePath: { type: 'string' } },
          required: ['filePath'],
        },
      },
    }],
    stream: true,
  }
  const transformed = new ToolCallingEngine().transformRequest({
    request: request as any,
    provider: provider as any,
    actualModel: 'Qwen3-Max',
    toolSessionKey: 'runtime-qwen-raw-shape-stream',
  })

  const result = await runtime.forward({
    ...makeRuntimeInput({
      request,
      provider,
      actualModel: 'Qwen3-Max',
      assembly: {
        ...makeAssembly(request.messages as any),
        messages: request.messages as any,
        toolManifest: transformed.toolManifest ?? null,
      },
      transformed,
      context: {
        requestId: 'req-runtime-stream-raw-shape',
        providerId: 'qwen',
        accountId: 'acc-runtime',
        model: 'Qwen3-Max',
        actualModel: 'Qwen3-Max',
        startTime: 1,
        isStream: true,
        toolCatalogSessionKey: 'tool-key',
        providerConversationSessionKey: 'provider-key-stream-raw-shape',
        sessionBoundaryReason: 'normal',
      },
      conversationStateKey: 'provider-key-stream-raw-shape',
      toolSessionKey: 'tool-key',
    }),
  })

  const output = await collect(result.stream as Readable)
  assert.match(output, /"tool_calls"/)
  assert.match(output, /"finish_reason":"tool_calls"/)
  assert.equal(conversationStateCache.get('provider-key-stream-raw-shape')?.qwenSessionId, 'raw-shape-session')
  assert.equal(conversationStateCache.get('provider-key-stream-raw-shape')?.qwenParentReqId, 'raw-shape-parent')
})

test('Kimi runtime plugin parses grpc-web stream frames into provider events', async () => {
  const stream = Readable.from([
    kimiFrame({ op: 'set', chat: { id: 'kimi-chat-1' } }),
    kimiFrame({ op: 'set', mask: 'block.text', block: { text: { content: 'OK' } } }),
    kimiFrame({ done: {} }),
  ])

  const events = []
  for await (const event of KimiProviderPlugin.parseStream!({
    response: { status: 200, headers: {}, data: stream },
    model: 'Kimi-K2.6',
  })) {
    events.push(event)
  }

  assert.deepEqual(events[0], { type: 'session_update', sessionId: 'kimi-chat-1' })
  assert.deepEqual(events[1], { type: 'text_delta', text: 'OK' })
  assert.deepEqual(events.at(-1), { type: 'done', finishReason: 'stop' })
})

test('RequestForwarder uses runtime only when explicit pilot gate is enabled', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'chat2api-runtime-main-path-'))
  const outfile = join(tempDir, 'forwarder-bundle.cjs')

  try {
    const { build } = await import('esbuild')
    await build({
      entryPoints: [resolve('src/main/proxy/forwarder.ts')],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      logLevel: 'silent',
      plugins: [{
        name: 'runtime-main-path-test-mocks',
        setup(buildApi) {
          buildApi.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-mock' }))
          buildApi.onLoad({ filter: /.*/, namespace: 'electron-mock' }, () => ({
            contents: [
              'export const app = { getPath: () => process.cwd(), getName: () => "Chat2API" };',
              'export const safeStorage = { isEncryptionAvailable: () => false, encryptString: (v) => Buffer.from(v), decryptString: (v) => Buffer.from(v).toString() };',
              'export class BrowserWindow {};',
              'export const net = {};',
            ].join('\n'),
          }))
          buildApi.onResolve({ filter: /(^|\/|\\)store(\.ts)?$/ }, (args) => {
            if (args.importer.includes('/src/main/') || args.importer.includes('\\src\\main\\')) {
              return { path: 'store', namespace: 'store-mock' }
            }
            return undefined
          })
          buildApi.onLoad({ filter: /.*/, namespace: 'store-mock' }, () => ({
            contents: `
              const config = {
                retryCount: 0,
                contextManagement: { enabled: false },
                toolCallingConfig: { mode: 'off', clientAdapterId: 'standard-openai-tools', providerOverrides: {}, advanced: {} },
              };
              export const storeManager = { getConfig: () => config };
            `,
          }))
        },
      }],
    })

    const require = createRequire(import.meta.url)
    const { RequestForwarder } = require(outfile)
    const request = { model: 'Qwen3-Max', messages: [{ role: 'user', content: 'hello' }], stream: false }
    const provider = { id: 'qwen', name: 'Qwen', type: 'builtin', authType: 'token', apiEndpoint: '', headers: {}, enabled: true, createdAt: 0, updatedAt: 0 }
    const account = { id: 'acc-1', providerId: 'qwen', name: 'Qwen Account', credentials: {}, enabled: true, createdAt: 0, updatedAt: 0 }
    const context = { requestId: 'req-1', providerId: 'qwen', accountId: 'acc-1', model: 'Qwen3-Max', actualModel: 'Qwen3-Max', startTime: 1, isStream: false, toolCatalogSessionKey: 'tool-key', providerConversationSessionKey: 'provider-key', sessionBoundaryReason: 'normal' }

    const off = new RequestForwarder()
    off.providerRuntime = { forward: async () => { throw new Error('runtime should not be used while gate is off') } }
    off.providerForwarders = [{ name: 'fake-qwen', matches: () => true, forward: async () => ({ success: true, status: 200, body: { path: 'dedicated' }, latency: 1 }) }]
    delete process.env.CHAT2API_PROVIDER_RUNTIME_PILOT
    const offResult = await off.forwardChatCompletion(request, account, provider, 'Qwen3-Max', context)
    assert.equal(offResult.body?.path, 'dedicated')

    const on = new RequestForwarder()
    let runtimeInput: any
    let transformToolSessionKey: any
    const originalTransform = on.transformRequestForPromptToolUse
    on.transformRequestForPromptToolUse = function(requestArg: any, providerArg: any, toolSessionKeyArg: any) {
      transformToolSessionKey = toolSessionKeyArg
      return originalTransform.call(this, requestArg, providerArg, toolSessionKeyArg)
    }
    on.providerRuntime = { forward: async (input: any) => { runtimeInput = input; return { success: true, status: 200, body: { path: 'runtime', promptRefreshMode: input.promptRefreshMode }, latency: 1 } } }
    on.providerForwarders = [{ name: 'fake-qwen', matches: () => true, forward: async () => { throw new Error('dedicated should not be used while gate is on') } }]
    process.env.CHAT2API_PROVIDER_RUNTIME_PILOT = '1'
    const onResult = await on.forwardChatCompletion(request, account, provider, 'Qwen3-Max', context)
    assert.equal(onResult.body?.path, 'runtime')
    assert.ok(runtimeInput?.assembly)
    assert.ok(runtimeInput?.conversationStateKey)
    assert.ok(runtimeInput?.toolSessionKey)
    assert.ok(runtimeInput?.promptRefreshMode)
    assert.equal(transformToolSessionKey, 'tool-key')

    const glm = new RequestForwarder()
    glm.providerRuntime = { forward: async () => ({ success: true, status: 200, body: { path: 'glm-runtime' }, latency: 1 }) }
    glm.providerForwarders = [{ name: 'fake-glm', matches: () => true, forward: async () => { throw new Error('glm dedicated should not be used while gate is on') } }]
    const glmProvider = { ...provider, id: 'glm', name: 'GLM' }
    const glmResult = await glm.forwardChatCompletion(request, account, glmProvider, 'GLM-5.2', { ...context, providerId: 'glm', actualModel: 'GLM-5.2' })
    assert.equal(glmResult.body?.path, 'glm-runtime')

    const kimiWithDefaultGate = new RequestForwarder()
    kimiWithDefaultGate.providerRuntime = { forward: async () => { throw new Error('kimi runtime should require explicit provider opt-in') } }
    kimiWithDefaultGate.providerForwarders = [{ name: 'fake-kimi', matches: () => true, forward: async () => ({ success: true, status: 200, body: { path: 'kimi-dedicated' }, latency: 1 }) }]
    const kimiProvider = { ...provider, id: 'kimi', name: 'Kimi' }
    const kimiAccount = { ...account, providerId: 'kimi', name: 'Kimi Account' }
    const kimiContext = { ...context, providerId: 'kimi', model: 'Kimi-K2.6', actualModel: 'Kimi-K2.6' }
    const kimiDefaultResult = await kimiWithDefaultGate.forwardChatCompletion(
      { ...request, model: 'Kimi-K2.6' },
      kimiAccount,
      kimiProvider,
      'Kimi-K2.6',
      kimiContext,
    )
    assert.equal(kimiDefaultResult.body?.path, 'kimi-dedicated')

    const kimiWithExplicitGate = new RequestForwarder()
    kimiWithExplicitGate.providerRuntime = { forward: async () => ({ success: true, status: 200, body: { path: 'kimi-runtime' }, latency: 1 }) }
    kimiWithExplicitGate.providerForwarders = [{ name: 'fake-kimi', matches: () => true, forward: async () => { throw new Error('kimi dedicated should not be used while provider is opted in') } }]
    process.env.CHAT2API_PROVIDER_RUNTIME_PILOT = 'kimi'
    const kimiRuntimeResult = await kimiWithExplicitGate.forwardChatCompletion(
      { ...request, model: 'Kimi-K2.6' },
      kimiAccount,
      kimiProvider,
      'Kimi-K2.6',
      kimiContext,
    )
    assert.equal(kimiRuntimeResult.body?.path, 'kimi-runtime')

    const mimoWithAllGate = new RequestForwarder()
    mimoWithAllGate.providerRuntime = { forward: async () => ({ success: true, status: 200, body: { path: 'mimo-runtime' }, latency: 1 }) }
    mimoWithAllGate.providerForwarders = [{ name: 'fake-mimo', matches: () => true, forward: async () => { throw new Error('mimo dedicated should not be used while all plugins are opted in') } }]
    const mimoProvider = { ...provider, id: 'mimo', name: 'Mimo' }
    process.env.CHAT2API_PROVIDER_RUNTIME_PILOT = 'all'
    const mimoRuntimeResult = await mimoWithAllGate.forwardChatCompletion(
      { ...request, model: 'MiMo-V2.5' },
      { ...account, providerId: 'mimo', name: 'Mimo Account' },
      mimoProvider,
      'MiMo-V2.5',
      { ...context, providerId: 'mimo', model: 'MiMo-V2.5', actualModel: 'MiMo-V2.5' },
    )
    assert.equal(mimoRuntimeResult.body?.path, 'mimo-runtime')
  } finally {
    delete process.env.CHAT2API_PROVIDER_RUNTIME_PILOT
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('RequestForwarder passes context compaction summary/handoff and full tool metadata into runtime assembly', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'chat2api-runtime-compact-assembly-'))
  const outfile = join(tempDir, 'forwarder-bundle.cjs')

  try {
    const { build } = await import('esbuild')
    await build({
      entryPoints: [resolve('src/main/proxy/forwarder.ts')],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      logLevel: 'silent',
      plugins: [{
        name: 'runtime-compact-assembly-test-mocks',
        setup(buildApi) {
          buildApi.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-mock' }))
          buildApi.onLoad({ filter: /.*/, namespace: 'electron-mock' }, () => ({
            contents: [
              'export const app = { getPath: () => process.cwd(), getName: () => "Chat2API" };',
              'export const safeStorage = { isEncryptionAvailable: () => false, encryptString: (v) => Buffer.from(v), decryptString: (v) => Buffer.from(v).toString() };',
              'export class BrowserWindow {};',
              'export const net = {};',
            ].join('\n'),
          }))
          buildApi.onResolve({ filter: /(^|\/|\\)store(\.ts)?$/ }, (args) => {
            if (args.importer.includes('/src/main/') || args.importer.includes('\\src\\main\\')) {
              return { path: 'store', namespace: 'store-mock' }
            }
            return undefined
          })
          buildApi.onLoad({ filter: /.*/, namespace: 'store-mock' }, () => ({
            contents: `
              const config = {
                retryCount: 0,
                contextManagement: {
                  enabled: true,
                  strategies: {
                    slidingWindow: { enabled: false, maxMessages: 20 },
                    tokenLimit: { enabled: false, maxTokens: 4000 },
                    summary: { enabled: true, keepRecentMessages: 2 },
                  },
                  executionOrder: ['summary'],
                },
                toolCallingConfig: { mode: 'mocked-on', clientAdapterId: 'standard-openai-tools', providerOverrides: {}, advanced: {} },
              };
              export const storeManager = { getConfig: () => config };
            `,
          }))
        },
      }],
    })

    const require = createRequire(import.meta.url)
    const { RequestForwarder } = require(outfile)
    const request = {
      model: 'Qwen3-Max',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Warmup 1' },
        { role: 'assistant', content: 'Warmup reply 1' },
        { role: 'user', content: 'Warmup 2' },
        { role: 'assistant', content: 'Warmup reply 2' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_old', type: 'function', function: { name: 'read', arguments: '{"filePath":"old.txt"}' } }] },
        { role: 'tool', tool_call_id: 'call_old', content: 'old body' },
        { role: 'user', content: 'Continue after compaction.' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'read',
          description: 'Read a file',
          parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] },
        },
      }, {
        type: 'function',
        function: {
          name: 'bash',
          description: 'Run a command',
          parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
        },
      }],
      stream: false,
    }
    const provider = { id: 'qwen', name: 'Qwen', type: 'builtin', authType: 'token', apiEndpoint: '', headers: {}, enabled: true, createdAt: 0, updatedAt: 0 }
    const account = { id: 'acc-1', providerId: 'qwen', name: 'Qwen Account', credentials: {}, enabled: true, createdAt: 0, updatedAt: 0 }
    const context = { requestId: 'req-compact', providerId: 'qwen', accountId: 'acc-1', model: 'Qwen3-Max', actualModel: 'Qwen3-Max', startTime: 1, isStream: false, toolCatalogSessionKey: 'tool-key', providerConversationSessionKey: 'provider-key', sessionBoundaryReason: 'normal' }

    const forwarder = new RequestForwarder()
    forwarder.createSummaryGenerator = () => async () => 'Bounded summary for the compacted turn.'
    let runtimeInput: any
    forwarder.providerRuntime = {
      forward: async (input: any) => {
        runtimeInput = input
        return { success: true, status: 200, body: { ok: true }, latency: 1 }
      },
    }
    forwarder.providerForwarders = [{ name: 'fake-qwen', matches: () => true, forward: async () => ({ success: true, status: 200, body: { path: 'dedicated' }, latency: 1 }) }]
    process.env.CHAT2API_PROVIDER_RUNTIME_PILOT = '1'

    const result = await forwarder.forwardChatCompletion(request, account, provider, 'Qwen3-Max', context)

    assert.equal(result.success, true)
    assert.equal(runtimeInput?.assembly?.summaryText, [
      '[Prior conversation summary — non-authoritative narrative. Tool catalog and MCP capabilities are re-injected below by the runtime and take precedence over anything summarized here.]',
      'Bounded summary for the compacted turn.',
    ].join('\n'))
    assert.equal(runtimeInput?.assembly?.metadata?.contextManagementApplied, true)
    assert.deepEqual(runtimeInput?.assembly?.metadata?.strategiesExecuted, ['summary'])
    assert.equal(typeof runtimeInput?.assembly?.toolManifest?.catalogFingerprint, 'string')
    assert.deepEqual([...runtimeInput?.assembly?.toolManifest?.allowedToolNames].sort(), ['bash', 'read'])
    assert.equal(runtimeInput?.assembly?.toolManifest?.tools?.length, 2)
    assert.equal(runtimeInput?.context?.sessionBoundaryReason, 'server_summary')
  } finally {
    delete process.env.CHAT2API_PROVIDER_RUNTIME_PILOT
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('RequestForwarder summary generator skips provider request when sanitized history is empty', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'chat2api-summary-generator-empty-'))
  const outfile = join(tempDir, 'forwarder-bundle.cjs')

  try {
    const { build } = await import('esbuild')
    await build({
      entryPoints: [resolve('src/main/proxy/forwarder.ts')],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      logLevel: 'silent',
      plugins: [{
        name: 'summary-generator-empty-test-mocks',
        setup(buildApi) {
          buildApi.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-mock' }))
          buildApi.onLoad({ filter: /.*/, namespace: 'electron-mock' }, () => ({
            contents: [
              'export const app = { getPath: () => process.cwd(), getName: () => "Chat2API" };',
              'export const safeStorage = { isEncryptionAvailable: () => false, encryptString: (v) => Buffer.from(v), decryptString: (v) => Buffer.from(v).toString() };',
              'export class BrowserWindow {};',
              'export const net = {};',
            ].join('\n'),
          }))
          buildApi.onResolve({ filter: /(^|\/|\\)store(\.ts)?$/ }, (args) => {
            if (args.importer.includes('/src/main/') || args.importer.includes('\\src\\main\\')) {
              return { path: 'store', namespace: 'store-mock' }
            }
            return undefined
          })
          buildApi.onLoad({ filter: /.*/, namespace: 'store-mock' }, () => ({
            contents: `
              const config = {
                retryCount: 0,
                contextManagement: { enabled: false },
                toolCallingConfig: { mode: 'off', clientAdapterId: 'standard-openai-tools', providerOverrides: {}, advanced: {} },
              };
              export const storeManager = { getConfig: () => config };
            `,
          }))
        },
      }],
    })

    const require = createRequire(import.meta.url)
    const { RequestForwarder } = require(outfile)
    const forwarder = new RequestForwarder()
    let providerCallCount = 0
    forwarder.doForward = async () => {
      providerCallCount++
      return {
        success: true,
        status: 200,
        body: { choices: [{ message: { content: 'Provider summary.' } }] },
        latency: 1,
      }
    }

    const provider = { id: 'qwen', name: 'Qwen', type: 'builtin', authType: 'token', apiEndpoint: '', headers: {}, enabled: true, createdAt: 0, updatedAt: 0 }
    const account = { id: 'acc-1', providerId: 'qwen', name: 'Qwen Account', credentials: {}, enabled: true, createdAt: 0, updatedAt: 0 }
    const context = { requestId: 'req-summary-empty', providerId: 'qwen', accountId: 'acc-1', model: 'Qwen3-Max', actualModel: 'Qwen3-Max', startTime: 1, isStream: false, toolCatalogSessionKey: 'tool-key', providerConversationSessionKey: 'provider-key', sessionBoundaryReason: 'normal' }
    const generator = forwarder.createSummaryGenerator(account, provider, 'Qwen3-Max', context)

    const emptySummary = await generator([
      { role: 'system', content: '## Available Tools\nread: read files' },
      { role: 'assistant', content: '<tools><tool><name>read</name></tool></tools>' },
    ])

    assert.equal(emptySummary, '')
    assert.equal(providerCallCount, 0)

    const realSummary = await generator([
      { role: 'user', content: 'Remember project alpha.' },
      { role: 'assistant', content: 'Project alpha remembered.' },
    ])

    assert.equal(realSummary, 'Provider summary.')
    assert.equal(providerCallCount, 1)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})
