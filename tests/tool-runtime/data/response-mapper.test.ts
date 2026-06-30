import test from 'node:test'
import assert from 'node:assert/strict'

import {
  mapNonStreamOpenAIResponse,
  mapStreamOpenAIResponseChunks,
} from '../../../src/main/proxy/toolRuntime/data/index.ts'
import type { ToolCall } from '../../../src/main/proxy/types.ts'

const toolCalls: ToolCall[] = [{
  id: 'call_0',
  index: 0,
  type: 'function',
  function: {
    name: 'bash',
    arguments: '{"argument":"pwd"}',
  },
}]

const meta = {
  id: 'chatcmpl-test',
  model: 'qwen-test',
  created: 123,
}

test('non-stream maps valid tool calls to assistant tool_calls', () => {
  const response = mapNonStreamOpenAIResponse({
    ...meta,
    input: { kind: 'valid_tool_calls', toolCalls },
  })

  assert.equal(response.object, 'chat.completion')
  assert.deepEqual(response.choices[0], {
    index: 0,
    message: {
      role: 'assistant',
      content: null,
      tool_calls: toolCalls,
    },
    finish_reason: 'tool_calls',
  })
})

test('non-stream maps plain text to assistant content', () => {
  const response = mapNonStreamOpenAIResponse({
    ...meta,
    input: { kind: 'plain_text', content: 'hello' },
  })

  assert.deepEqual(response.choices[0], {
    index: 0,
    message: {
      role: 'assistant',
      content: 'hello',
    },
    finish_reason: 'stop',
  })
})

test('non-stream maps blocked malformed to safe assistant content', () => {
  const response = mapNonStreamOpenAIResponse({
    ...meta,
    input: {
      kind: 'blocked_malformed',
      safeMessage: 'blocked',
    },
  })

  assert.equal(response.choices[0].message?.content, 'blocked')
  assert.equal(response.choices[0].finish_reason, 'stop')
})

test('stream maps tool calls to role chunk, tool chunk, and terminal chunk', () => {
  const chunks = mapStreamOpenAIResponseChunks({
    ...meta,
    input: { kind: 'valid_tool_calls', toolCalls },
  })

  assert.deepEqual(chunks.map((chunk) => chunk.choices[0]), [
    {
      index: 0,
      delta: { role: 'assistant' },
      finish_reason: null,
    },
    {
      index: 0,
      delta: { tool_calls: toolCalls },
      finish_reason: null,
    },
    {
      index: 0,
      delta: {},
      finish_reason: 'tool_calls',
    },
  ])
})

test('stream maps text into role chunk, content chunk, and stop chunk', () => {
  const chunks = mapStreamOpenAIResponseChunks({
    ...meta,
    input: { kind: 'plain_text', content: 'hello' },
  })

  assert.deepEqual(chunks.map((chunk) => chunk.choices[0]), [
    {
      index: 0,
      delta: { role: 'assistant' },
      finish_reason: null,
    },
    {
      index: 0,
      delta: { content: 'hello' },
      finish_reason: null,
    },
    {
      index: 0,
      delta: {},
      finish_reason: 'stop',
    },
  ])
})
