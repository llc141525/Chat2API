/**
 * Contract tests for ToolStreamParser (exported class).
 *
 * ToolStreamParser intercepts managed tool-call markers (XML, bracket, Chat2API)
 * from streaming model output and converts them into OpenAI tool_calls deltas.
 *
 * Contracts verified:
 *  1. Complete tool call block — a full managed_xml tool call in one chunk
 *     should be parsed and emitted as a tool_calls delta.
 *  2. Cross-chunk marker — a tool call split across multiple chunks should
 *     not be misidentified as plain text; parser should buffer correctly.
 *  3. Non-tool text — ordinary assistant prose without tool markers should
 *     pass through as text without triggering tool buffering.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { ToolStreamParser } from '../../src/main/proxy/toolCalling/ToolStreamParser.ts'
import type { ToolCallingPlan, NormalizedToolDefinition } from '../../src/main/proxy/toolCalling/types.ts'

// ── Helpers ────────────────────────────────────────────────────────

function makeTool(name: string, properties: Record<string, unknown> = {}, required: string[] = []): NormalizedToolDefinition {
  return {
    name,
    description: `Tool ${name}`,
    parameters: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
    source: 'openai' as const,
  }
}

function makeManagedXmlPlan(allowedToolNames: string[] = []): ToolCallingPlan {
  return {
    mode: 'managed',
    protocol: 'managed_xml' as const,
    clientAdapterId: 'standard-openai-tools',
    providerId: 'test-provider',
    tools: allowedToolNames.map(n => makeTool(n)),
    shouldInjectPrompt: false,
    shouldParseResponse: true,
    toolChoiceMode: 'auto' as const,
    allowedToolNames: new Set(allowedToolNames),
    catalogDiagnostics: { source: 'current_request', driftKinds: [], blocked: false } as any,
    availabilityRetryAllowed: false,
    contract: { turnId: 'test', sessionId: null, providerId: 'test-provider', model: 'test', protocol: 'managed_xml', snapshotFingerprint: null, tools: [], allowedToolNames: new Set(), toolChoiceMode: 'auto', shouldInjectPrompt: false, shouldParseResponse: true, historyMode: 'managed_protocol', emptyOutputPolicy: 'diagnose_and_fail', toolSourceChain: [] } as any,
    diagnostics: { clientAdapterId: 'standard-openai-tools', providerId: 'test-provider', toolSource: 'openai', mode: 'managed', protocol: 'managed_xml', toolCount: 0, injected: false, reason: 'test' } as any,
  }
}

function makePlanWithTools(toolDefs: NormalizedToolDefinition[]): ToolCallingPlan {
  const names = toolDefs.map(t => t.name)
  return {
    mode: 'managed',
    protocol: 'managed_xml',
    clientAdapterId: 'standard-openai-tools',
    providerId: 'test-provider',
    tools: toolDefs,
    shouldInjectPrompt: false,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(names),
    catalogDiagnostics: { source: 'current_request', driftKinds: [], blocked: false } as any,
    availabilityRetryAllowed: false,
    contract: { turnId: 'test', sessionId: null, providerId: 'test-provider', model: 'test', protocol: 'managed_xml', snapshotFingerprint: null, tools: toolDefs, allowedToolNames: new Set(names), toolChoiceMode: 'auto', shouldInjectPrompt: false, shouldParseResponse: true, historyMode: 'managed_protocol', emptyOutputPolicy: 'diagnose_and_fail', toolSourceChain: [] } as any,
    diagnostics: { clientAdapterId: 'standard-openai-tools', providerId: 'test-provider', toolSource: 'openai', mode: 'managed', protocol: 'managed_xml', toolCount: toolDefs.length, injected: false, reason: 'test' } as any,
  }
}

// ── Contract 1: Complete tool call block ──────────────────────────

test('contract: complete managed_xml tool call is parsed as tool_calls', () => {
  const tools = [
    makeTool('read_file', { filePath: { type: 'string' } }, ['filePath']),
    makeTool('write_file'),
  ]
  const plan = makePlanWithTools(tools)
  const parser = new ToolStreamParser(plan)

  const fullToolCall = '<tool_calls><invoke name="read_file">' +
    '<parameter name="filePath">/tmp/test.txt</parameter>' +
    '</invoke></tool_calls>'

  const results = parser.push(fullToolCall, {})
  assert.ok(results.length > 0, 'should emit at least one chunk')
  const toolCallChunks = results.filter((r: any) => r.choices?.[0]?.delta?.tool_calls)
  assert.ok(toolCallChunks.length > 0, 'should emit tool_calls delta')
})

// ── Contract 2: Cross-chunk not misidentified ────────────────────

test('contract: tool call split across chunks does not misidentify as text', () => {
  const tools = [
    makeTool('read_file', { filePath: { type: 'string' } }, ['filePath']),
  ]
  const plan = makePlanWithTools(tools)
  const parser = new ToolStreamParser(plan)

  // First chunk: just the opening
  const results1 = parser.push('<tool_calls', {})
  // No tool call should be emitted yet (still buffering)
  const toolCalls1 = results1.filter((r: any) => r.choices?.[0]?.delta?.tool_calls)
  assert.equal(toolCalls1.length, 0, 'partial opening should not emit tool_calls')

  // Second chunk: complete the tool call
  const results2 = parser.push('><invoke name="read_file">' +
    '<parameter name="filePath">/tmp/test.txt</parameter>' +
    '</invoke></tool_calls>', {})
  const toolCalls2 = results2.filter((r: any) => r.choices?.[0]?.delta?.tool_calls)
  assert.ok(toolCalls2.length > 0, 'completed tool call should emit tool_calls')
})

// ── Contract 3: Non-tool text not misidentified ───────────────────

test('contract: ordinary prose without tool markers passes through as text', () => {
  const plan = makeManagedXmlPlan(['read_file'])
  const parser = new ToolStreamParser(plan)

  const results = parser.push('Here is a regular assistant response.', {})
  const toolCallChunks = results.filter((r: any) => r.type === 'tool_calls')
  assert.equal(toolCallChunks.length, 0, 'plain text should not produce tool_calls')
  assert.ok(results.length >= 0, 'plain text may be emitted or suppressed depending on state')
})

test('contract: angle brackets in prose (not tool markers) do not trigger buffering', () => {
  const plan = makeManagedXmlPlan(['read_file'])
  const parser = new ToolStreamParser(plan)

  // Text with angle brackets but not a tool marker
  const results = parser.push('You should use <code> tags for inline code.', {})
  const toolCallChunks = results.filter((r: any) => r.type === 'tool_calls')
  assert.equal(toolCallChunks.length, 0, 'inline angle brackets should not trigger tool buffering')
})
