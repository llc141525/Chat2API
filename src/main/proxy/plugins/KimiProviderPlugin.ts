/**
 * KimiProviderPlugin — Phase 1 wrapper around KimiAdapter
 *
 * Implements the WebProviderPlugin interface to bridge between
 * ProviderRuntime normalized types and the Kimi web provider protocol.
 */

import type { WebProviderPlugin } from './WebProviderPlugin.ts'
import type {
  ProviderRuntimeRequest,
  ProviderRuntimeStreamInput,
  ProviderRuntimeEvent,
  ProviderWebRequest,
  ProviderWebResponse,
  ProviderRuntimeResult,
  ProviderRuntimeError,
  ProviderDeleteSessionInput,
  ProviderDeleteSessionResult,
} from './types.ts'
import { KimiAdapter, KimiStreamHandler } from '../adapters/kimi.ts'
import {
  createKimiChatPayload,
  encodeKimiGrpcFrame,
} from '../adapters/providerModelOptions.ts'
import axios from 'axios'

const KIMI_API_BASE = 'https://www.kimi.com'

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
 * Extract text content from a message content field (handles string, array of parts, etc.).
 */
function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((c: Record<string, unknown>) => c.type === 'text')
      .map((c: Record<string, unknown>) => String(c.text ?? ''))
      .join('\n')
  }
  return String(content ?? '')
}

/**
 * Convert normalized messages into a Kimi conversation text string.
 *
 * Mirrors KimiAdapter.messagesPrepare() logic but simplified for managed_xml
 * (tool calls are embedded as XML in text, not native tool_call objects).
 */
function buildKimiContent(
  messages: Array<{ role: string; content: unknown }>,
): string {
  const parts: string[] = []
  let system = ''
  for (const msg of messages) {
    const txt = extractTextContent(msg.content)
    if (!txt) continue
    if (msg.role === 'system') {
      system = txt
    } else if (msg.role === 'assistant') {
      parts.push(`Assistant: ${txt}`)
    } else {
      parts.push(txt)
    }
  }
  const joined = parts.join('\n\n')
  return system ? `${system}\n\nUser: ${joined}` : joined
}

async function* kimiStreamToProviderEvents(
  input: ProviderRuntimeStreamInput | ProviderWebResponse,
): AsyncIterable<ProviderRuntimeEvent> {
  const runtimeInput = 'response' in input
    ? input
    : {
        response: input,
        model: 'kimi',
      }
  const handler = new KimiStreamHandler(
    runtimeInput.model,
    '',
    false,
    runtimeInput.toolCallingPlan,
  )
  const rawResponse = (runtimeInput.rawResponse && typeof runtimeInput.rawResponse === 'object')
    ? runtimeInput.rawResponse as Record<string, unknown>
    : runtimeInput.response as unknown as Record<string, unknown>
  const responseStream = (rawResponse.data ?? runtimeInput.response.data) as NodeJS.ReadableStream
  const openAiStream = await handler.handleStream(responseStream)

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

        if (!emittedSessionUpdate && handler.getConversationId()) {
          emittedSessionUpdate = true
          yield {
            type: 'session_update',
            sessionId: handler.getConversationId() || undefined,
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

export const KimiProviderPlugin: WebProviderPlugin = {
  id: 'kimi',
  version: '1.0.0',

  matches(provider: { id: string }): boolean {
    return provider.id.toLowerCase() === 'kimi'
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
    const token = input.account.credentials.token
      || input.account.credentials.refreshToken
      || ''
    const sessionId = input.sessionId || generateId()
    const reqId = generateId()

    // Build conversation text from normalized messages
    const content = buildKimiContent(input.messages)

    // Check model name hints for thinking / web search
    const modelLower = (input.originalModel || input.model).toLowerCase()
    const enableThinking = input.enableThinking
      ?? (modelLower.includes('think') || modelLower.includes('r1'))
    const enableWebSearch = input.enableWebSearch
      ?? modelLower.includes('search')

    // Construct Kimi gRPC-Web frame (pure functions, no HTTP calls)
    const payload = createKimiChatPayload({
      model: input.model,
      content,
      enableWebSearch,
      enableThinking,
    })
    const frameBuffer = encodeKimiGrpcFrame(payload)

    return {
      url: `${KIMI_API_BASE}/apiv2/kimi.gateway.chat.v1.ChatService/Chat`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/connect+json',
      },
      body: frameBuffer,
      sessionId,
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
      const data = input.data as Record<string, unknown>
      // gRPC-Web response: try to decode the binary frame
      if (data && typeof data === 'object') {
        if (data.chat?.id) {
          sessionId = String((data.chat as Record<string, unknown>).id)
        }
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

  parseStream(input: ProviderRuntimeStreamInput): AsyncIterable<ProviderRuntimeEvent> {
    return kimiStreamToProviderEvents(input)
  },

  async deleteSession(input: ProviderDeleteSessionInput): Promise<ProviderDeleteSessionResult> {
    const adapter = new KimiAdapter(input.provider, input.account)
    const success = await adapter.deleteConversation(input.sessionId)
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
