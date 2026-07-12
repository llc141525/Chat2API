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
    model: 'GLM-5.1',
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

test('zai profile is experimental with provider-chat transport and risk-control caveat', () => {
  const profile = getProviderToolProfile('zai')
  assert.equal(profile.managedToolSupportStatus, 'experimental')
  assert.equal(profile.managedTransport, 'provider_chat_api')
  assert.deepEqual(profile.providerRiskControlCaveats, ['captcha_or_risk_control'])
})

test('zai restores catalog from session on follow-up turns without tools', () => {
  const engine = new ToolCallingEngine()
  const first = engine.transformRequest({
    request: request(),
    provider: makeProvider('zai'),
    actualModel: 'glm-5.1',
    requestId: 'zai-session',
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
    provider: makeProvider('zai'),
    actualModel: 'glm-5.1',
    toolSessionKey: 'zai-session',
  })

  assert.equal(first.plan.catalogDiagnostics.source, 'current_request')
  assert.equal(second.plan.catalogDiagnostics.source, 'session_catalog')
  assert.equal(second.plan.diagnostics.providerManagedStatus, 'experimental')
})

test('zai adapter does not import prompt injection helpers', () => {
  const source = readFileSync(join(process.cwd(), 'src/main/proxy/adapters/zai.ts'), 'utf8')
  assert.doesNotMatch(source, /^import[^\r\n]*(hasToolPromptInjected|toolsToSystemPrompt|TOOL_WRAP_HINT|shouldInjectToolPrompt)/m)
})
