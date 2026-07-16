import type { ChatCompletionRequest, ForwardResult } from '../types.ts'
import { ToolLoopOrchestrator } from './orchestrator.ts'
import { mcpClientManager } from './clientManager.ts'
import { McpToolExecutor } from './toolExecutor.ts'

export interface ProxyRequestHandlerOptions {
  maxToolLoopIterations?: number
  toolTimeout?: number
}

export class ProxyRequestHandler {
  private orchestrator: ToolLoopOrchestrator
  private options: Required<ProxyRequestHandlerOptions>

  constructor(
    orchestrator?: ToolLoopOrchestrator,
    options?: ProxyRequestHandlerOptions,
  ) {
    this.orchestrator = orchestrator ?? new ToolLoopOrchestrator()
    this.options = {
      maxToolLoopIterations: options?.maxToolLoopIterations ?? 20,
      toolTimeout: options?.toolTimeout ?? 30_000,
    }
  }

  async forwardWithMcp(
    forwardFn: (request: ChatCompletionRequest) => Promise<ForwardResult>,
    request: ChatCompletionRequest,
  ): Promise<ForwardResult> {
    const mcpTools = mcpClientManager.getAllTools()
    if (mcpTools.length === 0) {
      return forwardFn(request)
    }

    const mcpChatTools = this.orchestrator.mergeMcpToolsIntoTools(mcpTools)
    const existingTools = request.tools ?? []
    const mergedTools = [...existingTools, ...mcpChatTools]

    const enrichedRequest: ChatCompletionRequest = {
      ...request,
      tools: mergedTools,
    }

    return this.orchestrator.executeToolLoop(
      forwardFn,
      enrichedRequest,
      {
        maxIterations: this.options.maxToolLoopIterations,
        toolTimeout: this.options.toolTimeout,
      },
    )
  }

  async initializeMcpServers(servers: Array<{ name: string; command: string; args?: string[]; env?: Record<string, string>; enabled: boolean }>): Promise<void> {
    await Promise.all(
      servers.map(srv =>
        mcpClientManager.startServer(srv.name, {
          name: srv.name,
          command: srv.command,
          args: srv.args,
          env: srv.env,
          enabled: srv.enabled,
        }),
      ),
    )
  }

  async shutdown(): Promise<void> {
    await mcpClientManager.stopAll()
  }
}
