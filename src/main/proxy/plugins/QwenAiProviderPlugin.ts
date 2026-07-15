/**
 * QwenAiProviderPlugin — Phase 1 wrapper around QwenAiAdapter
 *
 * Implements the WebProviderPlugin interface to bridge between
 * ProviderRuntime normalized types and the Qwen AI (chat.qwen.ai)
 * web provider protocol.
 *
 * NOTE: This is the INTERNATIONAL Qwen API (chat.qwen.ai), different
 * from the domestic Qwen plugin (chat2.qianwen.com).
 */

import type { WebProviderPlugin } from './WebProviderPlugin.ts'
import type {
  ProviderRuntimeRequest,
  ProviderWebRequest,
  ProviderWebResponse,
  ProviderRuntimeResult,
  ProviderRuntimeEvent,
  ProviderRuntimeError,
  ProviderDeleteSessionInput,
  ProviderDeleteSessionResult,
} from './types.ts'
import { QwenAiAdapter } from '../adapters/qwen-ai.ts'
import axios from 'axios'
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib'

const QWEN_AI_BASE = 'https://chat.qwen.ai'

/**
 * Generate a UUID v4 string.
 */
function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/**
 * Extract a user-visible query string from messages, combining system
 * content and conversation history into a single text block (mirrors
 * how QwenAiAdapter builds content for the API).
 */
function buildQwenAiContent(messages: Array<{ role: string; content: unknown }>): string {
  let systemContent = ''
  let allContent = ''

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemContent += (systemContent ? '\n\n' : '') + (typeof msg.content === 'string' ? msg.content : '')
    } else if (msg.role === 'user') {
      const text = typeof msg.content === 'string'
        ? msg.content
        : (Array.isArray(msg.content)
            ? (msg.content.find((p: any) => p.type === 'text')?.text || '')
            : '')
      allContent += (allContent ? '\n\n' : '') + `User: ${text}`
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string' && msg.content) {
        allContent += (allContent ? '\n\n' : '') + `Assistant: ${msg.content}`
      }
    }
  }

  return systemContent ? `${systemContent}\n\n${allContent}` : allContent
}

/**
 * Build the feature config object used in Qwen AI requests.
 */
function buildFeatureConfig(enableThinking: boolean): Record<string, unknown> {
  return {
    thinking_enabled: enableThinking,
    output_schema: 'phase',
    research_mode: 'normal',
    auto_thinking: enableThinking,
    thinking_format: 'summary',
    auto_search: false,
  }
}

/**
 * Build the request payload for the Qwen AI API.
 */
function buildQwenAiRequestBody(
  userContent: string,
  modelId: string,
  chatId: string,
  enableThinking: boolean,
): Record<string, unknown> {
  const fid = generateId().replace(/-/g, '')
  const childId = generateId().replace(/-/g, '')
  const ts = Math.floor(Date.now() / 1000)

  return {
    stream: true,
    version: '2.1',
    incremental_output: true,
    chat_id: chatId,
    chat_mode: 'normal',
    model: modelId,
    parent_id: null,
    messages: [
      {
        fid,
        parentId: null,
        childrenIds: [childId],
        role: 'user',
        content: userContent,
        user_action: 'chat',
        files: [],
        timestamp: ts,
        models: [modelId],
        chat_type: 't2t',
        feature_config: buildFeatureConfig(enableThinking),
        extra: { meta: { subChatType: 't2t' } },
        sub_chat_type: 't2t',
        parent_id: null,
      },
    ],
    timestamp: ts + 1,
  }
}

/**
 * Parse a raw Qwen AI streaming response into ProviderRuntimeEvent objects.
 *
 * Qwen AI SSE format uses phase-based events:
 *   data: {"choices":[{"delta":{"phase":"think","content":"..."}}]}
 *   data: {"choices":[{"delta":{"phase":"thinking_summary","extra":{...}}}]}
 *   data: {"choices":[{"delta":{"phase":"answer","content":"..."}}]}
 *   data: {"choices":[{"delta":{"status":"finished"}}]}
 *   data: [DONE]
 */
async function* qwenAiStreamToProviderEvents(
  rawResponse: unknown,
): AsyncIterable<ProviderRuntimeEvent> {
  const response = rawResponse as Record<string, unknown>
  const stream = (response?.data ?? response) as NodeJS.ReadableStream
  const headers = (response?.headers ?? {}) as Record<string, string>

  const contentEncoding = headers['content-encoding']?.toLowerCase()

  // ── Decompression ─────────────────────────────────────────────────
  let decompressed: NodeJS.ReadableStream = stream

  if (contentEncoding === 'gzip') {
    decompressed = stream.pipe(createGunzip())
  } else if (contentEncoding === 'deflate') {
    decompressed = stream.pipe(createInflate())
  } else if (contentEncoding === 'br') {
    decompressed = stream.pipe(createBrotliDecompress())
  } else if (contentEncoding && contentEncoding !== 'identity') {
    throw new Error(
      `QwenAiProviderPlugin.parseStream: unsupported content-encoding "${contentEncoding}"`,
    )
  }

  // ── SSE parsing state ─────────────────────────────────────────────
  let buffer = ''
  let chatId = ''
  let contentAccumulator = ''
  let reasoningAccumulator = ''
  let doneYielded = false
  let errorYielded = false

  try {
    for await (const chunk of decompressed) {
      buffer += chunk.toString()

      while (true) {
        const dblNewline = buffer.indexOf('\n\n')
        if (dblNewline === -1) break

        const eventBlock = buffer.slice(0, dblNewline)
        buffer = buffer.slice(dblNewline + 2)

        const lines = eventBlock.split('\n')
        let eventType = 'message'
        let eventData = ''

        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            eventData = line.slice(5)
          }
        }

        if (!eventData || eventData === '[DONE]') continue

        let result: Record<string, unknown>
        try {
          result = JSON.parse(eventData) as Record<string, unknown>
        } catch {
          continue
        }

        // ── Response ID / chat ID ───────────────────────────────────
        const responseCreated = result['response.created'] as Record<string, unknown> | undefined
        if (responseCreated?.response_id && !chatId) {
          chatId = String(responseCreated.response_id)
        }

        // ── Choices / phase-based deltas ────────────────────────────
        const choices = result.choices as Array<Record<string, unknown>> | undefined
        if (choices && choices.length > 0) {
          const choice = choices[0]
          const delta = choice.delta as Record<string, unknown> | undefined
          if (!delta) continue

          const phase = delta.phase as string | null | undefined
          const status = delta.status as string | undefined
          const content = String(delta.content ?? '')

          if (phase === 'think' && status !== 'finished') {
            // Thinking content — yield as reasoning_content delta
            if (content && content.length > reasoningAccumulator.length) {
              const diff = content.slice(reasoningAccumulator.length)
              reasoningAccumulator = content
              if (diff.trim()) {
                yield { type: 'text_delta', text: diff }
              }
            }
          } else if (phase === 'answer' || (phase === null && content)) {
            // Answer content — yield as text_delta
            if (content && content.length > contentAccumulator.length) {
              const diff = content.slice(contentAccumulator.length)
              contentAccumulator = content
              if (diff.trim()) {
                yield { type: 'text_delta', text: diff }
              }
            }

            if (status === 'finished' && !doneYielded) {
              doneYielded = true
              yield { type: 'done', finishReason: 'stop' }
            }
          } else if (phase === 'thinking_summary') {
            // Handle thinking_summary — extract summary_thought content as reasoning
            const extra = delta.extra as Record<string, unknown> | undefined
            const summaryThought = extra?.summary_thought as Record<string, unknown> | undefined
            if (summaryThought?.content) {
              const summaryContent = (summaryThought.content as string[]).join('\n')
              if (summaryContent && summaryContent.length > reasoningAccumulator.length) {
                const diff = summaryContent.slice(reasoningAccumulator.length)
                reasoningAccumulator = summaryContent
                if (diff.trim()) {
                  yield { type: 'text_delta', text: diff }
                }
              }
            }
          }

          // Fallback: status finished with no phase
          if (status === 'finished' && phase === undefined && !doneYielded) {
            doneYielded = true
            yield { type: 'done', finishReason: 'stop' }
          }
        }

        // ── Error codes ─────────────────────────────────────────────
        const errorCode = result.error_code as number | undefined
        if (errorCode && errorCode !== 0) {
          errorYielded = true
          yield {
            type: 'error',
            error: {
              status: 0,
              code: String(errorCode),
              message: String(result.error_msg ?? `Error ${errorCode}`),
              retryable: false,
              classified: true,
            },
          }
        }
      }
    }

    // ── End of stream without explicit complete ─────────────────────
    if (!doneYielded && !errorYielded) {
      yield { type: 'done', finishReason: 'stop' }
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

export const QwenAiProviderPlugin: WebProviderPlugin = {
  id: 'qwen-ai',
  version: '1.0.0',

  matches(provider: { id: string }): boolean {
    return provider.id.toLowerCase() === 'qwen-ai'
  },

  capabilities: {
    supportsProviderSession: true,
    supportsParentMessageId: true,
    supportsDeleteSession: true,
    supportsStreaming: true,
    supportsNonStreaming: true,
    supportsNativeTools: false,
    preferredManagedProtocol: 'managed_xml',
    sessionIdKind: 'chat_id',
    transport: 'provider_chat_api',
  },

  async buildRequest(input: ProviderRuntimeRequest): Promise<ProviderWebRequest> {
    const adapter = new QwenAiAdapter(input.provider, input.account)

    const modelId = adapter.mapModel(input.model)
    const sessionId = input.sessionId || generateId().replace(/-/g, '')
    const reqId = generateId().replace(/-/g, '')

    // Build user content from messages
    const userContent = buildQwenAiContent(input.messages)

    // Determine thinking mode
    const enableThinking = input.enableThinking ?? false

    const requestBody = buildQwenAiRequestBody(userContent, modelId, sessionId, enableThinking)

    const token = input.account.credentials.token
      || input.account.credentials.accessToken
      || input.account.credentials.apiKey
      || ''

    const cookies = input.account.credentials.cookies
      || input.account.credentials.cookie
      || ''

    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'source': 'web',
      'bx-v': '2.5.36',
      'Version': '0.2.7',
      'Origin': QWEN_AI_BASE,
      'Referer': `${QWEN_AI_BASE}/`,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      'X-Request-Id': reqId,
      'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    }

    if (cookies) {
      headers['Cookie'] = cookies
    }

    const url = `${QWEN_AI_BASE}/api/v2/chat/completions?chat_id=${sessionId}`

    return {
      url,
      method: 'POST',
      headers,
      body: requestBody,
      sessionId,
      reqId,
    }
  },

  async parseNonStream(input: ProviderWebResponse): Promise<ProviderRuntimeResult> {
    let sessionId = ''
    let reqId = ''

    try {
      const data = input.data as Record<string, any>
      if (data?.chat_id) {
        sessionId = String(data.chat_id)
      }
      if (data?.id) {
        reqId = String(data.id)
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
   * Parse a streaming Qwen AI response into normalized runtime events.
   *
   * Accepts the raw Axios response object (or a duck-typed equivalent)
   * with:
   *   - `.data`   – the response body stream (Readable)
   *   - `.headers` – response headers, used to detect content-encoding
   *
   * Yields ProviderRuntimeEvent objects:
   *   text_delta  – for each new text or reasoning content delta
   *   done        – when the stream finishes
   *   error       – on Qwen AI API error codes
   */
  parseStream(input: unknown): AsyncIterable<ProviderRuntimeEvent> {
    return qwenAiStreamToProviderEvents(input)
  },

  async deleteSession(input: ProviderDeleteSessionInput): Promise<ProviderDeleteSessionResult> {
    const adapter = new QwenAiAdapter(input.provider, input.account)
    const success = await adapter.deleteChat(input.sessionId)
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
