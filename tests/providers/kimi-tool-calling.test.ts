import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ToolCallingEngine } from '../../src/main/proxy/toolCalling/ToolCallingEngine.ts'
import { getProviderToolProfile } from '../../src/main/proxy/toolCalling/providerProfiles.ts'
import type { ChatCompletionRequest } from '../../src/main/proxy/types.ts'
import type { Provider } from '../../src/main/store/types.ts'

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
    model: 'Kimi-K2.6',
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

test('kimi profile is experimental with grpc transport', () => {
  const profile = getProviderToolProfile('kimi')
  assert.equal(profile.managedToolSupportStatus, 'experimental')
  assert.equal(profile.managedTransport, 'grpc_web_stream')
  assert.deepEqual(profile.providerRiskControlCaveats, [])
})

test('kimi restores catalog from session on follow-up turns without tools', () => {
  const engine = new ToolCallingEngine()
  engine.transformRequest({
    request: request(),
    provider: makeProvider('kimi'),
    actualModel: 'kimi-k2.6',
    requestId: 'kimi-session',
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
    provider: makeProvider('kimi'),
    actualModel: 'kimi-k2.6',
    toolSessionKey: 'kimi-session',
  })

  assert.equal(second.plan.catalogDiagnostics.source, 'session_catalog')
  assert.equal(second.plan.diagnostics.providerManagedTransport, 'grpc_web_stream')
})

test('kimi adapter does not import prompt injection helpers', () => {
  const source = readFileSync(join(process.cwd(), 'src/main/proxy/adapters/kimi.ts'), 'utf8')
  assert.doesNotMatch(source, /^import[^\r\n]*(hasToolPromptInjected|toolsToSystemPrompt|TOOL_WRAP_HINT|shouldInjectToolPrompt)/m)
})
