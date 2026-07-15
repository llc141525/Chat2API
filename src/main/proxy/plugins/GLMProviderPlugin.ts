/**
 * GLMProviderPlugin — Phase 1 wrapper around GLMAdapter
 *
 * Implements the WebProviderPlugin interface to bridge between
 * ProviderRuntime normalized types and the GLM web provider protocol.
 */

import type { WebProviderPlugin } from './WebProviderPlugin.ts'
import type {
  ProviderRuntimeRequest,
  ProviderRuntimeStreamInput,
  ProviderWebRequest,
  ProviderWebResponse,
  ProviderRuntimeResult,
  ProviderRuntimeEvent,
  ProviderRuntimeError,
  ProviderDeleteSessionInput,
  ProviderDeleteSessionResult,
} from './types.ts'
import { GLMAdapter, GLMStreamHandler, buildGLMAssemblyPromptMessagesForTest } from '../adapters/glm.ts'
import crypto from 'node:crypto'
import axios from 'axios'

const GLM_API_BASE = 'https://chatglm.cn/chatglm'
const DEFAULT_ASSISTANT_ID = '65940acff94777010aa6b796'
const SIGN_SECRET = '8a1317a7468aa3ad86e997d08f3f31cb'

const FAKE_HEADERS: Record<string, string> = {
  Accept: 'text/event-stream',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
  'App-Name': 'chatglm',
  'Cache-Control': 'no-cache',
  'Content-Type': 'application/json',
  Origin: 'https://chatglm.cn',
  Pragma: 'no-cache',
  Priority: 'u=1, i',
  'Sec-Ch-Ua': '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'X-App-Fr': 'browser_extension',
  'X-App-Platform': 'pc',
  'X-App-Version': '0.0.1',
  'X-Device-Brand': '',
  'X-Device-Model': '',
  'X-Lang': 'zh',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
}

/**
 * Generate a UUID string with dashes.
 */
function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/**
 * Generate a request-scoped ID (no dashes).
 */
function generateId(): string {
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/**
 * MD5 hash of a string.
 */
function md5(str: string): string {
  return crypto.createHash('md5').update(str).digest('hex')
}

/**
 * Generate GLM request signing parameters (pure, no HTTP calls).
 */
function generateSign(): { timestamp: string; nonce: string; sign: string } {
  const e = Date.now()
  const A = e.toString()
  const t = A.length
  const o = A.split('').map((c) => Number(c))
  const i = o.reduce((acc, val) => acc + val, 0) - o[t - 2]
  const a = i % 10
  const timestamp = A.substring(0, t - 2) + a + A.substring(t - 1, t)
  const nonce = uuid()
  const sign = md5(`${timestamp}-${nonce}-${SIGN_SECRET}`)
  return { timestamp, nonce, sign }
}

async function* glmStreamToProviderEvents(
  input: ProviderRuntimeStreamInput,
): AsyncIterable<ProviderRuntimeEvent> {
  const handler = new GLMStreamHandler(input.model, undefined, undefined, input.toolCallingPlan)
  const rawResponse = (input.rawResponse && typeof input.rawResponse === 'object')
    ? input.rawResponse as Record<string, unknown>
    : input.response as unknown as Record<string, unknown>
  const responseStream = (rawResponse.data ?? input.response.data) as NodeJS.ReadableStream
  const axiosLikeResponse = rawResponse.data !== undefined
    ? rawResponse
    : {
        ...rawResponse,
        status: rawResponse.status ?? input.response.status,
        headers: rawResponse.headers ?? input.response.headers,
        data: responseStream,
      }

  const openAiStream = await handler.handleStream(
    responseStream,
    axiosLikeResponse as any,
  )

  let buffer = ''
  let emittedSessionUpdate = false

  try {
    for await (const chunk of openAiStream) {
      buffer += chunk.toString()

      while (true) {
        const dblNewline = buffer.indexOf('\n\n')
        if (dblNewline === -1) break

        const eventBlock = buffer.slice(0, dblNewline)
        buffer = buffer.slice(dblNewline + 2)

        const dataLine = eventBlock
          .split('\n')
          .find((line) => line.startsWith('data:'))
        if (!dataLine) continue

        const payload = dataLine.slice(5).trim()
        if (!payload || payload === '[DONE]') continue

        let parsed: Record<string, any>
        try {
          parsed = JSON.parse(payload)
        } catch {
          continue
        }

        if (parsed.error) {
          const statusCode = Number(parsed.error.code ?? 0)
          yield {
            type: 'error',
            error: {
              status: Number.isFinite(statusCode) ? statusCode : 0,
              code: String(parsed.error.code ?? 'STREAM_ERROR'),
              message: String(parsed.error.message ?? 'Stream error'),
              retryable: statusCode >= 500 || statusCode === 0,
              classified: true,
            },
          }
          return
        }

        if (!emittedSessionUpdate && parsed.id) {
          emittedSessionUpdate = true
          yield {
            type: 'session_update',
            sessionId: String(parsed.id),
            parentId: String(parsed.id),
          }
        }

        const choice = parsed.choices?.[0]
        const delta = choice?.delta ?? {}
        const finishReason = choice?.finish_reason

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          yield { type: 'text_delta', text: delta.content }
        }
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          yield { type: 'text_delta', text: delta.reasoning_content }
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) {
            yield {
              type: 'tool_call_delta',
              call: {
                index: Number(call.index ?? 0),
                id: typeof call.id === 'string' ? call.id : undefined,
                function: call.function ? {
                  ...(typeof call.function.name === 'string' ? { name: call.function.name } : {}),
                  ...(typeof call.function.arguments === 'string' ? { arguments: call.function.arguments } : {}),
                } : undefined,
              },
            }
          }
        }

        if (finishReason) {
          yield { type: 'done', finishReason }
        }
      }
    }
  } catch (err: unknown) {
    yield {
      type: 'error',
      error: {
        status: 0,
        code: 'STREAM_ERROR',
        message: err instanceof Error ? err.message : 'Stream processing error',
        retryable: true,
        classified: true,
      },
    }
  }
}

export const GLMProviderPlugin: WebProviderPlugin = {
  id: 'glm',
  version: '1.0.0',

  matches(provider: { id: string }): boolean {
    return provider.id.toLowerCase() === 'glm'
  },

  capabilities: {
    supportsProviderSession: true,
    supportsParentMessageId: true,
    supportsDeleteSession: true,
    supportsStreaming: true,
    supportsNonStreaming: true,
    supportsNativeTools: false,
    preferredManagedProtocol: 'managed_xml',
    sessionIdKind: 'conversation_id',
    transport: 'provider_chat_api',
  },

  async buildRequest(input: ProviderRuntimeRequest): Promise<ProviderWebRequest> {
    // Create adapter instance for message conversion utilities and token refresh.
    const adapter = new GLMAdapter(input.provider, input.account)

    const preparedMessages = buildGLMAssemblyPromptMessagesForTest(
      input.assembly,
      [],  // empty refs — file uploads not done here
      !!input.sessionId,
    )

    // Determine assistant ID from model name or use default
    let assistantId = DEFAULT_ASSISTANT_ID
    if (/^[a-z0-9]{24,}$/.test(input.model)) {
      assistantId = input.model
    }

    // Determine chat mode from reasoning/thinking flags
    let chatMode = ''
    let isNetworking = false
    const modelForDetection = input.originalModel || input.model
    const modelLower = modelForDetection.toLowerCase()

    if (input.enableThinking) {
      chatMode = 'zero'
    }
    if (input.enableWebSearch) {
      isNetworking = true
    }
    if (!chatMode && (modelLower.includes('think') || modelLower.includes('zero'))) {
      chatMode = 'zero'
    }

    const reqId = generateId()
    const sign = generateSign()
    const conversationId = input.sessionId || ''
    const token = await adapter.acquireToken()

    const body = {
      assistant_id: assistantId,
      conversation_id: conversationId,
      project_id: '',
      chat_type: 'user_chat',
      messages: preparedMessages,
      meta_data: {
        channel: '',
        chat_mode: chatMode || undefined,
        draft_id: '',
        if_plus_model: true,
        input_question_type: 'xxxx',
        is_networking: isNetworking,
        is_test: false,
        platform: 'pc',
        quote_log_id: '',
        cogview: {
          rm_label_watermark: false,
        },
      },
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...FAKE_HEADERS,
      'X-Device-Id': uuid(),
      'X-Request-Id': uuid(),
      'X-Sign': sign.sign,
      'X-Timestamp': sign.timestamp,
      'X-Nonce': sign.nonce,
    }

    return {
      url: `${GLM_API_BASE}/backend-api/assistant/stream`,
      method: 'POST',
      headers,
      body,
      sessionId: conversationId,
      reqId,
      transportOptions: {
        responseType: 'stream',
        timeout: 120000,
        validateStatus: () => true,
      },
    }
  },

  async parseNonStream(input: ProviderWebResponse): Promise<ProviderRuntimeResult> {
    let sessionId = ''
    let reqId = ''

    try {
      const data = input.data as Record<string, any>
      if (data?.conversation_id) {
        sessionId = String(data.conversation_id)
      }
      if (data?.req_id) {
        reqId = String(data.req_id)
      }
    } catch {
      // Ignore parse errors, return empty strings
    }

    return {
      sessionId,
      reqId,
      response: input,
    }
  },

  async deleteSession(input: ProviderDeleteSessionInput): Promise<ProviderDeleteSessionResult> {
    const adapter = new GLMAdapter(input.provider, input.account)
    const success = await adapter.deleteConversation(input.sessionId)
    return { success }
  },

  parseStream(input: ProviderRuntimeStreamInput): AsyncIterable<ProviderRuntimeEvent> {
    return glmStreamToProviderEvents(input)
  },

  classifyError(error: unknown): ProviderRuntimeError {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status ?? 0
      return {
        status,
        code: `HTTP_${status}`,
        message: error.message || 'Unknown Axios error',
        retryable: status >= 500 || status === 429 || status === 0,
        classified: true,
      }
    }

    return {
      status: 0,
      code: 'UNKNOWN',
      message: error instanceof Error ? error.message : 'Unknown error',
      retryable: false,
      classified: false,
    }
  },
}
