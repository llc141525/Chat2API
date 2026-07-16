import test from 'node:test'
import assert from 'node:assert/strict'

import { planToolExecution } from '../../../src/main/proxy/toolRuntime/control/index.ts'
import type { ChatCompletionRequest } from '../../../src/main/proxy/types.ts'
import type { ProviderToolProfile } from '../../../src/main/proxy/toolCalling/providerProfiles.ts'
import type { NormalizedClientToolRequest } from '../../../src/main/proxy/toolCalling/clientAdapters/types.ts'
import type { NormalizedToolDefinition } from '../../../src/main/proxy/toolCalling/types.ts'
import type { ToolCallingConfig } from '../../../src/shared/toolCalling.ts'

const baseConfig: ToolCallingConfig = {
  enabled: true,
  mode: 'auto',
  clientAdapterId: 'standard-openai-tools',
  diagnosticsEnabled: false,
  advanced: { promptPreviewEnabled: false },
}

const bashTool: NormalizedToolDefinition = {
  name: 'bash',
  description: 'Run a shell command',
  parameters: {
    type: 'object',
    properties: {
      argument: { type: 'string' },
    },
    required: ['argument'],
  },
  source: 'openai',
}

const managedProfile: ProviderToolProfile = {
  providerId: 'qwen',
  managedSupport: true,
  supportsNativeTools: false,
  preferredManagedProtocol: 'managed_xml',
  formatAssistantToolCalls: () => '',
  formatToolResult: () => '',
}

const nativeProfile: ProviderToolProfile = {
  ...managedProfile,
  providerId: 'native-provider',
  managedSupport: false,
  supportsNativeTools: true,
}

function request(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: 'qwen-test',
    messages: [{ role: 'user', content: 'use a tool' }],
    stream: false,
    ...overrides,
  }
}

function clientRequest(
  overrides: Partial<NormalizedClientToolRequest> = {},
): NormalizedClientToolRequest {
  const tools = overrides.tools ?? [bashTool]

  return {
    clientAdapterId: 'standard-openai-tools',
    toolSource: tools.length > 0 ? 'openai' : 'none',
    tools,
    toolChoice: { mode: 'auto' },
    diagnostics: {
      rawToolCount: tools.length,
      normalizedToolNames: tools.map((tool) => tool.name),
    },
    ...overrides,
  }
}

test('disabled config selects disabled passthrough', () => {
  const plan = planToolExecution({
    request: request(),
    providerProfile: managedProfile,
    clientToolRequest: clientRequest(),
    config: { ...baseConfig, enabled: false, mode: 'off' },
    requestId: 'r-disabled',
    actualModel: 'qwen-web',
  })

  assert.equal(plan.profile, 'disabled_passthrough')
  assert.equal(plan.protocol, null)
  assert.deepEqual(plan.allowedToolNames, [])
  assert.equal(plan.diagnostics.reason, 'tool_calling_disabled')
  assert.equal(plan.diagnostics.mode, 'disabled')
})

test('tool choice none selects disabled passthrough', () => {
  const plan = planToolExecution({
    request: request(),
    providerProfile: managedProfile,
    clientToolRequest: clientRequest({ toolChoice: { mode: 'none' } }),
    config: baseConfig,
  })

  assert.equal(plan.profile, 'disabled_passthrough')
  assert.equal(plan.protocol, null)
  assert.equal(plan.diagnostics.reason, 'tool_choice_none')
})

test('native provider with tools selects native passthrough', () => {
  const plan = planToolExecution({
    request: request({ stream: true }),
    providerProfile: nativeProfile,
    clientToolRequest: clientRequest(),
    config: baseConfig,
  })

  assert.equal(plan.profile, 'native_passthrough')
  assert.equal(plan.protocol, null)
  assert.deepEqual(plan.allowedToolNames, ['bash'])
  assert.equal(plan.diagnostics.reason, 'provider_native_tools')
})

test('managed provider with tools selects managed buffered structural', () => {
  const plan = planToolExecution({
    request: request({ stream: true }),
    providerProfile: managedProfile,
    clientToolRequest: clientRequest(),
    config: baseConfig,
    requestId: 'r-managed',
    actualModel: 'qwen-web',
  })

  assert.equal(plan.profile, 'managed_buffered_structural')
  assert.equal(plan.protocol, 'managed_xml')
  assert.deepEqual(plan.allowedToolNames, ['bash'])
  assert.equal(plan.diagnostics.requestId, 'r-managed')
  assert.equal(plan.diagnostics.providerId, 'qwen')
  assert.equal(plan.diagnostics.model, 'qwen-test')
  assert.equal(plan.diagnostics.actualModel, 'qwen-web')
  assert.equal(plan.diagnostics.reason, 'provider_managed_tools')
})

test('forced tool choice restricts allowed tools', () => {
  const secondTool: NormalizedToolDefinition = {
    ...bashTool,
    name: 'read_file',
  }

  const plan = planToolExecution({
    request: request(),
    providerProfile: managedProfile,
    clientToolRequest: clientRequest({
      tools: [bashTool, secondTool],
      toolChoice: { mode: 'forced', forcedName: 'read_file' },
    }),
    config: baseConfig,
  })

  assert.equal(plan.profile, 'managed_buffered_structural')
  assert.deepEqual(plan.allowedToolNames, ['read_file'])
  assert.equal(plan.forcedToolName, 'read_file')
  assert.equal(plan.diagnostics.forcedToolName, 'read_file')
})

test('forced missing tool is rejected before provider call', () => {
  assert.throws(() => planToolExecution({
    request: request(),
    providerProfile: managedProfile,
    clientToolRequest: clientRequest({
      toolChoice: { mode: 'forced', forcedName: 'missing_tool' },
    }),
    config: baseConfig,
  }), /Forced tool missing_tool is not declared/)
})

test('no tools and no managed context selects disabled passthrough', () => {
  const plan = planToolExecution({
    request: request({ messages: [{ role: 'user', content: 'hello' }] }),
    providerProfile: managedProfile,
    clientToolRequest: clientRequest({ tools: [] }),
    config: baseConfig,
  })

  assert.equal(plan.profile, 'disabled_passthrough')
  assert.equal(plan.protocol, null)
  assert.equal(plan.diagnostics.reason, 'no_tools_or_managed_context')
})

test('no tools but assistant tool_calls context selects managed buffered structural', () => {
  const plan = planToolExecution({
    request: request({
      messages: [{
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'bash', arguments: '{"argument":"pwd"}' },
        }],
      }],
    }),
    providerProfile: managedProfile,
    clientToolRequest: clientRequest({ tools: [] }),
    config: baseConfig,
  })

  assert.equal(plan.profile, 'managed_buffered_structural')
  assert.equal(plan.protocol, 'managed_xml')
  assert.deepEqual(plan.allowedToolNames, [])
  assert.equal(plan.diagnostics.reason, 'existing_managed_tool_context')
})

test('no tools but system managed prompt signature selects managed buffered structural', () => {
  const plan = planToolExecution({
    request: request({
      messages: [{
        role: 'system',
        content: '## Available Tools\nYou can invoke the following developer tools.',
      }],
    }),
    providerProfile: managedProfile,
    clientToolRequest: clientRequest({ tools: [] }),
    config: baseConfig,
  })

  assert.equal(plan.profile, 'managed_buffered_structural')
  assert.equal(plan.protocol, 'managed_xml')
  assert.equal(plan.diagnostics.reason, 'existing_managed_tool_context')
})
