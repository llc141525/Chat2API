import test from 'node:test'
import assert from 'node:assert/strict'

import { buildToolCallingRuntimePlan } from '../../src/main/proxy/toolCalling/runtimePlan.ts'

test('managed prompt injected but no tools available and no history names degrades to disabled', () => {
  const plan = buildToolCallingRuntimePlan({
    requestId: 'degrade-1',
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
      { role: 'system', content: '## Available Tools\nYou can use tools.' },
      { role: 'user', content: 'continue' },
    ],
  })

  assert.equal(plan.mode, 'disabled')
  assert.equal(plan.shouldInjectPrompt, false)
  assert.equal(plan.shouldParseResponse, false)
  assert.equal(plan.diagnostics.reason, 'no_tools_with_managed_history')
})

test('tool result message with system tool prompt but no extractable names degrades', () => {
  const plan = buildToolCallingRuntimePlan({
    requestId: 'degrade-2',
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
      { role: 'system', content: '## Available Tools' },
      { role: 'tool', tool_call_id: 'call_123', content: 'result data' },
      { role: 'user', content: 'continue' },
    ],
  })

  assert.equal(plan.mode, 'disabled')
  assert.equal(plan.shouldInjectPrompt, false)
  assert.equal(plan.diagnostics.reason, 'no_tools_with_managed_history')
})

test('repeated tool name extraction from managed XML invocations is deterministic', () => {
  const baseConfig = {
    providerId: 'qwen' as const,
    actualModel: 'qwen3-coder',
    config: {
      enabled: true,
      mode: 'force' as const,
      clientAdapterId: 'standard-openai-tools' as const,
      diagnosticsEnabled: false,
      advanced: { promptPreviewEnabled: false },
    },
    clientRequest: {
      clientAdapterId: 'standard-openai-tools' as const,
      toolSource: 'openai' as const,
      tools: [] as any[],
      toolChoice: { mode: 'auto' as const },
      diagnostics: { rawToolCount: 0, normalizedToolNames: [] as string[] },
    },
    messages: [
      {
        role: 'assistant' as const,
        content: [
          '<|CHAT2API|tool_calls>',
          '<|CHAT2API|invoke name="bash"><|CHAT2API|parameter name="cmd">ls</|CHAT2API|parameter></|CHAT2API|invoke>',
          '<|CHAT2API|invoke name="write"><|CHAT2API|parameter name="path">/tmp/a</|CHAT2API|parameter></|CHAT2API|invoke>',
          '</|CHAT2API|tool_calls>',
        ].join(''),
      },
      { role: 'user', content: 'continue' },
    ],
  }

  const results: string[][] = []
  for (let i = 0; i < 20; i++) {
    const plan = buildToolCallingRuntimePlan({ ...baseConfig, requestId: `regex-repeat-${i}` })
    results.push([...plan.allowedToolNames].sort())
  }

  const first = JSON.stringify(results[0])
  for (const r of results.slice(1)) {
    assert.equal(JSON.stringify(r), first, 'Repeated tool name extraction must yield identical results')
  }
})

test('no tools and no managed history returns no_tools disabled plan', () => {
  const plan = buildToolCallingRuntimePlan({
    requestId: 'degrade-3',
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
      tools: [],
      toolChoice: { mode: 'auto' },
      diagnostics: { rawToolCount: 0, normalizedToolNames: [] },
    },
    messages: [{ role: 'user', content: 'hello' }],
  })

  assert.equal(plan.mode, 'disabled')
  assert.equal(plan.diagnostics.reason, 'no_tools')
  assert.equal(plan.shouldInjectPrompt, false)
})
