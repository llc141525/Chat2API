import test from 'node:test'
import assert from 'node:assert/strict'

import {
  decidePromptBudgetPolicy,
  getPromptBudgetSnapshot,
  inspectRecentPromptBudgetToolSignals,
  PROMPT_BUDGET_SNAPSHOT_CACHE_LIMIT,
  promptBudgetSnapshotCache,
  recordPromptBudgetSnapshot,
  type PromptBudgetPolicyInput,
  type PromptBudgetSessionBoundaryReason,
} from '../../src/main/proxy/promptBudgetPolicy.ts'
import { buildQwenAssemblyRequestBodyForTest } from '../../src/main/proxy/adapters/qwen.ts'
import type { PromptRefreshMode } from '../../src/main/proxy/promptBudgetPolicy.ts'

function baseInput(overrides: Partial<PromptBudgetPolicyInput> = {}): PromptBudgetPolicyInput {
  return {
    toolCatalogSessionKey: 'catalog-session-1',
    providerConversationSessionKey: 'provider-session-1',
    sessionBoundaryReason: 'normal',
    providerId: 'qwen',
    previousProviderId: 'qwen',
    modelId: 'qwen3-coder',
    previousModelId: 'qwen3-coder',
    accountId: 'acct-1',
    previousAccountId: 'acct-1',
    toolCatalogFingerprint: 'tool-fp-1',
    previousToolCatalogFingerprint: 'tool-fp-1',
    recentSchemaFailure: false,
    recentMalformedToolOutput: false,
    recentUnknownToolFailure: false,
    hasActiveTools: false,
    hasCurrentToolResult: false,
    hasPreviousAssistantToolCalls: false,
    hasManagedToolCapableTurn: false,
    isFreshProviderSession: false,
    ...overrides,
  }
}

test('fresh provider session or missing provider key upgrades to full', () => {
  const freshDecision = decidePromptBudgetPolicy(baseInput({ isFreshProviderSession: true }))
  assert.equal(freshDecision.promptRefreshMode, 'full')
  assert.deepEqual(freshDecision.reasons, ['fresh_provider_session'])

  const missingKeyDecision = decidePromptBudgetPolicy(baseInput({ providerConversationSessionKey: '   ' }))
  assert.equal(missingKeyDecision.promptRefreshMode, 'full')
  assert.ok(missingKeyDecision.reasons.includes('missing_provider_conversation_session_key'))
})

test('boundary reasons that fork provider context always require full refresh', () => {
  const boundaries: Array<Exclude<PromptBudgetSessionBoundaryReason, 'normal'>> = [
    'client_compact',
    'summary_generator',
    'tool_child',
    'subagent_child',
  ]

  for (const sessionBoundaryReason of boundaries) {
    const decision = decidePromptBudgetPolicy(baseInput({ sessionBoundaryReason }))
    assert.equal(decision.promptRefreshMode, 'full')
    assert.ok(decision.reasons.some((reason) => reason.startsWith('session_boundary_')))
  }

  const serverSummaryDecision = decidePromptBudgetPolicy(baseInput({ sessionBoundaryReason: 'server_summary' }))
  assert.equal(serverSummaryDecision.promptRefreshMode, 'full')
  assert.deepEqual(serverSummaryDecision.reasons, ['session_boundary_server_summary'])
})

test('tool catalog fingerprint drift upgrades to full', () => {
  const decision = decidePromptBudgetPolicy(baseInput({
    previousToolCatalogFingerprint: 'tool-fp-old',
    toolCatalogFingerprint: 'tool-fp-new',
  }))

  assert.equal(decision.promptRefreshMode, 'full')
  assert.deepEqual(decision.reasons, ['tool_catalog_fingerprint_changed'])
})

test('recent schema or malformed or unknown-tool failures upgrade to repair', () => {
  const decision = decidePromptBudgetPolicy(baseInput({
    recentSchemaFailure: true,
    recentMalformedToolOutput: true,
    recentUnknownToolFailure: true,
    sessionBoundaryReason: 'client_compact',
  }))

  assert.equal(decision.promptRefreshMode, 'repair')
  assert.deepEqual(decision.reasons, [
    'recent_schema_failure',
    'recent_malformed_tool_output',
    'recent_unknown_tool',
  ])
})

test('tool-result continuity upgrades to tool_ready', () => {
  const currentToolResultDecision = decidePromptBudgetPolicy(baseInput({ hasCurrentToolResult: true }))
  assert.equal(currentToolResultDecision.promptRefreshMode, 'tool_ready')
  assert.deepEqual(currentToolResultDecision.reasons, ['current_tool_result_present'])

  const previousToolCallsDecision = decidePromptBudgetPolicy(baseInput({ hasPreviousAssistantToolCalls: true }))
  assert.equal(previousToolCallsDecision.promptRefreshMode, 'tool_ready')
  assert.deepEqual(previousToolCallsDecision.reasons, ['previous_assistant_tool_calls_present'])

  const managedTurnDecision = decidePromptBudgetPolicy(baseInput({
    hasManagedToolCapableTurn: true,
    hasActiveTools: true,
  }))
  assert.equal(managedTurnDecision.promptRefreshMode, 'tool_ready')
  assert.deepEqual(managedTurnDecision.reasons, ['managed_tool_turn_present'])
})

test('server-summary fork keeps active tool workflow on tool_ready', () => {
  const decision = decidePromptBudgetPolicy(baseInput({
    sessionBoundaryReason: 'server_summary',
    hasCurrentToolResult: true,
    hasPreviousAssistantToolCalls: true,
    hasManagedToolCapableTurn: true,
    hasActiveTools: true,
  }))

  assert.equal(decision.promptRefreshMode, 'tool_ready')
  assert.deepEqual(decision.reasons, [
    'server_summary_active_tool_continuation',
    'current_tool_result_present',
    'previous_assistant_tool_calls_present',
    'managed_tool_turn_present',
  ])
})

test('server-summary active tool workflow on first fork still avoids full when only fresh and uncertain snapshot signals are missing', () => {
  const decision = decidePromptBudgetPolicy(baseInput({
    sessionBoundaryReason: 'server_summary',
    previousProviderId: undefined,
    previousModelId: undefined,
    previousAccountId: undefined,
    previousToolCatalogFingerprint: undefined,
    previousSkillFingerprint: undefined,
    isFreshProviderSession: true,
    hasCurrentToolResult: true,
    hasPreviousAssistantToolCalls: true,
    hasManagedToolCapableTurn: true,
    hasActiveTools: true,
  }))

  assert.equal(decision.promptRefreshMode, 'tool_ready')
  assert.deepEqual(decision.reasons, [
    'server_summary_active_tool_continuation',
    'current_tool_result_present',
    'previous_assistant_tool_calls_present',
    'managed_tool_turn_present',
  ])
})

test('server-summary with tools present but no real tool tail still stays full on a fresh fork', () => {
  const decision = decidePromptBudgetPolicy(baseInput({
    sessionBoundaryReason: 'server_summary',
    previousProviderId: undefined,
    previousModelId: undefined,
    previousAccountId: undefined,
    previousToolCatalogFingerprint: undefined,
    previousSkillFingerprint: undefined,
    isFreshProviderSession: true,
    hasCurrentToolResult: false,
    hasPreviousAssistantToolCalls: false,
    hasManagedToolCapableTurn: true,
    hasActiveTools: true,
  }))

  assert.equal(decision.promptRefreshMode, 'full')
  assert.ok(decision.reasons.includes('fresh_provider_session'))
  assert.ok(decision.reasons.includes('session_boundary_server_summary'))
})

test('server-summary active tool workflow still upgrades to full when continuity safety is broken', () => {
  const decision = decidePromptBudgetPolicy(baseInput({
    sessionBoundaryReason: 'server_summary',
    hasCurrentToolResult: true,
    hasPreviousAssistantToolCalls: true,
    hasManagedToolCapableTurn: true,
    hasActiveTools: true,
    previousToolCatalogFingerprint: 'tool-fp-old',
    toolCatalogFingerprint: 'tool-fp-new',
  }))

  assert.equal(decision.promptRefreshMode, 'full')
  assert.deepEqual(decision.reasons, ['tool_catalog_fingerprint_changed'])
})

test('server-summary active tool workflow still upgrades to full when tool keys are missing', () => {
  const decision = decidePromptBudgetPolicy(baseInput({
    sessionBoundaryReason: 'server_summary',
    providerConversationSessionKey: '   ',
    hasCurrentToolResult: true,
    hasPreviousAssistantToolCalls: true,
    hasManagedToolCapableTurn: true,
    hasActiveTools: true,
    isFreshProviderSession: true,
    previousProviderId: undefined,
    previousModelId: undefined,
    previousAccountId: undefined,
    previousToolCatalogFingerprint: undefined,
  }))

  assert.equal(decision.promptRefreshMode, 'full')
  assert.ok(decision.reasons.includes('missing_provider_conversation_session_key'))
})

test('managed tool-capable turn without active tools does not upgrade to tool_ready', () => {
  const minimalDecision = decidePromptBudgetPolicy(baseInput({
    hasManagedToolCapableTurn: true,
    hasActiveTools: false,
  }))
  assert.equal(minimalDecision.promptRefreshMode, 'minimal')
  assert.deepEqual(minimalDecision.reasons, ['stable_normal_continuation'])

  const digestDecision = decidePromptBudgetPolicy(baseInput({
    hasManagedToolCapableTurn: true,
    hasActiveTools: false,
    skillFingerprint: 'skill-fp-1',
    previousSkillFingerprint: 'skill-fp-1',
  }))
  assert.equal(digestDecision.promptRefreshMode, 'digest')
  assert.deepEqual(digestDecision.reasons, ['skill_fingerprint_present'])
})

test('stable normal continuation without active tools or skills falls back to minimal', () => {
  const decision = decidePromptBudgetPolicy(baseInput())

  assert.equal(decision.promptRefreshMode, 'minimal')
  assert.deepEqual(decision.reasons, ['stable_normal_continuation'])
})

test('skill fingerprint without exact tool-ready requirement uses digest', () => {
  const decision = decidePromptBudgetPolicy(baseInput({
    skillFingerprint: 'skill-fp-1',
    previousSkillFingerprint: 'skill-fp-1',
  }))

  assert.equal(decision.promptRefreshMode, 'digest')
  assert.deepEqual(decision.reasons, ['skill_fingerprint_present'])
})

test('uncertainty upgrades conservatively instead of downgrading', () => {
  const decision = decidePromptBudgetPolicy(baseInput({
    previousToolCatalogFingerprint: 'tool-fp-1',
    toolCatalogFingerprint: undefined,
  }))

  assert.equal(decision.promptRefreshMode, 'full')
  assert.deepEqual(decision.reasons, ['fingerprint_uncertain'])
})

test('historical tool loop does not keep tool_ready alive after assistant answer and user follow-up', () => {
  const signals = inspectRecentPromptBudgetToolSignals([
    { role: 'assistant', tool_calls: [{ id: 'call_1' }] },
    { role: 'tool', tool_call_id: 'call_1' },
    { role: 'assistant' },
    { role: 'user' },
  ])

  assert.deepEqual(signals, {
    hasCurrentToolResult: false,
    hasPreviousAssistantToolCalls: false,
  })

  const decision = decidePromptBudgetPolicy(baseInput({
    hasCurrentToolResult: signals.hasCurrentToolResult,
    hasPreviousAssistantToolCalls: signals.hasPreviousAssistantToolCalls,
    skillFingerprint: 'skill-fp-1',
    previousSkillFingerprint: 'skill-fp-1',
  }))

  assert.equal(decision.promptRefreshMode, 'digest')
  assert.deepEqual(decision.reasons, ['skill_fingerprint_present'])
})

test('snapshot cache evicts the oldest entry once the bounded limit is exceeded', () => {
  promptBudgetSnapshotCache.clear()

  for (let index = 0; index <= PROMPT_BUDGET_SNAPSHOT_CACHE_LIMIT; index += 1) {
    recordPromptBudgetSnapshot(`session-${index}`, {
      providerId: `provider-${index}`,
      modelId: `model-${index}`,
      accountId: `account-${index}`,
      toolCatalogFingerprint: `tool-fp-${index}`,
      skillFingerprint: `skill-fp-${index}`,
    })
  }

  assert.equal(promptBudgetSnapshotCache.size, PROMPT_BUDGET_SNAPSHOT_CACHE_LIMIT)
  assert.equal(getPromptBudgetSnapshot('session-0'), undefined)
  assert.deepEqual(getPromptBudgetSnapshot(`session-${PROMPT_BUDGET_SNAPSHOT_CACHE_LIMIT}`), {
    providerId: `provider-${PROMPT_BUDGET_SNAPSHOT_CACHE_LIMIT}`,
    modelId: `model-${PROMPT_BUDGET_SNAPSHOT_CACHE_LIMIT}`,
    accountId: `account-${PROMPT_BUDGET_SNAPSHOT_CACHE_LIMIT}`,
    toolCatalogFingerprint: `tool-fp-${PROMPT_BUDGET_SNAPSHOT_CACHE_LIMIT}`,
    skillFingerprint: `skill-fp-${PROMPT_BUDGET_SNAPSHOT_CACHE_LIMIT}`,
  })

  promptBudgetSnapshotCache.clear()
})

test('tool_ready mode preserves active tool boundary and excludes old exchanges', () => {
  const assemblyMessages = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_old', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_old', content: 'old result' },
    { role: 'user', content: 'do something new' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_new', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_new', content: 'new result' },
  ]

  const requestBody = buildQwenAssemblyRequestBodyForTest({
    assembly: {
      messages: assemblyMessages,
      toolManifest: { renderedPrompt: '<|CHAT2API|tool_calls>tool schema' },
      summaryText: null,
      metadata: { contextManagementApplied: false, strategiesExecuted: [], originalMessageCount: assemblyMessages.length, finalMessageCount: assemblyMessages.length },
    },
    request: {
      model: 'qwen3-coder',
      originalModel: 'qwen3-coder',
      messages: assemblyMessages,
      stream: false,
      sessionId: 'test-session',
      promptRefreshMode: 'tool_ready' as PromptRefreshMode,
    },
    actualModel: 'qwen3-coder',
    sessionId: 'test-session',
    reqId: 'test-req',
    timestamp: Date.now(),
    enableThinking: false,
    enableWebSearch: false,
  })

  const content = requestBody.messages[0].content

  assert.ok(content.includes('call_new'), 'tool_ready should include latest tool call id')
  assert.ok(content.includes('new result'), 'tool_ready should include latest tool result')
  assert.ok(!content.includes('call_old'), 'tool_ready should exclude old tool call id')
  assert.ok(!content.includes('old result'), 'tool_ready should exclude old tool result')
  assert.ok(content.includes('helpful assistant'), 'tool_ready should keep system text')
  assert.ok(content.includes('tool schema'), 'tool_ready should keep tool contract')
})

test('digest mode excludes full tool schemas and keeps last ~4 messages', () => {
  const assemblyMessages = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'first response' },
    { role: 'user', content: 'second' },
    { role: 'assistant', content: 'second response' },
    { role: 'user', content: 'third' },
    { role: 'assistant', content: 'third response' },
  ]

  const requestBody = buildQwenAssemblyRequestBodyForTest({
    assembly: {
      messages: assemblyMessages,
      toolManifest: { renderedPrompt: 'catalog_fingerprint:abc\ntool_schema_content' },
      summaryText: 'Prior conversation summary: [some summary]',
      metadata: { contextManagementApplied: false, strategiesExecuted: [], originalMessageCount: assemblyMessages.length, finalMessageCount: assemblyMessages.length },
    },
    request: {
      model: 'qwen3-coder',
      originalModel: 'qwen3-coder',
      messages: assemblyMessages,
      stream: false,
      sessionId: 'test-session',
      promptRefreshMode: 'digest' as PromptRefreshMode,
    },
    actualModel: 'qwen3-coder',
    sessionId: 'test-session',
    reqId: 'test-req',
    timestamp: Date.now(),
    enableThinking: false,
    enableWebSearch: false,
  })

  const content = requestBody.messages[0].content

  assert.ok(content.includes('helpful assistant'), 'digest should keep system text')
  assert.ok(content.includes('Prior conversation summary'), 'digest should keep summary')
  assert.ok(!content.includes('tool_schema_content'), 'digest should drop tool schemas')
  assert.ok(content.includes('third response'), 'digest should keep latest exchange')
  assert.ok(content.includes('second'), 'digest should keep second exchange')
  assert.ok(!content.includes('first response'), 'digest should drop old exchanges beyond last 4')
})

test('minimal mode drops tool contract and summary, keeps only latest user+assistant', () => {
  const assemblyMessages = [
    { role: 'system', content: 'System instructions here.' },
    { role: 'user', content: 'first turn' },
    { role: 'assistant', content: 'first response' },
    { role: 'user', content: 'second turn' },
    { role: 'assistant', content: 'second response' },
  ]

  const requestBody = buildQwenAssemblyRequestBodyForTest({
    assembly: {
      messages: assemblyMessages,
      toolManifest: { renderedPrompt: 'tool_schema_text' },
      summaryText: 'Prior conversation summary: [summary]',
      metadata: { contextManagementApplied: false, strategiesExecuted: [], originalMessageCount: assemblyMessages.length, finalMessageCount: assemblyMessages.length },
    },
    request: {
      model: 'qwen3-coder',
      originalModel: 'qwen3-coder',
      messages: assemblyMessages,
      stream: false,
      sessionId: 'test-session',
      promptRefreshMode: 'minimal' as PromptRefreshMode,
    },
    actualModel: 'qwen3-coder',
    sessionId: 'test-session',
    reqId: 'test-req',
    timestamp: Date.now(),
    enableThinking: false,
    enableWebSearch: false,
  })

  const content = requestBody.messages[0].content

  assert.ok(content.includes('System instructions'), 'minimal should keep system text')
  assert.ok(!content.includes('tool_schema_text'), 'minimal should drop tool contract')
  assert.ok(!content.includes('Prior conversation summary'), 'minimal should drop summary')
  assert.ok(content.includes('second turn'), 'minimal should keep latest user turn')
  assert.ok(content.includes('second response'), 'minimal should keep latest assistant response')
  assert.ok(!content.includes('first turn'), 'minimal should drop old user turns')
  assert.ok(!content.includes('first response'), 'minimal should drop old assistant responses')
})

test('undefined mode preserves current behavior (backward compatibility)', () => {
  const assemblyMessages = [
    { role: 'system', content: 'System text.' },
    { role: 'user', content: 'user turn' },
    { role: 'assistant', content: 'assistant response' },
  ]

  const requestBodyWithMode = buildQwenAssemblyRequestBodyForTest({
    assembly: {
      messages: assemblyMessages,
      toolManifest: { renderedPrompt: 'tool_contract' },
      summaryText: null,
      metadata: { contextManagementApplied: false, strategiesExecuted: [], originalMessageCount: assemblyMessages.length, finalMessageCount: assemblyMessages.length },
    },
    request: {
      model: 'qwen3-coder',
      originalModel: 'qwen3-coder',
      messages: assemblyMessages,
      stream: false,
      sessionId: 'test-session',
      promptRefreshMode: undefined,
    },
    actualModel: 'qwen3-coder',
    sessionId: 'test-session',
    reqId: 'test-req',
    timestamp: Date.now(),
    enableThinking: false,
    enableWebSearch: false,
  })

  const contentWithMode = requestBodyWithMode.messages[0].content

  const requestBodyWithoutMode = buildQwenAssemblyRequestBodyForTest({
    assembly: {
      messages: assemblyMessages,
      toolManifest: { renderedPrompt: 'tool_contract' },
      summaryText: null,
      metadata: { contextManagementApplied: false, strategiesExecuted: [], originalMessageCount: assemblyMessages.length, finalMessageCount: assemblyMessages.length },
    },
    request: {
      model: 'qwen3-coder',
      originalModel: 'qwen3-coder',
      messages: assemblyMessages,
      stream: false,
      sessionId: 'test-session',
    },
    actualModel: 'qwen3-coder',
    sessionId: 'test-session',
    reqId: 'test-req',
    timestamp: Date.now(),
    enableThinking: false,
    enableWebSearch: false,
  })

  const contentWithoutMode = requestBodyWithoutMode.messages[0].content

  assert.equal(contentWithMode, contentWithoutMode, 'undefined mode should match absent mode')
  assert.ok(contentWithMode.includes('System text'), 'backward compat should include system text')
  assert.ok(contentWithMode.includes('tool_contract'), 'backward compat should include tool contract')
  assert.ok(contentWithMode.includes('user turn'), 'backward compat should include user turn')
  assert.ok(contentWithMode.includes('assistant response'), 'backward compat should include assistant response')
})

test('full and repair modes keep all sections like undefined', () => {
  const assemblyMessages = [
    { role: 'system', content: 'System text.' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'world' },
  ]

  function buildWithMode(mode: PromptRefreshMode | undefined): string {
    const body = buildQwenAssemblyRequestBodyForTest({
      assembly: {
        messages: assemblyMessages,
        toolManifest: { renderedPrompt: 'tool_contract' },
        summaryText: 'Prior conversation summary: [summary]',
        metadata: { contextManagementApplied: false, strategiesExecuted: [], originalMessageCount: assemblyMessages.length, finalMessageCount: assemblyMessages.length },
      },
      request: {
        model: 'qwen3-coder',
        originalModel: 'qwen3-coder',
        messages: assemblyMessages,
        stream: false,
        sessionId: 'test-session',
        ...(mode ? { promptRefreshMode: mode } : {}),
      },
      actualModel: 'qwen3-coder',
      sessionId: 'test-session',
      reqId: 'test-req',
      timestamp: Date.now(),
      enableThinking: false,
      enableWebSearch: false,
    })
    return body.messages[0].content
  }

  const fullContent = buildWithMode('full')
  const repairContent = buildWithMode('repair')
  const defaultContent = buildWithMode(undefined)

  assert.equal(fullContent, defaultContent, 'full mode should match default')
  assert.equal(repairContent, defaultContent, 'repair mode should match default')
  assert.ok(fullContent.includes('tool_contract'), 'full should include tool contract')
  assert.ok(fullContent.includes('Prior conversation summary'), 'full should include summary')
})
