import { PassThrough } from 'stream'
import type { ChatCompletionRequest, ChatCompletionTool, ChatMessage } from '../types.ts'

export interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | AnthropicContentBlock[]
  source?: unknown
}

export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

export interface AnthropicTool {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
}

export interface AnthropicMessagesRequest {
  model: string
  messages: AnthropicMessage[]
  system?: string | AnthropicContentBlock[]
  metadata?: Record<string, unknown>
  max_tokens?: number
  temperature?: number
  top_p?: number
  stream?: boolean
  tools?: AnthropicTool[]
  tool_choice?: { type?: 'auto' | 'any' | 'tool' | 'none'; name?: string } | string
}

export type AnthropicTerminalErrorClass =
  | 'none'
  | 'no_provider_configured'
  | 'no_account_configured'
  | 'no_account_available'
  | 'selection_failed'
  | 'tool_catalog_drift'
  | 'provider_auth_failure'
  | 'provider_model_not_found'
  | 'provider_rate_limited'
  | 'malformed_provider_response'
  | 'provider_request_failed'

export function generateAnthropicRequestId(): string {
  return `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function textFromAnthropicContent(content: AnthropicMessage['content'] | AnthropicMessagesRequest['system']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map((block) => {
      if (block.type === 'text') return block.text || ''
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function stringifyToolInput(input: Record<string, unknown> | undefined): string {
  return JSON.stringify(input ?? {})
}

function textFromToolResultContent(content: AnthropicContentBlock['content']): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return textFromAnthropicContent(content)
  return ''
}

function flushBufferedUserText(messages: ChatMessage[], textBuffer: string[]): void {
  const text = textBuffer.join('\n').trim()
  if (text.length > 0) {
    messages.push({ role: 'user', content: text })
  }
  textBuffer.length = 0
}

function anthropicMessageToOpenAIMessages(message: AnthropicMessage): ChatMessage[] {
  if (typeof message.content === 'string') {
    return [{
      role: message.role,
      content: message.content,
    }]
  }

  if (!Array.isArray(message.content) || message.content.length === 0) {
    return []
  }

  if (message.role === 'assistant') {
    const textParts: string[] = []
    const toolCalls: NonNullable<ChatMessage['tool_calls']> = []

    for (const block of message.content) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text)
        continue
      }

      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id || `toolu_${toolCalls.length}`,
          type: 'function',
          function: {
            name: block.name || '',
            arguments: stringifyToolInput(block.input),
          },
        })
      }
    }

    if (textParts.length === 0 && toolCalls.length === 0) {
      return []
    }

    return [{
      role: 'assistant',
      content: textParts.length > 0 ? textParts.join('\n') : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    }]
  }

  const messages: ChatMessage[] = []
  const textBuffer: string[] = []

  for (const block of message.content) {
    if (block.type === 'text' && block.text) {
      textBuffer.push(block.text)
      continue
    }

    if (block.type === 'tool_result') {
      flushBufferedUserText(messages, textBuffer)
      messages.push({
        role: 'tool',
        tool_call_id: block.tool_use_id || 'unknown',
        content: textFromToolResultContent(block.content),
      })
      continue
    }
  }

  flushBufferedUserText(messages, textBuffer)
  return messages
}

export function anthropicToolToOpenAI(tool: AnthropicTool): ChatCompletionTool {
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

export function anthropicRequestToOpenAI(request: AnthropicMessagesRequest): ChatCompletionRequest {
  const messages: ChatMessage[] = []
  const systemContent = textFromAnthropicContent(request.system)

  if (systemContent) {
    messages.push({ role: 'system', content: systemContent })
  }

  for (const message of request.messages || []) {
    messages.push(...anthropicMessageToOpenAIMessages(message))
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

function parseJsonObject(value: string | undefined): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    console.warn('[AnthropicRoute] Failed to parse tool arguments as JSON object')
    return {}
  }
}

export function openAIResponseToAnthropic(body: any, fallbackModel: string): any {
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
    id: body?.id || generateAnthropicRequestId(),
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

function writeAnthropicEvent(stream: PassThrough, event: string, data: any): void {
  stream.write(`event: ${event}\n`)
  stream.write(`data: ${JSON.stringify(data)}\n\n`)
}

export function transformOpenAIStreamToAnthropic(openAIStream: NodeJS.ReadableStream, model: string): PassThrough {
  const out = new PassThrough()
  let buffer = ''
  let messageId = generateAnthropicRequestId()
  let textBlockIndex: number | null = null
  let nextBlockIndex = 0
  const toolBlockIndexes = new Map<number, { anthropicIndex: number; id: string; name: string }>()

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
    if (textBlockIndex !== null) return textBlockIndex
    textBlockIndex = nextBlockIndex++
    writeAnthropicEvent(out, 'content_block_start', {
      type: 'content_block_start',
      index: textBlockIndex,
      content_block: { type: 'text', text: '' },
    })
    return textBlockIndex
  }

  const closeTextBlock = () => {
    if (textBlockIndex === null) return
    writeAnthropicEvent(out, 'content_block_stop', {
      type: 'content_block_stop',
      index: textBlockIndex,
    })
    textBlockIndex = null
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
      closeTextBlock()
      const openAIIndex = toolCall.index ?? 0
      let toolBlock = toolBlockIndexes.get(openAIIndex)
      if (toolBlock === undefined) {
        toolBlock = {
          anthropicIndex: nextBlockIndex++,
          id: toolCall.id || `toolu_${openAIIndex}`,
          name: toolCall.function?.name || '',
        }
        toolBlockIndexes.set(openAIIndex, toolBlock)
        writeAnthropicEvent(out, 'content_block_start', {
          type: 'content_block_start',
          index: toolBlock.anthropicIndex,
          content_block: {
            type: 'tool_use',
            id: toolBlock.id,
            name: toolBlock.name,
            input: {},
          },
        })
      }

      const partialJson = toolCall.function?.arguments || ''
      if (partialJson) {
        writeAnthropicEvent(out, 'content_block_delta', {
          type: 'content_block_delta',
          index: toolBlock.anthropicIndex,
          delta: { type: 'input_json_delta', partial_json: partialJson },
        })
      }
    }

    if (choice.finish_reason) {
      closeTextBlock()
      for (const { anthropicIndex } of [...toolBlockIndexes.values()].sort((a, b) => a.anthropicIndex - b.anthropicIndex)) {
        writeAnthropicEvent(out, 'content_block_stop', { type: 'content_block_stop', index: anthropicIndex })
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

export function anthropicError(message: string, type: string = 'invalid_request_error') {
  return {
    type: 'error',
    error: {
      type,
      message,
    },
  }
}

export function classifyAnthropicSelectionFailure(input: {
  requestedModel: string
  supportedProviderCount: number
  configuredAccountCount: number
  availableAccountCount: number
}): { type: string; message: string; diagnosticClass: AnthropicTerminalErrorClass } {
  if (input.supportedProviderCount === 0) {
    return {
      type: 'not_found_error',
      message: `No enabled provider supports requested model: ${input.requestedModel}`,
      diagnosticClass: 'no_provider_configured',
    }
  }

  if (input.configuredAccountCount === 0) {
    return {
      type: 'authentication_error',
      message: `No configured account for model: ${input.requestedModel}`,
      diagnosticClass: 'no_account_configured',
    }
  }

  if (input.availableAccountCount === 0) {
    return {
      type: 'api_error',
      message: `No available account for model: ${input.requestedModel}`,
      diagnosticClass: 'no_account_available',
    }
  }

  return {
    type: 'api_error',
    message: `Model selection failed for: ${input.requestedModel}`,
    diagnosticClass: 'selection_failed',
  }
}

export function classifyAnthropicForwardError(
  status: number | undefined,
  error: string | undefined,
): { type: string; message: string; diagnosticClass: AnthropicTerminalErrorClass } {
  const message = error || 'Request failed'
  const normalized = message.toLowerCase()

  if (status === 401 || status === 403) {
    return { type: 'authentication_error', message, diagnosticClass: 'provider_auth_failure' }
  }
  if (status === 404) {
    return { type: 'not_found_error', message, diagnosticClass: 'provider_model_not_found' }
  }
  if (status === 429) {
    return { type: 'rate_limit_error', message, diagnosticClass: 'provider_rate_limited' }
  }
  if (normalized.includes('authoritative tool catalog')) {
    return { type: 'api_error', message, diagnosticClass: 'tool_catalog_drift' }
  }
  if (
    normalized.includes('malformed')
    || normalized.includes('invalid response')
    || normalized.includes('unexpected response')
    || normalized.includes('provider_empty_output')
  ) {
    return { type: 'api_error', message, diagnosticClass: 'malformed_provider_response' }
  }

  return { type: 'api_error', message, diagnosticClass: 'provider_request_failed' }
}
