/**
 * PerplexityProviderPlugin — Phase 1 wrapper around PerplexityAdapter
 *
 * Implements the WebProviderPlugin interface to bridge between
 * ProviderRuntime normalized types and the Perplexity web provider protocol.
 *
 * Perplexity uses Electron's net API for HTTP calls — buildRequest
 * returns the URL/headers/body, and the actual HTTP call is handled
 * by forwarder / ProviderRuntime.
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
import { PerplexityAdapter } from '../adapters/perplexity.ts'
import axios from 'axios'
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib'

const PERPLEXITY_BASE = 'https://www.perplexity.ai'
const QUERY_ENDPOINT = `${PERPLEXITY_BASE}/rest/sse/perplexity_ask`

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
 * Parse a raw Perplexity streaming response into ProviderRuntimeEvent objects.
 *
 * Handles content-encoding decompression (gzip, deflate, brotli) and
 * Perplexity SSE event blocks (event: / data: lines separated by \n\n).
 *
 * Extracts session IDs from backend_uuid fields, text deltas from
 * answer/response events, and completion signals.
 */
async function* perplexityStreamToProviderEvents(
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
      `PerplexityProviderPlugin.parseStream: unsupported content-encoding "${contentEncoding}"`,
    )
  }

  // ── SSE parsing state ─────────────────────────────────────────────
  let buffer = ''
  let sessionId = ''
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
          // Ignore malformed JSON in individual event blocks
          continue
        }

        // ── Session ID ──────────────────────────────────────────────
        const backendUuid = result.backend_uuid as string | undefined
        if (backendUuid && !sessionId) {
          sessionId = backendUuid
          yield { type: 'session_update', sessionId }
        }

        // ── Text content ────────────────────────────────────────────
        // Perplexity may deliver text in a top-level "text" field or
        // nested inside data.text / response.text
        let text = ''
        if (typeof result.text === 'string') {
          text = result.text
        } else if (typeof (result as any).data?.text === 'string') {
          text = (result as any).data.text
        } else if (typeof (result as any).response?.text === 'string') {
          text = (result as any).response.text
        }

        if (text && text.length > contentAccumulator.length) {
          const delta = text.slice(contentAccumulator.length)
          contentAccumulator = text
          if (delta.trim()) {
            yield { type: 'text_delta', text: delta }
          }
        }

        // ── Completion signal ───────────────────────────────────────
        if (
          result.type === 'done'
          || result.type === 'complete'
          || eventType === 'complete'
          || eventType === 'done'
        ) {
          if (!doneYielded) {
            doneYielded = true
            yield { type: 'done', finishReason: 'stop' }
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

export const PerplexityProviderPlugin: WebProviderPlugin = {
  id: 'perplexity',
  version: '1.0.0',

  matches(provider: { id: string }): boolean {
    return provider.id.toLowerCase() === 'perplexity'
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
    // Create adapter instance and access its body-building logic
    // (private methods are accessible at runtime via bracket notation)
    const adapter = new PerplexityAdapter(input.provider, input.account) as unknown as Record<string, unknown>
    const query = (adapter['extractQuery'] as (messages: unknown[]) => string)(input.messages)
    const model = (adapter['mapModel'] as (model: string) => string)(input.model)
    const sessionId = input.sessionId || generateId()
    const reqId = generateId()
    const requestData = (adapter['buildRequestData'] as (query: string, model: string) => unknown)(query, model)

    const cookieToken = input.account.credentials.sessionToken
      || input.account.credentials.cookie
      || input.account.credentials.token
      || ''

    return {
      url: QUERY_ENDPOINT,
      method: 'POST',
      headers: {
        'Accept': 'text/event-stream',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'Cookie': `__Secure-next-auth.session-token=${cookieToken}`,
        'Origin': PERPLEXITY_BASE,
        'Sec-Ch-Ua': '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"macOS"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        'x-perplexity-request-reason': 'perplexity-query-state-provider',
        'x-request-id': reqId,
        'Referer': `${PERPLEXITY_BASE}/`,
      },
      body: requestData,
      sessionId,
      reqId,
    }
  },

  async parseNonStream(input: ProviderWebResponse): Promise<ProviderRuntimeResult> {
    let sessionId = ''
    let reqId = ''

    try {
      const data = input.data as Record<string, any>
      if (data?.backend_uuid) {
        sessionId = String(data.backend_uuid)
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
   * Parse a streaming Perplexity response into normalized runtime events.
   *
   * Accepts the raw Axios response object (or a duck-typed equivalent)
   * with:
   *   - `.data`   – the response body stream (Readable)
   *   - `.headers` – response headers, used to detect content-encoding
   *
   * Yields ProviderRuntimeEvent objects:
   *   session_update  – when the Perplexity backend_uuid is first received
   *   text_delta      – for each new text content delta
   *   done            – when the stream finishes
   *   error           – on stream processing errors
   */
  parseStream(input: unknown): AsyncIterable<ProviderRuntimeEvent> {
    return perplexityStreamToProviderEvents(input)
  },

  async deleteSession(input: ProviderDeleteSessionInput): Promise<ProviderDeleteSessionResult> {
    const adapter = new PerplexityAdapter(input.provider, input.account)
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
