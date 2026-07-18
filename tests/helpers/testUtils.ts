/**
 * Shared test utilities — message factories, SSE event helpers, mock responses.
 *
 * Extracted from duplicated patterns across the test suite:
 * - sseEvent from tests/providers/qwen-session-continuity.test.ts
 * - makeToolCall from tests/providers/qwen-session-continuity.test.ts
 * - input() factory pattern from tests/services/promptBudget-context-economy.test.ts
 */

import { Readable } from 'node:stream'
import type { ChatMessage, ChatCompletionMessageToolCall, ProxyContext } from '../../src/main/proxy/types.ts'

// ── Message factories ──────────────────────────────────────────────

export function makeSystemMsg(content: string): ChatMessage {
  return { role: 'system', content }
}

export function makeUserMsg(content: string): ChatMessage {
  return { role: 'user', content }
}

export function makeAssistantMsg(content: string | null, toolCalls?: ChatCompletionMessageToolCall[]): ChatMessage {
  const msg: ChatMessage = { role: 'assistant', content }
  if (toolCalls && toolCalls.length > 0) {
    msg.tool_calls = toolCalls
  }
  return msg
}

export function makeToolMsg(callId: string, content: string): ChatMessage {
  return { role: 'tool', content, tool_call_id: callId }
}

// ── Tool call factory ─────────────────────────────────────────────

export function makeToolCall(id: string, name: string, args: string): ChatCompletionMessageToolCall {
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: args,
    },
  }
}

// ── SSE event factory ─────────────────────────────────────────────

/** Generate a single SSE event string from data. */
export function sseEvent(data: Record<string, unknown>, event = 'message'): string {
  return `event:${event}\ndata:${JSON.stringify(data)}\n\n`
}

// ── Stream helpers ─────────────────────────────────────────────────

/** Collect an entire Readable stream into a string. */
export async function collect(stream: Readable): Promise<string> {
  let output = ''
  for await (const chunk of stream) {
    output += chunk.toString()
  }
  return output
}

// ── Mock responses ────────────────────────────────────────────────

/** Create a mock readable SSE stream from an array of event strings. */
export function mockStreamResponse(events: string[]): Readable {
  return Readable.from(events)
}

/** Create a mock JSON response object. */
export function mockJsonResponse(data: unknown): { status: number; headers: Record<string, string>; data: unknown } {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    data,
  }
}

// ── ProxyContext mock ─────────────────────────────────────────────

let _mockSeq = 0

/**
 * Create a mock ProxyContext with sensible defaults.
 * Sequential requestId and startTime for ordering tests.
 */
export function mockSessionState(overrides: Partial<ProxyContext> = {}): ProxyContext {
  _mockSeq++
  return {
    requestId: `req-${_mockSeq}`,
    providerId: 'qwen',
    accountId: 'acc-1',
    model: 'Qwen3-Max',
    actualModel: 'Qwen3-Max',
    startTime: Date.now() + _mockSeq,
    isStream: false,
    toolCatalogSessionKey: 'openai-chat:tool-key',
    providerConversationSessionKey: 'openai-chat:provider-key',
    providerSessionEpoch: 'main',
    sessionBoundaryReason: 'normal',
    ...overrides,
  }
}
