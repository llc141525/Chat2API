/**
 * Stream Normalizer — Node J (Plugin Phase 3)
 *
 * Converts a stream of ProviderRuntimeEvent objects into OpenAI-compatible
 * SSE (Server-Sent Events) format, as a Node.js Readable stream.
 *
 * Event → SSE mapping:
 *   text_delta      → data: {"choices":[{"index":0,"delta":{"content":"..."},"finish_reason":null}]}\n\n
 *   tool_call_delta → data: {"choices":[{"index":0,"delta":{"tool_calls":[...]},"finish_reason":null}]}\n\n
 *   session_update  → not emitted (metadata only)
 *   done            → data: {"choices":[{"index":0,"delta":{},"finish_reason":"..."}]}\n\n
 *                     data: [DONE]\n\n
 *   error           → data: {"error":{"message":"...","code":"..."}}\n\n
 */

import { Readable } from 'node:stream'
import type { ProviderRuntimeEvent } from '../plugins/types.ts'

// ── SSE formatting helpers ─────────────────────────────────────────────

function sseLine(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

function emitTextDelta(text: string): string {
  return sseLine({
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  })
}

function emitToolCallDelta(call: {
  index: number
  id?: string
  function?: { name?: string; arguments?: string }
}): string {
  const tc: Record<string, unknown> = { index: call.index }
  if (call.id !== undefined) tc.id = call.id
  if (call.function !== undefined) tc.function = call.function
  return sseLine({
    choices: [{ index: 0, delta: { tool_calls: [tc] }, finish_reason: null }],
  })
}

function emitDone(finishReason?: string): [string, string] {
  return [
    sseLine({
      choices: [{ index: 0, delta: {}, finish_reason: finishReason ?? 'stop' }],
    }),
    'data: [DONE]\n\n',
  ]
}

function emitError(message: string, code: string): string {
  return sseLine({ error: { message, code } })
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Normalize a stream of `ProviderRuntimeEvent` objects into OpenAI-compatible
 * SSE chunks via a Node.js `Readable` stream.
 *
 * The returned stream emits chunks as UTF-8 strings that can be piped
 * directly into an HTTP response.
 *
 * @param events - An async iterable of ProviderRuntimeEvent objects emitted
 *                 by a plugin's `parseStream` implementation.
 * @returns A Readable stream outputting SSE-formatted string chunks.
 */
export function normalizeProviderStreamToOpenAI(
  events: AsyncIterable<ProviderRuntimeEvent>,
): Readable {
  const iter = events[Symbol.asyncIterator]()
  let reading = false

  return new Readable({
    async read() {
      if (reading) return
      reading = true
      try {
        while (true) {
          const { value, done } = await iter.next()
          if (done) {
            this.push(null)
            return
          }
          const chunks = eventToSSEChunks(value)
          for (const chunk of chunks) {
            const canContinue = this.push(chunk)
            if (!canContinue) {
              reading = false
              return
            }
          }
        }
      } catch (err: unknown) {
        this.destroy(err instanceof Error ? err : new Error(String(err)))
        return
      }
    },
    objectMode: false,
  })
}

// ── Internals ──────────────────────────────────────────────────────────

function eventToSSEChunks(event: ProviderRuntimeEvent): string[] {
  switch (event.type) {
    case 'text_delta':
      return [emitTextDelta(event.text)]

    case 'tool_call_delta':
      return [emitToolCallDelta(event.call)]

    case 'session_update':
      // Metadata only — not emitted as SSE.
      return []

    case 'done': {
      const [finish, done] = emitDone(event.finishReason)
      return [finish, done]
    }

    case 'error':
      return [emitError(event.error.message, event.error.code)]

    default:
      // Exhaustiveness guard — new event types must be handled.
      const _exhaustive: never = event
      return []
  }
}
