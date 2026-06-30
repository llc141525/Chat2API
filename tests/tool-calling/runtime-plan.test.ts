import test from 'node:test'
import assert from 'node:assert/strict'

import { buildToolCallingRuntimePlan } from '../../src/main/proxy/toolCalling/runtimePlan.ts'
import type { NormalizedToolDefinition } from '../../src/main/proxy/toolCalling/types.ts'

const tools: NormalizedToolDefinition[] = [{
  name: 'weather-test:get_weather',
  description: 'Get weather',
  parameters: { type: 'object' },
  source: 'mcp',
}]

test('off mode disables managed processing', () => {
  const plan = buildToolCallingRuntimePlan({
    requestId: 'r1',
    providerId: 'deepseek',
    actualModel: 'deepseek-chat',
    config: {
      enabled: true,
      mode: 'off',
      clientAdapterId: 'cherry-studio-mcp',
      diagnosticsEnabled: false,
      advanced: { promptPreviewEnabled: false },
    },
    clientRequest: {
      clientAdapterId: 'cherry-studio-mcp',
      toolSource: 'mcp',
      tools,
      toolChoice: { mode: 'auto' },
      diagnostics: { rawToolCount: 1, normalizedToolNames: ['weather-test:get_weather'] },
    },
  })

  assert.equal(plan.mode, 'disabled')
  assert.equal(plan.shouldInjectPrompt, false)
  assert.equal(plan.diagnostics.reason, 'mode_off')
})

test('auto mode manages P0 provider requests with tools', () => {
  const plan = buildToolCallingRuntimePlan({
    requestId: 'r2',
    providerId: 'kimi',
    actualModel: 'kimi-k2',
    config: {
      enabled: true,
      mode: 'auto',
      clientAdapterId: 'cherry-studio-mcp',
      diagnosticsEnabled: false,
      advanced: { promptPreviewEnabled: false },
    },
    clientRequest: {
      clientAdapterId: 'cherry-studio-mcp',
      toolSource: 'mcp',
      tools,
      toolChoice: { mode: 'auto' },
      diagnostics: { rawToolCount: 1, normalizedToolNames: ['weather-test:get_weather'] },
    },
  })

  assert.equal(plan.mode, 'managed')
  assert.equal(plan.protocol, 'managed_xml')
  assert.equal(plan.clientAdapterId, 'cherry-studio-mcp')
  assert.deepEqual([...plan.allowedToolNames], ['weather-test:get_weather'])
})

test('tool_choice none disables prompt injection and parsing', () => {
  const plan = buildToolCallingRuntimePlan({
    requestId: 'r3',
    providerId: 'glm',
    actualModel: 'glm-5',
    config: {
      enabled: true,
      mode: 'force',
      clientAdapterId: 'standard-openai-tools',
      diagnosticsEnabled: false,
      advanced: { promptPreviewEnabled: false },
    },
    clientRequest: {
      clientAdapterId: 'standard-openai-tools',
      toolSource: 'openai',
      tools,
      toolChoice: { mode: 'none' },
      diagnostics: { rawToolCount: 1, normalizedToolNames: ['weather-test:get_weather'] },
    },
  })

  assert.equal(plan.mode, 'disabled')
  assert.equal(plan.diagnostics.reason, 'tool_choice_none')
})

test('forced missing tool name is rejected before provider call', () => {
  assert.throws(() => buildToolCallingRuntimePlan({
    requestId: 'r4',
    providerId: 'qwen',
    actualModel: 'qwen3-coder',
    config: {
      enabled: true,
      mode: 'force',
      clientAdapterId: 'standard-openai-tools',
      diagnosticsEnabled: false,
      advanced: { promptPreviewEnabled: false },
    },
    clientRequest: {
      clientAdapterId: 'standard-openai-tools',
      toolSource: 'openai',
      tools,
      toolChoice: { mode: 'forced', forcedName: 'missing_tool' },
      diagnostics: { rawToolCount: 1, normalizedToolNames: ['weather-test:get_weather'] },
    },
  }), /Forced tool missing_tool is not declared/)
})

test('existing catalog is reused when a later turn omits request tools', () => {
  const first = buildToolCallingRuntimePlan({
    requestId: 'r5',
    providerId: 'qwen',
    actualModel: 'qwen3-coder',
    config: {
      enabled: true,
      mode: 'force',
      clientAdapterId: 'standard-openai-tools',
      diagnosticsEnabled: false,
      advanced: { promptPreviewEnabled: false },
    },
    clientRequest: {
      clientAdapterId: 'standard-openai-tools',
      toolSource: 'openai',
      tools,
      toolChoice: { mode: 'auto' },
      diagnostics: { rawToolCount: 1, normalizedToolNames: ['weather-test:get_weather'] },
    },
    toolSessionKey: 'runtime-plan-reuse',
    messages: [{ role: 'user', content: 'first turn' }],
  })

  const second = buildToolCallingRuntimePlan({
    requestId: 'r6',
    providerId: 'qwen',
    actualModel: 'qwen3-coder',
    config: {
      enabled: true,
      mode: 'force',
      clientAdapterId: 'standard-openai-tools',
      diagnosticsEnabled: false,
      advanced: { promptPreviewEnabled: false },
    },
    clientRequest: {
      clientAdapterId: 'standard-openai-tools',
      toolSource: 'openai',
      tools: [],
      toolChoice: { mode: 'auto' },
      diagnostics: { rawToolCount: 0, normalizedToolNames: [] },
    },
    toolSessionKey: 'runtime-plan-reuse',
    messages: [
      {
        role: 'assistant',
        content: null as any,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather-test:get_weather', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
      { role: 'user', content: 'next turn' },
    ],
  })

  assert.equal(first.catalogSnapshot?.fingerprint, second.catalogSnapshot?.fingerprint)
  assert.equal(second.catalogDiagnostics.source, 'session_catalog')
  assert.deepEqual(second.tools.map((tool) => tool.name), ['weather-test:get_weather'])
})

test('forced tool selection uses session catalog when the current turn omits tools', () => {
  buildToolCallingRuntimePlan({
    requestId: 'r6-seed',
    providerId: 'qwen',
    actualModel: 'qwen3-coder',
    config: {
      enabled: true,
      mode: 'force',
      clientAdapterId: 'standard-openai-tools',
      diagnosticsEnabled: false,
      advanced: { promptPreviewEnabled: false },
    },
    clientRequest: {
      clientAdapterId: 'standard-openai-tools',
      toolSource: 'openai',
      tools,
      toolChoice: { mode: 'auto' },
      diagnostics: { rawToolCount: 1, normalizedToolNames: ['weather-test:get_weather'] },
    },
    toolSessionKey: 'runtime-plan-forced-reuse',
    messages: [{ role: 'user', content: 'first turn' }],
  })

  const forcedPlan = buildToolCallingRuntimePlan({
    requestId: 'r6-forced',
    providerId: 'qwen',
    actualModel: 'qwen3-coder',
    config: {
      enabled: true,
      mode: 'force',
      clientAdapterId: 'standard-openai-tools',
      diagnosticsEnabled: false,
      advanced: { promptPreviewEnabled: false },
    },
    clientRequest: {
      clientAdapterId: 'standard-openai-tools',
      toolSource: 'openai',
      tools: [],
      toolChoice: { mode: 'forced', forcedName: 'weather-test:get_weather' },
      diagnostics: { rawToolCount: 0, normalizedToolNames: [] },
    },
    toolSessionKey: 'runtime-plan-forced-reuse',
    messages: [
      {
        role: 'assistant',
        content: null as any,
        tool_calls: [{ id: 'call_forced', type: 'function', function: { name: 'weather-test:get_weather', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_forced', content: 'sunny' },
      { role: 'user', content: 'next turn' },
    ],
  })

  assert.equal(forcedPlan.mode, 'managed')
  assert.equal(forcedPlan.catalogDiagnostics.source, 'session_catalog')
  assert.deepEqual([...forcedPlan.allowedToolNames], ['weather-test:get_weather'])
  assert.deepEqual(forcedPlan.tools.map((tool) => tool.name), ['weather-test:get_weather'])
})

test('managed history without catalog throws instead of degrading to a disabled passthrough plan', () => {
  assert.throws(() => buildToolCallingRuntimePlan({
    requestId: 'r7',
    providerId: 'qwen',
    actualModel: 'qwen3-coder',
    config: {
      enabled: true,
      mode: 'force',
      clientAdapterId: 'standard-openai-tools',
      diagnosticsEnabled: false,
      advanced: { promptPreviewEnabled: false },
    },
    clientRequest: {
      clientAdapterId: 'standard-openai-tools',
      toolSource: 'openai',
      tools: [],
      toolChoice: { mode: 'auto' },
      diagnostics: { rawToolCount: 0, normalizedToolNames: [] },
    },
    messages: [
      {
        role: 'assistant',
        content: null as any,
        tool_calls: [{ id: 'call_legacy', type: 'function', function: { name: 'weather-test:get_weather', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_legacy', content: 'legacy result' },
      { role: 'user', content: 'continue' },
    ],
  }), /managed_history_requires_catalog|tool_catalog_blocked/)
})

test('assistant managed xml content without a catalog also blocks instead of degrading to no_tools', () => {
  assert.throws(() => buildToolCallingRuntimePlan({
    requestId: 'r8',
    providerId: 'qwen',
    actualModel: 'qwen3-coder',
    config: {
      enabled: true,
      mode: 'force',
      clientAdapterId: 'standard-openai-tools',
      diagnosticsEnabled: false,
      advanced: { promptPreviewEnabled: false },
    },
    clientRequest: {
      clientAdapterId: 'standard-openai-tools',
      toolSource: 'none',
      tools: [],
      toolChoice: { mode: 'auto' },
      diagnostics: { rawToolCount: 0, normalizedToolNames: [] },
    },
    messages: [{
      role: 'assistant',
      content: '<|CHAT2API|tool_calls><|CHAT2API|invoke name="bash"></|CHAT2API|tool_calls>' as any,
    }],
  }), /managed_history_requires_catalog|tool_catalog_blocked/)
})
