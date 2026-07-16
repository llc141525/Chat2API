import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolStreamParser } from '../../src/main/proxy/toolCalling/ToolStreamParser.ts'
import type { ToolCallingPlan } from '../../src/main/proxy/toolCalling/types.ts'

const tools = [
  {
    name: 'default_api:read_file',
    parameters: {
      type: 'object',
      properties: { filePath: { type: 'string' } },
      required: ['filePath'],
    },
    source: 'openai' as const,
  },
]

const questionTool = {
  name: 'question',
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            header: { type: 'string' },
            options: { type: 'array' },
          },
        },
      },
    },
    required: ['questions'],
  },
  source: 'openai' as const,
}

const todowriteTool = {
  name: 'todowrite',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            status: { type: 'string' },
            priority: { type: 'string' },
          },
          required: ['content', 'status', 'priority'],
        },
      },
    },
    required: ['todos'],
  },
  source: 'openai' as const,
}

const taskTool = {
  name: 'task',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string' },
      prompt: { type: 'string' },
    },
    required: ['description', 'prompt'],
  },
  source: 'openai' as const,
}

const readTool = {
  name: 'read',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string' },
    },
    required: ['filePath'],
  },
  source: 'openai' as const,
}

const globTool = {
  name: 'glob',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      pattern: { type: 'string' },
    },
    required: ['path', 'pattern'],
  },
  source: 'openai' as const,
}

function plan(protocol: ToolCallingPlan['protocol'] = 'managed_xml'): ToolCallingPlan {
  return {
    mode: 'managed',
    protocol,
    clientAdapterId: 'standard-openai-tools',
    providerId: 'deepseek',
    tools,
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(['default_api:read_file']),
    catalogSnapshot: {
      sessionId: 'stream-test-session',
      fingerprint: 'stream-test-fingerprint',
      tools: tools,
      allowedToolNames: ['default_api:read_file'],
      schemaHashes: {},
      source: 'current_request',
      createdTurnIndex: 1,
      updatedTurnIndex: 1,
    },
    catalogDiagnostics: {
      source: 'current_request',
      fingerprint: 'stream-test-fingerprint',
      driftKinds: [],
      blocked: false,
    },
    availabilityRetryAllowed: true,
    contract: {
      turnId: 'stream-test-turn',
      sessionId: 'stream-test-session',
      providerId: 'deepseek',
      model: 'deepseek-chat',
      protocol,
      snapshotFingerprint: 'stream-test-fingerprint',
      tools,
      allowedToolNames: new Set(['default_api:read_file']),
      toolChoiceMode: 'auto',
      shouldInjectPrompt: true,
      shouldParseResponse: true,
      historyMode: 'managed_protocol',
      emptyOutputPolicy: 'diagnose_and_fail',
      toolSourceChain: ['current_request', 'session_catalog', 'message_history', 'safe_empty'],
    },
    diagnostics: {
      clientAdapterId: 'standard-openai-tools',
      providerId: 'deepseek',
      model: 'deepseek-chat',
      actualModel: 'deepseek-chat',
      toolSource: 'openai',
      mode: 'managed',
      protocol,
      toolCount: 1,
      injected: true,
      reason: 'test',
    },
  }
}

function qwenQuestionPlan(): ToolCallingPlan {
  const base = plan('managed_xml')
  return {
    ...base,
    providerId: 'qwen',
    tools: [questionTool],
    allowedToolNames: new Set(['question']),
    catalogSnapshot: {
      ...base.catalogSnapshot!,
      tools: [questionTool],
      allowedToolNames: ['question'],
    },
    contract: {
      ...base.contract,
      providerId: 'qwen',
      tools: [questionTool],
      allowedToolNames: new Set(['question']),
    },
    diagnostics: {
      ...base.diagnostics,
      providerId: 'qwen',
      toolCount: 1,
    },
  }
}

function qwenTodowritePlan(): ToolCallingPlan {
  const base = plan('managed_xml')
  return {
    ...base,
    providerId: 'qwen',
    tools: [todowriteTool],
    allowedToolNames: new Set(['todowrite']),
    catalogSnapshot: {
      ...base.catalogSnapshot!,
      tools: [todowriteTool],
      allowedToolNames: ['todowrite'],
    },
    contract: {
      ...base.contract,
      providerId: 'qwen',
      tools: [todowriteTool],
      allowedToolNames: new Set(['todowrite']),
    },
    diagnostics: {
      ...base.diagnostics,
      providerId: 'qwen',
      toolCount: 1,
    },
  }
}

function qwenTaskPlan(): ToolCallingPlan {
  const base = plan('managed_xml')
  return {
    ...base,
    providerId: 'qwen',
    tools: [taskTool],
    allowedToolNames: new Set(['task']),
    catalogSnapshot: {
      ...base.catalogSnapshot!,
      tools: [taskTool],
      allowedToolNames: ['task'],
    },
    contract: {
      ...base.contract,
      providerId: 'qwen',
      tools: [taskTool],
      allowedToolNames: new Set(['task']),
    },
    diagnostics: {
      ...base.diagnostics,
      providerId: 'qwen',
      toolCount: 1,
    },
  }
}

function qwenFilesystemPlan(): ToolCallingPlan {
  const base = plan('managed_xml')
  return {
    ...base,
    providerId: 'qwen',
    tools: [readTool, globTool],
    allowedToolNames: new Set(['read', 'glob']),
    catalogSnapshot: {
      ...base.catalogSnapshot!,
      tools: [readTool, globTool],
      allowedToolNames: ['read', 'glob'],
    },
    contract: {
      ...base.contract,
      providerId: 'qwen',
      tools: [readTool, globTool],
      allowedToolNames: new Set(['read', 'glob']),
    },
    diagnostics: {
      ...base.diagnostics,
      providerId: 'qwen',
      toolCount: 2,
    },
  }
}

const baseChunk = {
  id: 'chatcmpl_1',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'deepseek-chat',
}

test('bracket marker split across chunks emits a tool call', () => {
  const parser = new ToolStreamParser(plan('managed_bracket'))
  assert.deepEqual(parser.push('[fun', baseChunk), [])
  const chunks = parser.push('ction_calls][call:default_api:read_file]{"filePath":"/tmp/a"}[/call][/function_calls]', baseChunk)

  assert.equal(chunks.at(-1)?.choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
})

test('bracket output is text when XML protocol is selected', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const text = '[function_calls][call:default_api:read_file]{"filePath":"/tmp/a"}[/call][/function_calls]'
  const chunks = parser.push(text, baseChunk)

  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].choices[0].delta.content, text)
})

test('XML marker split across chunks emits a tool call', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  assert.deepEqual(parser.push('<tool_', baseChunk), [])
  const chunks = parser.push('calls><invoke name="default_api:read_file"><parameter name="filePath">/tmp/a</parameter></invoke></tool_calls>', baseChunk)

  assert.equal(chunks.at(-1)?.choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
})

test('Chat2API XML marker split across chunks emits a tool call', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  assert.deepEqual(parser.push('<|CHAT2API|tool_', baseChunk), [])
  const chunks = parser.push('calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath">/tmp/a</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>', baseChunk)

  assert.equal(chunks.at(-1)?.choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
})

test('Chat2API XML split after invoke open keeps buffering until parameters arrive', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const first = parser.push(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file">',
    baseChunk,
  )
  const second = parser.push(
    '<|CHAT2API|parameter name="filePath">/tmp/a</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
    baseChunk,
  )

  assert.deepEqual(first, [])
  assert.equal(parser.hasEmittedToolCall(), true)
  assert.equal(second.at(-1)?.choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
})

test('partial Chat2API start marker is reported as buffered so stream handlers do not leak it', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push('<|CHAT2API|tool_calls', baseChunk)

  assert.deepEqual(chunks, [])
  assert.equal(parser.isBuffering(), true)
})

test('text before tool call is preserved only before tool calling begins', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push('before <tool_calls><invoke name="default_api:read_file"><parameter name="filePath">/tmp/a</parameter></invoke></tool_calls> after', baseChunk)

  assert.equal(chunks[0].choices[0].delta.content, 'before ')
  assert.equal(chunks.some((chunk) => chunk.choices[0].delta.content === ' after'), false)
})

test('invalid tool name is not emitted as a tool call', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push('<tool_calls><invoke name="missing"><parameter name="x">1</parameter></invoke></tool_calls>', baseChunk)

  assert.equal(chunks.some((chunk) => chunk.choices[0].delta.tool_calls), false)
})

test('stream parser rejects allowed tool calls that omit required parameters', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="path">/tmp/a</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
    baseChunk,
  )

  assert.equal(
    chunks.some((chunk) => chunk.choices[0].delta.tool_calls),
    false,
    'A stream tool call with the right tool name but missing required filePath must not be emitted',
  )
  assert.equal(parser.hasEmittedToolCall(), false)
})

test('stream parser rejects standalone invoke that omits required parameters', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push(
    '<|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="path">/tmp/a</|CHAT2API|parameter></|CHAT2API|invoke>',
    baseChunk,
  )

  assert.equal(chunks.some((chunk) => chunk.choices[0].delta.tool_calls), false)
  assert.equal(parser.hasEmittedToolCall(), false)
})

test('fenced code block examples are emitted as text and never as tool calls', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const text = '```xml\n<tool_calls><invoke name="default_api:read_file"><parameter name="filePath">fake</parameter></invoke></tool_calls>\n```'
  const chunks = parser.push(text, baseChunk)

  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].choices[0].delta.content, text)
})

test('ordinary XML-like angle bracket text does not start tool buffering', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const text = 'literal <tag attr="1">value</tag> and escaped &lt;tool_calls&gt;'
  const chunks = parser.push(text, baseChunk)

  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].choices[0].delta.content, text)
  assert.equal(parser.isBuffering(), false)
  assert.equal(parser.hasEmittedToolCall(), false)
})

test('inline key=value Chat2API marker literal remains plain text', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const text = 'chat2api_marker=<|CHAT2API|tool_calls> is data here, not an instruction.'
  const chunks = parser.push(text, baseChunk)

  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].choices[0].delta.content, text)
  assert.equal(parser.isBuffering(), false)
  assert.equal(parser.hasEmittedToolCall(), false)
})

test('inline key=value canonical tool XML literal remains plain text', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const text = 'fake_xml=<tool_calls><invoke name="default_api:read_file"><parameter name="filePath">DO_NOT_CALL</parameter></invoke></tool_calls>'
  const chunks = parser.push(text, baseChunk)

  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].choices[0].delta.content, text)
  assert.equal(parser.isBuffering(), false)
  assert.equal(parser.hasEmittedToolCall(), false)
})

test('XML tool call preserves literal angle brackets in CDATA arguments', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[tests/<literal>/input.txt with <tag>value</tag>]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
    baseChunk,
  )

  const toolCall = chunks.at(-1)?.choices[0].delta.tool_calls[0]
  assert.equal(toolCall.function.name, 'default_api:read_file')
  assert.deepEqual(JSON.parse(toolCall.function.arguments), {
    filePath: 'tests/<literal>/input.txt with <tag>value</tag>',
  })
})

test('GLM pipe-closed XML delimiters are normalized into a managed tool call', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push(
    '<|CHAT2API|tool_calls|><|CHAT2API|invoke name="default_api:read_file"|><|CHAT2API|parameter name="filePath"|><![CDATA[/tmp/a]]></|CHAT2API|parameter|></|CHAT2API|invoke|></|CHAT2API|tool_calls|>',
    {},
  )
  const parsed = parser.flush({})
  const toolChunks = [...chunks, ...parsed].filter(chunk => chunk.choices?.[0]?.delta?.tool_calls)
  assert.equal(toolChunks.length > 0, true)
})

test('Qwen stream repairs question tool call with truncated Chat2API XML tail', () => {
  const parser = new ToolStreamParser(qwenQuestionPlan())
  const payload = '{"question":"Dark mode style?","header":"Dark Mode Style","options":[{"label":"Unified Light","description":"Use the same quiet design language."}]}'

  const first = parser.push(
    `<|CHAT2API|tool_calls><|CHAT2API|invoke name="question"><|CHAT2API|parameter name="questions"><![CDATA[${payload}]]</|CHAT2API|parameter></|`,
    baseChunk,
  )
  assert.deepEqual(first, [])

  const repaired = parser.flush(baseChunk)
  const toolCall = repaired.at(-1)?.choices[0].delta.tool_calls[0]

  assert.equal(toolCall.function.name, 'question')
  assert.deepEqual(JSON.parse(toolCall.function.arguments), { questions: [JSON.parse(payload)] })
  assert.equal(parser.hasEmittedToolCall(), true)
  assert.equal(parser.getObservation().suppressedMalformedToolOutput, false)
})

test('Qwen stream accepts question singleton object for array schema', () => {
  const parser = new ToolStreamParser(qwenQuestionPlan())
  const payload = '{"question":"Dark mode direction?","header":"Dark Mode Direction","options":[{"label":"Unified Light","description":"Keep dark aligned with light."},{"label":"Restrained Dark","description":"Keep dark but reduce glow."}]}'

  const chunks = parser.push(
    `<|CHAT2API|tool_calls><|CHAT2API|invoke name="question"><|CHAT2API|parameter name="questions"><![CDATA[${payload}]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>`,
    baseChunk,
  )

  const toolCall = chunks.at(-1)?.choices[0].delta.tool_calls[0]
  assert.equal(toolCall.function.name, 'question')
  assert.deepEqual(JSON.parse(toolCall.function.arguments), { questions: [JSON.parse(payload)] })
  assert.equal(parser.hasEmittedToolCall(), true)
  assert.equal(parser.getObservation().suppressedMalformedToolOutput, false)
})

test('Qwen stream repairs question object truncated after options array', () => {
  const parser = new ToolStreamParser(qwenQuestionPlan())
  const payload = '{"question":"Dark mode direction?","header":"Dark Mode Style","options":[{"label":"Unified Light","description":"Keep dark aligned with light."},{"label":"Restrained Dark","description":"Keep dark but reduce glow."}], '

  const first = parser.push(
    `<|CHAT2API|tool_calls><|CHAT2API|invoke name="question"><|CHAT2API|parameter name="questions"><![CDATA[${payload}`,
    baseChunk,
  )
  assert.deepEqual(first, [])

  const repaired = parser.flush(baseChunk)
  const toolCall = repaired.at(-1)?.choices[0].delta.tool_calls[0]
  assert.equal(toolCall.function.name, 'question')
  assert.deepEqual(JSON.parse(toolCall.function.arguments), {
    questions: [{
      question: 'Dark mode direction?',
      header: 'Dark Mode Style',
      options: [
        { label: 'Unified Light', description: 'Keep dark aligned with light.' },
        { label: 'Restrained Dark', description: 'Keep dark but reduce glow.' },
      ],
    }],
  })
  assert.equal(parser.hasEmittedToolCall(), true)
  assert.equal(parser.getObservation().suppressedMalformedToolOutput, false)
})

test('Qwen stream repairs todowrite array truncated after complete todo items', () => {
  const parser = new ToolStreamParser(qwenTodowritePlan())
  const completeTodos = [
    { content: 'Update dark mode CSS variables', status: 'in_progress', priority: 'high' },
    { content: 'Remove decorative background animation', status: 'pending', priority: 'high' },
    { content: 'Adjust sidebar and topbar shadows', status: 'pending', priority: 'high' },
  ]
  const payload = `${JSON.stringify(completeTodos).slice(0, -1)}, {"content": "Update tailwind.config.js dark tokens`

  const first = parser.push(
    `<|CHAT2API|tool_calls><|CHAT2API|invoke name="todowrite"><|CHAT2API|parameter name="todos"><![CDATA[${payload}`,
    baseChunk,
  )
  assert.deepEqual(first, [])

  const repaired = parser.flush(baseChunk)
  const toolCall = repaired.at(-1)?.choices[0].delta.tool_calls[0]

  assert.equal(toolCall.function.name, 'todowrite')
  assert.deepEqual(JSON.parse(toolCall.function.arguments), { todos: completeTodos })
  assert.equal(parser.hasEmittedToolCall(), true)
  assert.equal(parser.getObservation().suppressedMalformedToolOutput, false)
})

test('Qwen stream repairs todowrite bare object sequence for array parameter', () => {
  const parser = new ToolStreamParser(qwenTodowritePlan())
  const completeTodos = [
    { content: 'Update dark mode CSS variables', status: 'in_progress', priority: 'high' },
    { content: 'Remove decorative background animation', status: 'pending', priority: 'high' },
    { content: 'Adjust sidebar and topbar shadows', status: 'pending', priority: 'medium' },
  ]
  const payload = `${completeTodos.map((todo) => JSON.stringify(todo)).join(', ')}, {"content": "Verify light mode", "status": "pending", "priori`

  const first = parser.push(
    `<|CHAT2API|tool_calls><|CHAT2API|invoke name="todowrite"><|CHAT2API|parameter name="todos"><![CDATA[${payload}`,
    baseChunk,
  )
  assert.deepEqual(first, [])

  const repaired = parser.flush(baseChunk)
  const toolCall = repaired.at(-1)?.choices[0].delta.tool_calls[0]

  assert.equal(toolCall.function.name, 'todowrite')
  assert.deepEqual(JSON.parse(toolCall.function.arguments), { todos: completeTodos })
  assert.equal(parser.hasEmittedToolCall(), true)
  assert.equal(parser.getObservation().suppressedMalformedToolOutput, false)
})

test('Qwen stream repairs task tool call with malformed parameter opener', () => {
  const parser = new ToolStreamParser(qwenTaskPlan())
  const chunks = parser.push(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="task">'
    + '<|CHAT2API|parameter name="description"><![CDATA[Explore Chat2Api UI codebase]]></|CHAT2API|parameter>'
    + '<parameter=prompt><![CDATA[Thoroughly explore the UI files and summarize findings.]]></parameter>'
    + '</|CHAT2API|invoke></|CHAT2API|tool_calls>',
    baseChunk,
  )

  const toolCall = chunks.at(-1)?.choices[0].delta.tool_calls[0]
  assert.equal(toolCall.function.name, 'task')
  assert.deepEqual(JSON.parse(toolCall.function.arguments), {
    description: 'Explore Chat2Api UI codebase',
    prompt: 'Thoroughly explore the UI files and summarize findings.',
  })
  assert.equal(parser.hasEmittedToolCall(), true)
  assert.equal(parser.getObservation().suppressedMalformedToolOutput, false)
})

test('Qwen malformed parameter opener does not repair unknown parameters', () => {
  const parser = new ToolStreamParser(qwenTaskPlan())
  const chunks = parser.push(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="task">'
    + '<|CHAT2API|parameter name="description"><![CDATA[Explore Chat2Api UI codebase]]></|CHAT2API|parameter>'
    + '<parameter=notPrompt><![CDATA[Do not accept this as prompt.]]></parameter>'
    + '</|CHAT2API|invoke></|CHAT2API|tool_calls>',
    baseChunk,
  )

  assert.equal(chunks.some((chunk) => chunk.choices[0].delta.tool_calls), false)
  assert.equal(parser.hasEmittedToolCall(), false)
  assert.equal(parser.getObservation().suppressedMalformedToolOutput, true)
})

test('Qwen stream repairs multiple read invokes closed as functions into separate tool calls', () => {
  const parser = new ToolStreamParser(qwenFilesystemPlan())
  const first = parser.push(
    '<|CHAT2API|tool_calls>'
    + '<|CHAT2API|invoke name="read"><|CHAT2API|parameter name="filePath">\nE:/Chat2Api/src/renderer/src/App.tsx\n</parameter></function>\n'
    + '<|CHAT2API|invoke name="read"><|CHAT2API|parameter name="filePath">\nE:/Chat2Api/src/renderer/src/pages/Dashboard.tsx\n</parameter></function>\n'
    + '<|CHAT2API|invoke name="read"><|CHAT2API|parameter name="filePath">\nE:/Chat2Api/package.json\n</parameter></function>',
    baseChunk,
  )
  assert.deepEqual(first, [])

  const repaired = parser.flush(baseChunk)
  const toolCalls = repaired.map((chunk) => chunk.choices[0].delta.tool_calls[0])

  assert.equal(toolCalls.length, 3)
  assert.deepEqual(toolCalls.map((call) => call.function.name), ['read', 'read', 'read'])
  assert.deepEqual(toolCalls.map((call) => JSON.parse(call.function.arguments)), [
    { filePath: 'E:/Chat2Api/src/renderer/src/App.tsx' },
    { filePath: 'E:/Chat2Api/src/renderer/src/pages/Dashboard.tsx' },
    { filePath: 'E:/Chat2Api/package.json' },
  ])
  assert.equal(Array.isArray(JSON.parse(toolCalls[0].function.arguments).filePath), false)
  assert.equal(parser.hasEmittedToolCall(), true)
})

test('Qwen stream repairs glob invoke with malformed path opener and function close', () => {
  const parser = new ToolStreamParser(qwenFilesystemPlan())
  const first = parser.push(
    '<|CHAT2API|tool_calls>'
    + '<|CHAT2API|invoke name="glob"><parameter=path><![CDATA[E:/Chat2Api/src/renderer/src]]></parameter>'
    + '<|CHAT2API|parameter name="pattern"><![CDATA[**/*.tsx]]></|CHAT2API|parameter></function>',
    baseChunk,
  )
  assert.deepEqual(first, [])

  const repaired = parser.flush(baseChunk)
  const toolCall = repaired.at(-1)?.choices[0].delta.tool_calls[0]

  assert.equal(toolCall.function.name, 'glob')
  assert.deepEqual(JSON.parse(toolCall.function.arguments), {
    path: 'E:/Chat2Api/src/renderer/src',
    pattern: '**/*.tsx',
  })
  assert.equal(parser.hasEmittedToolCall(), true)
})

test('Qwen function-close repair rejects unknown parameters and missing required parameters', () => {
  const unknownParser = new ToolStreamParser(qwenFilesystemPlan())
  unknownParser.push(
    '<|CHAT2API|tool_calls>'
    + '<|CHAT2API|invoke name="read"><|CHAT2API|parameter name="filePath">E:/Chat2Api/package.json</parameter>'
    + '<parameter=extra>ignored</parameter></function>',
    baseChunk,
  )
  assert.deepEqual(unknownParser.flush(baseChunk), [])
  assert.equal(unknownParser.hasEmittedToolCall(), false)

  const missingParser = new ToolStreamParser(qwenFilesystemPlan())
  missingParser.push(
    '<|CHAT2API|tool_calls>'
    + '<|CHAT2API|invoke name="glob"><parameter=path><![CDATA[E:/Chat2Api/src/renderer/src]]></parameter></function>',
    baseChunk,
  )
  assert.deepEqual(missingParser.flush(baseChunk), [])
  assert.equal(missingParser.hasEmittedToolCall(), false)
})

test('generated call IDs stay stable between emitted chunks and final state', () => {
  const parser = new ToolStreamParser(plan('managed_bracket'))
  const chunks = parser.push('[function_calls][call:default_api:read_file]{"filePath":"/tmp/a"}[/call][/function_calls]', baseChunk)
  const emittedId = chunks.at(-1)?.choices[0].delta.tool_calls[0].id

  assert.equal(parser.hasEmittedToolCall(), true)
  assert.equal(emittedId, 'call_0')
  assert.deepEqual(parser.flush(baseChunk), [])
})

test('stream parser suppresses later plain text after a tool call was emitted', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const first = parser.push(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath">/tmp/a</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
    baseChunk,
  )
  const second = parser.push('|tool_calls>', baseChunk)

  assert.equal(first.at(-1)?.choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
  assert.deepEqual(second, [])
  assert.deepEqual(parser.flush(baseChunk), [])
})

test('stream parser suppresses protocol residue after a malformed tool block', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const malformed = parser.push(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="missing">'
      + '<|CHAT2API|parameter name="filePath"><![CDATA[E:/Chat2API/tailwind.config.js]]></|CHAT2API|parameter>'
      + '</|CHAT2API|invoke></|CHAT2API|tool_calls>',
    baseChunk,
  )

  const residue = parser.push(
    '|CHAT2API|parameter><|CHAT2API|invoke><|CHAT2API|tool_calls>',
    baseChunk,
  )

  assert.deepEqual(malformed, [])
  assert.deepEqual(residue, [])
  assert.deepEqual(parser.flush(baseChunk), [])
  assert.equal(parser.getObservation().suppressedMalformedToolOutput, true)
})

test('stream parser flush does not release a partial marker as plain text', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  parser.push('<|CHAT2API|tool_calls', baseChunk)

  const flushed = parser.flush(baseChunk)
  const observation = parser.getObservation()

  assert.deepEqual(flushed, [])
  assert.equal(observation.suppressedMalformedToolOutput, true)
  assert.equal(observation.suppressedReason, 'malformed_tool_output')
})

test('stream parser records content and tool-call emission facts', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  parser.push('hello ', baseChunk)
  parser.push('<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath">/tmp/a</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>', baseChunk)

  const observation = parser.getObservation()
  assert.equal(
    observation.rawContentLength,
    'hello '.length + '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath">/tmp/a</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>'.length,
  )
  assert.equal(observation.emittedContentLength, 'hello '.length)
  assert.equal(observation.emittedToolCallCount, 1)
  assert.equal(observation.suppressedMalformedToolOutput, false)
})

test('stream parser records invalid buffer suppression facts', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  parser.push('<|CHAT2API|tool_calls><|CHAT2API|invoke name="missing"><|CHAT2API|parameter name="x">1</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>', baseChunk)

  const observation = parser.getObservation()
  assert.equal(observation.rawContentLength > 0, true)
  assert.equal(observation.emittedToolCallCount, 0)
  assert.equal(observation.suppressedMalformedToolOutput, true)
  assert.equal(observation.suppressedReason, 'invalid_tool_name')
})

test('stream parser flush records malformed buffered tool suppression facts', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  parser.push('hello ', baseChunk)
  parser.push('<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath">/tmp/a</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>', baseChunk)
  parser.push('<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"', baseChunk)
  const flushed = parser.flush(baseChunk)

  assert.deepEqual(flushed, [])

  const observation = parser.getObservation()
  assert.equal(
    observation.rawContentLength,
    'hello '.length
      + '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath">/tmp/a</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>'.length
      + '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"'.length,
  )
  assert.equal(observation.emittedContentLength, 'hello '.length)
  assert.equal(observation.emittedToolCallCount, 1)
  assert.equal(observation.suppressedMalformedToolOutput, true)
  assert.equal(observation.suppressedReason, 'malformed_tool_output')
})

test('stream parser records split availability denial observations', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  parser.push('I only', baseChunk)
  parser.push(' have open_url', baseChunk)
  parser.push(' available.', baseChunk)

  const observation = parser.getObservation()
  assert.equal(observation.availabilityDriftDetected, true)
  assert.deepEqual(observation.deniedToolNames, [])
  assert.deepEqual(observation.mentionedUnavailableOnlyTools, ['open_url'])
})
