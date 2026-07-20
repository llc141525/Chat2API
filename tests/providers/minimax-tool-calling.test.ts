import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ToolCallingEngine } from '../../src/main/proxy/toolCalling/ToolCallingEngine.ts'
import { getProviderToolProfile } from '../../src/main/proxy/toolCalling/providerProfiles.ts'
import { parseMiniMaxStream } from '../../src/main/proxy/providers/minimax/parser.ts'
import type { ChatCompletionRequest } from '../../src/main/proxy/types.ts'
import type { Provider } from '../../src/main/store/types.ts'
import type { ToolCallingPlan } from '../../src/main/proxy/toolCalling/types.ts'

function makeProvider(id: string): Provider {
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

function request(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: 'MiniMax-M2.7',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    }],
    ...overrides,
  }
}

function managedPlan(): ToolCallingPlan {
  return {
    mode: 'managed',
    protocol: 'managed_xml',
    clientAdapterId: 'standard-openai-tools',
    providerId: 'minimax',
    tools: [
      { name: 'default_api:read_file', description: 'Read a file', parameters: {}, source: 'openai' },
    ],
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(['default_api:read_file']),
    availabilityRetryAllowed: false,
    contract: {
      turnId: 'minimax-turn',
      sessionId: 'minimax-session',
      providerId: 'minimax',
      model: 'MiniMax-M2.7',
      protocol: 'managed_xml',
      snapshotFingerprint: null,
      tools: Object.freeze([]),
      allowedToolNames: Object.freeze(new Set<string>(['default_api:read_file'])),
      toolChoiceMode: 'auto',
      shouldInjectPrompt: true,
      shouldParseResponse: true,
      historyMode: 'managed_protocol',
      emptyOutputPolicy: 'diagnose_and_fail',
      toolSourceChain: Object.freeze(['current_request', 'session_catalog', 'message_history', 'safe_empty']),
    },
    diagnostics: {
      requestId: 'minimax-request',
      turnId: 'minimax-turn',
      clientAdapterId: 'standard-openai-tools',
      providerId: 'minimax',
      model: 'MiniMax-M2.7',
      actualModel: 'MiniMax-M2.7',
      toolSource: 'openai',
      mode: 'managed',
      protocol: 'managed_xml',
      toolCount: 1,
      injected: true,
      reason: 'test',
      emptyOutputPolicy: 'diagnose_and_fail',
    },
  }
}

async function collectEvents(stream: AsyncIterable<unknown>): Promise<any[]> {
  const events: any[] = []
  for await (const event of stream) events.push(event)
  return events
}

test('minimax profile is experimental with polling transport', () => {
  const profile = getProviderToolProfile('minimax')
  assert.equal(profile.managedToolSupportStatus, 'experimental')
  assert.equal(profile.managedTransport, 'polling_stream')
  assert.deepEqual(profile.providerRiskControlCaveats, [])
})

test('minimax production stream parser converts managed XML to tool_call_delta events', async () => {
  const managedXmlToolCall = '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>'
  const providerFrame = [
    'event: message_result',
    `data: ${JSON.stringify({
      data: {
        messageResult: {
          chat_id: 'minimax-chat-1',
          isEnd: 0,
          content: managedXmlToolCall,
        },
      },
      base_resp: { status_code: 0 },
    })}`,
    '',
    '',
  ].join('\n')

  const events = await collectEvents(parseMiniMaxStream({
    response: {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      data: Readable.from([providerFrame]),
    },
    model: 'MiniMax-M2.7',
    toolCallingPlan: managedPlan(),
    correlationId: 'minimax-parser-tool-call-test',
    toolActionConstraint: null,
  }))

  assert.equal(events.some(event => event.type === 'session_update' && event.sessionId === 'minimax-chat-1'), true)
  assert.equal(events.some(event => event.type === 'tool_call_delta' && event.call.function?.name === 'default_api:read_file'), true)
  assert.equal(events.some(event => event.type === 'done' && event.finishReason === 'tool_calls'), true)
  assert.equal(events.some(event => event.type === 'text_delta' && String(event.text).includes('<|CHAT2API|tool_calls>')), false)
})

test('minimax production stream parser ignores provider end frames after isEnd closes output', async () => {
  const managedXmlToolCall = '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>'
  const providerFrame = [
    'event: message_result',
    `data: ${JSON.stringify({
      data: {
        messageResult: {
          chat_id: 'minimax-chat-1',
          isEnd: 0,
          content: managedXmlToolCall,
        },
      },
      base_resp: { status_code: 0 },
    })}`,
    '',
    'event: close',
    `data: ${JSON.stringify({ type: 8, base_resp: { status_code: 0 } })}`,
    '',
    '',
  ].join('\n')

  const events = await collectEvents(parseMiniMaxStream({
    response: {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      data: Readable.from([providerFrame]),
    },
    model: 'MiniMax-M2.7',
    toolCallingPlan: managedPlan(),
    correlationId: 'minimax-parser-trailing-end-frame-test',
    toolActionConstraint: null,
  }))

  assert.equal(events.filter(event => event.type === 'done').length, 1)
  assert.equal(events.some(event => event.type === 'tool_call_delta' && event.call.function?.name === 'default_api:read_file'), true)
  assert.equal(events.some(event => event.type === 'error'), false)
})

test('minimax production stream parser reports empty provider close', async () => {
  const events = await collectEvents(parseMiniMaxStream({
    response: {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      data: Readable.from([]),
    },
    model: 'MiniMax-M2.7',
    toolCallingPlan: managedPlan(),
    correlationId: 'minimax-parser-empty-close-test',
    toolActionConstraint: null,
  }))

  assert.deepEqual(events, [{
    type: 'error',
    error: {
      status: 502,
      code: 'EMPTY_PROVIDER_STREAM',
      message: 'MiniMax provider stream closed before emitting any provider event',
      retryable: true,
      classified: true,
    },
  }])
})

test('minimax restores catalog from session on follow-up turns without tools', () => {
  const engine = new ToolCallingEngine()
  engine.transformRequest({
    request: request(),
    provider: makeProvider('minimax'),
    actualModel: 'MiniMax-M2.7',
    requestId: 'minimax-session',
  })

  const second = engine.transformRequest({
    request: request({
      tools: undefined,
      messages: [
        { role: 'assistant', content: null as any, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
        { role: 'user', content: 'again' },
      ],
    }),
    provider: makeProvider('minimax'),
    actualModel: 'MiniMax-M2.7',
    toolSessionKey: 'minimax-session',
  })

  assert.equal(second.plan.catalogDiagnostics.source, 'session_catalog')
  assert.equal(second.plan.diagnostics.providerManagedStatus, 'experimental')
})

test('minimax adapter does not import prompt injection helpers', () => {
  const source = readFileSync(join(process.cwd(), 'src/main/proxy/adapters/minimax.ts'), 'utf8')
  assert.doesNotMatch(source, /^import[^\r\n]*(hasToolPromptInjected|toolsToSystemPrompt|TOOL_WRAP_HINT|shouldInjectToolPrompt)/m)
})
