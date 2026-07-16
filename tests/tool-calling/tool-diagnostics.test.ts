import test from 'node:test'
import assert from 'node:assert/strict'

import {
  clearToolDiagnosticEvents,
  getToolDiagnosticEvents,
  recordToolDiagnosticEvent,
} from '../../src/main/proxy/toolCalling/diagnostics.ts'

test('tool diagnostic events store structure facts without arguments or full schemas', () => {
  clearToolDiagnosticEvents()
  recordToolDiagnosticEvent({
    type: 'tool_catalog_resolved',
    requestId: 'r1',
    providerId: 'qwen',
    model: 'qwen3',
    catalogFingerprint: 'abc',
    toolNames: ['bash'],
    schemaHashes: { bash: 'hash' },
    argumentsText: '{"argument":"rm -rf /"}',
    fullSchema: { type: 'object', properties: { argument: { type: 'string' } } },
    prompt: 'secret prompt',
  } as any)

  const events = getToolDiagnosticEvents()
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'tool_catalog_resolved')
  assert.deepEqual(events[0].toolNames, ['bash'])
  assert.equal((events[0] as any).argumentsText, undefined)
  assert.equal((events[0] as any).fullSchema, undefined)
  assert.equal((events[0] as any).prompt, undefined)
})

test('tool diagnostic events keep contract facts and redact payload detail', () => {
  clearToolDiagnosticEvents()
  recordToolDiagnosticEvent({
    type: 'tool_contract_resolved',
    requestId: 'diag-contract',
    providerId: 'glm',
    model: 'glm-5',
    catalogSource: 'none',
    catalogFingerprint: undefined,
    toolNames: [],
    toolSourceChain: ['current_request', 'session_catalog', 'message_history', 'safe_empty'],
    protocol: 'managed_xml',
    responseMode: 'non_streaming',
    terminalOutcome: 'provider_empty',
    emptyOutputPolicy: 'diagnose_and_fail',
    validationFailureKind: 'unknown_tool_name',
    suppressedReason: 'invalid_tool_name',
    argumentsText: '{"secret":"value"}',
    fullSchema: { type: 'object', properties: { secret: { type: 'string' } } },
    prompt: 'do not store this',
  } as any)

  const [event] = getToolDiagnosticEvents()
  assert.equal(event.type, 'tool_contract_resolved')
  assert.deepEqual(event.toolSourceChain, ['current_request', 'session_catalog', 'message_history', 'safe_empty'])
  assert.equal(event.terminalOutcome, 'provider_empty')
  assert.equal(event.emptyOutputPolicy, 'diagnose_and_fail')
  assert.equal(event.validationFailureKind, 'unknown_tool_name')
  assert.equal(event.suppressedReason, 'invalid_tool_name')
  assert.equal((event as any).argumentsText, undefined)
  assert.equal((event as any).fullSchema, undefined)
  assert.equal((event as any).prompt, undefined)
})

test('validation failure diagnostic records only failure category', () => {
  clearToolDiagnosticEvents()
  recordToolDiagnosticEvent({
    type: 'tool_validation_failed',
    requestId: 'bad-call',
    providerId: 'qwen',
    model: 'qwen3',
    protocol: 'managed_xml',
    responseMode: 'non_streaming',
    validationFailureKind: 'schema_validation_failed',
    argumentsText: '{"secret":"value"}',
  } as any)

  const [event] = getToolDiagnosticEvents()
  assert.equal(event.type, 'tool_validation_failed')
  assert.equal(event.validationFailureKind, 'schema_validation_failed')
  assert.equal((event as any).argumentsText, undefined)
})
