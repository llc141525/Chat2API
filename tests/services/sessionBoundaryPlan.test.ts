import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSessionBoundaryPlan } from '../../src/main/proxy/services/sessionBoundaryPlan.ts'
import type { ChatCompletionRequest, ProxyContext } from '../../src/main/proxy/types.ts'

const request: ChatCompletionRequest = {
  model: 'model',
  messages: [{ role: 'user', content: 'Continue.' }],
}

function context(boundary: NonNullable<ProxyContext['sessionBoundaryReason']>): ProxyContext {
  return {
    requestId: 'req-1',
    model: 'model',
    startTime: 1,
    isStream: false,
    toolCatalogSessionKey: 'tool-key',
    providerConversationSessionKey: `provider-key:${boundary}`,
    parentProviderConversationSessionKey: 'provider-key:normal',
    sessionBoundaryReason: boundary,
  }
}

test('normal boundary reuses the prior provider session', () => {
  const plan = buildSessionBoundaryPlan({
    context: context('normal'),
    priorState: { providerSessionId: 'qwen-parent' },
    request,
  })

  assert.equal(plan.providerSessionAction, 'reuse_parent')
  assert.equal(plan.expectedProviderSessionIdReuse, true)
})

for (const boundary of ['client_compact', 'summary_generator'] as const) {
  test(`${boundary} starts a fresh provider session`, () => {
    const plan = buildSessionBoundaryPlan({
      context: context(boundary),
      priorState: { conversationId: 'glm-parent' },
      request,
    })

    assert.equal(plan.providerSessionAction, 'start_fresh')
    assert.equal(plan.expectedProviderSessionIdReuse, false)
  })
}

test('server_summary starts fresh on first turn, reuses on subsequent turns', () => {
  // First turn in compaction epoch: no prior session → start_fresh
  const plan1 = buildSessionBoundaryPlan({
    context: context('server_summary'),
    request,
  })
  assert.equal(plan1.providerSessionAction, 'start_fresh')
  assert.equal(plan1.expectedProviderSessionIdReuse, false)

  // Subsequent turn: prior session exists → reuse_parent
  const plan2 = buildSessionBoundaryPlan({
    context: context('server_summary'),
    priorState: { providerSessionId: 'qwen-session' },
    request,
  })
  assert.equal(plan2.providerSessionAction, 'reuse_parent')
  assert.equal(plan2.expectedProviderSessionIdReuse, true)
})

for (const boundary of ['tool_child', 'subagent_child'] as const) {
  test(`${boundary} starts an isolated child provider session`, () => {
    const plan = buildSessionBoundaryPlan({
      context: context(boundary),
      priorState: { providerSessionId: 'qwen-parent' },
      request,
    })

    assert.equal(plan.providerSessionAction, 'start_child')
    assert.equal(plan.expectedProviderSessionIdReuse, false)
  })
}
