import test from 'node:test'
import assert from 'node:assert/strict'
import { McpToolExecutor } from '../../src/main/proxy/mcp/toolExecutor.ts'
import { McpClientManager } from '../../src/main/proxy/mcp/clientManager.ts'
import type { McpToolCallRequest, McpToolCallResult } from '../../src/main/proxy/mcp/types.ts'

class FakeClientManager extends McpClientManager {
  private results: Map<string, McpToolCallResult> = new Map()
  private delays: Map<string, number> = new Map()

  setResult(key: string, result: McpToolCallResult): void {
    this.results.set(key, result)
  }

  setDelay(key: string, ms: number): void {
    this.delays.set(key, ms)
  }

  async callTool(request: McpToolCallRequest): Promise<McpToolCallResult> {
    const key = `${request.serverName}/${request.toolName}`
    const delay = this.delays.get(key) ?? 0
    if (delay > 0) {
      await new Promise(r => setTimeout(r, delay))
    }
    return this.results.get(key) ?? {
      serverName: request.serverName,
      toolName: request.toolName,
      success: false,
      content: [{ type: 'text', text: 'Unmocked result' }],
      isError: true,
    }
  }
}

test('executeTool returns successful result', async () => {
  const fakeManager = new FakeClientManager()
  fakeManager.setResult('srv/test-tool', {
    serverName: 'srv',
    toolName: 'test-tool',
    success: true,
    content: [{ type: 'text', text: 'hello world' }],
  })

  const executor = new McpToolExecutor(fakeManager, 5000)
  const result = await executor.executeTool({ serverName: 'srv', toolName: 'test-tool', arguments: {} })

  assert.equal(result.success, true)
  assert.equal(result.content[0].text, 'hello world')
})

test('executeTool handles timeout', async () => {
  const fakeManager = new FakeClientManager()
  fakeManager.setResult('srv/slow', {
    serverName: 'srv',
    toolName: 'slow',
    success: true,
    content: [{ type: 'text', text: 'too late' }],
  })
  fakeManager.setDelay('srv/slow', 100)

  const executor = new McpToolExecutor(fakeManager, 50)
  const result = await executor.executeTool({ serverName: 'srv', toolName: 'slow', arguments: {} })

  assert.equal(result.success, false)
  assert.ok(result.content[0].text?.includes('timed out'))
})

test('executeTool handles aborted signal', async () => {
  const fakeManager = new FakeClientManager()
  const executor = new McpToolExecutor(fakeManager, 5000)
  const ac = new AbortController()
  ac.abort()

  const result = await executor.executeTool(
    { serverName: 'srv', toolName: 'cancelled', arguments: {} },
    { signal: ac.signal },
  )

  assert.equal(result.success, false)
  assert.ok(result.content[0].text?.includes('cancelled'))
})

test('executeTools returns results for multiple tools', async () => {
  const fakeManager = new FakeClientManager()
  fakeManager.setResult('srv/a', {
    serverName: 'srv', toolName: 'a', success: true,
    content: [{ type: 'text', text: 'result a' }],
  })
  fakeManager.setResult('srv/b', {
    serverName: 'srv', toolName: 'b', success: true,
    content: [{ type: 'text', text: 'result b' }],
  })

  const executor = new McpToolExecutor(fakeManager, 5000)
  const results = await executor.executeTools([
    { serverName: 'srv', toolName: 'a', arguments: {} },
    { serverName: 'srv', toolName: 'b', arguments: {} },
  ])

  assert.equal(results.length, 2)
  assert.equal(results[0].success, true)
  assert.equal(results[1].success, true)
})

test('executeTools returns empty array for empty input', async () => {
  const executor = new McpToolExecutor(new FakeClientManager(), 5000)
  const results = await executor.executeTools([])
  assert.deepEqual(results, [])
})

test('normalizeToolResult produces OpenAI-compatible format', () => {
  const fakeManager = new FakeClientManager()
  const executor = new McpToolExecutor(fakeManager, 5000)

  const result: McpToolCallResult = {
    serverName: 'srv',
    toolName: 'test',
    success: true,
    content: [
      { type: 'text', text: 'line1' },
      { type: 'text', text: 'line2' },
      { type: 'image', data: 'base64...', mimeType: 'image/png' },
    ],
  }

  const normalized = executor.normalizeToolResult(result, 'call_123')
  assert.equal(normalized.role, 'tool')
  assert.equal(normalized.tool_call_id, 'call_123')
  assert.ok(normalized.content.includes('line1'))
  assert.ok(normalized.content.includes('line2'))
  assert.ok(normalized.content.includes('[image content]'))
})

test('executeTool handles execution error from server', async () => {
  const fakeManager = new FakeClientManager()
  fakeManager.setResult('srv/error', {
    serverName: 'srv',
    toolName: 'error',
    success: false,
    content: [{ type: 'text', text: 'Something went wrong' }],
    isError: true,
  })

  const executor = new McpToolExecutor(fakeManager, 5000)
  const result = await executor.executeTool({ serverName: 'srv', toolName: 'error', arguments: {} })

  assert.equal(result.success, false)
  assert.equal(result.isError, true)
})
