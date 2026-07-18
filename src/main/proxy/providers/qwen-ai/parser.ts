/**
 * parser.ts — Phase 3c
 *
 * Pure parsing logic for Qwen AI International provider.
 *
 * Exports:
 *   - parseQwenAiStream(input): AsyncIterable<ProviderRuntimeEvent>
 *   - parseQwenAiNonStream(input): Promise<ProviderRuntimeResult>
 */

import { QwenAiStreamHandler } from '../../adapters/qwen-ai.ts'
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib'
import type {
  ProviderRuntimeEvent,
  ProviderRuntimeResult,
  ProviderWebResponse,
  ProviderRuntimeStreamInput,
} from '../../plugins/types.ts'

// ── Public streaming parser ─────────────────────────────────────────

/**
 * Parse a streaming Qwen AI response into normalized runtime events.
 *
 * Qwen AI SSE format uses phase-based events:
 *   data: {"choices":[{"delta":{"phase":"think","content":"..."}}]}
 *   data: {"choices":[{"delta":{"phase":"answer","content":"..."}}]}
 *   data: [DONE]
 *
 * Accepts ProviderRuntimeStreamInput with:
 *   response.data — the response body stream (Readable)
 *   response.headers — content-encoding for auto-decompression
 *
 * Yields ProviderRuntimeEvent objects.
 */
export async function* parseQwenAiStream(
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

  // Use QwenAiStreamHandler to produce OpenAI-format stream
  const handler = new QwenAiStreamHandler(
    model,
    undefined,
    toolCallingPlan,
  )

  const axiosLikeResponse = {
    ...rawResponse,
    status: rawResponse.status ?? response.status,
    headers,
    data: stream,
  }

  const openAiStream = await handler.handleStream(
    stream,
    axiosLikeResponse as any,
  )

  let buffer = ''
  let emittedSessionUpdate = false
  // QwenAiStreamHandler doesn't expose getChatId, so we track from parsed chunks

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
          yield {
            type: 'error',
            error: {
              status: Number(parsed.error.code ?? 0),
              code: String(parsed.error.code ?? 'STREAM_ERROR'),
              message: String(parsed.error.message ?? 'Stream error'),
              retryable: true,
              classified: true,
            },
          }
          return
        }

        // Emit session update once
        if (!emittedSessionUpdate && parsed.id) {
          emittedSessionUpdate = true
          yield {
            type: 'session_update',
            sessionId: String(parsed.id),
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
                function: call.function
                  ? {
                      ...(typeof call.function.name === 'string' ? { name: call.function.name } : {}),
                      ...(typeof call.function.arguments === 'string' ? { arguments: call.function.arguments } : {}),
                    }
                  : undefined,
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

// ── Public non-streaming parser ─────────────────────────────────────

/**
 * Parse a non-streaming Qwen AI response into a normalized result.
 */
export async function parseQwenAiNonStream(
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
