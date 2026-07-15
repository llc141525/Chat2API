/**
 * ZaiProviderPlugin — Phase 1 wrapper around ZaiAdapter
 *
 * Implements the WebProviderPlugin interface to bridge between
 * ProviderRuntime normalized types and the Z.ai (GLM International)
 * web provider protocol.
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
import { ZaiAdapter } from '../adapters/zai.ts'
import axios from 'axios'
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib'
import crypto from 'crypto'

const ZAI_API_BASE = 'https://chat.z.ai'
const ZAI_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

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
 * Generate a UUID without dashes.
 */
function generateIdFlat(): string {
  return generateId().replace(/-/g, '')
}

/**
 * Extract a user ID from a JWT token — mirrors the adapter's logic.
 */
function extractUserIdFromToken(token: string): string {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return 'guest'
    let payload = parts[1]
    const padding = payload.length % 4
    if (padding > 0) payload += '='.repeat(4 - padding)
    payload = payload.replace(/-/g, '+').replace(/_/g, '/')
    const decoded = Buffer.from(payload, 'base64').toString('utf8')
    const data = JSON.parse(decoded)
    return data.id || data.user_id || data.uid || data.sub || 'guest'
  } catch {
    return 'guest'
  }
}

/**
 * Generate the X-Signature for Z.ai API requests — mirrors the adapter's logic.
 */
function generateZaiSignature(
  messageText: string,
  requestId: string,
  timestampMs: number,
  userId: string,
): string {
  const SECRET = 'key-@@@@)))()((9))-xxxx&&&%%%%%'
  const windowIndex = Math.floor(timestampMs / (5 * 60 * 1000))
  const metaString = `requestId,${requestId},timestamp,${timestampMs},user_id,${userId}`
  const messageB64 = Buffer.from(messageText, 'utf-8').toString('base64')
  const canonicalString = `${metaString}|${messageB64}|${String(timestampMs)}`

  const derivedKey = crypto.createHmac('sha256', SECRET).update(String(windowIndex)).digest('hex')
  return crypto.createHmac('sha256', derivedKey).update(canonicalString).digest('hex')
}

/**
 * Map OpenAI model names to Z.ai model IDs — mirrors the adapter's logic.
 */
function mapZaiModel(model: string): string {
  const mapping: Record<string, string> = {
    'glm-5.2': 'GLM-5.2',
    'glm-5.1': 'GLM-5.1',
    'glm-5-turbo': 'GLM-5-Turbo',
    'glm-5v-turbo': 'GLM-5v-Turbo',
    'glm-5': 'glm-5',
    'glm-4.7': 'glm-4.7',
    'GLM-5.2': 'GLM-5.2',
    'GLM-5.1': 'GLM-5.1',
    'GLM-5-Turbo': 'GLM-5-Turbo',
    'GLM-5V-Turbo': 'GLM-5v-Turbo',
    'GLM-5v-Turbo': 'GLM-5v-Turbo',
    'GLM-5': 'glm-5',
    'GLM-4.7': 'glm-4.7',
  }
  return mapping[model] || mapping[model.toLowerCase()] || model
}

/**
 * Build query parameters for the Z.ai API request URL.
 */
function buildZaiQueryParams(
  timestamp: number,
  requestId: string,
  userId: string,
  token: string,
  chatId: string,
): URLSearchParams {
  const params = new URLSearchParams({
    timestamp: String(timestamp),
    requestId,
    user_id: userId,
    version: '0.0.1',
    platform: 'web',
    token,
    user_agent: ZAI_USER_AGENT,
    language: 'zh-CN',
    languages: 'zh-CN,zh',
    timezone: 'Asia/Shanghai',
    cookie_enabled: 'true',
    screen_width: '1512',
    screen_height: '982',
    screen_resolution: '1512x982',
    viewport_height: '945',
    viewport_width: '923',
    viewport_size: '923x945',
    color_depth: '30',
    pixel_ratio: '2',
    current_url: `${ZAI_API_BASE}/c/${chatId}`,
    pathname: `/c/${chatId}`,
    search: '',
    hash: '',
    host: 'chat.z.ai',
    hostname: 'chat.z.ai',
    protocol: 'https:',
    referrer: '',
    title: 'Z.ai - Free AI Chatbot & Agent powered by GLM-5 & GLM-4.7',
    timezone_offset: '-480',
    local_time: new Date().toISOString(),
    utc_time: new Date().toUTCString(),
    is_mobile: 'false',
    is_touch: 'false',
    max_touch_points: '0',
    browser_name: 'Chrome',
    os_name: 'Mac OS',
    signature_timestamp: String(timestamp),
  })
  return params
}

/**
 * Build the request body for the Z.ai API.
 */
function buildZaiRequestBody(
  mappedModel: string,
  messages: Array<{ role: string; content: unknown }>,
  chatId: string,
  messageId: string,
  enableThinking: boolean,
  enableWebSearch: boolean,
): Record<string, unknown> {
  return {
    stream: true,
    model: mappedModel,
    messages: messages.map(m => ({
      role: m.role,
      content: m.content,
    })),
    signature_prompt: '',
    params: {},
    extra: {},
    features: {
      image_generation: false,
      web_search: false,
      auto_web_search: enableWebSearch,
      preview_mode: true,
      flags: [],
      vlm_tools_enable: false,
      vlm_web_search_enable: false,
      vlm_website_mode: false,
      enable_thinking: enableThinking,
    },
    variables: {
      '{{USER_NAME}}': 'User',
      '{{USER_LOCATION}}': 'Unknown',
      '{{CURRENT_DATETIME}}': new Date().toISOString().replace('T', ' ').substring(0, 19),
      '{{CURRENT_DATE}}': new Date().toISOString().substring(0, 10),
      '{{CURRENT_TIME}}': new Date().toISOString().substring(11, 19),
      '{{CURRENT_WEEKDAY}}': ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date().getDay()],
      '{{CURRENT_TIMEZONE}}': 'Asia/Shanghai',
      '{{USER_LANGUAGE}}': 'zh-CN',
    },
    chat_id: chatId,
    id: generateIdFlat(),
    current_user_message_id: messageId,
    current_user_message_parent_id: null,
    background_tasks: {
      title_generation: true,
      tags_generation: true,
    },
  }
}

/**
 * Extract the last user message text from the messages array —
 * mirrors the adapter's logic for the signature_prompt.
 */
function extractLastUserMessage(messages: Array<{ role: string; content: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      const content = messages[i].content
      if (typeof content === 'string') return content
      if (Array.isArray(content)) {
        const texts: string[] = []
        for (const part of content) {
          if (typeof part === 'object' && part !== null && part.type === 'text' && part.text) {
            texts.push(part.text)
          }
        }
        return texts.join('\n')
      }
      return ''
    }
  }
  return ''
}

/**
 * Parse a raw Z.ai streaming response into ProviderRuntimeEvent objects.
 *
 * Z.ai SSE format uses events with type "chat:completion":
 *   data: {"type":"chat:completion","data":{"phase":"thinking","delta_content":"..."}}
 *   data: {"type":"chat:completion","data":{"phase":"answer","delta_content":"..."}}
 *   data: {"type":"chat:completion","data":{"phase":"done","done":true}}
 *   data: [DONE]
 */
async function* zaiStreamToProviderEvents(
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
      `ZaiProviderPlugin.parseStream: unsupported content-encoding "${contentEncoding}"`,
    )
  }

  // ── SSE parsing state ─────────────────────────────────────────────
  let buffer = ''
  let chatId = ''
  let contentAccumulator = ''
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

        // Z.ai wraps data in { type: "chat:completion", data: { ... } }
        const payload = result.type === 'chat:completion'
          ? (result.data as Record<string, unknown>)
          : result

        if (!payload) continue

        // ── Session / chat ID ───────────────────────────────────────
        if (payload.chat_id && !chatId) {
          chatId = String(payload.chat_id)
        } else if (payload.id && payload.role === 'assistant' && !chatId) {
          chatId = String(payload.id)
        }

        // ── Phase-based content ─────────────────────────────────────
        const phase = payload.phase as string | undefined
        const deltaContent = payload.delta_content as string | undefined

        if (phase === 'thinking' && deltaContent) {
          // Thinking content — yield as text_delta (maps to reasoning_content upstream)
          if (deltaContent.trim()) {
            yield { type: 'text_delta', text: deltaContent }
          }
        } else if (phase === 'answer' && deltaContent) {
          // Answer content — yield as text_delta, tracking for dedup
          if (deltaContent.length > contentAccumulator.length) {
            const diff = deltaContent.slice(contentAccumulator.length)
            contentAccumulator = deltaContent
            if (diff.trim()) {
              yield { type: 'text_delta', text: diff }
            }
          } else {
            // delta_content is already incremental — yield directly
            if (deltaContent.trim()) {
              yield { type: 'text_delta', text: deltaContent }
            }
          }
        } else if (phase === 'done' && (payload.done as boolean)) {
          // Completion signal
          if (!doneYielded) {
            doneYielded = true
            yield { type: 'done', finishReason: 'stop' }
          }
        }

        // ── Error ───────────────────────────────────────────────────
        const errorPayload = payload.error as Record<string, unknown> | undefined
        const rootError = result.error as Record<string, unknown> | undefined
        const errorObj = errorPayload || rootError
        if (errorObj) {
          errorYielded = true
          yield {
            type: 'error',
            error: {
              status: 0,
              code: 'ZAI_ERROR',
              message: String(errorObj.detail || errorObj.message || JSON.stringify(errorObj)),
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

export const ZaiProviderPlugin: WebProviderPlugin = {
  id: 'zai',
  version: '1.0.0',

  matches(provider: { id: string }): boolean {
    return provider.id.toLowerCase() === 'zai'
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
    const mappedModel = mapZaiModel(input.model)
    const sessionId = input.sessionId || generateIdFlat()
    const messageId = generateIdFlat()
    const reqId = generateIdFlat()
    const timestamp = Date.now()

    const token = input.account.credentials.token
      || input.account.credentials.accessToken
      || input.account.credentials.jwt
      || ''

    const userId = extractUserIdFromToken(token)
    const lastUserMessage = extractLastUserMessage(input.messages)
    const signature = generateZaiSignature(lastUserMessage, reqId, timestamp, userId)

    const enableThinking = input.enableThinking ?? true
    const enableWebSearch = input.enableWebSearch ?? false

    // Merge system content into user messages if needed
    let messages = [...input.messages]
    let systemContent = ''
    const nonSystemMessages: Array<{ role: string; content: unknown }> = []

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemContent += (systemContent ? '\n\n' : '') + (typeof msg.content === 'string' ? msg.content : '')
      } else {
        nonSystemMessages.push(msg)
      }
    }

    if (systemContent && nonSystemMessages.length > 0) {
      const firstUserIdx = nonSystemMessages.findIndex(m => m.role === 'user')
      if (firstUserIdx !== -1) {
        const firstUserMsg = nonSystemMessages[firstUserIdx]
        const originalContent = typeof firstUserMsg.content === 'string'
          ? firstUserMsg.content
          : ''
        nonSystemMessages[firstUserIdx] = {
          ...firstUserMsg,
          content: `${systemContent}\n\nUser: ${originalContent}`,
        }
      }
    }

    const requestBody = buildZaiRequestBody(
      mappedModel,
      nonSystemMessages,
      sessionId,
      messageId,
      enableThinking,
      enableWebSearch,
    )

    // Update the signature_prompt in the body with the actual last user message
    requestBody.signature_prompt = lastUserMessage

    const queryParams = buildZaiQueryParams(timestamp, reqId, userId, token, sessionId)
    const url = `${ZAI_API_BASE}/api/v2/chat/completions?${queryParams.toString()}`

    return {
      url,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Cookie': `token=${token}`,
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'zh-CN',
        'Cache-Control': 'no-cache',
        'Origin': ZAI_API_BASE,
        'Referer': `${ZAI_API_BASE}/c/${sessionId}`,
        'X-FE-Version': 'prod-fe-1.1.68',
        'X-Signature': signature,
        'User-Agent': ZAI_USER_AGENT,
        'Sec-Ch-Ua': '"Not/A)Brand";v="99", "Chromium";v="148"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"macOS"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'X-Region': 'domestic',
      },
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
   * Parse a streaming Z.ai response into normalized runtime events.
   *
   * Accepts the raw Axios response object (or a duck-typed equivalent)
   * with:
   *   - `.data`   – the response body stream (Readable)
   *   - `.headers` – response headers, used to detect content-encoding
   *
   * Yields ProviderRuntimeEvent objects:
   *   text_delta  – for each new text content delta (both thinking and answer)
   *   done        – when the stream finishes
   *   error       – on Z.ai API error codes
   */
  parseStream(input: unknown): AsyncIterable<ProviderRuntimeEvent> {
    return zaiStreamToProviderEvents(input)
  },

  async deleteSession(input: ProviderDeleteSessionInput): Promise<ProviderDeleteSessionResult> {
    const adapter = new ZaiAdapter(input.provider, input.account)
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
