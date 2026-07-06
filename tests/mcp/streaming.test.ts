import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'stream'
import { McpStreamHandler } from '../../src/main/proxy/mcp/streamHandler.ts'
import type { ChatCompletionRequest, ForwardResult } from '../../src/main/proxy/types.ts'

test('handleStreamingWithMcp returns a PassThrough stream', async () => {
  const handler = new McpStreamHandler()
  const stream = await handler.handleStreamingWithMcp(
    async () => ({ success: true, status: 200, stream: new PassThrough(), latency: 0 }),
    { model: 'test', messages: [{ role: 'user', content: 'hi' }] },
    'resp_1',
    'test-model',
  )
  assert.ok(stream instanceof PassThrough)
  stream.end()
})

test('handleStreamingWithMcp passes through final SSE', async () => {
  const handler = new McpStreamHandler()
  const sourceStream = new PassThrough()
  const responseId = `resp_${Date.now()}`
  const model = 'test-model'

  const outputPromise = handler.handleStreamingWithMcp(
    async () => ({ success: true, status: 200, stream: sourceStream, latency: 0 }),
    { model, messages: [{ role: 'user', content: 'hi' }] },
    responseId,
    model,
  )

  await new Promise(r => setTimeout(r, 10))

  sourceStream.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n')
  sourceStream.write('data: [DONE]\n\n')
  sourceStream.end()

  const output = await outputPromise
  const chunks: string[] = []
  for await (const chunk of output) {
    chunks.push(chunk.toString())
  }

  const fullText = chunks.join('')
  assert.ok(fullText.includes('Hello'), `Expected 'Hello' in output: ${fullText.substring(0, 200)}`)
})

test('handleStreamingWithMcp non-stream response passes through', async () => {
  const handler = new McpStreamHandler()

  const output = await handler.handleStreamingWithMcp(
    async () => ({
      success: true,
      status: 200,
      body: { choices: [{ message: { role: 'assistant', content: 'Hello from non-stream' } }] },
      latency: 0,
    }),
    { model: 'test', messages: [{ role: 'user', content: 'hi' }] },
    'resp_1',
    'test-model',
  )

  const chunks: string[] = []
  for await (const chunk of output) {
    chunks.push(chunk.toString())
  }

  const fullText = chunks.join('')
  assert.ok(fullText.includes('Hello from non-stream'))
  assert.ok(fullText.includes('[DONE]'))
})

test('collectStreamToolCalls aggregates tool_calls from SSE chunks', async () => {
  const handler = new McpStreamHandler()
  const sourceStream = new PassThrough()
  const outputStream = new PassThrough()

  const collectPromise = (handler as any).collectStreamToolCalls(
    sourceStream,
    outputStream,
    'resp_1',
    'test-model',
    Math.floor(Date.now() / 1000),
  )

  await new Promise(r => setTimeout(r, 10))

  const toolCallData = {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call_1',
          function: {
            name: 'mcp__fs__read_file',
            arguments: JSON.stringify({ path: '/test' }),
          },
        }],
      },
    }],
  }
  sourceStream.write(`data: ${JSON.stringify(toolCallData)}\n\n`)
  sourceStream.write('data: [DONE]\n\n')
  sourceStream.end()

  const { toolCalls } = await collectPromise
  assert.equal(toolCalls.length, 1)
  assert.equal(toolCalls[0].function.name, 'mcp__fs__read_file')
  assert.equal(toolCalls[0].id, 'call_1')
})
