import type { McpClientManager } from './clientManager.ts'
import type { McpToolCallRequest, McpToolCallResult } from './types.ts'
import { buildMcpToolName } from './types.ts'

export interface ToolExecutionOptions {
  timeout?: number
  signal?: AbortSignal
}

export interface NormalizedToolResult {
  role: 'tool'
  tool_call_id: string
  content: string
}

export class McpToolExecutor {
  private clientManager: McpClientManager
  private defaultTimeoutMs: number

  constructor(
    clientManager: McpClientManager,
    defaultTimeoutMs: number = 30_000,
  ) {
    this.clientManager = clientManager
    this.defaultTimeoutMs = defaultTimeoutMs
  }

  setDefaultTimeout(ms: number): void {
    this.defaultTimeoutMs = ms
  }

  private async executeWithTimeout(
    request: McpToolCallRequest,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<McpToolCallResult> {
    if (signal?.aborted) {
      return {
        serverName: request.serverName,
        toolName: request.toolName,
        success: false,
        content: [{ type: 'text', text: 'Execution cancelled' }],
        isError: true,
      }
    }

    const timeoutPromise = new Promise<McpToolCallResult>((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Tool call timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new Error('Execution cancelled'))
        }, { once: true })
      }
    })

    const executionPromise = this.clientManager.callTool(request)

    try {
      return await Promise.race([executionPromise, timeoutPromise])
    } catch (error) {
      return {
        serverName: request.serverName,
        toolName: request.toolName,
        success: false,
        content: [{
          type: 'text',
          text: error instanceof Error ? error.message : 'Tool execution failed',
        }],
        isError: true,
      }
    }
  }

  async executeTool(
    request: McpToolCallRequest,
    options?: ToolExecutionOptions,
  ): Promise<McpToolCallResult> {
    const timeout = options?.timeout ?? this.defaultTimeoutMs
    return this.executeWithTimeout(request, timeout, options?.signal)
  }

  async executeTools(
    requests: McpToolCallRequest[],
    options?: ToolExecutionOptions,
  ): Promise<McpToolCallResult[]> {
    if (requests.length === 0) return []
    const timeout = options?.timeout ?? this.defaultTimeoutMs

    const results = await Promise.allSettled(
      requests.map(req => this.executeWithTimeout(req, timeout, options?.signal)),
    )

    return results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value
      return {
        serverName: requests[i].serverName,
        toolName: requests[i].toolName,
        success: false,
        content: [{ type: 'text', text: 'Internal execution error' }],
        isError: true,
      }
    })
  }

  normalizeToolResult(
    result: McpToolCallResult,
    toolCallId: string,
  ): NormalizedToolResult {
    const contentText = result.content
      .map(c => {
        if (c.type === 'text' && c.text) return c.text
        if (c.type === 'resource' && c.text) return c.text
        return `[${c.type} content]`
      })
      .join('\n')

    return {
      role: 'tool',
      tool_call_id: toolCallId,
      content: contentText || '(empty result)',
    }
  }
}
