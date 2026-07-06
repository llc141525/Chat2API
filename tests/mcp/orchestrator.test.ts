import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolLoopOrchestrator, DEFAULT_MAX_TOOL_LOOP_ITERATIONS } from '../../src/main/proxy/mcp/orchestrator.ts'
import { buildMcpToolName, parseMcpToolName } from '../../src/main/proxy/mcp/types.ts'
import type { McpToolDefinition, McpToolCallRequest, McpToolCallResult } from '../../src/main/proxy/mcp/types.ts'
import type { ChatCompletionTool, ForwardResult, ToolCall } from '../../src/main/proxy/types.ts'

const sampleMcpTool: McpToolDefinition = {
  serverName: 'fs',
  name: 'read_file',
  originalName: 'read_file',
  description: 'Read a file',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
}

test('buildMcpToolName and parseMcpToolName roundtrip', () => {
  const full = buildMcpToolName('fs', 'read_file')
  assert.equal(full, 'mcp__fs__read_file')
  const parsed = parseMcpToolName(full)
  assert.deepEqual(parsed, { serverName: 'fs', toolName: 'read_file' })
})

test('parseMcpToolName returns null for non-MCP names', () => {
  assert.equal(parseMcpToolName('bash'), null)
  assert.equal(parseMcpToolName('mcp__foo'), null)
  assert.equal(parseMcpToolName(''), null)
})

test('mergeMcpToolsIntoTools converts MCP tools to ChatCompletionTool format', () => {
  const orchestrator = new ToolLoopOrchestrator()
  const tools = orchestrator.mergeMcpToolsIntoTools([sampleMcpTool])

  assert.equal(tools.length, 1)
  assert.equal(tools[0].function.name, 'mcp__fs__read_file')
  assert.equal(tools[0].function.description, 'Read a file')
  assert.equal(tools[0].type, 'function')
})

test('separateToolCalls separates MCP from client tool calls', () => {
  const orchestrator = new ToolLoopOrchestrator()

  const mcpCall: ToolCall = {
    id: 'call_1',
    type: 'function',
    function: { name: 'mcp__fs__read_file', arguments: '{"path":"/test"}' },
  }
  const clientCall: ToolCall = {
    id: 'call_2',
    type: 'function',
    function: { name: 'bash', arguments: '{"cmd":"ls"}' },
  }

  const { mcpToolCalls, clientToolCalls } = orchestrator.separateToolCalls([mcpCall, clientCall])

  assert.equal(mcpToolCalls.length, 1)
  assert.equal(mcpToolCalls[0].serverName, 'fs')
  assert.equal(mcpToolCalls[0].toolName, 'read_file')
  assert.equal(mcpToolCalls[0].arguments.path, '/test')

  assert.equal(clientToolCalls.length, 1)
  assert.equal(clientToolCalls[0].function.name, 'bash')
})

test('buildToolResultMessages creates properly formatted tool result messages', () => {
  const orchestrator = new ToolLoopOrchestrator()

  const toolCalls: ToolCall[] = [
    { id: 'call_1', type: 'function', function: { name: 'mcp__fs__read_file', arguments: '{}' } },
    { id: 'call_2', type: 'function', function: { name: 'bash', arguments: '{}' } },
  ]

  const mcpRequests: McpToolCallRequest[] = [
    { serverName: 'fs', toolName: 'read_file', arguments: {} },
  ]

  const mcpResults: McpToolCallResult[] = [
    {
      serverName: 'fs',
      toolName: 'read_file',
      success: true,
      content: [{ type: 'text', text: 'file content' }],
    },
  ]

  const messages = orchestrator.buildToolResultMessages(toolCalls, mcpRequests, mcpResults)

  assert.equal(messages.length, 1)
  assert.equal(messages[0].role, 'tool')
  assert.equal(messages[0].tool_call_id, 'call_1')
  assert.equal(messages[0].content, 'file content')
})

test('buildNormalizedToolDefinitions converts MCP tools to NormalizedToolDefinition format', () => {
  const orchestrator = new ToolLoopOrchestrator()
  const defs = orchestrator.buildNormalizedToolDefinitions([sampleMcpTool])

  assert.equal(defs.length, 1)
  assert.equal(defs[0].name, 'mcp__fs__read_file')
  assert.equal(defs[0].source, 'mcp')
  assert.equal(defs[0].description, 'Read a file')
})

test('buildToolResultMessages handles multi-content results', () => {
  const orchestrator = new ToolLoopOrchestrator()

  const toolCalls: ToolCall[] = [
    { id: 'call_1', type: 'function', function: { name: 'mcp__db__query', arguments: '{}' } },
  ]

  const mcpRequests: McpToolCallRequest[] = [
    { serverName: 'db', toolName: 'query', arguments: {} },
  ]

  const mcpResults: McpToolCallResult[] = [
    {
      serverName: 'db',
      toolName: 'query',
      success: true,
      content: [
        { type: 'text', text: 'row1' },
        { type: 'text', text: 'row2' },
      ],
    },
  ]

  const messages = orchestrator.buildToolResultMessages(toolCalls, mcpRequests, mcpResults)
  assert.equal(messages[0].content, 'row1\nrow2')
})

test('tool loop terminates when no tool calls in response', async () => {
  const orchestrator = new ToolLoopOrchestrator()
  let callCount = 0

  const result = await orchestrator.executeToolLoop(
    async (req) => {
      callCount++
      return {
        success: true,
        status: 200,
        body: {
          choices: [{
            message: { role: 'assistant', content: 'Hello!' },
          }],
        },
        latency: 0,
      }
    },
    { model: 'test', messages: [{ role: 'user', content: 'hi' }] },
  )

  assert.equal(callCount, 1)
  assert.equal(result.success, true)
})

test('tool loop terminates when response has only client tool calls', async () => {
  const orchestrator = new ToolLoopOrchestrator()
  let callCount = 0

  const result = await orchestrator.executeToolLoop(
    async (req) => {
      callCount++
      return {
        success: true,
        status: 200,
        body: {
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
            },
          }],
        },
        latency: 0,
      }
    },
    { model: 'test', messages: [{ role: 'user', content: 'hi' }] },
  )

  assert.equal(callCount, 1)
})

test('tool loop terminates when max iterations exceeded', async () => {
  const orchestrator = new ToolLoopOrchestrator(undefined, undefined, 3)

  const result = await orchestrator.executeToolLoop(
    async (req) => {
      return {
        success: true,
        status: 200,
        body: {
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'mcp__fs__read_file', arguments: '{}' } }],
            },
          }],
        },
        latency: 0,
      }
    },
    { model: 'test', messages: [{ role: 'user', content: 'hi' }] },
  )

  assert.equal(result.success, false)
  assert.ok(result.error?.includes('exceeded maximum iterations'))
})

test('DEFAULT_MAX_TOOL_LOOP_ITERATIONS is 20', () => {
  assert.equal(DEFAULT_MAX_TOOL_LOOP_ITERATIONS, 20)
})
