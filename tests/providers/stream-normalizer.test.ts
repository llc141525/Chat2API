/**
 * Node J — Stream Normalizer (Plugin Phase 3)
 *
 * Tests for:
 *   - normalizeProviderStreamToOpenAI (streamNormalizer.ts)
 *   - QwenProviderPlugin.parseStream (QwenProviderPlugin.ts)
 *
 * Run: node --test tests/providers/stream-normalizer.test.ts
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { type ProviderRuntimeEvent } from '../../src/main/proxy/plugins/types.ts'

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Collect all chunks from a Readable stream into a single string.
 */
async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf-8')
}

/**
 * Concatenate Qwen SSE event blocks into one raw string.
 * Each event block uses the "event:" / "data:" lines separated by "\n\n".
 */
function qwenEvent(event: string, data: Record<string, unknown>): string {
  return `event:${event}\ndata:${JSON.stringify(data)}\n\n`
}

/**
 * Create a Readable from an array of string chunks.
 */
function streamFrom(...chunks: string[]): Readable {
  return Readable.from(chunks)
}

/**
 * Collect all ProviderRuntimeEvent values from an AsyncIterable into an array.
 */
async function collectEvents(
  iterable: AsyncIterable<ProviderRuntimeEvent>,
): Promise<ProviderRuntimeEvent[]> {
  const events: ProviderRuntimeEvent[] = []
  for await (const event of iterable) {
    events.push(event)
  }
  return events
}

// ── Stream Normalizer Tests ────────────────────────────────────────────

await test('stream normalizer converts text_delta to SSE', async () => {
  const { normalizeProviderStreamToOpenAI } = await import(
    '../../src/main/proxy/services/streamNormalizer.ts'
  )

  async function* events(): AsyncIterable<ProviderRuntimeEvent> {
    yield { type: 'text_delta', text: 'Hello' }
    yield { type: 'text_delta', text: ' world' }
    yield { type: 'done', finishReason: 'stop' }
  }

  const output = await collect(normalizeProviderStreamToOpenAI(events()))

  assert.ok(output.includes('"content":"Hello"'), 'first delta must include Hello')
  assert.ok(output.includes('"content":" world"'), 'second delta must include " world"')
  assert.ok(output.includes('"finish_reason":"stop"'), 'done must include finish_reason stop')
  assert.ok(output.includes('[DONE]'), 'done must emit [DONE] marker')
})

await test('stream normalizer converts tool_call_delta to SSE', async () => {
  const { normalizeProviderStreamToOpenAI } = await import(
    '../../src/main/proxy/services/streamNormalizer.ts'
  )

  async function* events(): AsyncIterable<ProviderRuntimeEvent> {
    yield {
      type: 'tool_call_delta',
      call: { index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"loc":"NYC"}' } },
    }
    yield { type: 'done', finishReason: 'tool_calls' }
  }

  const output = await collect(normalizeProviderStreamToOpenAI(events()))

  assert.ok(output.includes('"tool_calls"'), 'must include tool_calls key')
  assert.ok(output.includes('"id":"call_1"'), 'must include tool call id')
  assert.ok(output.includes('"name":"get_weather"'), 'must include function name')
  assert.ok(output.includes('"finish_reason":"tool_calls"'), 'must include tool_calls finish_reason')
  assert.ok(output.includes('[DONE]'), 'must emit [DONE] marker')
})

await test('stream normalizer ignores session_update (metadata only)', async () => {
  const { normalizeProviderStreamToOpenAI } = await import(
    '../../src/main/proxy/services/streamNormalizer.ts'
  )

  async function* events(): AsyncIterable<ProviderRuntimeEvent> {
    yield { type: 'session_update', sessionId: 'sess-123' }
    yield { type: 'text_delta', text: 'response' }
    yield { type: 'done', finishReason: 'stop' }
  }

  const output = await collect(normalizeProviderStreamToOpenAI(events()))

  // session_update should not produce any SSE output
  assert.ok(!output.includes('sess-123'), 'session metadata must not appear in SSE')
  assert.ok(output.includes('"content":"response"'), 'text delta must still appear')
})

await test('stream normalizer converts error to SSE error line', async () => {
  const { normalizeProviderStreamToOpenAI } = await import(
    '../../src/main/proxy/services/streamNormalizer.ts'
  )

  async function* events(): AsyncIterable<ProviderRuntimeEvent> {
    yield {
      type: 'error',
      error: { status: 429, code: 'RATE_LIMITED', message: 'Too fast', retryable: true, classified: true },
    }
  }

  const output = await collect(normalizeProviderStreamToOpenAI(events()))

  assert.ok(output.includes('"error"'), 'must include error key at top level')
  assert.ok(output.includes('"message":"Too fast"'), 'must include error message')
  assert.ok(output.includes('"code":"RATE_LIMITED"'), 'must include error code')
})

await test('stream normalizer handles empty event stream', async () => {
  const { normalizeProviderStreamToOpenAI } = await import(
    '../../src/main/proxy/services/streamNormalizer.ts'
  )

  async function* empty(): AsyncIterable<ProviderRuntimeEvent> {
    // No events
  }

  const output = await collect(normalizeProviderStreamToOpenAI(empty()))

  assert.equal(output, '', 'empty event stream must produce no output')
})

await test('stream normalizer renders finish_reason from done event', async () => {
  const { normalizeProviderStreamToOpenAI } = await import(
    '../../src/main/proxy/services/streamNormalizer.ts'
  )

  // Without explicit finishReason — defaults to "stop"
  async function* defaultReason(): AsyncIterable<ProviderRuntimeEvent> {
    yield { type: 'done' }
  }

  const defaultOutput = await collect(normalizeProviderStreamToOpenAI(defaultReason()))
  assert.ok(defaultOutput.includes('"finish_reason":"stop"'), 'default done must yield stop')
  assert.ok(defaultOutput.includes('[DONE]'), 'done must yield [DONE]')
})

await test('stream normalizer produces valid sequential SSE format', async () => {
  const { normalizeProviderStreamToOpenAI } = await import(
    '../../src/main/proxy/services/streamNormalizer.ts'
  )

  async function* events(): AsyncIterable<ProviderRuntimeEvent> {
    yield { type: 'text_delta', text: 'A' }
    yield { type: 'text_delta', text: 'B' }
    yield { type: 'done' }
  }

  const output = await collect(normalizeProviderStreamToOpenAI(events()))
  const lines = output.split('\n').filter(l => l.startsWith('data: '))

  // text_delta "A" + text_delta "B" + done(finish_reason) + [DONE] = 4 data lines
  assert.equal(lines.length, 4, 'Must have 4 data lines: A, B, finish_reason, [DONE]')
  assert.ok(lines[0].includes('"content":"A"'), 'First data line must contain A')
  assert.ok(lines[1].includes('"content":"B"'), 'Second data line must contain B')
  assert.ok(lines[2].includes('"finish_reason"'), 'Third data line must contain finish_reason')
  assert.equal(lines[3].trim(), 'data: [DONE]', 'Last line must be [DONE]')
})

// ── QwenProviderPlugin.parseStream Tests ───────────────────────────────

await test('parseStream yields session_update and text_delta from Qwen SSE', async () => {
  const { QwenProviderPlugin } = await import(
    '../../src/main/proxy/plugins/QwenProviderPlugin.ts'
  )

  const rawData = [
    qwenEvent('message', {
      communication: { sessionid: 'sess-abc-123', reqid: 'req-1' },
      data: {
        messages: [
          { mime_type: 'text/plain', content: 'Hello', status: 'progressing' },
        ],
      },
    }),
    qwenEvent('message', {
      data: {
        messages: [
          { mime_type: 'text/plain', content: 'Hello world', status: 'progressing' },
        ],
      },
    }),
    qwenEvent('complete', {
      data: {
        messages: [
          { mime_type: 'multi_load/iframe', content: 'Hello world', status: 'complete' },
        ],
      },
    }),
  ].join('')

  const mockResponse = { data: streamFrom(rawData), headers: {} }
  const events = await collectEvents(QwenProviderPlugin.parseStream!(mockResponse))

  // session_update + text_delta("Hello") + text_delta(" world") + done = 4 events
  assert.equal(events.length, 4, 'Must yield 4 events')

  const [first, second, third, fourth] = events

  assert.equal(first.type, 'session_update')
  if (first.type === 'session_update') {
    assert.equal(first.sessionId, 'sess-abc-123')
  }

  assert.equal(second.type, 'text_delta')
  if (second.type === 'text_delta') {
    assert.equal(second.text, 'Hello')
  }

  assert.equal(third.type, 'text_delta')
  if (third.type === 'text_delta') {
    assert.equal(third.text, ' world')
  }

  assert.equal(fourth.type, 'done')
  if (fourth.type === 'done') {
    assert.equal(fourth.finishReason, 'stop')
  }
})

await test('parseStream yields text_delta with cumulative delta logic', async () => {
  const { QwenProviderPlugin } = await import(
    '../../src/main/proxy/plugins/QwenProviderPlugin.ts'
  )

  // Qwen sometimes sends the full accumulated content, not just the delta.
  // parseStream must compute the delta internally.
  const rawData = [
    qwenEvent('message', {
      data: {
        messages: [
          { mime_type: 'text/plain', content: 'abc', status: 'progressing' },
        ],
      },
    }),
    qwenEvent('message', {
      data: {
        messages: [
          { mime_type: 'text/plain', content: 'abcdef', status: 'progressing' },
        ],
      },
    }),
    qwenEvent('complete', {
      data: {
        messages: [
          { mime_type: 'multi_load/iframe', content: 'abcdef', status: 'complete' },
        ],
      },
    }),
  ].join('')

  const mockResponse = { data: streamFrom(rawData), headers: {} }
  const events = await collectEvents(QwenProviderPlugin.parseStream!(mockResponse))

  const textDeltas = events.filter(e => e.type === 'text_delta') as Array<{ type: 'text_delta'; text: string }>
  assert.equal(textDeltas.length, 2)
  assert.equal(textDeltas[0].text, 'abc')
  assert.equal(textDeltas[1].text, 'def')
})

await test('parseStream ignores thinking markers in content', async () => {
  const { QwenProviderPlugin } = await import(
    '../../src/main/proxy/plugins/QwenProviderPlugin.ts'
  )

  const rawData = [
    qwenEvent('message', {
      communication: { sessionid: 'sess-1', reqid: 'req-1' },
      data: {
        messages: [
          { mime_type: 'text/plain', content: '[(deep_think)]', status: 'progressing' },
        ],
      },
    }),
    qwenEvent('message', {
      data: {
        messages: [
          { mime_type: 'text/plain', content: '[(deep_think)]Actual content', status: 'progressing' },
        ],
      },
    }),
    qwenEvent('complete', {
      data: {
        messages: [
          { mime_type: 'multi_load/iframe', content: '[(deep_think)]Actual content', status: 'complete' },
        ],
      },
    }),
  ].join('')

  const mockResponse = { data: streamFrom(rawData), headers: {} }
  const events = await collectEvents(QwenProviderPlugin.parseStream!(mockResponse))

  const textDeltas = events.filter(e => e.type === 'text_delta') as Array<{ type: 'text_delta'; text: string }>
  assert.ok(textDeltas.length >= 1, 'should yield at least one text_delta')

  // The first message is pure marker text — it should be skipped.
  // The second should yield "Actual content" (markers stripped).
  // The third is the complete event that triggers done.
  const text = textDeltas.map(d => d.text).join('')
  assert.ok(!text.includes('[(deep_think)]'), 'output must not contain thinking markers')
  assert.ok(text.includes('Actual content'), 'output must contain the actual content')
})

await test('parseStream yields error on Qwen error_code', async () => {
  const { QwenProviderPlugin } = await import(
    '../../src/main/proxy/plugins/QwenProviderPlugin.ts'
  )

  const rawData = qwenEvent('message', {
    error_code: 400,
    error_msg: 'Bad request: invalid parameter',
  })

  const mockResponse = { data: streamFrom(rawData), headers: {} }
  const events = await collectEvents(QwenProviderPlugin.parseStream!(mockResponse))

  assert.equal(events.length, 1, 'Must yield exactly 1 event')
  assert.equal(events[0].type, 'error')
  if (events[0].type === 'error') {
    assert.equal(events[0].error.code, '400')
    assert.equal(events[0].error.message, 'Bad request: invalid parameter')
    assert.equal(events[0].error.retryable, false)
  }
})

await test('parseStream yields done on empty stream', async () => {
  const { QwenProviderPlugin } = await import(
    '../../src/main/proxy/plugins/QwenProviderPlugin.ts'
  )

  // Stream that ends without any data
  const mockResponse = { data: streamFrom(''), headers: {} }
  const events = await collectEvents(QwenProviderPlugin.parseStream!(mockResponse))

  assert.equal(events.length, 1, 'Empty stream must yield exactly done event')
  assert.equal(events[0].type, 'done')
})

// ── End-to-End: parseStream + normalizeProviderStreamToOpenAI ───────────

await test('full pipeline: Qwen SSE → ProviderRuntimeEvent → OpenAI SSE', async () => {
  const { QwenProviderPlugin } = await import(
    '../../src/main/proxy/plugins/QwenProviderPlugin.ts'
  )
  const { normalizeProviderStreamToOpenAI } = await import(
    '../../src/main/proxy/services/streamNormalizer.ts'
  )

  const rawData = [
    qwenEvent('message', {
      communication: { sessionid: 'sess-final', reqid: 'req-final' },
      data: {
        messages: [
          { mime_type: 'text/plain', content: 'Hello from Qwen', status: 'progressing' },
        ],
      },
    }),
    qwenEvent('complete', {
      data: {
        messages: [
          { mime_type: 'multi_load/iframe', content: 'Hello from Qwen', status: 'complete' },
        ],
      },
    }),
  ].join('')

  const mockResponse = { data: streamFrom(rawData), headers: {} }
  const pluginEvents = QwenProviderPlugin.parseStream!(mockResponse)
  const normalized = normalizeProviderStreamToOpenAI(pluginEvents)
  const output = await collect(normalized)

  // The session_update should be suppressed; text_delta and done should appear
  assert.ok(!output.includes('sess-final'), 'session_update metadata must not appear in SSE')
  assert.ok(output.includes('"content":"Hello from Qwen"'), 'text content must appear in SSE')
  assert.ok(output.includes('"finish_reason":"stop"'), 'finish_reason must appear')
  assert.ok(output.includes('[DONE]'), '[DONE] marker must appear')

  // Verify line count: 1 text_delta + 1 finish + 1 [DONE] = 3 data lines
  const dataLines = output.split('\n').filter(l => l.startsWith('data: '))
  assert.equal(dataLines.length, 3, 'Must be 3 data lines for a simple response')
})

await test('full pipeline with thinking content included as text_delta', async () => {
  const { QwenProviderPlugin } = await import(
    '../../src/main/proxy/plugins/QwenProviderPlugin.ts'
  )
  const { normalizeProviderStreamToOpenAI } = await import(
    '../../src/main/proxy/services/streamNormalizer.ts'
  )

  const rawData = [
    qwenEvent('message', {
      communication: { sessionid: 'sess-think', reqid: 'req-think' },
      data: {
        messages: [{
          mime_type: 'text/plain',
          status: 'progressing',
          meta_data: {
            multi_load: [{
              type: 'deep_think',
              content: { think_content: 'I am thinking step by step...' },
            }],
          },
        }],
      },
    }),
    qwenEvent('message', {
      data: {
        messages: [
          { mime_type: 'text/plain', content: 'Final answer', status: 'progressing' },
        ],
      },
    }),
    qwenEvent('complete', {
      data: {
        messages: [
          { mime_type: 'multi_load/iframe', content: 'Final answer', status: 'complete' },
        ],
      },
    }),
  ].join('')

  const mockResponse = { data: streamFrom(rawData), headers: {} }
  const pluginEvents = QwenProviderPlugin.parseStream!(mockResponse)
  const normalized = normalizeProviderStreamToOpenAI(pluginEvents)
  const output = await collect(normalized)

  // Both thinking content and answer should appear as text_delta
  assert.ok(output.includes('I am thinking step by step'), 'thinking content must appear as text_delta')
  assert.ok(output.includes('Final answer'), 'final answer must appear')
  assert.ok(output.includes('[DONE]'), '[DONE] marker must appear')
})
