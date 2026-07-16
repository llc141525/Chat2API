import test from 'node:test'
import assert from 'node:assert/strict'

import { ToolCallingEngine } from '../../src/main/proxy/toolCalling/ToolCallingEngine.ts'
import { anthropicRequestToOpenAI, type AnthropicMessagesRequest } from '../../src/main/proxy/routes/anthropicCompat.ts'
import { deriveAnthropicSessionIdentity } from '../../src/main/proxy/routes/anthropicSession.ts'
import type { Provider } from '../../src/main/store/types.ts'

const provider = {
  id: 'qwen',
  name: 'Qwen',
  type: 'builtin',
  authType: 'token',
  apiEndpoint: '',
  headers: {},
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
} as Provider

const initialRequest: AnthropicMessagesRequest = {
  model: 'qwen/Qwen3.7-Max',
  system: 'Repo task: inspect package.json',
  messages: [{ role: 'user', content: 'Use Read first.' }],
  tools: [
    {
      name: 'Bash',
      description: 'Execute shell commands',
      input_schema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
    {
      name: 'Read',
      description: 'Read a file',
      input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string' } },
        required: ['file_path'],
      },
    },
  ],
}

test('Anthropic compact follow-up restores the prior tool catalog from the stable Claude session key', () => {
  const engine = new ToolCallingEngine()
  const headers = { 'x-claude-code-session-id': 'session-compact-1' }
  const firstSession = deriveAnthropicSessionIdentity({
    request: initialRequest,
    headers,
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  const first = engine.transformRequest({
    request: anthropicRequestToOpenAI(initialRequest),
    provider,
    actualModel: 'Qwen3.7-Max',
    toolSessionKey: firstSession.claudeSessionKey,
  })

  const compactRequest: AnthropicMessagesRequest = {
    model: 'qwen/Qwen3.7-Max',
    system: 'Conversation compact summary: keep working on the same repository task.',
    messages: [{ role: 'user', content: 'Use Read first.' }],
  }
  const secondSession = deriveAnthropicSessionIdentity({
    request: compactRequest,
    headers,
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  const second = engine.transformRequest({
    request: anthropicRequestToOpenAI(compactRequest),
    provider,
    actualModel: 'Qwen3.7-Max',
    toolSessionKey: secondSession.claudeSessionKey,
  })

  assert.equal(firstSession.claudeSessionKey, secondSession.claudeSessionKey)
  assert.equal(second.plan.catalogDiagnostics.source, 'session_catalog')
  assert.deepEqual(second.plan.catalogDiagnostics.driftKinds, ['missing_current_tools_with_session_catalog'])
  assert.equal(second.plan.catalogSnapshot?.fingerprint, first.plan.catalogSnapshot?.fingerprint)
  assert.deepEqual(second.plan.tools.map((tool) => tool.name), ['Bash', 'Read'])
})

test('Anthropic follow-up with a non-empty subset respects current tools instead of restoring dropped session MCP/catalog entries', () => {
  const engine = new ToolCallingEngine()
  const headers = { 'x-claude-code-session-id': 'session-compact-subset-1' }
  const firstSession = deriveAnthropicSessionIdentity({
    request: {
      ...initialRequest,
      tools: [
        ...initialRequest.tools!,
        {
          name: 'CodeGraph',
          description: 'Read repository symbol graph',
          input_schema: {
            type: 'object',
            properties: { symbol: { type: 'string' } },
            required: ['symbol'],
          },
        },
      ],
    },
    headers,
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  const first = engine.transformRequest({
    request: anthropicRequestToOpenAI({
      ...initialRequest,
      tools: [
        ...initialRequest.tools!,
        {
          name: 'CodeGraph',
          description: 'Read repository symbol graph',
          input_schema: {
            type: 'object',
            properties: { symbol: { type: 'string' } },
            required: ['symbol'],
          },
        },
      ],
    }),
    provider,
    actualModel: 'Qwen3.7-Max',
    toolSessionKey: firstSession.claudeSessionKey,
  })

  const subsetRequest: AnthropicMessagesRequest = {
    model: 'qwen/Qwen3.7-Max',
    system: 'Conversation compact summary: continue using only Read.',
    messages: [{ role: 'user', content: 'Use Read first.' }],
    tools: [
      {
        name: 'Read',
        description: 'Read a file',
        input_schema: {
          type: 'object',
          properties: { file_path: { type: 'string' } },
          required: ['file_path'],
        },
      },
    ],
  }

  const secondSession = deriveAnthropicSessionIdentity({
    request: subsetRequest,
    headers,
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  const second = engine.transformRequest({
    request: anthropicRequestToOpenAI(subsetRequest),
    provider,
    actualModel: 'Qwen3.7-Max',
    toolSessionKey: secondSession.claudeSessionKey,
  })

  assert.equal(firstSession.claudeSessionKey, secondSession.claudeSessionKey)
  assert.equal(first.plan.catalogSnapshot?.allowedToolNames.includes('CodeGraph'), true)
  assert.equal(second.plan.catalogDiagnostics.source, 'current_request')
  assert.deepEqual(second.plan.tools.map((tool) => tool.name), ['Read'])
  assert.equal(second.plan.catalogSnapshot?.allowedToolNames.includes('CodeGraph'), false)
})

test('Derived Claude session key stays stable for same compacted conversation seed and differs for unrelated sessions', () => {
  const first = deriveAnthropicSessionIdentity({
    request: {
      model: 'qwen/Qwen3.7-Max',
      system: 'Repo task: inspect package.json',
      messages: [{ role: 'user', content: 'Use Read first.' }],
    },
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })
  const compactedSameSession = deriveAnthropicSessionIdentity({
    request: {
      model: 'qwen/Qwen3.7-Max',
      system: 'Repo task: inspect package.json',
      messages: [{ role: 'user', content: 'Compact summary says keep using Read.' }],
    },
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })
  const unrelated = deriveAnthropicSessionIdentity({
    request: {
      model: 'qwen/Qwen3.7-Max',
      system: 'Completely different task',
      messages: [{ role: 'user', content: 'Say hello.' }],
    },
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  assert.equal(first.source, 'derived_hash')
  assert.equal(compactedSameSession.source, 'derived_hash')
  assert.equal(first.claudeSessionKey, compactedSameSession.claudeSessionKey)
  assert.notEqual(first.claudeSessionKey, unrelated.claudeSessionKey)
})
