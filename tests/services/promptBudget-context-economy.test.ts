import test from 'node:test'
import assert from 'node:assert/strict'

import { decidePromptBudgetPolicy, type PromptBudgetPolicyInput } from '../../src/main/proxy/promptBudgetPolicy.ts'
import { buildQwenAssemblyRequestBodyForTest } from '../../src/main/proxy/adapters/qwen.ts'

function input(overrides: Partial<PromptBudgetPolicyInput> = {}): PromptBudgetPolicyInput {
  return {
    toolCatalogSessionKey: 'tool-key',
    providerConversationSessionKey: 'provider-key',
    providerId: 'qwen',
    modelId: 'Qwen3-Max',
    accountId: 'acc-1',
    toolCatalogFingerprint: 'catalog-1',
    hasActiveTools: true,
    hasManagedToolCapableTurn: false,
    ...overrides,
  }
}

test('normal first request uses full prompt refresh', () => {
  assert.equal(decidePromptBudgetPolicy(input({ isFreshProviderSession: true })).promptRefreshMode, 'full')
})

for (const boundary of ['client_compact', 'server_summary'] as const) {
  test(`${boundary} uses digest on a fresh compacted provider session`, () => {
    const decision = decidePromptBudgetPolicy(input({
      sessionBoundaryReason: boundary,
      isFreshProviderSession: true,
    }))
    assert.equal(decision.promptRefreshMode, 'digest')
  })
}

test('server summary with active tool continuation uses tool_ready', () => {
  const decision = decidePromptBudgetPolicy(input({
    sessionBoundaryReason: 'server_summary',
    isFreshProviderSession: true,
    hasCurrentToolResult: true,
    hasPreviousAssistantToolCalls: true,
  }))
  assert.equal(decision.promptRefreshMode, 'tool_ready')
})

test('summary generator uses full prompt on its isolated provider session', () => {
  const decision = decidePromptBudgetPolicy(input({
    sessionBoundaryReason: 'summary_generator',
    isFreshProviderSession: true,
    hasActiveTools: false,
  }))
  assert.equal(decision.promptRefreshMode, 'full')
})

test('stable normal continuation uses minimal', () => {
  const decision = decidePromptBudgetPolicy(input({
    sessionBoundaryReason: 'normal',
    isFreshProviderSession: false,
    previousProviderId: 'qwen',
    previousModelId: 'Qwen3-Max',
    previousAccountId: 'acc-1',
    previousToolCatalogFingerprint: 'catalog-1',
  }))
  assert.equal(decision.promptRefreshMode, 'minimal')
})

test('qwen digest request re-derives the current tool contract on the fresh provider session', () => {
  const body = buildQwenAssemblyRequestBodyForTest({
    assembly: {
      messages: [{ role: 'user', content: 'Continue after compact.' }],
      summaryText: '[Workflow state digest v1] task remains active',
      workflowDigest: null,
      toolManifest: { renderedPrompt: 'Tool Contract Header\n## Available Tools\nTool `read`' },
      metadata: { contextManagementApplied: true, strategiesExecuted: ['summary'], originalMessageCount: 40, finalMessageCount: 3 },
    } as any,
    request: {
      model: 'Qwen3-Max',
      messages: [{ role: 'user', content: 'Continue after compact.' }],
      promptRefreshMode: 'digest',
    },
    actualModel: 'Qwen3-Max',
    sessionId: 'fresh-provider-session',
    reqId: 'req-1',
    timestamp: 1,
    enableThinking: false,
    enableWebSearch: false,
  })

  const content = String(body.messages[0]?.content ?? '')
  assert.match(content, /Workflow state digest v1/)
  assert.match(content, /Tool Contract Header/)
  assert.equal((content.match(/## Available Tools/g) ?? []).length, 1)
})
