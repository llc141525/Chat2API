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

test('minimax profile is experimental with polling transport', () => {
  const profile = getProviderToolProfile('minimax')
  assert.equal(profile.managedToolSupportStatus, 'experimental')
  assert.equal(profile.managedTransport, 'polling_stream')
  assert.deepEqual(profile.providerRiskControlCaveats, [])
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
