import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolCallingEngine } from '../../src/main/proxy/toolCalling/ToolCallingEngine.ts'
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
  })

  assert.equal(result.plan.mode, 'managed')
  assert.equal(result.plan.protocol, 'managed_xml')
  assert.equal(result.plan.shouldInjectPrompt, true)
  assert.equal(result.tools, undefined)
  assert.equal(result.plan.tools.length, 2)
  assert.match(result.messages[0].content as string, /<\|CHAT2API\|tool_calls>/)
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
  assert.equal(result.plan.tools[0].name, 'default_api:read_file')
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
  })

  assert.equal(result.plan.toolChoiceMode, 'required')
  assert.deepEqual([...result.plan.allowedToolNames].sort(), ['default_api:list_dir', 'default_api:read_file'])
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

test('ToolCallingEngine non-stream repairs mixed protocol output before tool_calls', () => {
  const qwenProvider = {
    id: 'qwen',
    name: 'Qwen',
    type: 'builtin',
    authType: 'token',
    apiEndpoint: '',
    headers: {},
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  } as Provider
  const engine = new ToolCallingEngine({
    enabled: true,
    mode: 'force',
    clientAdapterId: 'standard-openai-tools',
    diagnosticsEnabled: false,
    advanced: { promptPreviewEnabled: false },
  })

  const transform = engine.transformRequest({
    request: {
      model: 'qwen-test',
      messages: [{ role: 'user', content: 'list files' }],
      tools: [{
        type: 'function',
        function: {
          name: 'bash',
          parameters: {
            type: 'object',
            properties: { argument: { type: 'string' } },
            required: ['argument'],
          },
        },
      }],
    },
    provider: qwenProvider,
    actualModel: 'qwen-test',
  })

  const response: any = {
    choices: [{
      message: {
        role: 'assistant',
        content: '<|CHAT2API|tool_calls><|CHAT2API|invoke name="bash"><|CHAT2API|parameter name="argument"><![CDATA[pwd]]></arg_value></tool_call>',
      },
      finish_reason: 'stop',
    }],
  }

  engine.applyNonStreamResponse(response, transform.plan)

  assert.equal(response.choices[0].message.content, null)
  assert.equal(response.choices[0].finish_reason, 'tool_calls')
  assert.equal(response.choices[0].message.tool_calls[0].function.name, 'bash')
  assert.equal(response.choices[0].message.tool_calls[0].function.arguments, '{"argument":"pwd"}')
})

test('ToolCallingEngine non-stream blocks malformed unknown tool output', () => {
  const qwenProvider = {
    id: 'qwen',
    name: 'Qwen',
    type: 'builtin',
    authType: 'token',
    apiEndpoint: '',
    headers: {},
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  } as Provider
  const engine = new ToolCallingEngine({ mode: 'force' })
  const transform = engine.transformRequest({
    request: {
      model: 'qwen-test',
      messages: [{ role: 'user', content: 'list files' }],
      tools: [{
        type: 'function',
        function: {
          name: 'bash',
          parameters: {
            type: 'object',
            properties: { argument: { type: 'string' } },
            required: ['argument'],
          },
        },
      }],
    },
    provider: qwenProvider,
    actualModel: 'qwen-test',
  })

  const response: any = {
    choices: [{
      message: {
        role: 'assistant',
        content: '<|CHAT2API|tool_calls><|CHAT2API|invoke name="python"><|CHAT2API|parameter name="argument"><![CDATA[pwd]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
      },
      finish_reason: 'stop',
    }],
  }

  engine.applyNonStreamResponse(response, transform.plan)

  assert.equal(response.choices[0].message.tool_calls, undefined)
  assert.equal(response.choices[0].message.content, '<|CHAT2API|tool_calls><|CHAT2API|invoke name="python"><|CHAT2API|parameter name="argument"><![CDATA[pwd]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>')
  assert.equal(transform.plan.diagnostics.parsedToolCallCount, 0)
  assert.equal(transform.plan.diagnostics.malformedReason, 'unknown_tool_name')
})
