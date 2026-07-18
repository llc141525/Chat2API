/**
 * parser.ts — Phase 3c
 *
 * Pure parsing logic for Perplexity provider.
 *
 * Exports:
 *   - parsePerplexityStream(input): AsyncIterable<ProviderRuntimeEvent>
 *   - parsePerplexityNonStream(input): Promise<ProviderRuntimeResult>
 */

import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib'
import type {
  ProviderRuntimeEvent,
  ProviderRuntimeResult,
  ProviderWebResponse,
  ProviderRuntimeStreamInput,
} from '../../plugins/types.ts'

// ── Public streaming parser ─────────────────────────────────────────

/**
 * Parse a streaming Perplexity response into normalized runtime events.
 *
 * Handles content-encoding decompression (gzip, deflate, brotli) and
 * Perplexity SSE event blocks (event: / data: lines separated by \n\n).
 *
 * Extracts session IDs from backend_uuid fields, text deltas from
 * answer/response events, and completion signals.
 *
 * Accepts ProviderRuntimeStreamInput with:
 *   response.data — the response body stream (Readable)
 *   response.headers — content-encoding for auto-decompression
 *
 * Yields ProviderRuntimeEvent objects.
 */
export async function* parsePerplexityStream(
  input: ProviderRuntimeStreamInput,
): AsyncIterable<ProviderRuntimeEvent> {
  const response = input.response

  // Handle decompression
  const rawResponse = (input.rawResponse && typeof input.rawResponse === 'object')
    ? input.rawResponse as Record<string, unknown>
    : response as unknown as Record<string, unknown>
  const responseStream = (rawResponse.data ?? response.data) as NodeJS.ReadableStream
  const headers = (rawResponse.headers ?? response.headers ?? {}) as Record<string, string>
  const contentEncoding = headers['content-encoding']?.toLowerCase()

  let stream: NodeJS.ReadableStream = responseStream
  if (contentEncoding === 'gzip') {
    stream = responseStream.pipe(createGunzip())
  } else if (contentEncoding === 'deflate') {
    stream = responseStream.pipe(createInflate())
  } else if (contentEncoding === 'br') {
    stream = responseStream.pipe(createBrotliDecompress())
  }

  // SSE parsing state
  let buffer = ''
  let sessionId = ''
  let contentAccumulator = ''
  let doneYielded = false
  let errorYielded = false

  try {
    for await (const chunk of stream) {
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

        // Session ID
        const backendUuid = result.backend_uuid as string | undefined
        if (backendUuid && !sessionId) {
          sessionId = backendUuid
          yield { type: 'session_update', sessionId }
        }

        // Text content
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

        // Completion signal
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

    // End of stream without explicit complete
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

// ── Public non-streaming parser ─────────────────────────────────────

/**
 * Parse a non-streaming Perplexity response into a normalized result.
 */
export async function parsePerplexityNonStream(
  input: ProviderWebResponse,
): Promise<ProviderRuntimeResult> {
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
}
