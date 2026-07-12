import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { DeepSeekStreamHandler } from '../../src/main/proxy/adapters/deepseek-stream.ts'
import type { ToolCallingPlan } from '../../src/main/proxy/toolCalling/types.ts'

const ALLOWED_TOOLS = [
  {
    name: 'bash',
    description: 'Execute a shell command',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    source: 'openai' as const,
  },
  {
    name: 'read',
    description: 'Read a file from disk',
    parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
    source: 'openai' as const,
  },
]

function makeToolCallingPlan(overrides: Partial<ToolCallingPlan> = {}): ToolCallingPlan {
  return {
    mode: 'managed',
    protocol: 'managed_xml',
    clientAdapterId: 'standard-openai-tools',
    providerId: 'deepseek',
    tools: ALLOWED_TOOLS,
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(['bash', 'read']),
    catalogSnapshot: {
      sessionId: 'ds-test',
      fingerprint: 'ds-fp-001',
      tools: ALLOWED_TOOLS,
      allowedToolNames: ['bash', 'read'],
      schemaHashes: {},
      source: 'current_request',
      createdTurnIndex: 1,
      updatedTurnIndex: 1,
    },
    catalogDiagnostics: {
      source: 'current_request',
      fingerprint: 'ds-fp-001',
      driftKinds: [],
      blocked: false,
    },
    availabilityRetryAllowed: true,
    contract: {
      turnId: 'deepseek:test',
      sessionId: 'ds-test',
      providerId: 'deepseek',
      model: 'deepseek-chat',
      protocol: 'managed_xml',
      snapshotFingerprint: 'ds-fp-001',
      tools: ALLOWED_TOOLS,
      allowedToolNames: new Set(['bash', 'read']),
      toolChoiceMode: 'auto',
      shouldInjectPrompt: true,
      shouldParseResponse: true,
      historyMode: 'managed_protocol',
      emptyOutputPolicy: 'diagnose_and_fail',
      toolSourceChain: ['current_request'],
    },
    diagnostics: {
      clientAdapterId: 'standard-openai-tools',
      providerId: 'deepseek',
      toolSource: 'openai',
      mode: 'managed',
      protocol: 'managed_xml',
      toolCount: 2,
      injected: true,
      reason: 'managed_auto',
      allowedToolNames: ['bash', 'read'],
    },
    ...overrides,
  }
}

// Build SSE lines in the DeepSeek response/fragments format
function fragmentChunk(content: string, type: 'ANSWER' | 'THINK' = 'ANSWER'): string {
  return JSON.stringify({ p: 'response/fragments', v: [{ type, content }] })
}

function makeSSEStream(...dataLines: string[]): Readable {
  const readable = new Readable({ read() {} })
  readable.push(`data: ${JSON.stringify({ response_message_id: 'test-msg-id' })}\n\n`)
  for (const line of dataLines) {
    readable.push(`data: ${line}\n\n`)
  }
  readable.push('data: [DONE]\n\n')
  readable.push(null)
  return readable
}

const BASH_TOOL_XML =
  '<|CHAT2API|tool_calls><|CHAT2API|invoke name="bash">' +
  '<|CHAT2API|parameter name="command"><![CDATA[echo hello]]></|CHAT2API|parameter>' +
  '</|CHAT2API|invoke></|CHAT2API|tool_calls>'

const READ_TOOL_XML =
  '<|CHAT2API|tool_calls><|CHAT2API|invoke name="read">' +
  '<|CHAT2API|parameter name="file_path"><![CDATA[/tmp/test.txt]]></|CHAT2API|parameter>' +
  '</|CHAT2API|invoke></|CHAT2API|tool_calls>'

// ── Track A: non-stream tool parsing ──────────────────────────────────────────

test('DeepSeek non-stream: managed XML block → tool_calls in response', async () => {
  const plan = makeToolCallingPlan()
  const handler = new DeepSeekStreamHandler(
    'deepseek-chat', 'session-1', undefined, false, undefined, plan,
  )

  const stream = makeSSEStream(fragmentChunk(BASH_TOOL_XML))
  const result = await handler.handleNonStream(stream)

  const choice = result?.choices?.[0]
  assert.ok(Array.isArray(choice?.message?.tool_calls) && choice.message.tool_calls.length > 0,
    `Expected tool_calls, got: ${JSON.stringify(choice?.message)}`)
  assert.equal(choice.message.tool_calls[0].function?.name, 'bash')
  assert.equal(choice.finish_reason, 'tool_calls')
})

test('DeepSeek non-stream: plain content passes through unchanged when no tool XML', async () => {
  const plan = makeToolCallingPlan()
  const handler = new DeepSeekStreamHandler(
    'deepseek-chat', 'session-1', undefined, false, undefined, plan,
  )

  const stream = makeSSEStream(fragmentChunk('Here is my analysis.'))
  const result = await handler.handleNonStream(stream)

  const choice = result?.choices?.[0]
  assert.ok(choice?.message?.content?.includes('Here is my analysis.'))
  assert.equal(choice.finish_reason, 'stop')
  assert.ok(!choice.message?.tool_calls || choice.message.tool_calls.length === 0)
})

test('DeepSeek non-stream: without plan, raw XML remains in content field', async () => {
  const handler = new DeepSeekStreamHandler(
    'deepseek-chat', 'session-1', undefined, false, undefined, undefined,
  )

  const stream = makeSSEStream(fragmentChunk(BASH_TOOL_XML))
  const result = await handler.handleNonStream(stream)

  const choice = result?.choices?.[0]
  // No plan → no parsing → raw XML appears in content
  assert.ok(typeof choice?.message?.content === 'string')
  assert.equal(choice.finish_reason, 'stop')
})

test('DeepSeek non-stream: tool XML with trailing residue — residue suppressed', async () => {
  const plan = makeToolCallingPlan()
  const handler = new DeepSeekStreamHandler(
    'deepseek-chat', 'session-1', undefined, false, undefined, plan,
  )

  const stream = makeSSEStream(fragmentChunk(BASH_TOOL_XML + ' let me know if you need anything'))
  const result = await handler.handleNonStream(stream)

  const choice = result?.choices?.[0]
  assert.ok(Array.isArray(choice?.message?.tool_calls) && choice.message.tool_calls.length > 0,
    'Expected tool_calls')
  assert.equal(choice.message.tool_calls[0].function?.name, 'bash')
  assert.equal(choice.finish_reason, 'tool_calls')
  // Residue text should not appear in content
  assert.ok(
    !choice.message?.content || !choice.message.content.includes('let me know'),
    'Residue text must be suppressed',
  )
})

test('DeepSeek non-stream: multi-chunk accumulation still parses tool XML', async () => {
  const plan = makeToolCallingPlan()
  const handler = new DeepSeekStreamHandler(
    'deepseek-chat', 'session-1', undefined, false, undefined, plan,
  )

  // Tool XML split across two fragment chunks (simulating chunked streaming)
  const half = Math.floor(BASH_TOOL_XML.length / 2)
  const part1 = BASH_TOOL_XML.slice(0, half)
  const part2 = BASH_TOOL_XML.slice(half)
  const stream = makeSSEStream(
    fragmentChunk(part1),
    fragmentChunk(part2),
  )
  const result = await handler.handleNonStream(stream)

  const choice = result?.choices?.[0]
  assert.ok(Array.isArray(choice?.message?.tool_calls) && choice.message.tool_calls.length > 0,
    `Expected tool_calls after multi-chunk accumulation, got: ${JSON.stringify(choice?.message)}`)
  assert.equal(choice.message.tool_calls[0].function?.name, 'bash')
  assert.equal(choice.finish_reason, 'tool_calls')
})
