import test from 'node:test'
import assert from 'node:assert/strict'

import {
  detectAvailabilityDrift,
  buildAvailabilityRetryClarification,
  type AvailabilityDriftDetection,
} from '../../src/main/proxy/toolCalling/availabilityDrift.ts'
import type { ToolCallingPlan } from '../../src/main/proxy/toolCalling/types.ts'

function makePlan(toolNames: string[]): ToolCallingPlan {
  return {
    enabled: true,
    protocol: 'managed-xml',
    allowedToolNames: new Set(toolNames),
    catalogSnapshot: { fingerprint: 'test-fp-001', tools: toolNames },
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    shouldRetryOnDrift: true,
    clientType: 'claudeCode',
    toolCallFormat: 'xml',
  } as unknown as ToolCallingPlan
}

function makePlanNoCatalog(): ToolCallingPlan {
  return {
    enabled: true,
    protocol: 'managed-xml',
    allowedToolNames: new Set<string>(),
    catalogSnapshot: null,
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    shouldRetryOnDrift: true,
    clientType: 'claudeCode',
    toolCallFormat: 'xml',
  } as unknown as ToolCallingPlan
}

// ── catalog_missing subkind ────────────────────────────────────────────────────

test('drift: subkind is catalog_missing when plan has no catalog', () => {
  const plan = makePlanNoCatalog()
  const result = detectAvailabilityDrift(plan, 'The bash tool is not available.')

  assert.equal(result.detected, false, 'catalog_missing is not detected=true drift')
  assert.equal(result.subkind, 'catalog_missing')
})

// ── provider_side subkind ──────────────────────────────────────────────────────

test('drift: subkind is provider_side when drift detected with no summary contamination flag', () => {
  const plan = makePlan(['bash', 'filesystem'])
  const assistantText = 'The bash tool is not available in this context.'

  const result = detectAvailabilityDrift(plan, assistantText)

  assert.equal(result.detected, true)
  assert.equal(result.subkind, 'provider_side')
})

// ── summary_contamination subkind ─────────────────────────────────────────────

test('drift: subkind is summary_contamination when opts.summaryContaminated is true', () => {
  const plan = makePlan(['bash', 'filesystem'])
  const assistantText = 'The bash tool is not available in this context.'

  const result = detectAvailabilityDrift(plan, assistantText, { summaryContaminated: true })

  assert.equal(result.detected, true)
  assert.equal(result.subkind, 'summary_contamination')
})

// ── buildAvailabilityRetryClarification message text ──────────────────────────

test('clarification: summary_contamination drift includes remediation note', () => {
  const plan = makePlan(['bash'])
  const drift: AvailabilityDriftDetection = {
    detected: true,
    deniedToolNames: ['bash'],
    mentionedUnavailableOnlyTools: [],
    subkind: 'summary_contamination',
  }

  const clarification = buildAvailabilityRetryClarification(plan, drift)

  assert.ok(
    clarification.includes('prior compaction summary'),
    'summary_contamination clarification must mention compaction'
  )
  assert.ok(clarification.includes('authoritative catalog below supersedes it'))
})

test('clarification: provider_side drift does not add contamination note', () => {
  const plan = makePlan(['bash'])
  const drift: AvailabilityDriftDetection = {
    detected: true,
    deniedToolNames: ['bash'],
    mentionedUnavailableOnlyTools: [],
    subkind: 'provider_side',
  }

  const clarification = buildAvailabilityRetryClarification(plan, drift)

  assert.ok(!clarification.includes('compaction summary'), 'provider_side must not mention compaction')
})
