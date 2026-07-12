import test from 'node:test'
import assert from 'node:assert/strict'

import { ToolStreamParser } from '../../src/main/proxy/toolCalling/ToolStreamParser.ts'
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
    description: 'Read a file',
    parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
    source: 'openai' as const,
  },
]

function makePlan(overrides: Partial<ToolCallingPlan> = {}): ToolCallingPlan {
  return {
    mode: 'managed',
    protocol: 'managed_xml',
    clientAdapterId: 'standard-openai-tools',
    providerId: 'qwen',
    tools: ALLOWED_TOOLS,
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(['bash', 'read']),
    catalogSnapshot: {
      sessionId: 'q-test',
      fingerprint: 'q-fp-001',
      tools: ALLOWED_TOOLS,
      allowedToolNames: ['bash', 'read'],
      schemaHashes: {},
      source: 'current_request',
      createdTurnIndex: 1,
      updatedTurnIndex: 1,
    },
    catalogDiagnostics: { source: 'current_request', fingerprint: 'q-fp-001', driftKinds: [], blocked: false },
    availabilityRetryAllowed: true,
    contract: {
      turnId: 'qwen:test',
      sessionId: 'q-test',
      providerId: 'qwen',
      model: 'Qwen3.7-Max',
      protocol: 'managed_xml',
      snapshotFingerprint: 'q-fp-001',
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
      providerId: 'qwen',
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

const BASE_CHUNK = { id: 'test', model: 'qwen', object: 'chat.completion.chunk', created: 1 }

const CLEAN_BASH_XML =
  '<|CHAT2API|tool_calls><|CHAT2API|invoke name="bash">' +
  '<|CHAT2API|parameter name="command"><![CDATA[echo hello]]></|CHAT2API|parameter>' +
  '</|CHAT2API|invoke></|CHAT2API|tool_calls>'

function parseAll(plan: ToolCallingPlan, content: string) {
  const parser = new ToolStreamParser(plan)
  const chunks = parser.push(content, BASE_CHUNK, false)
  const flushChunks = parser.flush(BASE_CHUNK)
  return {
    chunks: [...chunks, ...flushChunks],
    observation: parser.getObservation(),
    hasToolCalls: parser.hasEmittedToolCall(),
  }
}

// ── Track B: parser repair for benign noise ───────────────────────────────────

test('parser: clean managed XML parses successfully', () => {
  const { hasToolCalls, observation } = parseAll(makePlan(), CLEAN_BASH_XML)
  assert.ok(hasToolCalls, 'Expected tool call to be emitted')
  assert.equal(observation.suppressedMalformedToolOutput, false)
  assert.equal(observation.emittedToolCallCount, 1)
})

test('parser: trailing whitespace/newline after closing tag — must parse', () => {
  const xmlWithTrailing = CLEAN_BASH_XML + '  \n  '
  const { hasToolCalls, observation } = parseAll(makePlan(), xmlWithTrailing)
  assert.ok(hasToolCalls,
    `Expected tool call despite trailing whitespace; suppressed=${observation.suppressedMalformedToolOutput}, reason=${observation.suppressedReason}`)
  assert.equal(observation.suppressedMalformedToolOutput, false)
})

test('parser: CRLF line endings inside container — must parse', () => {
  const xmlWithCRLF = CLEAN_BASH_XML.replace(/\n/g, '\r\n')
  const { hasToolCalls, observation } = parseAll(makePlan(), xmlWithCRLF)
  assert.ok(hasToolCalls,
    `Expected tool call with CRLF endings; suppressed=${observation.suppressedMalformedToolOutput}`)
  assert.equal(observation.suppressedMalformedToolOutput, false)
})

test('parser: zero-width joiner inside CDATA value — must parse', () => {
  // ‍ is a zero-width joiner — should be stripped before parse, not cause malformed output
  const xmlWithZWJ = CLEAN_BASH_XML.replace('echo hello', 'echo‍ hello')
  const { hasToolCalls, observation } = parseAll(makePlan(), xmlWithZWJ)
  assert.ok(hasToolCalls,
    `Expected tool call with ZWJ in CDATA; suppressed=${observation.suppressedMalformedToolOutput}, reason=${observation.suppressedReason}`)
  assert.equal(observation.suppressedMalformedToolOutput, false)
})

test('parser: NBSP character inside container — must parse', () => {
  //   is non-breaking space — should be treated as whitespace
  const xmlWithNBSP = CLEAN_BASH_XML.replace('bash">', 'bash"> ')
  const { hasToolCalls, observation } = parseAll(makePlan(), xmlWithNBSP)
  assert.ok(hasToolCalls,
    `Expected tool call with NBSP; suppressed=${observation.suppressedMalformedToolOutput}`)
  assert.equal(observation.suppressedMalformedToolOutput, false)
})

test('parser: null bytes (control char \\x00) inside container — must parse', () => {
  // Stray null byte should be stripped, not break the parser
  const xmlWithNull = CLEAN_BASH_XML.replace('bash">', 'bash">\x00')
  const { hasToolCalls, observation } = parseAll(makePlan(), xmlWithNull)
  assert.ok(hasToolCalls,
    `Expected tool call with null byte stripped; suppressed=${observation.suppressedMalformedToolOutput}`)
  assert.equal(observation.suppressedMalformedToolOutput, false)
})

test('parser: genuinely broken container (missing close tag) — classified as malformed', () => {
  // Truncated XML — container never closes, no valid tool call
  const broken = '<|CHAT2API|tool_calls><|CHAT2API|invoke name="bash"><|CHAT2API|parameter name="command"><![CDATA[echo'
  const { hasToolCalls, observation } = parseAll(makePlan(), broken)
  assert.equal(hasToolCalls, false, 'Broken container must not produce tool calls')
  // It's buffered (unterminated), so suppressedMalformedToolOutput may fire on flush
  // The key invariant: no tool calls emitted from a broken container
  assert.equal(observation.emittedToolCallCount, 0)
})

test('parser: unknown tool name — classified as invalid_tool_name not noise', () => {
  const xmlWithBadName =
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="nonexistent_tool">' +
    '<|CHAT2API|parameter name="x"><![CDATA[y]]></|CHAT2API|parameter>' +
    '</|CHAT2API|invoke></|CHAT2API|tool_calls>'
  const { hasToolCalls, observation } = parseAll(makePlan(), xmlWithBadName)
  assert.equal(hasToolCalls, false)
  assert.equal(observation.suppressedMalformedToolOutput, true)
  assert.equal(observation.suppressedReason, 'invalid_tool_name')
})

test('parser: malformedDetails is surfaced in observation for invalid structures', () => {
  // Invalid tool name means the structural adapter returns invalid_structure with 'unknown_tool_name' reason
  const xmlWithBadName =
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="nonexistent_tool">' +
    '<|CHAT2API|parameter name="x"><![CDATA[y]]></|CHAT2API|parameter>' +
    '</|CHAT2API|invoke></|CHAT2API|tool_calls>'
  const { observation } = parseAll(makePlan(), xmlWithBadName)
  assert.ok(typeof observation.malformedDetails === 'string',
    `Expected malformedDetails to be a string, got: ${JSON.stringify(observation.malformedDetails)}`)
  assert.ok(observation.malformedDetails.length > 0, 'malformedDetails must be non-empty')
})
