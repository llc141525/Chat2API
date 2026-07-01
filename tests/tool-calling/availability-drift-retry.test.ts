import test from 'node:test'
import assert from 'node:assert/strict'

import { buildAvailabilityRetryClarification } from '../../src/main/proxy/toolCalling/availabilityDrift.ts'
import type { ToolCallingPlan } from '../../src/main/proxy/toolCalling/types.ts'

function makePlan(overrides: Partial<ToolCallingPlan> = {}): ToolCallingPlan {
  return {
    mode: 'managed',
    protocol: 'managed_xml',
    clientAdapterId: 'standard-openai-tools',
    providerId: 'qwen',
    tools: [],
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(['bash', 'write', 'read']),
    catalogSnapshot: undefined,
    catalogDiagnostics: {
      source: 'current_request',
      fingerprint: 'abc123',
      driftKinds: [],
      blocked: false,
    },
    availabilityRetryAllowed: false,
    diagnostics: {
      clientAdapterId: 'standard-openai-tools',
      providerId: 'qwen',
      toolSource: 'openai',
      mode: 'managed',
      protocol: 'managed_xml',
      toolCount: 3,
      injected: true,
      reason: 'managed_auto',
      allowedToolNames: ['bash', 'write', 'read'],
    },
    ...overrides,
  }
}

test('clarification includes all available tool names', () => {
  const plan = makePlan()
  const result = buildAvailabilityRetryClarification(plan)

  assert.ok(result.includes('bash'))
  assert.ok(result.includes('write'))
  assert.ok(result.includes('read'))
  assert.ok(result.includes('available_tools: bash, write, read'))
})

test('clarification includes catalog fingerprint when snapshot is present', () => {
  const plan = makePlan({
    catalogSnapshot: {
      sessionId: 's1',
      fingerprint: 'fp_test_123',
      tools: [],
      allowedToolNames: ['bash', 'write', 'read'],
      schemaHashes: {},
      source: 'current_request',
      createdTurnIndex: 1,
      updatedTurnIndex: 1,
    },
  })
  const result = buildAvailabilityRetryClarification(plan)

  assert.ok(result.includes('catalog_fingerprint: fp_test_123'))
})

test('clarification handles missing catalog snapshot gracefully', () => {
  const plan = makePlan({ catalogSnapshot: undefined })
  const result = buildAvailabilityRetryClarification(plan)

  assert.ok(result.includes('catalog_fingerprint:'))
  assert.ok(result.includes('available_tools: bash, write, read'))
  assert.ok(result.includes('Tool availability clarification:'))
})

test('clarification returns safe message when no tools are allowed', () => {
  const plan = makePlan({ allowedToolNames: new Set() })
  const result = buildAvailabilityRetryClarification(plan)

  assert.ok(result.includes('no tools available'))
})
