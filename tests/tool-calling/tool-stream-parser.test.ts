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
