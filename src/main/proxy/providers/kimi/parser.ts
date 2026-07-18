/**
 * parser.ts — Phase 3c
 *
 * Pure parsing logic for Kimi provider.
 *
 * Exports:
 *   - parseKimiStream(input): AsyncIterable<ProviderRuntimeEvent>
 *   - parseKimiNonStream(input): Promise<ProviderRuntimeResult>
 */

import { KimiStreamHandler } from '../../adapters/kimi.ts'
import type {
  ProviderRuntimeEvent,
  ProviderRuntimeResult,
  ProviderWebResponse,
  ProviderRuntimeStreamInput,
} from '../../plugins/types.ts'

// ── Public streaming parser ─────────────────────────────────────────

/**
 * Parse a streaming Kimi response into normalized runtime events.
 *
 * Accepts ProviderRuntimeStreamInput with:
 *   response.data — the response body stream (Readable)
 *
 * Yields ProviderRuntimeEvent objects.
 */
export async function* parseKimiStream(
  input: ProviderRuntimeStreamInput,
): AsyncIterable<ProviderRuntimeEvent> {
  const { model, toolCallingPlan } = input
  const response = input.response

  const handler = new KimiStreamHandler(
    model,
    '',
    false,
    toolCallingPlan,
  )

  const rawResponse = (input.rawResponse && typeof input.rawResponse === 'object')
    ? input.rawResponse as Record<string, unknown>
    : response as unknown as Record<string, unknown>
  const responseStream = (rawResponse.data ?? response.data) as NodeJS.ReadableStream

  let openAiStream: NodeJS.ReadableStream
  try {
    openAiStream = await handler.handleStream(responseStream)
  } catch (err: unknown) {
    yield {
      type: 'error',
      error: {
        status: 0,
        code: 'STREAM_INIT_ERROR',
        message: err instanceof Error ? err.message : 'Failed to initialize stream handler',
        retryable: true,
        classified: true,
      },
    }
    return
  }

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
 * Parse a non-streaming Kimi response into a normalized result.
 */
export async function parseKimiNonStream(
  input: ProviderWebResponse,
): Promise<ProviderRuntimeResult> {
  let sessionId = ''
  let reqId = ''

  try {
    const data = input.data as Record<string, unknown>
    if (data && typeof data === 'object') {
      if ((data.chat as Record<string, unknown> | undefined)?.id) {
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
}
