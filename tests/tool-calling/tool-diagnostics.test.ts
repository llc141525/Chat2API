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