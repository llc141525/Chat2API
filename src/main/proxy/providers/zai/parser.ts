/**
 * parser.ts — Phase 3c
 *
 * Pure parsing logic for Z.ai (GLM International) provider.
 *
 * Exports:
 *   - parseZaiStream(input): AsyncIterable<ProviderRuntimeEvent>
 *   - parseZaiNonStream(input): Promise<ProviderRuntimeResult>
 */

import { ZaiStreamHandler } from '../../adapters/zai.ts'
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib'
import type {
  ProviderRuntimeEvent,
  ProviderRuntimeResult,
  ProviderWebResponse,
  ProviderRuntimeStreamInput,
} from '../../plugins/types.ts'

// ── Public streaming parser ─────────────────────────────────────────

/**
 * Parse a streaming Z.ai response into normalized runtime events.
 *
 * Z.ai SSE format uses events with type "chat:completion":
 *   data: {"type":"chat:completion","data":{"phase":"thinking","delta_content":"..."}}
 *   data: {"type":"chat:completion","data":{"phase":"answer","delta_content":"..."}}
 *   data: [DONE]
 *
 * Accepts ProviderRuntimeStreamInput with:
 *   response.data — the response body stream (Readable)
 *   response.headers — content-encoding for auto-decompression
 *
 * Yields ProviderRuntimeEvent objects.
 */
export async function* parseZaiStream(
  input: ProviderRuntimeStreamInput,
): AsyncIterable<ProviderRuntimeEvent> {
  const { model, toolCallingPlan } = input
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
  let chatId = ''
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

        // Z.ai wraps data in { type: "chat:completion", data: { ... } }
        const payload = result.type === 'chat:completion'
          ? (result.data as Record<string, unknown>)
          : result

        if (!payload) continue

        // Session / chat ID
        if (payload.chat_id && !chatId) {
          chatId = String(payload.chat_id)
        } else if (payload.id && payload.role === 'assistant' && !chatId) {
          chatId = String(payload.id)
        }

        // Emit session update
        if (chatId) {
          yield { type: 'session_update', sessionId: chatId }
          chatId = '' // only emit once
        }

        // Phase-based content
        const phase = payload.phase as string | undefined
        const deltaContent = payload.delta_content as string | undefined

        if (phase === 'thinking' && deltaContent) {
          if (deltaContent.trim()) {
            yield { type: 'text_delta', text: deltaContent }
          }
        } else if (phase === 'answer' && deltaContent) {
          if (deltaContent.length > contentAccumulator.length) {
            const diff = deltaContent.slice(contentAccumulator.length)
            contentAccumulator = deltaContent
            if (diff.trim()) {
              yield { type: 'text_delta', text: diff }
            }
          } else {
            if (deltaContent.trim()) {
              yield { type: 'text_delta', text: deltaContent }
            }
          }
        } else if (phase === 'done' && (payload.done as boolean)) {
          if (!doneYielded) {
            doneYielded = true
            yield { type: 'done', finishReason: 'stop' }
          }
        }

        // Error
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
 * Parse a non-streaming Z.ai response into a normalized result.
 */
export async function parseZaiNonStream(
  input: ProviderWebResponse,
): Promise<ProviderRuntimeResult> {
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
}
