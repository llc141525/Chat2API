/**
 * parser.ts — Phase 3c
 *
 * Pure parsing logic for MiniMax provider.
 *
 * Exports:
 *   - parseMiniMaxStream(input): AsyncIterable<ProviderRuntimeEvent>
 *   - parseMiniMaxNonStream(input): Promise<ProviderRuntimeResult>
 */

import { MiniMaxStreamHandler } from '../../adapters/minimax.ts'
import { logger } from '../../shared/logger.ts'
import type {
  ProviderRuntimeEvent,
  ProviderRuntimeResult,
  ProviderWebResponse,
  ProviderRuntimeStreamInput,
} from '../../plugins/types.ts'

// ── Public streaming parser ─────────────────────────────────────────

/**
 * Parse a streaming MiniMax response into normalized runtime events.
 *
 * Accepts ProviderRuntimeStreamInput with:
 *   response.data — the response body stream (HTTP/2 Readable)
 *
 * Yields ProviderRuntimeEvent objects.
 */
export async function* parseMiniMaxStream(
  input: ProviderRuntimeStreamInput,
): AsyncIterable<ProviderRuntimeEvent> {
  const { model, toolCallingPlan } = input
  const response = input.response
  const correlationId = input.correlationId

  const handler = new MiniMaxStreamHandler(
    model,
    undefined,
    toolCallingPlan,
  )

  const rawResponse = (input.rawResponse && typeof input.rawResponse === 'object')
    ? input.rawResponse as Record<string, unknown>
    : response as unknown as Record<string, unknown>
  const responseStream = (rawResponse.data ?? response.data) as NodeJS.ReadableStream

  const openAiStream = handler.handleStream(
    responseStream as any,
  )

  let buffer = ''
  let emittedSessionUpdate = false
  let parsedFrameCount = 0
  let emittedProviderEventCount = 0
  let sawDoneFrame = false

  logger.info('[MiniMaxProviderPlugin] Production stream parse start:', JSON.stringify({
    correlationId,
    model,
    status: response.status,
    contentType: response.headers?.['content-type'] ?? null,
    responseDataKind: response.data == null ? 'nullish' : typeof response.data,
    responseDataReadable: Boolean((response.data as any)?.pipe && (response.data as any)?.on),
    shouldParseTools: Boolean(toolCallingPlan?.shouldParseResponse),
    protocol: toolCallingPlan?.protocol ?? null,
    actionConstraint: input.toolActionConstraint ?? null,
  }))

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
        if (!payload) continue
        if (payload === '[DONE]') {
          sawDoneFrame = true
          continue
        }

        let parsed: Record<string, any>
        try {
          parsed = JSON.parse(payload)
          parsedFrameCount++
        } catch {
          logger.warn('[MiniMaxProviderPlugin] Production stream parse skipped invalid JSON frame:', JSON.stringify({
            correlationId,
            payloadLength: payload.length,
          }))
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
          emittedProviderEventCount++
          return
        }

        if (!emittedSessionUpdate && (handler.getChatId() || parsed.id)) {
          emittedSessionUpdate = true
          emittedProviderEventCount++
          yield {
            type: 'session_update',
            sessionId: handler.getChatId() || String(parsed.id || ''),
          }
        }

        const choice = parsed.choices?.[0]
        const delta = choice?.delta ?? {}
        const finishReason = choice?.finish_reason

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          emittedProviderEventCount++
          yield { type: 'text_delta', text: delta.content }
        }
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          emittedProviderEventCount++
          yield { type: 'text_delta', text: delta.reasoning_content }
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) {
            emittedProviderEventCount++
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
          emittedProviderEventCount++
          logger.info('[MiniMaxProviderPlugin] Production stream parse finish:', JSON.stringify({
            correlationId,
            finishReason,
            parsedFrameCount,
            emittedProviderEventCount,
            emittedSessionUpdate,
          }))
          yield { type: 'done', finishReason }
        }
      }
    }

    if (emittedProviderEventCount === 0) {
      const message = 'MiniMax provider stream closed before emitting any provider event'
      logger.error('[MiniMaxProviderPlugin] Production stream empty close:', JSON.stringify({
        correlationId,
        model,
        status: response.status,
        parsedFrameCount,
        sawDoneFrame,
        responseDataKind: response.data == null ? 'nullish' : typeof response.data,
      }))
      yield {
        type: 'error',
        error: {
          status: 502,
          code: 'EMPTY_PROVIDER_STREAM',
          message,
          retryable: true,
          classified: true,
        },
      }
    }
  } catch (err: unknown) {
    logger.error('[MiniMaxProviderPlugin] Production stream parse error:', JSON.stringify({
      correlationId,
      model,
      message: err instanceof Error ? err.message : String(err),
    }))
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
 * Parse a non-streaming MiniMax response into a normalized result.
 */
export async function parseMiniMaxNonStream(
  input: ProviderWebResponse,
): Promise<ProviderRuntimeResult> {
  let sessionId = ''
  let reqId = ''

  try {
    const data = input.data as Record<string, unknown>
    if (data?.chat_id) {
      sessionId = String(data.chat_id)
    }
    if (data?.msg_id) {
      reqId = String(data.msg_id)
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
