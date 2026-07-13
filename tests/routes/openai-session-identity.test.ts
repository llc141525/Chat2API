import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyOpenAISessionIdentity,
  deriveOpenAISessionIdentity,
} from '../../src/main/proxy/routes/openaiSession.ts'
import type { ChatCompletionRequest, ProxyContext } from '../../src/main/proxy/types.ts'

function createRequest(messages: ChatCompletionRequest['messages'], extras: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: 'Qwen3.7-Max',
    messages,
    ...extras,
  }
}

function createContext(): ProxyContext {
  return {
    requestId: 'req-1',
    providerId: 'qwen',
    accountId: 'acc-1',
    model: 'Qwen3.7-Max',
    actualModel: 'Qwen3.7-Max',
    startTime: 1,
    isStream: false,
    clientIP: '127.0.0.1',
  }
}

test('same stable history without user derives the same key', () => {
  const requestA = createRequest([
    { role: 'user', content: 'Remember project Chat2API and nonce alpha.' },
  ])
  const requestB = createRequest([
    { role: 'user', content: 'Remember project Chat2API and nonce alpha.' },
    { role: 'assistant', content: 'Stored.' },
    { role: 'user', content: 'What did I ask you to remember?' },
  ])

  const identityA = deriveOpenAISessionIdentity({
    request: requestA,
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })
  const identityB = deriveOpenAISessionIdentity({
    request: requestB,
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  assert.equal(identityA.source, 'derived_hash')
  assert.equal(identityB.source, 'derived_hash')
  assert.equal(identityA.sessionKey, identityB.sessionKey)
})

test('appended OpenAI history without user keeps the same derived key', () => {
  const firstTurn = createRequest([
    { role: 'user', content: 'Remember project Chat2API and nonce alpha.' },
  ])
  const followUp = createRequest([
    { role: 'user', content: 'Remember project Chat2API and nonce alpha.' },
    { role: 'assistant', content: 'Stored.' },
    { role: 'user', content: 'What did I ask you to remember?' },
  ])

  const identityA = deriveOpenAISessionIdentity({
    request: firstTurn,
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })
  const identityB = deriveOpenAISessionIdentity({
    request: followUp,
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  assert.equal(identityA.source, 'derived_hash')
  assert.equal(identityB.source, 'derived_hash')
  assert.equal(identityA.sessionKey, identityB.sessionKey)
})

test('different first prefix derives different key', () => {
  const identityA = deriveOpenAISessionIdentity({
    request: createRequest([
      { role: 'user', content: 'prefix one' },
      { role: 'assistant', content: 'stored one' },
    ]),
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })
  const identityB = deriveOpenAISessionIdentity({
    request: createRequest([
      { role: 'user', content: 'prefix two' },
      { role: 'assistant', content: 'stored one' },
    ]),
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  assert.equal(identityA.source, 'derived_hash')
  assert.equal(identityB.source, 'derived_hash')
  assert.notEqual(identityA.sessionKey, identityB.sessionKey)
})

test('explicit header wins over derived hash', () => {
  const identity = deriveOpenAISessionIdentity({
    request: createRequest([
      { role: 'user', content: 'prefix one' },
      { role: 'assistant', content: 'stored one' },
    ]),
    headers: {
      'x-session-id': 'client-session-123',
    },
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  assert.equal(identity.source, 'header')
  assert.match(identity.sessionKey, /^openai-chat:[a-f0-9]{24}$/)
  assert.doesNotMatch(identity.sessionKey, /client-session-123/)
})

test('chat route context receives providerConversationSessionKey and toolCatalogSessionKey from derived identity', () => {
  const request = createRequest([
    { role: 'user', content: 'Remember nonce beta.' },
    { role: 'assistant', content: 'Stored.' },
    { role: 'user', content: 'Recall it.' },
  ])

  const expected = deriveOpenAISessionIdentity({
    request,
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  const context = applyOpenAISessionIdentity(createContext(), request)

  assert.equal(context.toolCatalogSessionKey, expected.sessionKey)
  assert.equal(context.providerConversationSessionKey, expected.sessionKey)
})
