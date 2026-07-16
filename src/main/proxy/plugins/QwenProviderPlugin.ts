/**
 * QwenProviderPlugin — Phase 1 wrapper around QwenAdapter
 *
 * Implements the WebProviderPlugin interface to bridge between
 * ProviderRuntime normalized types and the Qwen web provider protocol.
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
import { DEFAULT_HEADERS, QwenAdapter, QwenStreamHandler, buildQwenAssemblyRequestBodyForTest } from '../adapters/qwen.ts'
import axios from 'axios'

const QWEN_API_BASE = 'https://chat2.qianwen.com'

/**
 * Generate a UUID-like string without dashes.
 */
function generateId(): string {
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/**
 * Generate a random 12-character nonce.
 */
function generateNonce(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

async function* qwenStreamToProviderEvents(
  input: ProviderRuntimeStreamInput | ProviderWebResponse,
): AsyncIterable<ProviderRuntimeEvent> {
  const runtimeInput = 'response' in input
    ? input
    : {
        response: input,
        model: 'qwen',
      }
  const handler = new QwenStreamHandler(runtimeInput.model, undefined, runtimeInput.toolCallingPlan)
  const rawResponse = (runtimeInput.rawResponse && typeof runtimeInput.rawResponse === 'object')
    ? runtimeInput.rawResponse as Record<string, unknown>
    : runtimeInput.response as unknown as Record<string, unknown>
  const responseStream = (rawResponse.data ?? runtimeInput.response.data) as NodeJS.ReadableStream
  const axiosLikeResponse = rawResponse.data !== undefined
    ? rawResponse
    : {
        ...rawResponse,
        status: rawResponse.status ?? runtimeInput.response.status,
        headers: rawResponse.headers ?? runtimeInput.response.headers,
        data: responseStream,
      }
  const openAiStream = handler.handleStream(
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
        if (!dataLine) {
          continue
        }

        const payload = dataLine.slice(5).trim()
        if (!payload || payload === '[DONE]') {
          continue
        }

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

        if (!emittedSessionUpdate && (handler.getSessionId() || handler.getResponseId())) {
          emittedSessionUpdate = true
          yield {
            type: 'session_update',
            sessionId: handler.getSessionId() || undefined,
            parentId: handler.getResponseId() || undefined,
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

export const QwenProviderPlugin: WebProviderPlugin = {
  id: 'qwen',
  version: '1.0.0',

  matches(provider: { id: string }): boolean {
    return provider.id.toLowerCase() === 'qwen'
  },

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

  async buildRequest(input: ProviderRuntimeRequest): Promise<ProviderWebRequest> {
    // Create adapter instance (Phase 1: delegate internally to existing adapter)
    const adapter = new QwenAdapter(input.provider, input.account)

    const ticket = input.account.credentials.ticket || input.account.credentials.tongyi_sso_ticket || ''

    const reqId = generateId()
    const sessionId = input.sessionId || generateId()
    const timestamp = Date.now()
    const nonce = generateNonce()

    // Build a minimal ChatCompletionRequest for the body builder
    const chatRequest = {
      model: input.model,
      originalModel: input.originalModel,
      messages: input.assembly.messages as any,
      stream: input.stream,
      temperature: input.temperature,
      sessionId: input.sessionId,
      parentReqId: input.parentReqId,
      enableThinking: input.enableThinking ?? false,
      enableWebSearch: input.enableWebSearch ?? false,
      promptRefreshMode: input.promptRefreshMode,
    }

    const requestBody = buildQwenAssemblyRequestBodyForTest({
      assembly: input.assembly,
      request: chatRequest as any,
      actualModel: input.model,
      sessionId,
      reqId,
      parentReqId: input.parentReqId,
      timestamp,
      enableThinking: input.enableThinking ?? false,
      enableWebSearch: input.enableWebSearch ?? false,
    })

    const queryString = `biz_id=ai_qwen&chat_client=h5&device=pc&fr=pc&pr=qwen&ut=${generateId()}&nonce=${nonce}&timestamp=${timestamp}`
    const url = `${QWEN_API_BASE}/api/v2/chat?${queryString}`

    return {
      url,
      method: 'POST',
      headers: {
        ...DEFAULT_HEADERS,
        'Content-Type': 'application/json',
        Cookie: `tongyi_sso_ticket=${ticket}`,
      },
      body: requestBody,
      sessionId,
      reqId,
      transportOptions: {
        responseType: 'stream',
        timeout: 120000,
        decompress: false,
        validateStatus: () => true,
      },
    }
  },

  async parseNonStream(input: ProviderWebResponse): Promise<ProviderRuntimeResult> {
    if (input.data && typeof (input.data as any).on === 'function') {
      const handler = new QwenStreamHandler('qwen')
      const body = await handler.handleNonStream(input.data, input as any)

      return {
        sessionId: handler.getSessionId(),
        reqId: handler.getResponseId(),
        response: {
          ...input,
          data: body,
        },
      }
    }

    let sessionId = ''
    let reqId = ''

    try {
      const data = input.data as Record<string, any>
      if (data?.communication?.sessionid) {
        sessionId = String(data.communication.sessionid)
      }
      if (data?.communication?.reqid) {
        reqId = String(data.communication.reqid)
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

  /**
   * Parse a streaming Qwen response into normalized runtime events.
   *
   * Accepts the raw Axios response object (or a duck-typed equivalent)
   * with:
   *   - `.data`   – the response body stream (Readable)
   *   - `.headers` – response headers, used to detect content-encoding
   *                  for automatic decompression (gzip, deflate, br).
   *
   * Yields ProviderRuntimeEvent objects:
   *   session_update  – when the Qwen session ID is first received
   *   text_delta      – for each new text content delta
   *   done            – when the stream finishes
   *   error           – on Qwen API error codes
   */
  parseStream(input: ProviderRuntimeStreamInput): AsyncIterable<ProviderRuntimeEvent> {
    return qwenStreamToProviderEvents(input)
  },

  async deleteSession(input: ProviderDeleteSessionInput): Promise<ProviderDeleteSessionResult> {
    const adapter = new QwenAdapter(input.provider, input.account)
    const success = await adapter.deleteSession(input.sessionId)
    return { success }
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
