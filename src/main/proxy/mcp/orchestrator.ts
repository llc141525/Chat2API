import type { ChatCompletionRequest, ChatMessage, ToolCall } from '../types.ts'
import type { ChatCompletionTool, ForwardResult } from '../types.ts'
import type { NormalizedToolDefinition } from '../toolCalling/types.ts'
import type { McpClientManager } from './clientManager.ts'
import { mcpClientManager } from './clientManager.ts'
import { McpToolExecutor } from './toolExecutor.ts'
import type {
  McpToolCallRequest,
  McpToolCallResult,
  McpToolDefinition,
  NormalizedToolResult,
} from './types.ts'
import {
  buildMcpToolName,
  parseMcpToolName,
} from './types.ts'

export const DEFAULT_MAX_TOOL_LOOP_ITERATIONS = 20

export interface ToolLoopOptions {
  maxIterations?: number
  toolTimeout?: number
  signal?: AbortSignal
}

export interface ToolLoopSegment {
  messages: ChatMessage[]
  tools: ChatCompletionTool[]
  toolCalls: ToolCall[]
  mcpToolCalls: McpToolCallRequest[]
  clientToolCalls: ToolCall[]
}

export class ToolLoopOrchestrator {
  private clientManager: McpClientManager
  private toolExecutor: McpToolExecutor
  private maxIterations: number

  constructor(
    clientManager?: McpClientManager,
    toolExecutor?: McpToolExecutor,
    maxIterations: number = DEFAULT_MAX_TOOL_LOOP_ITERATIONS,
  ) {
    this.clientManager = clientManager ?? mcpClientManager
    this.toolExecutor = toolExecutor ?? new McpToolExecutor(this.clientManager)
    this.maxIterations = maxIterations
  }

  mergeMcpToolsIntoTools(mcpTools: McpToolDefinition[]): ChatCompletionTool[] {
    return mcpTools.map(mcpTool => ({
      type: 'function' as const,
      function: {
        name: buildMcpToolName(mcpTool.serverName, mcpTool.originalName),
        description: mcpTool.description ?? '',
        parameters: mcpTool.inputSchema as Record<string, unknown>,
      },
    }))
  }

  buildNormalizedToolDefinitions(mcpTools: McpToolDefinition[]): NormalizedToolDefinition[] {
    return mcpTools.map(mcpTool => ({
      name: buildMcpToolName(mcpTool.serverName, mcpTool.originalName),
      description: mcpTool.description,
      parameters: mcpTool.inputSchema,
      source: 'mcp' as const,
    }))
  }

  async executeToolLoop(
    forwardFn: (request: ChatCompletionRequest) => Promise<ForwardResult>,
    request: ChatCompletionRequest,
    options?: ToolLoopOptions,
  ): Promise<ForwardResult> {
    const maxIter = options?.maxIterations ?? this.maxIterations
    const signal = options?.signal
    const toolTimeout = options?.toolTimeout

    if (signal?.aborted) {
      return { success: false, error: 'Request cancelled' }
    }

    let currentRequest = { ...request }
    let iterationCount = 0

    while (iterationCount < maxIter) {
      iterationCount++

      const result = await forwardFn(currentRequest)
      if (!result.success) return result

      if (signal?.aborted) {
        return { success: false, error: 'Request cancelled' }
      }

      const body = result.body
      if (!body) return result

      const choice = body.choices?.[0]
      if (!choice) return result

      const toolCalls: ToolCall[] = choice.message?.tool_calls ?? []
      if (toolCalls.length === 0) return result

      const { mcpToolCalls, clientToolCalls } = this.separateToolCalls(toolCalls)

      if (mcpToolCalls.length === 0) {
        return result
      }

      const mcpResults = await this.toolExecutor.executeTools(mcpToolCalls, {
        timeout: toolTimeout,
        signal,
      })

      if (signal?.aborted) {
        return { success: false, error: 'Request cancelled' }
      }

      const toolResultMessages = this.buildToolResultMessages(toolCalls, mcpToolCalls, mcpResults)

      currentRequest = {
        ...currentRequest,
        stream: false,
        messages: [
          ...currentRequest.messages,
          choice.message,
          ...toolResultMessages,
        ],
        tools: currentRequest.tools,
      }
    }

    return {
      success: false,
      error: `Tool loop exceeded maximum iterations (${maxIter})`,
    }
  }

  separateToolCalls(toolCalls: ToolCall[]): {
    mcpToolCalls: McpToolCallRequest[]
    clientToolCalls: ToolCall[]
  } {
    const mcpToolCalls: McpToolCallRequest[] = []
    const clientToolCalls: ToolCall[] = []

    for (const tc of toolCalls) {
      const parsed = parseMcpToolName(tc.function.name)
      if (parsed) {
        mcpToolCalls.push({
          serverName: parsed.serverName,
          toolName: parsed.toolName,
          arguments: this.parseToolArguments(tc.function.arguments),
        })
      } else {
        clientToolCalls.push(tc)
      }
    }

    return { mcpToolCalls, clientToolCalls }
  }

  private parseToolArguments(args: string): Record<string, unknown> {
    try {
      return JSON.parse(args)
    } catch {
      return {}
    }
  }

  buildToolResultMessages(
    originalToolCalls: ToolCall[],
    mcpToolCalls: McpToolCallRequest[],
    mcpResults: McpToolCallResult[],
  ): ChatMessage[] {
    const resultMap = new Map<string, McpToolCallResult>()
    for (let i = 0; i < mcpToolCalls.length; i++) {
      resultMap.set(mcpToolCalls[i].toolName, mcpResults[i])
    }

    const messages: ChatMessage[] = []

    for (const tc of originalToolCalls) {
      const parsed = parseMcpToolName(tc.function.name)
      if (!parsed) continue

      const mcpResult = resultMap.get(parsed.toolName)
      if (!mcpResult) continue

      const contentText = mcpResult.content
        .map(c => {
          if (c.type === 'text' && c.text) return c.text
          if (c.type === 'resource' && c.text) return c.text
          return `[${c.type} content: ${c.mimeType ?? 'unknown'}]`
        })
        .filter(Boolean)
        .join('\n')

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: contentText || '(empty result)',
      })
    }

    return messages
  }

  async getNormalizedTools(): Promise<NormalizedToolDefinition[]> {
    const mcpTools = this.clientManager.getAllTools()

    const mcpDefinitions = mcpTools.map(mcpTool => ({
      name: buildMcpToolName(mcpTool.serverName, mcpTool.originalName),
      description: mcpTool.description,
      parameters: mcpTool.inputSchema as Record<string, unknown>,
      source: 'mcp' as const,
    }))

    return mcpDefinitions
  }

  async getChatCompletionTools(): Promise<ChatCompletionTool[]> {
    const mcpTools = this.clientManager.getAllTools()
    return this.mergeMcpToolsIntoTools(mcpTools)
  }
}
