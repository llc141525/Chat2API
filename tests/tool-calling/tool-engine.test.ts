import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolCallingEngine } from '../../src/main/proxy/toolCalling/ToolCallingEngine.ts'
import { inspectNonStreamAssistantOutput } from '../../src/main/proxy/toolCalling/outputInspection.ts'
import type { ChatCompletionRequest } from '../../src/main/proxy/types.ts'
import type { Provider } from '../../src/main/store/types.ts'

const provider = {
  id: 'deepseek',
  name: 'DeepSeek',
  type: 'builtin',
  authType: 'userToken',
  apiEndpoint: 'https://chat.deepseek.com',
  headers: {},
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
} as Provider

const tools = [
  {
    type: 'function' as const,
    function: {
      name: 'default_api:read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { filePath: { type: 'string' } } },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'default_api:list_dir',
      description: 'List a directory',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  },
]

function request(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'read /tmp/a' }],
    tools,
    ...overrides,
  }
}

test('OpenAI tools plus DeepSeek choose managed prompt', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: 'engine-stage2-openai-tools',
  })

  assert.equal(result.plan.mode, 'managed')
  assert.equal(result.plan.protocol, 'managed_xml')
  assert.equal(result.plan.shouldInjectPrompt, true)
  assert.equal(result.tools, undefined)
  assert.equal(result.plan.tools.length, 2)
  // Tool contract lives in toolManifest.renderedPrompt, not in messages
  assert.ok(result.toolManifest, 'toolManifest should be present')
  assert.match(result.toolManifest!.renderedPrompt, /<\|CHAT2API\|tool_calls>/)
})

test('managed prompt includes Tool Contract Header from catalog snapshot', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: `engine-catalog-${Date.now()}-header`,
  })

  assert.ok(result.toolManifest, 'toolManifest should be present')
  assert.ok(result.plan.catalogSnapshot, 'catalogSnapshot should be present')
  assert.equal(typeof result.plan.catalogSnapshot?.fingerprint, 'string')
})

test('explicit Cherry Studio MCP adapter uses managed prompt and preserves tool names', () => {
  const result = new ToolCallingEngine({ clientAdapterId: 'cherry-studio-mcp' }).transformRequest({
    request: request({
      messages: [
        { role: 'system', content: 'In this environment you have access to a set of tools' },
        { role: 'user', content: 'read /tmp/a' },
      ],
    }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.clientAdapterId, 'cherry-studio-mcp')
  assert.equal(result.plan.mode, 'managed')
  assert.equal(result.plan.shouldInjectPrompt, true)
  assert.deepEqual(result.plan.tools.map((tool) => tool.name), ['default_api:list_dir', 'default_api:read_file'])
  assert.equal(result.plan.tools[0].source, 'mcp')
})

test('client prompt signatures do not override selected adapter', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({
      messages: [
        { role: 'system', content: 'You are Kilo, the best coding agent. Tool definitions:' },
        { role: 'user', content: 'read /tmp/a' },
      ],
    }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.clientAdapterId, 'standard-openai-tools')
  assert.equal(result.plan.mode, 'managed')
  assert.equal(result.plan.shouldInjectPrompt, true)
})

test('No tools choose disabled', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({ tools: undefined }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.mode, 'disabled')
  assert.equal(result.plan.shouldInjectPrompt, false)
})

test('Store mode off chooses disabled', () => {
  const result = new ToolCallingEngine({ mode: 'off', enabled: false }).transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.mode, 'disabled')
  assert.equal(result.tools, tools)
})

test('tool_choice none chooses disabled even when tools are present', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({ tool_choice: 'none' }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.mode, 'disabled')
  assert.equal(result.plan.toolChoiceMode, 'none')
})

test('tool_choice required preserves required policy on the plan', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({ tool_choice: 'required' }),
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: 'engine-stage2-required',
  })

  assert.equal(result.plan.toolChoiceMode, 'required')
  assert.deepEqual([...result.plan.allowedToolNames].sort(), ['default_api:list_dir', 'default_api:read_file'])
  assert.equal(result.plan.availabilityRetryAllowed, true)
})

test('tool session key reuses catalog snapshot across omitted-tool turns', () => {
  const engine = new ToolCallingEngine()
  const first = engine.transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: 'engine-stage2-reuse',
  })
  const second = engine.transformRequest({
    request: request({
      tools: undefined,
      messages: [
        {
          role: 'assistant',
          content: null as any,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'default_api:read_file', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'body' },
        { role: 'user', content: 'continue' },
      ],
    }),
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: 'engine-stage2-reuse',
  })

  assert.equal(first.plan.catalogSnapshot?.fingerprint, second.plan.catalogSnapshot?.fingerprint)
  assert.equal(second.plan.catalogDiagnostics.source, 'session_catalog')
  assert.ok(second.toolManifest, 'toolManifest should be present on reuse')
})

test('tool session key keeps the full catalog when a later request sends only a subset of tools', () => {
  const engine = new ToolCallingEngine()
  const sessionKey = 'engine-stage2-subset-reuse'
  const first = engine.transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: sessionKey,
  })

  const second = engine.transformRequest({
    request: {
      model: 'deepseek-chat',
      messages: [
        {
          role: 'assistant',
          content: null as any,
          tool_calls: [{ id: 'call_skill', type: 'function', function: { name: 'default_api:read_file', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call_skill', content: 'body' },
        { role: 'user', content: 'continue' },
      ],
      tools: [tools[0]],
    },
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: sessionKey,
  })

  assert.equal(second.plan.catalogDiagnostics.source, 'session_catalog')
  assert.deepEqual(second.plan.catalogDiagnostics.driftKinds, ['current_request_subset_of_session_catalog'])
  assert.equal(second.plan.catalogSnapshot?.fingerprint, first.plan.catalogSnapshot?.fingerprint)
  assert.deepEqual(second.plan.tools.map((tool) => tool.name), ['default_api:list_dir', 'default_api:read_file'])
  assert.ok(second.toolManifest, 'toolManifest should be present')
  assert.match(second.toolManifest!.renderedPrompt, /default_api:list_dir/)
})

test('requestId falls back as the tool session key for omitted-tool follow-up turns', () => {
  const engine = new ToolCallingEngine()
  const first = engine.transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
    requestId: 'engine-stage2-requestid-reuse',
  })
  const second = engine.transformRequest({
    request: request({
      tools: undefined,
      messages: [
        {
          role: 'assistant',
          content: null as any,
          tool_calls: [{ id: 'call_reqid', type: 'function', function: { name: 'default_api:read_file', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call_reqid', content: 'body' },
        { role: 'user', content: 'continue' },
      ],
    }),
    provider,
    actualModel: 'deepseek-chat',
    requestId: 'engine-stage2-requestid-reuse',
  })

  assert.equal(first.plan.catalogSnapshot?.fingerprint, second.plan.catalogSnapshot?.fingerprint)
  assert.equal(second.plan.catalogDiagnostics.source, 'session_catalog')
  assert.ok(second.toolManifest, 'toolManifest should be present')
})

test('legacy managed xml prompt without a catalog restores default_api:read_file from history', () => {
  const engine = new ToolCallingEngine()

  const result = engine.transformRequest({
    request: request({
      tools: undefined,
      messages: [
        {
          role: 'system',
          content: [
            '<|CHAT2API|tool_calls>',
            '<|CHAT2API|invoke name="default_api:read_file">',
            '<|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter>',
            '</|CHAT2API|invoke>',
            '</|CHAT2API|tool_calls>',
          ].join('\n'),
        },
        { role: 'user', content: 'continue' },
      ],
    }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.mode, 'managed')
})

test('forced function choice narrows allowed tool names to the selected function', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({ tool_choice: { type: 'function', function: { name: 'default_api:list_dir' } } }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.toolChoiceMode, 'forced')
  assert.equal(result.plan.forcedToolName, 'default_api:list_dir')
  assert.deepEqual(result.plan.tools.map((tool) => tool.name), ['default_api:list_dir'])
})

test('forced function choice contract header only exposes the forced tool for this turn', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({ tool_choice: { type: 'function', function: { name: 'default_api:list_dir' } } }),
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: 'engine-stage3-forced-header',
  })

  assert.ok(result.toolManifest, 'toolManifest should be present')
})

test('non-stream parsing only accepts the selected provider protocol', () => {
  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
  })
  const result: any = {
    choices: [{
      message: {
        role: 'assistant',
        content: '[function_calls][call:default_api:read_file]{"filePath":"/tmp/a"}[/call][/function_calls]',
      },
      finish_reason: 'stop',
    }],
  }

  engine.applyNonStreamResponse(result, transformed.plan)

  assert.equal(result.choices[0].message.tool_calls, undefined)
  assert.equal(result.choices[0].message.content, '[function_calls][call:default_api:read_file]{"filePath":"/tmp/a"}[/call][/function_calls]')
})

test('transformRequest returns toolManifest alongside messages for managed prompt', () => {
  const provider = {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'builtin' as const,
    authType: 'token' as const,
    apiEndpoint: '',
    headers: {},
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  }
  const engine = new ToolCallingEngine()
  const result = engine.transformRequest({
    request: request({ tools: [{ type: 'function', function: { name: 'default_api:read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } } }] }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.ok(result.toolManifest, 'toolManifest should be present when shouldInjectPrompt is true')
  assert.equal(result.toolManifest!.protocol, 'managed_xml')
  assert.ok(result.toolManifest!.allowedToolNames.length > 0)
  assert.ok(result.toolManifest!.renderedPrompt.length > 0)
  assert.match(result.toolManifest!.renderedPrompt, /## Available Tools/)
  // Messages are no longer modified — tool contract lives entirely in toolManifest.renderedPrompt
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].content, 'read /tmp/a')
})

test('transformRequest omits toolManifest when injection is skipped', () => {
  const provider = {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'builtin' as const,
    authType: 'token' as const,
    apiEndpoint: '',
    headers: {},
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  }
  const engine = new ToolCallingEngine()
  const result = engine.transformRequest({
    request: { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] },
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.shouldInjectPrompt, false)
  assert.equal(result.toolManifest, undefined)
})

test('toolManifest uses catalogFingerprint from plan snapshot', () => {
  const provider = {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'builtin' as const,
    authType: 'token' as const,
    apiEndpoint: '',
    headers: {},
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  }
  const engine = new ToolCallingEngine()
  const result = engine.transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.shouldInjectPrompt, true)
  // catalogFingerprint matches the plan's snapshot fingerprint
  assert.equal(result.toolManifest!.catalogFingerprint, result.plan.catalogSnapshot?.fingerprint ?? '')
})
