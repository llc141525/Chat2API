import test from 'node:test'
import assert from 'node:assert/strict'

import {
  clearToolDiagnosticEvents,
  getToolDiagnosticEvents,
} from '../../src/main/proxy/toolCalling/diagnostics.ts'
import { inspectNonStreamAssistantOutput, inspectStreamAssistantOutput } from '../../src/main/proxy/toolCalling/outputInspection.ts'
import type { ToolCallingPlan } from '../../src/main/proxy/toolCalling/types.ts'

function plan(emptyOutputPolicy: ToolCallingPlan['contract']['emptyOutputPolicy'] = 'diagnose_and_fail'): ToolCallingPlan {
  return {
    mode: 'managed',
    protocol: 'managed_xml',
    clientAdapterId: 'standard-openai-tools',
    providerId: 'qwen',
    tools: [],
    shouldInjectPrompt: false,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(),
    catalogDiagnostics: {
      source: 'none',
      driftKinds: [],
      blocked: false,
      reason: 'no_tools',
    },
    availabilityRetryAllowed: false,
    contract: {
      turnId: 'empty-r1',
      sessionId: 'empty-session',
      providerId: 'qwen',
      model: 'qwen3',
      protocol: 'managed_xml',
      snapshotFingerprint: null,
      tools: Object.freeze([]),
      allowedToolNames: Object.freeze(new Set<string>()),
      toolChoiceMode: 'auto',
      shouldInjectPrompt: false,
      shouldParseResponse: true,
      historyMode: 'managed_protocol',
      emptyOutputPolicy,
      toolSourceChain: Object.freeze(['current_request', 'session_catalog', 'message_history', 'safe_empty']),
    },
    diagnostics: {
      requestId: 'empty-r1',
      turnId: 'empty-r1',
      clientAdapterId: 'standard-openai-tools',
      providerId: 'qwen',
      model: 'qwen3',
      actualModel: 'qwen3',
      toolSource: 'none',
      mode: 'managed',
      protocol: 'managed_xml',
      toolCount: 0,
      injected: false,
      reason: 'no_tools',
      emptyOutputPolicy,
    },
  }
}

test('empty non-stream assistant output fails when policy is diagnose_and_fail', () => {
  clearToolDiagnosticEvents()
  const result = inspectNonStreamAssistantOutput({
    result: {
      choices: [{
        message: { role: 'assistant', content: '' },
        finish_reason: 'stop',
      }],
    },
    plan: plan('diagnose_and_fail'),
  })

  assert.equal(result.ok, false)
  assert.equal(result.outcome, 'provider_empty')
  assert.match(result.error, /empty assistant output/i)

  const [event] = getToolDiagnosticEvents()
  assert.equal(event.type, 'provider_empty_output')
  assert.equal(event.terminalOutcome, 'provider_empty')
})

test('tool calls count as non-empty output', () => {
  const result = inspectNonStreamAssistantOutput({
    result: {
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_0',
            type: 'function',
            function: { name: 'bash', arguments: '{}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    },
    plan: plan('diagnose_and_fail'),
  })

  assert.equal(result.ok, true)
  assert.equal(result.outcome, 'tool_calls')
})

test('intentional silence policy passes through empty output with diagnostic outcome', () => {
  const result = inspectNonStreamAssistantOutput({
    result: {
      choices: [{
        message: { role: 'assistant', content: '' },
        finish_reason: 'stop',
      }],
    },
    plan: plan('pass_through_without_tool_semantics'),
  })

  assert.equal(result.ok, true)
  assert.equal(result.outcome, 'provider_empty')
})

test('whitespace-only non-stream assistant output fails under strict contract', () => {
  const result = inspectNonStreamAssistantOutput({
    result: {
      choices: [{
        message: { role: 'assistant', content: '  \n\t  ' },
        finish_reason: 'stop',
      }],
    },
    plan: plan('diagnose_and_fail'),
  })

  assert.equal(result.ok, false)
  assert.equal(result.outcome, 'provider_empty')
})

test('missing non-stream message fails under strict contract', () => {
  const result = inspectNonStreamAssistantOutput({
    result: {
      choices: [],
    },
    plan: plan('diagnose_and_fail'),
  })

  assert.equal(result.ok, false)
  assert.equal(result.outcome, 'provider_empty')
})

test('stream inspection fails when only whitespace content was emitted', () => {
  const result = inspectStreamAssistantOutput({
    plan: plan('diagnose_and_fail'),
    observation: {
      rawContentLength: 3,
      emittedContentLength: 3,
      emittedVisibleContentLength: 0,
      emittedToolCallCount: 0,
      suppressedMalformedToolOutput: false,
    },
    finishReason: 'stop',
  })

  assert.equal(result.ok, false)
  assert.equal(result.outcome, 'provider_empty')
})

test('stream inspection reports malformed tool output when buffered protocol text was suppressed', () => {
  const result = inspectStreamAssistantOutput({
    plan: plan('diagnose_and_fail'),
    observation: {
      rawContentLength: 32,
      emittedContentLength: 0,
      emittedVisibleContentLength: 0,
      emittedToolCallCount: 0,
      suppressedMalformedToolOutput: true,
      suppressedReason: 'malformed_tool_output',
    },
    finishReason: 'stop',
  })

  assert.equal(result.ok, false)
  assert.equal(result.outcome, 'malformed_tool_output')
})
