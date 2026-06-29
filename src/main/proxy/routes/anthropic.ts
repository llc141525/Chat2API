/**
 * Anthropic Messages compatibility routes.
 * Supports SDKs configured with /anthropic/v1 or /v1 base URLs.
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { PassThrough } from 'stream'
import type { ChatCompletionRequest, ChatCompletionTool, ChatMessage } from '../types'
import { requestForwarder } from '../forwarder'
import { loadBalancer } from '../loadbalancer'
import { modelMapper } from '../modelMapper'
import { proxyStatusManager } from '../status'
import { storeManager } from '../../store/store'

const router = new Router()

interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | AnthropicContentBlock[]
  source?: unknown
}

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

interface AnthropicTool {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
}

interface AnthropicMessagesRequest {
  model: string
  messages: AnthropicMessage[]
  system?: string | AnthropicContentBlock[]
  max_tokens?: number
  temperature?: number
  top_p?: number
  stream?: boolean
  tools?: AnthropicTool[]
  tool_choice?: { type?: 'auto' | 'any' | 'tool' | 'none'; name?: string } | string
}

function generateRequestId(): string {
  return `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function getClientIP(ctx: Context): string {
  return ctx.headers['x-real-ip'] as string ||
    ctx.headers['x-forwarded-for'] as string ||
    ctx.ip ||
    'unknown'
}

function textFromAnthropicContent(content: AnthropicMessage['content'] | AnthropicMessagesRequest['system']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map((block) => {
      if (block.type === 'text') return block.text || ''
      if (block.type === 'tool_result') {
        const resultText = typeof block.content === 'string'
          ? block.content
          : textFromAnthropicContent(block.content || [])
        return `[TOOL_RESULT for ${block.tool_use_id || 'unknown'}] ${resultText}`
      }
      if (block.type === 'tool_use') {
        return `[TOOL_USE ${block.name || 'unknown'}] ${JSON.stringify(block.input || {})}`
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function anthropicToolToOpenAI(tool: AnthropicTool): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema || { type: 'object', properties: {} },
    },
  }
}

function anthropicToolChoiceToOpenAI(toolChoice: AnthropicMessagesRequest['tool_choice']): ChatCompletionRequest['tool_choice'] {
  if (!toolChoice) return undefined
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'any') return 'required'
    if (toolChoice === 'none' || toolChoice === 'auto') return toolChoice
    return undefined
  }

  if (toolChoice.type === 'any') return 'required'
  if (toolChoice.type === 'none' || toolChoice.type === 'auto') return toolChoice.type
  if (toolChoice.type === 'tool' && toolChoice.name) {
    return { type: 'function', function: { name: toolChoice.name } }
  }
  return undefined
}

function anthropicRequestToOpenAI(request: AnthropicMessagesRequest): ChatCompletionRequest {
  const messages: ChatMessage[] = []
  const systemContent = textFromAnthropicContent(request.system)

  if (systemContent) {
    messages.push({ role: 'system', content: systemContent })
  }

  for (const message of request.messages || []) {
    messages.push({
      role: message.role,
      content: textFromAnthropicContent(message.content),
    })
  }

  return {
    model: request.model,
    messages,
    stream: request.stream,
    max_tokens: request.max_tokens,
    temperature: request.temperature,
    top_p: request.top_p,
    tools: request.tools?.map(anthropicToolToOpenAI),
    tool_choice: anthropicToolChoiceToOpenAI(request.tool_choice),
  }
}

function openAIResponseToAnthropic(body: any, fallbackModel: string): any {
  const choice = body?.choices?.[0] || {}
  const message = choice.message || {}
  const content: AnthropicContentBlock[] = []

  if (typeof message.content === 'string' && message.content) {
    content.push({ type: 'text', text: message.content })
  }

  for (const toolCall of message.tool_calls || []) {
    content.push({
      type: 'tool_use',
      id: toolCall.id,
      name: toolCall.function?.name || '',
      input: parseJsonObject(toolCall.function?.arguments),
    })
  }

  return {
    id: body?.id || generateRequestId(),
    type: 'message',
    role: 'assistant',
    model: body?.model || fallbackModel,
    content,
    stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: body?.usage?.prompt_tokens || 0,
      output_tokens: body?.usage?.completion_tokens || 0,
    },
  }
}

function parseJsonObject(value: string | undefined): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function anthropicError(message: string, type: string = 'invalid_request_error') {
  return {
    type: 'error',
    error: {
      type,
      message,
    },
  }
}

function writeAnthropicEvent(stream: PassThrough, event: string, data: any): void {
  stream.write(`event: ${event}\n`)
  stream.write(`data: ${JSON.stringify(data)}\n\n`)
}

function transformOpenAIStreamToAnthropic(openAIStream: NodeJS.ReadableStream, model: string): PassThrough {
  const out = new PassThrough()
  let buffer = ''
  let messageId = generateRequestId()
  let textBlockStarted = false
  let nextBlockIndex = 0
  const toolBlockIndexes = new Map<number, number>()

  writeAnthropicEvent(out, 'message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })

  const ensureTextBlock = () => {
    if (textBlockStarted) return 0
    textBlockStarted = true
    const index = nextBlockIndex++
    writeAnthropicEvent(out, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' },
    })
    return index
  }

  const handleChunk = (chunk: any) => {
    if (chunk?.id) messageId = chunk.id
    const choice = chunk?.choices?.[0] || {}
    const delta = choice.delta || {}

    if (typeof delta.content === 'string' && delta.content) {
      const index = ensureTextBlock()
      writeAnthropicEvent(out, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: delta.content },
      })
    }

    for (const toolCall of delta.tool_calls || []) {
      const openAIIndex = toolCall.index ?? 0
      let anthropicIndex = toolBlockIndexes.get(openAIIndex)
      if (anthropicIndex === undefined) {
        anthropicIndex = nextBlockIndex++
        toolBlockIndexes.set(openAIIndex, anthropicIndex)
        writeAnthropicEvent(out, 'content_block_start', {
          type: 'content_block_start',
          index: anthropicIndex,
          content_block: {
            type: 'tool_use',
            id: toolCall.id || `toolu_${openAIIndex}`,
            name: toolCall.function?.name || '',
            input: {},
          },
        })
      }

      const partialJson = toolCall.function?.arguments || ''
      if (partialJson) {
        writeAnthropicEvent(out, 'content_block_delta', {
          type: 'content_block_delta',
          index: anthropicIndex,
          delta: { type: 'input_json_delta', partial_json: partialJson },
        })
      }
    }

    if (choice.finish_reason) {
      for (let index = 0; index < nextBlockIndex; index += 1) {
        writeAnthropicEvent(out, 'content_block_stop', { type: 'content_block_stop', index })
      }
      writeAnthropicEvent(out, 'message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
          stop_sequence: null,
        },
        usage: { output_tokens: 0 },
      })
      writeAnthropicEvent(out, 'message_stop', { type: 'message_stop' })
    }
  }

  openAIStream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    const events = buffer.split('\n\n')
    buffer = events.pop() || ''

    for (const eventText of events) {
      const dataLine = eventText.split('\n').find((line) => line.startsWith('data:'))
      if (!dataLine) continue
      const data = dataLine.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        handleChunk(JSON.parse(data))
      } catch (error) {
        console.error('[Anthropic] Failed to transform stream chunk:', error)
      }
    }
  })

  openAIStream.once('end', () => out.end())
  openAIStream.once('error', (error) => {
    writeAnthropicEvent(out, 'error', anthropicError(error.message || String(error), 'api_error'))
    out.end()
  })

  return out
}

async function handleMessages(ctx: Context): Promise<void> {
  const startTime = Date.now()
  const requestId = generateRequestId()
  const request = ctx.request.body as AnthropicMessagesRequest

  if (!request?.model) {
    ctx.status = 400
    ctx.body = anthropicError('Missing required field: model')
    return
  }

  if (!Array.isArray(request.messages)) {
    ctx.status = 400
    ctx.body = anthropicError('Missing required field: messages')
    return
  }

  const openAIRequest = anthropicRequestToOpenAI(request)
  const config = storeManager.getConfig()
  const preferredProviderId = modelMapper.getPreferredProvider(openAIRequest.model)
  const preferredAccountId = modelMapper.getPreferredAccount(openAIRequest.model)
  const selection = loadBalancer.selectAccount(
    openAIRequest.model,
    config.loadBalanceStrategy,
    preferredProviderId,
    preferredAccountId
  )

  if (!selection) {
    ctx.status = 503
    ctx.body = anthropicError(`No available account for model: ${openAIRequest.model}`, 'api_error')
    return
  }

  const { account, provider, actualModel } = selection
  proxyStatusManager.recordRequestStart(openAIRequest.model, provider.id, account.id)

  const result = await requestForwarder.forwardChatCompletion(
    openAIRequest,
    account,
    provider,
    actualModel,
    {
      requestId,
      providerId: provider.id,
      accountId: account.id,
      model: openAIRequest.model,
      actualModel,
      startTime,
      isStream: openAIRequest.stream || false,
      clientIP: getClientIP(ctx),
    }
  )

  const latency = Date.now() - startTime

  if (!result.success) {
    proxyStatusManager.recordRequestFailure(latency)
    ctx.status = result.status || 500
    ctx.body = anthropicError(result.error || 'Request failed', 'api_error')
    return
  }

  proxyStatusManager.recordRequestSuccess(latency)

  if (openAIRequest.stream && result.stream) {
    ctx.set('Content-Type', 'text/event-stream')
    ctx.set('Cache-Control', 'no-cache')
    ctx.set('Connection', 'keep-alive')
    ctx.body = transformOpenAIStreamToAnthropic(result.stream, actualModel)
    return
  }

  ctx.set('Content-Type', 'application/json')
  ctx.body = openAIResponseToAnthropic(result.body, actualModel)
}

router.post('/anthropic/v1/messages', handleMessages)
router.post('/v1/messages', handleMessages)

export {
  anthropicToolToOpenAI,
  openAIResponseToAnthropic,
}

export default router
