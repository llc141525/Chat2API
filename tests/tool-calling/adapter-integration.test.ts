import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolCallingEngine } from '../../src/main/proxy/toolCalling/ToolCallingEngine.ts'
import type { ChatCompletionRequest } from '../../src/main/proxy/types.ts'
import type { Provider } from '../../src/main/store/types.ts'

function makeProvider(id: string): Provider {
  return {
    id,
    name: id,
    type: 'builtin',
    authType: 'userToken',
    apiEndpoint: 'https://api.example.com',
    headers: {},
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  } as Provider
}

const readFileTool = {
  type: 'function' as const,
  function: {
    name: 'read_file',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  },
}

const writeFileTool = {
  type: 'function' as const,
  function: {
    name: 'write_file',
    description: 'Write a file',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
  },
}

function request(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: 'default-model',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [readFileTool, writeFileTool],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function assertToolPromptInjected(messages: ChatCompletionRequest['messages'], toolNames: string[]): void {
  const allContent = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
  assert.ok(allContent.includes('## Available Tools'), 'Expected tool prompt header')
  assert.ok(allContent.includes('Tool Contract Header'), 'Expected tool contract header')
  assert.ok(allContent.includes('catalog_fingerprint:'), 'Expected catalog fingerprint in prompt')
  for (const name of toolNames) {
    assert.ok(allContent.includes(name), `Expected tool "${name}" in prompt`)
  }
}

function assertNoToolPromptInjected(messages: ChatCompletionRequest['messages']): void {
  const allContent = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
  assert.ok(!allContent.includes('## Available Tools'), 'Tool prompt should NOT be present')
}

function makeMultiTurnMessages(): ChatCompletionRequest['messages'] {
  return [
    { role: 'system', content: 'You are a helpful assistant.' },
    {
      role: 'assistant',
      content: null as any,
      tool_calls: [
        { id: 'call_m1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/tmp/a"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_m1', content: 'file content' },
    { role: 'user', content: 'now write it' },
  ]
}

// ---------------------------------------------------------------------------
// Test cases per adapter
// ---------------------------------------------------------------------------

// -- GLM --

test('GLM adapter injects tool prompt for first turn with tools', () => {
  const engine = new ToolCallingEngine()
  const result = engine.transformRequest({
    request: request(),
    provider: makeProvider('glm'),
    actualModel: 'glm-5',
    requestId: 'glm-first',
  })

  assert.equal(result.plan.mode, 'managed')
  assert.equal(result.plan.protocol, 'managed_xml')
  assertToolPromptInjected(result.messages, ['read_file', 'write_file'])
})

test('GLM adapter restores tools from history on second turn without tools', () => {
  const engine = new ToolCallingEngine()
  const first = engine.transformRequest({
    request: request({ messages: [{ role: 'user', content: 'read a file' }] }),
    provider: makeProvider('glm'),
    actualModel: 'glm-5',
    requestId: 'glm-second',
  })

  const second = engine.transformRequest({
    request: request({
      tools: undefined,
      messages: makeMultiTurnMessages(),
    }),
    provider: makeProvider('glm'),
    actualModel: 'glm-5',
    toolSessionKey: 'glm-second',
  })

  assert.equal(second.plan.mode, 'managed')
  assert.equal(second.plan.catalogDiagnostics.source, 'session_catalog')
  assert.equal(second.plan.catalogSnapshot?.fingerprint, first.plan.catalogSnapshot?.fingerprint)
  assertToolPromptInjected(second.messages, ['read_file', 'write_file'])
})

test('GLM adapter session miss falls back to history', () => {
  const engine = new ToolCallingEngine()
  const result = engine.transformRequest({
    request: request({
      tools: undefined,
      messages: makeMultiTurnMessages(),
    }),
    provider: makeProvider('glm'),
    actualModel: 'glm-5',
    requestId: 'glm-session-miss',
  })

  assert.equal(result.plan.mode, 'managed')
  assert.equal(result.plan.catalogDiagnostics.source, 'restored_from_history')
  assert.ok([...result.plan.allowedToolNames].includes('read_file'))
})

// -- Qwen --

test('Qwen adapter injects tool prompt for first turn with tools', () => {
  const engine = new ToolCallingEngine()
  const result = engine.transformRequest({
    request: request(),
    provider: makeProvider('qwen'),
    actualModel: 'qwen3-coder',
    requestId: 'qwen-first',
  })

  assert.equal(result.plan.mode, 'managed')
  assert.ok(result.plan.diagnostics.reason.startsWith('managed_'))
  assertToolPromptInjected(result.messages, ['read_file', 'write_file'])
})

test('Qwen adapter restores tools from session on second turn', () => {
  const engine = new ToolCallingEngine()
  const first = engine.transformRequest({
    request: request({ messages: [{ role: 'user', content: 'first' }] }),
    provider: makeProvider('qwen'),
    actualModel: 'qwen3-coder',
    requestId: 'qwen-second',
  })

  const second = engine.transformRequest({
    request: request({
      tools: undefined,
      messages: makeMultiTurnMessages(),
    }),
    provider: makeProvider('qwen'),
    actualModel: 'qwen3-coder',
    toolSessionKey: 'qwen-second',
  })

  assert.equal(second.plan.mode, 'managed')
  assert.equal(second.plan.catalogDiagnostics.source, 'session_catalog')
  assert.equal(second.plan.catalogSnapshot?.fingerprint, first.plan.catalogSnapshot?.fingerprint)
})

test('Qwen adapter session miss restores from history', () => {
  const engine = new ToolCallingEngine()
  const result = engine.transformRequest({
    request: request({
      tools: undefined,
      messages: makeMultiTurnMessages(),
    }),
    provider: makeProvider('qwen'),
    actualModel: 'qwen3-coder',
    requestId: 'qwen-session-miss',
  })

  assert.equal(result.plan.mode, 'managed')
  assert.equal(result.plan.catalogDiagnostics.source, 'restored_from_history')
  assert.ok([...result.plan.allowedToolNames].includes('read_file'))
})

// -- MiniMax --

test('MiniMax adapter injects managed tool prompt', () => {
  const engine = new ToolCallingEngine()
  const result = engine.transformRequest({
    request: request(),
    provider: makeProvider('minimax'),
    actualModel: 'minimax-pro',
    requestId: 'minimax-first',
  })

  assert.equal(result.plan.mode, 'managed')
  assertToolPromptInjected(result.messages, ['read_file', 'write_file'])
})

test('MiniMax adapter session miss restores from tool history', () => {
  const engine = new ToolCallingEngine()
  const result = engine.transformRequest({
    request: request({
      tools: undefined,
      messages: makeMultiTurnMessages(),
    }),
    provider: makeProvider('minimax'),
    actualModel: 'minimax-pro',
    requestId: 'minimax-session-miss',
  })

  assert.equal(result.plan.mode, 'managed')
  assert.equal(result.plan.catalogDiagnostics.source, 'restored_from_history')
})

// -- Kimi --

test('Kimi adapter injects managed tool prompt', () => {
  const engine = new ToolCallingEngine()
  const result = engine.transformRequest({
    request: request(),
    provider: makeProvider('kimi'),
    actualModel: 'kimi-k2',
    requestId: 'kimi-first',
  })

  assert.equal(result.plan.mode, 'managed')
  assertToolPromptInjected(result.messages, ['read_file', 'write_file'])
})

test('Kimi adapter session miss restores from tool history', () => {
  const engine = new ToolCallingEngine()
  const result = engine.transformRequest({
    request: request({
      tools: undefined,
      messages: makeMultiTurnMessages(),
    }),
    provider: makeProvider('kimi'),
    actualModel: 'kimi-k2',
    requestId: 'kimi-session-miss',
  })

  assert.equal(result.plan.mode, 'managed')
  assert.equal(result.plan.catalogDiagnostics.source, 'restored_from_history')
})

// -- DeepSeek --

test('DeepSeek adapter injects managed tool prompt', () => {
  const engine = new ToolCallingEngine()
  const result = engine.transformRequest({
    request: request(),
    provider: makeProvider('deepseek'),
    actualModel: 'deepseek-chat',
    requestId: 'deepseek-first',
  })

  assert.equal(result.plan.mode, 'managed')
  assertToolPromptInjected(result.messages, ['read_file', 'write_file'])
})

test('DeepSeek adapter session miss restores from tool history', () => {
  const engine = new ToolCallingEngine()
  const result = engine.transformRequest({
    request: request({
      tools: undefined,
      messages: makeMultiTurnMessages(),
    }),
    provider: makeProvider('deepseek'),
    actualModel: 'deepseek-chat',
    requestId: 'deepseek-session-miss',
  })

  assert.equal(result.plan.mode, 'managed')
  assert.equal(result.plan.catalogDiagnostics.source, 'restored_from_history')
})

// -- Provider-agnostic scenarios --

test('no tools and no managed history produces disabled plan for any provider', () => {
  const engine = new ToolCallingEngine()
  const result = engine.transformRequest({
    request: request({
      tools: undefined,
      messages: [{ role: 'user', content: 'no tools' }],
    }),
    provider: makeProvider('glm'),
    actualModel: 'glm-5',
    requestId: 'no-tools-all',
  })

  assert.equal(result.plan.mode, 'disabled')
  assert.equal(result.plan.shouldInjectPrompt, false)
})

test('tool_choice "none" disables managed mode for all providers', () => {
  const engine = new ToolCallingEngine()
  const result = engine.transformRequest({
    request: request({ tool_choice: 'none' as any }),
    provider: makeProvider('qwen'),
    actualModel: 'qwen3-coder',
    requestId: 'tool-choice-none',
  })

  assert.equal(result.plan.mode, 'disabled')
  assertNoToolPromptInjected(result.messages)
})

test('second turn without tools reuses catalog fingerprint when session is present', () => {
  const engine = new ToolCallingEngine()
  const first = engine.transformRequest({
    request: request({ messages: [{ role: 'user', content: 'first' }] }),
    provider: makeProvider('deepseek'),
    actualModel: 'deepseek-chat',
    requestId: 'fingerprint-reuse',
  })

  const second = engine.transformRequest({
    request: request({
      tools: undefined,
      messages: makeMultiTurnMessages(),
    }),
    provider: makeProvider('deepseek'),
    actualModel: 'deepseek-chat',
    toolSessionKey: 'fingerprint-reuse',
  })

  assert.equal(second.plan.mode, 'managed')
  assert.equal(second.plan.catalogDiagnostics.source, 'session_catalog')
  assert.equal(second.plan.catalogSnapshot?.fingerprint, first.plan.catalogSnapshot?.fingerprint)
})

test('non-stream response parsing extracts tool_calls from managed XML', () => {
  const engine = new ToolCallingEngine()
  const result = engine.transformRequest({
    request: request(),
    provider: makeProvider('qwen'),
    actualModel: 'qwen3-coder',
    requestId: 'non-stream-parse',
  })

  const mockResponse = {
    choices: [{
      message: {
        content: [
          '<|CHAT2API|tool_calls>',
          '<|CHAT2API|invoke name="read_file"><|CHAT2API|parameter name="path">/tmp/a</|CHAT2API|parameter></|CHAT2API|invoke>',
          '</|CHAT2API|tool_calls>',
        ].join(''),
        role: 'assistant' as const,
      },
      finish_reason: 'stop',
    }],
  }

  const retry = engine.applyNonStreamResponse(mockResponse, result.plan)
  const message = mockResponse.choices[0].message

  assert.equal(retry, undefined)
  assert.equal(message.content, null)
  assert.ok(message.tool_calls !== undefined)
  assert.equal(message.tool_calls.length, 1)
  assert.equal(message.tool_calls[0].function.name, 'read_file')
  assert.equal(mockResponse.choices[0].finish_reason, 'tool_calls')
})
