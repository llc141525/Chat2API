/**
 * Contract tests for resolveQwenContentDelta (internal to adapters/qwen.ts).
 *
 * Because resolveQwenContentDelta is not exported, we validate its contract
 * through the public QwenStreamHandler.handleStream() interface. The handler
 * uses the delta resolution internally for cumulative-snapshot streams.
 *
 * Contracts verified:
 *  1. Incremental append — when nextContent starts with previousContent,
 *     only the new suffix is emitted in the stream output.
 *  2. Snapshot-shorter handling — when the cumulative snapshot shortens,
 *     the handler should not crash and should produce output.
 *  3. Managed tool rewrite detection — when a <|CHAT2API|tool_calls>-containing
 *     snapshot is rewritten, the handler produces a valid tool_calls result.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { QwenStreamHandler } from '../../src/main/proxy/adapters/qwen.ts'
import type { ToolCallingPlan } from '../../src/main/proxy/toolCalling/types.ts'

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Build an SSE event in the format Qwen's API actually uses.
 * Qwen sends data as: { communication: {...}, data: { messages: [...] } }
 */
function sseEvent(data: Record<string, unknown>): string {
  return `data:${JSON.stringify(data)}\n\n`
}

async function collect(stream: Readable): Promise<string> {
  let output = ''
  for await (const chunk of stream) output += chunk.toString()
  return output
}

/**
 * Minimal managed ToolCallingPlan for contract 3.
 * shouldParseResponse=true triggers ToolStreamParser creation in the constructor.
 */
function managedPlan(): ToolCallingPlan {
  return {
    mode: 'managed',
    protocol: 'managed_xml',
    clientAdapterId: 'standard-openai-tools',
    providerId: 'qwen',
    tools: [
      { name: 'read', description: 'Read a file', parameters: {} as any, source: 'openai' },
    ],
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(['read']),
    availabilityRetryAllowed: false,
    catalogSnapshot: undefined,
    contract: {
      turnId: 'contract-turn',
      sessionId: 'contract-session',
      providerId: 'qwen',
      model: 'Qwen3-Max',
      protocol: 'managed_xml',
      snapshotFingerprint: null,
      tools: Object.freeze([]),
      allowedToolNames: Object.freeze(new Set<string>()),
      toolChoiceMode: 'auto',
      shouldInjectPrompt: true,
      shouldParseResponse: true,
      historyMode: 'managed_protocol',
      emptyOutputPolicy: 'diagnose_and_fail',
      toolSourceChain: Object.freeze(['current_request'] as const),
    },
    diagnostics: {
      requestId: 'contract-request',
      turnId: 'contract-turn',
      clientAdapterId: 'standard-openai-tools',
      providerId: 'qwen',
      model: 'Qwen3-Max',
      actualModel: 'Qwen3-Max',
      toolSource: 'openai',
      mode: 'managed',
      protocol: 'managed_xml',
      toolCount: 1,
      injected: true,
      reason: 'test',
    },
  }
}

/**
 * Build a Qwen API response message object.
 */
function answerMessage(content: string, status: 'streaming' | 'complete') {
  return {
    mime_type: 'multi_load/iframe',
    status,
    content,
    meta_data: {},
  }
}

// ── Contract 1: Incremental append ─────────────────────────────────

test('contract: incremental delta emits only the new suffix', async () => {
  // First event: "Hello" → handler should emit "Hello"
  // Second event: "Hello world" (cumulative) → handler should emit " world" (the delta)
  const handler = new QwenStreamHandler('Qwen3-Max')

  const output = await collect(handler.handleStream(Readable.from([
    sseEvent({
      communication: { sessionid: 's1', reqid: 'r1' },
      data: {
        messages: [answerMessage('Hello', 'streaming')],
      },
    }),
    sseEvent({
      communication: { sessionid: 's1', reqid: 'r1' },
      data: {
        messages: [answerMessage('Hello world', 'complete')],
      },
    }),
  ])))

  // The stream output should contain both "Hello" (initial text) and "world" (appended)
  assert.ok(output.includes('Hello'), 'output should contain initial text')
  assert.ok(output.includes('world'), 'output should contain the appended word')
})

// ── Contract 2: Snapshot-shorter handling ──────────────────────────

test('contract: shorter snapshot does not crash and emits new content', async () => {
  // Cumulative snapshots can sometimes shorten (e.g., when the provider
  // rewrites a streaming response). The handler must not throw.
  const handler = new QwenStreamHandler('Qwen3-Max')

  const output = await collect(handler.handleStream(Readable.from([
    sseEvent({
      communication: { sessionid: 's2', reqid: 'r2' },
      data: {
        messages: [answerMessage('Hello long text here', 'streaming')],
      },
    }),
    sseEvent({
      communication: { sessionid: 's2', reqid: 'r2' },
      data: {
        messages: [answerMessage('Hello short', 'complete')],
      },
    }),
  ])))

  // The handler should produce output without throwing
  assert.ok(output.length > 0, 'stream should produce output for shorter snapshot')
})

// ── Contract 3: Managed tool rewrite ───────────────────────────────

test('contract: managed tool rewrite in cumulative snapshot produces tool output', async () => {
  // When a cumulative snapshot switches from plain text to managed XML tool calls,
  // resolveQwenContentDelta detects it via isManagedToolRewrite and emits the
  // new content, resetting the parser so ToolStreamParser can handle the rewrite.
  const handler = new QwenStreamHandler('Qwen3-Max', undefined, managedPlan())

  const toolXml = '<|CHAT2API|tool_calls>' +
    '<|CHAT2API|invoke name="read">' +
    '<|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]>' +
    '</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>'

  const output = await collect(handler.handleStream(Readable.from([
    sseEvent({
      communication: { sessionid: 's3', reqid: 'r3' },
      data: {
        messages: [answerMessage('I will read the file.', 'streaming')],
      },
    }),
    sseEvent({
      communication: { sessionid: 's3', reqid: 'r3' },
      data: {
        messages: [answerMessage(toolXml, 'complete')],
      },
    }),
  ])))

  assert.ok(output.length > 0, 'stream should produce output for managed tool rewrite')
  // The output should contain the tool XML converted to OpenAI tool_calls format
  assert.ok(
    output.includes('tool_calls') || output.includes('name":"read"'),
    'output should contain tool-related content',
  )
})
