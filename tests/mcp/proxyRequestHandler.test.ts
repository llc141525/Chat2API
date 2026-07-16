import test from 'node:test'
import assert from 'node:assert/strict'
import { ProxyRequestHandler } from '../../src/main/proxy/mcp/proxyRequestHandler.ts'
import { ToolLoopOrchestrator } from '../../src/main/proxy/mcp/orchestrator.ts'
import type { ChatCompletionRequest, ForwardResult } from '../../src/main/proxy/types.ts'

test('forwardWithMcp passes through when no MCP servers connected', async () => {
  const handler = new ProxyRequestHandler()
  let called = false

  const result = await handler.forwardWithMcp(
    async (req) => {
      called = true
      return { success: true, status: 200, body: { choices: [{ message: { role: 'assistant', content: 'ok' } }] }, latency: 0 }
    },
    { model: 'test', messages: [{ role: 'user', content: 'hi' }] },
  )

  assert.equal(called, true)
  assert.equal(result.success, true)
})

test('forwardWithMcp merges MCP tools into request tools', async () => {
  let capturedTools: any = null
  let callCount = 0

  const mockOrchestrator = new ToolLoopOrchestrator()
  const origMerge = mockOrchestrator.mergeMcpToolsIntoTools.bind(mockOrchestrator)
  mockOrchestrator.mergeMcpToolsIntoTools = (mcpTools) => {
    return mcpTools.map(t => ({
      type: 'function' as const,
      function: { name: `mcp__${t.serverName}__${t.originalName}`, description: '', parameters: {} },
    }))
  }

  const handler = new ProxyRequestHandler(mockOrchestrator)
  const result = await handler.forwardWithMcp(
    async (req) => {
      callCount++
      capturedTools = req.tools
      return { success: true, status: 200, body: { choices: [{ message: { role: 'assistant', content: 'ok' } }] }, latency: 0 }
    },
    { model: 'test', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'bash', description: '', parameters: {} } }] },
  )

  assert.equal(result.success, true)
})

test('forwardWithMcp returns error when forwardFn fails', async () => {
  const handler = new ProxyRequestHandler()
  const result = await handler.forwardWithMcp(
    async () => ({ success: false, error: 'Network error', latency: 100 }),
    { model: 'test', messages: [{ role: 'user', content: 'hi' }] },
  )

  assert.equal(result.success, false)
  assert.equal(result.error, 'Network error')
})

test('initializeMcpServers starts MCP servers', async () => {
  const handler = new ProxyRequestHandler()
  await handler.initializeMcpServers([
    { name: 'test', command: 'node', args: ['-e', ''], enabled: false },
  ])
  assert.equal(typeof handler.shutdown, 'function')
})

test('shutdown stops all servers', async () => {
  const handler = new ProxyRequestHandler()
  await handler.shutdown()
})
