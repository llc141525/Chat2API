import { PassThrough } from 'stream'
import type {
  ToolCall,
  ChatCompletionRequest,
  ForwardResult,
  ChatCompletionResponse,
} from '../types.ts'
import { ToolLoopOrchestrator } from './orchestrator.ts'
import { mcpClientManager } from './clientManager.ts'
import { McpToolExecutor } from './toolExecutor.ts'

const KEEPALIVE_INTERVAL_MS = 15_000

export interface McpStreamSegment {
  stream: PassThrough
  toolCalls: ToolCall[]
  finishReason: string | null
}

export class McpStreamHandler {
  private orchestrator: ToolLoopOrchestrator
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null

  constructor(orchestrator?: ToolLoopOrchestrator) {
    this.orchestrator = orchestrator ?? new ToolLoopOrchestrator()
  }

  private startKeepAlive(stream: PassThrough): void {
    this.stopKeepAlive()
    this.keepAliveTimer = setInterval(() => {
      try {
        stream.write(': keep-alive\n\n')
      } catch {
        this.stopKeepAlive()
      }
    }, KEEPALIVE_INTERVAL_MS)
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer)
      this.keepAliveTimer = null
    }
  }

  private formatSSE(data: object): string {
    return `data: ${JSON.stringify(data)}\n\n`
  }

  private formatDone(): string {
    return 'data: [DONE]\n\n'
  }

  async handleStreamingWithMcp(
    forwardFn: (request: ChatCompletionRequest) => Promise<ForwardResult>,
    request: ChatCompletionRequest,
    responseId: string,
    model: string,
    maxIterations: number = 20,
  ): Promise<PassThrough> {
    const outputStream = new PassThrough()
    const mcpTools = mcpClientManager.getAllTools()

    if (mcpTools.length === 0) {
      const result = await forwardFn(request)
      if (!result.success) {
        outputStream.write(this.formatSSE({
          id: responseId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{
            index: 0,
            delta: { content: `\n\n[Error: ${result.error ?? 'Request failed'}]` },
            finish_reason: 'stop',
          }],
        }))
        outputStream.write(this.formatDone())
        outputStream.end()
        return outputStream
      }
      if (result.stream) {
        result.stream.pipe(outputStream)
        return outputStream
      }
      if (result.body) {
        outputStream.write(this.formatSSE(result.body))
        outputStream.write(this.formatDone())
        outputStream.end()
        return outputStream
      }
      outputStream.end()
      return outputStream
    }

    const mcpChatTools = this.orchestrator.mergeMcpToolsIntoTools(mcpTools)
    const mergedTools = [...(request.tools ?? []), ...mcpChatTools]

    let currentRequest: ChatCompletionRequest = {
      ...request,
      tools: mergedTools,
    }

    const created = Math.floor(Date.now() / 1000)

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const result = await forwardFn(currentRequest)

      if (!result.success) {
        outputStream.write(this.formatSSE({
          id: responseId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{
            index: 0,
            delta: { content: `\n\n[Error: ${result.error ?? 'Request failed'}]` },
            finish_reason: 'stop',
          }],
        }))
        outputStream.write(this.formatDone())
        outputStream.end()
        return outputStream
      }

      if (result.stream) {
        const { toolCalls } = await this.collectStreamToolCalls(
          result.stream, outputStream, responseId, model, created,
        )

        if (toolCalls.length === 0) {
          return outputStream
        }

        const { mcpToolCalls } = this.orchestrator.separateToolCalls(toolCalls)
        if (mcpToolCalls.length === 0) {
          return outputStream
        }

        this.startKeepAlive(outputStream)

        const executor = new McpToolExecutor(mcpClientManager, 30_000)
        const mcpResults = await executor.executeTools(mcpToolCalls)

        this.stopKeepAlive()

        const toolResultMessages = this.orchestrator.buildToolResultMessages(
          toolCalls, mcpToolCalls, mcpResults,
        )

        currentRequest = {
          ...currentRequest,
          stream: true,
          messages: [
            ...currentRequest.messages,
            { role: 'assistant', content: null, tool_calls: toolCalls },
            ...toolResultMessages,
          ],
          tools: currentRequest.tools,
        }
      } else if (result.body) {
        const toolCalls = result.body.choices?.[0]?.message?.tool_calls ?? []
        if (toolCalls.length === 0) {
          outputStream.write(this.formatSSE(result.body))
          outputStream.write(this.formatDone())
          outputStream.end()
          return outputStream
        }

        const { mcpToolCalls } = this.orchestrator.separateToolCalls(toolCalls)
        if (mcpToolCalls.length === 0) {
          outputStream.write(this.formatSSE(result.body))
          outputStream.write(this.formatDone())
          outputStream.end()
          return outputStream
        }

        this.startKeepAlive(outputStream)

        const executor = new McpToolExecutor(mcpClientManager, 30_000)
        const mcpResults = await executor.executeTools(mcpToolCalls)

        this.stopKeepAlive()

        const toolResultMessages = this.orchestrator.buildToolResultMessages(
          toolCalls, mcpToolCalls, mcpResults,
        )

        currentRequest = {
          ...currentRequest,
          stream: true,
          messages: [
            ...currentRequest.messages,
            result.body.choices[0].message,
            ...toolResultMessages,
          ],
          tools: currentRequest.tools,
        }
      }
    }

    outputStream.write(this.formatSSE({
      id: responseId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    }))
    outputStream.write(this.formatDone())
    outputStream.end()
    return outputStream
  }

  private collectStreamToolCalls(
    sourceStream: NodeJS.ReadableStream,
    outputStream: PassThrough,
    responseId: string,
    model: string,
    created: number,
  ): Promise<{ toolCalls: ToolCall[] }> {
    return new Promise((resolve, reject) => {
      const toolCalls: ToolCall[] = []
      let buffer = ''

      sourceStream.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        buffer += text

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) {
            if (line.startsWith(': keep-alive')) continue
            if (line.startsWith(':')) continue
            if (line.trim() === '') continue
            outputStream.write(line + '\n')
            continue
          }

          const data = line.slice(6)
          if (data.trim() === '[DONE]') continue

          try {
            const parsed = JSON.parse(data)
            const delta = parsed.choices?.[0]?.delta
            const deltaToolCalls = delta?.tool_calls

            if (deltaToolCalls) {
              for (const tc of deltaToolCalls) {
                const existing = toolCalls.find(t => t.index === tc.index)
                if (existing) {
                  if (tc.function?.arguments) {
                    existing.function.arguments += tc.function.arguments
                  }
                  if (tc.id) existing.id = tc.id
                  if (tc.function?.name) existing.function.name = tc.function.name
                } else {
                  toolCalls.push({
                    index: tc.index,
                    id: tc.id ?? '',
                    type: tc.type ?? 'function',
                    function: {
                      name: tc.function?.name ?? '',
                      arguments: tc.function?.arguments ?? '',
                    },
                  })
                }
              }

              outputStream.write(line + '\n')
            } else if (delta?.content !== undefined) {
              outputStream.write(line + '\n')
            } else {
              outputStream.write(line + '\n')
            }
          } catch {
            outputStream.write(line + '\n')
          }
        }
      })

      sourceStream.on('end', () => {
        if (toolCalls.length > 0) {
          outputStream.write(this.formatSSE({
            id: responseId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: 'tool_calls',
            }],
          }))
        }
        resolve({ toolCalls })
      })

      sourceStream.on('error', reject)
    })
  }
}
