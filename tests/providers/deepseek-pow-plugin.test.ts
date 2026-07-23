import test from 'node:test'
import assert from 'node:assert/strict'

import { createDeepSeekProviderPlugin } from '../../src/main/proxy/plugins/DeepSeekProviderPlugin.ts'
import { buildDeepSeekPowResponse } from '../../src/main/proxy/providers/deepseek/pow.ts'
import type { ProviderRuntimeRequest } from '../../src/main/proxy/plugins/types.ts'
import type { RequestAssembly } from '../../src/main/proxy/RequestAssembly.ts'

const TARGET_PATH = '/api/v0/chat/completion'

function makeAssembly(messages: ProviderRuntimeRequest['messages']): RequestAssembly {
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
  }
}

function makeRequest(overrides: Partial<ProviderRuntimeRequest> = {}): ProviderRuntimeRequest {
  const messages = [
    { role: 'user', content: 'hello' },
  ]

  return {
    provider: { id: 'deepseek', name: 'DeepSeek' } as any,
    account: {
      id: 'account-1',
      name: 'DeepSeek Account',
      credentials: { token: 'same-account-token' },
    } as any,
    model: 'deepseek-chat',
    messages,
    assembly: makeAssembly(messages),
    stream: true,
    sessionId: 'session-1',
    ...overrides,
  }
}

function decodePowHeader(value: string): any {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8'))
}

test('DeepSeek buildRequest adds PoW header from production challenge and hash boundary', async () => {
  let capturedChallengeRequest: any
  const plugin = createDeepSeekProviderPlugin({
    postChallenge: async (url, body, config) => {
      capturedChallengeRequest = { url, body, config }
      return {
        status: 200,
        data: {
          data: {
            biz_data: {
              challenge: {
                algorithm: 'DeepSeekHashV1',
                challenge: 'challenge-value',
                salt: 'salt-value',
                difficulty: 144000,
                expire_at: 1234567890,
                signature: 'signature-value',
              },
            },
          },
        },
      }
    },
    getHash: async () => ({
      calculateHash: (algorithm, challenge, salt, difficulty, expireAt) => {
        assert.equal(algorithm, 'DeepSeekHashV1')
        assert.equal(challenge, 'challenge-value')
        assert.equal(salt, 'salt-value')
        assert.equal(difficulty, 144000)
        assert.equal(expireAt, 1234567890)
        return 42
      },
    } as any),
  })

  const req = await plugin.buildRequest(makeRequest())

  assert.equal(capturedChallengeRequest.url, 'https://chat.deepseek.com/api/v0/chat/create_pow_challenge')
  assert.deepEqual(capturedChallengeRequest.body, { target_path: TARGET_PATH })
  assert.equal(capturedChallengeRequest.config.headers.Authorization, 'Bearer same-account-token')
  assert.equal(req.url, 'https://chat.deepseek.com/api/v0/chat/completion')

  const powHeader = req.headers['x-ds-pow-response']
  assert.equal(typeof powHeader, 'string')
  const decoded = decodePowHeader(powHeader)
  assert.deepEqual(decoded, {
    algorithm: 'DeepSeekHashV1',
    challenge: 'challenge-value',
    salt: 'salt-value',
    answer: 42,
    signature: 'signature-value',
    target_path: TARGET_PATH,
  })
})

test('DeepSeek buildRequest creates a web chat session for the first production request', async () => {
  const plugin = createDeepSeekProviderPlugin({
    createSession: async () => 'created-session-1',
    postChallenge: async () => ({
      status: 200,
      data: {
        data: {
          biz_data: {
            challenge: {
              algorithm: 'DeepSeekHashV1',
              challenge: 'challenge-value',
              salt: 'salt-value',
              difficulty: 1,
              expire_at: 1234567890,
              signature: 'signature-value',
            },
          },
        },
      },
    }),
    getHash: async () => ({ calculateHash: () => 7 } as any),
  })

  const req = await plugin.buildRequest(makeRequest({ sessionId: undefined }))

  assert.equal(req.sessionId, 'created-session-1')
  assert.equal((req.body as any).chat_session_id, 'created-session-1')
  assert.equal(req.headers.Referer, 'https://chat.deepseek.com/a/chat/s/created-session-1')
})

test('DeepSeek buildRequest reuses an explicit provider session without creating a new one', async () => {
  let createSessionCalls = 0
  const plugin = createDeepSeekProviderPlugin({
    createSession: async () => {
      createSessionCalls += 1
      return 'unexpected-created-session'
    },
    postChallenge: async () => ({
      status: 200,
      data: {
        data: {
          biz_data: {
            challenge: {
              algorithm: 'DeepSeekHashV1',
              challenge: 'challenge-value',
              salt: 'salt-value',
              difficulty: 1,
              expire_at: 1234567890,
              signature: 'signature-value',
            },
          },
        },
      },
    }),
    getHash: async () => ({ calculateHash: () => 7 } as any),
  })

  const req = await plugin.buildRequest(makeRequest({ sessionId: 'existing-session-1' }))

  assert.equal(createSessionCalls, 0)
  assert.equal(req.sessionId, 'existing-session-1')
  assert.equal((req.body as any).chat_session_id, 'existing-session-1')
})

test('DeepSeek buildRequest does not leak account token when session creation fails', async () => {
  const plugin = createDeepSeekProviderPlugin({
    createSession: async () => {
      throw new Error('session creation rejected')
    },
    postChallenge: async () => {
      throw new Error('PoW should not run after session failure')
    },
  })

  await assert.rejects(
    () => plugin.buildRequest(makeRequest({
      sessionId: undefined,
      account: {
        id: 'account-1',
        name: 'DeepSeek Account',
        credentials: { token: 'secret-token-value' },
      } as any,
    })),
    (error: any) => {
      assert.equal(error instanceof Error, true)
      assert.equal(String(error.message).includes('secret-token-value'), false)
      return true
    },
  )
})

test('shared DeepSeek PoW helper owns exact target path and response encoding', async () => {
  let capturedChallengeRequest: any

  const powResponse = await buildDeepSeekPowResponse('same-account-token', TARGET_PATH, {
    postChallenge: async (url, body, config) => {
      capturedChallengeRequest = { url, body, config }
      return {
        status: 200,
        data: {
          biz_data: {
            challenge: {
              algorithm: 'DeepSeekHashV1',
              challenge: 'shared-challenge',
              salt: 'shared-salt',
              difficulty: 1,
              expire_at: 987654321,
              signature: 'shared-signature',
            },
          },
        },
      }
    },
    getHash: async () => ({
      calculateHash: () => 99,
    } as any),
  })

  assert.equal(capturedChallengeRequest.url, 'https://chat.deepseek.com/api/v0/chat/create_pow_challenge')
  assert.deepEqual(capturedChallengeRequest.body, { target_path: TARGET_PATH })
  assert.equal(capturedChallengeRequest.config.headers.Authorization, 'Bearer same-account-token')
  assert.deepEqual(decodePowHeader(powResponse), {
    algorithm: 'DeepSeekHashV1',
    challenge: 'shared-challenge',
    salt: 'shared-salt',
    answer: 99,
    signature: 'shared-signature',
    target_path: TARGET_PATH,
  })
})

test('DeepSeek buildRequest surfaces challenge failure', async () => {
  const plugin = createDeepSeekProviderPlugin({
    postChallenge: async () => ({
      status: 503,
      data: { msg: 'pow unavailable' },
    }),
    getHash: async () => {
      throw new Error('hash should not run')
    },
  })

  await assert.rejects(
    () => plugin.buildRequest(makeRequest()),
    /Failed to get DeepSeek PoW challenge: pow unavailable/,
  )
})

test('DeepSeek buildRequest surfaces hash failure', async () => {
  const plugin = createDeepSeekProviderPlugin({
    postChallenge: async () => ({
      status: 200,
      data: {
        data: {
          biz_data: {
            challenge: {
              algorithm: 'DeepSeekHashV1',
              challenge: 'challenge-value',
              salt: 'salt-value',
              difficulty: 144000,
              expire_at: 1234567890,
              signature: 'signature-value',
            },
          },
        },
      },
    }),
    getHash: async () => ({
      calculateHash: () => undefined,
    } as any),
  })

  await assert.rejects(
    () => plugin.buildRequest(makeRequest()),
    /DeepSeek PoW challenge calculation failed/,
  )
})
