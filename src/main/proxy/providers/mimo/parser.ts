/**
 * parser.ts — Mimo provider
 *
 * Pure parsing logic for Mimo (Xiaomi AI Studio) provider.
 * Handles SSE stream parsing and OpenAI-format conversion.
 *
 * Extracted from adapters/mimo.ts (MimoStreamHandler, tool call parsing,
 * text processing functions).
 */

import type { ToolCallingPlan } from '../../toolCalling/types.ts'
import { ToolStreamParser } from '../../toolCalling/ToolStreamParser.ts'
import { logger } from '../../shared/logger.ts'
import type {
  ProviderRuntimeEvent,
  ProviderRuntimeResult,
  ProviderWebResponse,
  ProviderRuntimeStreamInput,
} from '../../plugins/types.ts'

// ── Types ──────────────────────────────────────────────────────────────

interface MimoUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  reasoningTokens: number
}

interface MimoChunk {
  type: 'text' | 'usage' | 'dialogId' | 'finish' | 'message'
  content?: string
  usage?: MimoUsage
}

export interface ParsedToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

// ── UUID helper ────────────────────────────────────────────────────────

function uuid(separator: boolean = true): string {
  const id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
  return separator ? id : id.replace(/-/g, '')
}

// ── Tool call parsing ──────────────────────────────────────────────────

function parseXmlParam(xml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const re = /<(?:parameter|arg) name="([^"]+)">((?:.|\n|\r)*?)<\/(?:parameter|arg)>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const key = m[1]
    const val = m[2].trim()
    try {
      result[key] = JSON.parse(val)
    } catch {
      result[key] = val
    }
  }
  return result
}

function extractName(inner: string): string | null {
  let m = inner.match(/<name>([^<\n]+?)<\/name>/)
  if (m) return m[1].trim()
  m = inner.match(/<name=([^<>\n\/]+)/)
  if (m) return m[1].trim()
  return null
}

function parseMimoNativeToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = []
  const blockRe = /<tool_callgt;([\s\S]*?)<\/tool_call>/g
  let block: RegExpExecArray | null
  while ((block = blockRe.exec(text)) !== null) {
    let inner = block[1].trim()
    if (inner.startsWith('<tool_result>')) inner = inner.slice('<tool_result>'.length).trim()
    if (inner.endsWith('</tool_result>')) inner = inner.slice(0, -'</tool_result>'.length).trim()
    if (inner.startsWith('{')) {
      try {
        const parsed = JSON.parse(inner)
        if (parsed.name) {
          calls.push({
            id: `call_${Math.random().toString(36).slice(2, 10)}`,
            name: parsed.name,
            arguments: parsed.arguments ?? parsed.parameters ?? parsed.input ?? {},
          })
        }
      } catch {
        // skip
      }
    } else if (inner.includes('<name')) {
      const name = extractName(inner)
      if (!name) continue
      const args = parseXmlParam(inner)
      calls.push({
        id: `call_${Math.random().toString(36).slice(2, 10)}`,
        name,
        arguments: args,
      })
    } else {
      const tagMatch = inner.match(/^<([a-zA-Z_][a-zA-Z0-9_]*)>/)
      if (!tagMatch) continue
      const name = tagMatch[1].trim()
      const args: Record<string, unknown> = {}
      const paramRe4 = /<([a-zA-Z_][a-zA-Z0-9_]*?)>((?:.|\n|\r)*?)<\/\1>/g
      let pm: RegExpExecArray | null
      while ((pm = paramRe4.exec(inner)) !== null) {
        if (pm[1] === name) continue
        const key = pm[1].trim()
        const val = pm[2].trim()
        try {
          args[key] = JSON.parse(val)
        } catch {
          args[key] = val
        }
      }
      calls.push({
        id: `call_${Math.random().toString(36).slice(2, 10)}`,
        name,
        arguments: args,
      })
    }
  }
  return calls
}

export function parseToolCalls(text: string): ParsedToolCall[] {
  if (text.includes('<tool_callgt;')) {
    return parseMimoNativeToolCalls(text)
  }
  const calls: ParsedToolCall[] = []
  const blockRe = /<function_calls>([\s\S]*?)<\/function_calls>/g
  let block: RegExpExecArray | null
  while ((block = blockRe.exec(text)) !== null) {
    const invokeRe = /<invoke name="([^"]+)">([\s\S]*?)<\/invoke>/g
    let inv: RegExpExecArray | null
    while ((inv = invokeRe.exec(block[1])) !== null) {
      calls.push({
        id: `call_${Math.random().toString(36).slice(2, 10)}`,
        name: inv[1],
        arguments: parseXmlParam(inv[2]),
      })
    }
  }
  return calls
}

export function hasToolCallMarker(text: string): boolean {
  return text.includes('<tool_callgt;') || text.includes('<function_calls>')
}

// ── Citation stripping ─────────────────────────────────────────────────

const CITATION_START = '(citation'

function stripCitations(text: string): string {
  return text
    .replace(/从\(citation:\d+\)中[：:]\s*/g, '')
    .replace(/-?\s*citation:\d+[：:]\s*/g, '')
    .replace(/[（\(]\s*citation:\d+(?:,\s*citation:\d+)*\s*[）\)]/g, '')
    .replace(/citation:\d+(?:,\s*citation:\d+)*/g, '')
    .replace(/\(citation:\d+\)/g, '')
    .replace(/\[\d+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripCitationsWithBuffer(text: string, buffer: { value: string }): string {
  const combined = buffer.value + text

  let cleaned = combined
    .replace(/从\(citation:\d+\)中[：:]\s*/g, '')
    .replace(/-?\s*citation:\d+[：:]\s*/g, '')
    .replace(/[（\(]\s*citation:\d+(?:,\s*citation:\d+)*\s*[）\)]/g, '')
    .replace(/citation:\d+(?:,\s*citation:\d+)*/g, '')
    .replace(/\(citation:\d+\)/g, '')
    .replace(/\[\d+\]/g, '')

  const lastCitationStart = cleaned.lastIndexOf(CITATION_START)
  if (lastCitationStart !== -1) {
    const afterCitation = cleaned.slice(lastCitationStart)
    if (!afterCitation.includes(')')) {
      buffer.value = afterCitation
      cleaned = cleaned.slice(0, lastCitationStart)
    } else {
      buffer.value = ''
    }
  } else {
    buffer.value = ''
  }

  return cleaned.replace(/\s+/g, ' ').trim()
}

// ── Think tag processing ───────────────────────────────────────────────

function stripThinkTags(text: string): string {
  text = text.replace(/\u0000/g, '')
  text = text.replace(/^<think[^>]*>/, '')
  text = text.replace(/^&gt;/, '')
  text = text.replace(/^hink>/, '')
  text = text.replace(/^ink>/, '')
  text = text.replace(/^nk>/, '')
  text = text.replace(/^k>/, '')
  text = text.replace(/^>/, '')
  return text
}

function stripThink(text: string): string {
  text = text.replace(/\u0000/g, '')
  text = text.replace(/<think[\s\S]*?<\/think>/g, '')
  text = text.replace(/<think[\s\S]*?<\/thinkgt;/g, '')
  const openIdx = text.indexOf('<think')
  if (openIdx !== -1) text = text.slice(0, openIdx)
  return text.trimStart()
}

function extractThinkContent(text: string): { thinking: string; content: string } {
  let thinking = ''
  let content = text

  const thinkRegex = /<think[^>]*>([\s\S]*?)<\/think>/g
  let match
  while ((match = thinkRegex.exec(text)) !== null) {
    thinking += match[1]
  }

  const thinkRegex2 = /<think[^>]*>([\s\S]*?)<\/thinkgt;/g
  while ((match = thinkRegex2.exec(text)) !== null) {
    thinking += match[1]
  }

  content = stripThink(text)

  const openIdx = text.indexOf('<think')
  if (openIdx !== -1 && !text.includes('</think') && !text.includes('</thinkgt;')) {
    const partialThink = text.slice(openIdx)
    thinking += partialThink.replace(/<think[^>]*>/, '')
  }

  return { thinking, content }
}

// ── MimoStreamHandler ──────────────────────────────────────────────────

export class MimoStreamHandler {
  private model: string
  private conversationId: string
  private content: string = ''
  private thinking: string = ''
  private usage: MimoUsage | null = null
  private dialogId: string = ''
  private toolCalls: ParsedToolCall[] = []
  private thinkingMode: 'passthrough' | 'strip' | 'separate' = 'strip'
  private lastSentContentLen: number = 0
  private lastSentThinkLen: number = 0
  private toolCallBuf: string | null = null
  private pendingText: string = ''
  private citationBuffer: { value: string } = { value: '' }
  private thinkingCitationBuffer: { value: string } = { value: '' }
  private toolStreamParser?: ToolStreamParser

  constructor(
    model: string,
    conversationId: string,
    thinkingMode: 'passthrough' | 'strip' | 'separate' = 'strip',
    toolCallingPlan?: ToolCallingPlan
  ) {
    this.model = model
    this.conversationId = conversationId
    this.thinkingMode = thinkingMode
    this.toolStreamParser = toolCallingPlan?.shouldParseResponse ? new ToolStreamParser(toolCallingPlan) : undefined
  }

  async *handleStream(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
    const id = `chatcmpl-${uuid(false)}`
    const created = Math.floor(Date.now() / 1000)

    let buffer = ''
    let currentEvent = ''
    let providerFrameCount = 0
    let sentRole = false

    let state: 'init' | 'thinking' | 'content' = 'init'
    let totalContent = ''
    let lastProcessedIndex = 0
    let thinkEndTagFound = false
    const thinkEndTag1 = '</think>'
    const thinkEndTag2 = '</thinkgt;'

    for await (const chunk of stream) {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()

        if (trimmed.startsWith('event:')) {
          currentEvent = trimmed.slice(6).trim()
        } else if (trimmed.startsWith('data:')) {
          try {
            const dataStr = trimmed.slice(5).trim()
            const data = JSON.parse(dataStr)
            providerFrameCount++
            const mimoChunk: MimoChunk = { type: currentEvent as any, ...data }

            if ((mimoChunk.type === 'message' || mimoChunk.type === 'text') && mimoChunk.content) {
              const newText = (mimoChunk.content ?? '').replace(/\u0000/g, '')
              totalContent += newText
              this.content = totalContent

              if (state === 'init') {
                const thinkStartIdx = totalContent.indexOf('<think')
                if (thinkStartIdx !== -1) {
                  state = 'thinking'
                  lastProcessedIndex = thinkStartIdx
                } else {
                  state = 'content'
                }
              }

              if (state === 'thinking') {
                if (!thinkEndTagFound) {
                  let thinkEndIdx = totalContent.indexOf(thinkEndTag1, lastProcessedIndex)
                  let actualEndTag = thinkEndTag1

                  if (thinkEndIdx === -1) {
                    thinkEndIdx = totalContent.indexOf(thinkEndTag2, lastProcessedIndex)
                    actualEndTag = thinkEndTag2
                  }

                  if (thinkEndIdx !== -1) {
                    thinkEndTagFound = true

                    const thinkContent = totalContent.slice(lastProcessedIndex, thinkEndIdx)
                    const cleanedThink = stripThinkTags(thinkContent)
                    const cleanedThinkWithCitations = stripCitationsWithBuffer(cleanedThink, this.thinkingCitationBuffer)

                    if (cleanedThinkWithCitations && this.thinkingMode === 'separate') {
                      yield this.formatOpenAIChunk(id, created, { reasoning_content: cleanedThinkWithCitations })
                    }

                    lastProcessedIndex = thinkEndIdx + actualEndTag.length
                    state = 'content'
                  } else {
                    const thinkContent = totalContent.slice(lastProcessedIndex)
                    const cleanedThink = stripThinkTags(thinkContent)
                    const cleanedThinkWithCitations = stripCitationsWithBuffer(cleanedThink, this.thinkingCitationBuffer)

                    if (cleanedThinkWithCitations && this.thinkingMode === 'separate') {
                      yield this.formatOpenAIChunk(id, created, { reasoning_content: cleanedThinkWithCitations })
                    }

                    lastProcessedIndex = totalContent.length
                  }
                }
              }

              if (state === 'content' && lastProcessedIndex < totalContent.length) {
                const contentPart = totalContent.slice(lastProcessedIndex)
                const cleanedContent = stripCitationsWithBuffer(contentPart, this.citationBuffer)

                if (cleanedContent) {
                  if (this.toolStreamParser) {
                    const chunks = this.toolStreamParser.push(cleanedContent, this.createBaseChunk(id, created), !sentRole)
                    for (const chunk of chunks) {
                      yield `data: ${JSON.stringify(chunk)}\n\n`
                    }
                    if (chunks.length > 0 || this.toolStreamParser.isBuffering() || this.toolStreamParser.hasEmittedToolCall()) {
                      if (chunks.length > 0) sentRole = true
                      lastProcessedIndex = totalContent.length
                      continue
                    }
                  }
                  yield this.formatOpenAIChunk(id, created, {
                    ...(!sentRole ? { role: 'assistant' } : {}),
                    content: cleanedContent,
                  })
                  sentRole = true
                }

                lastProcessedIndex = totalContent.length
              }
            } else if (mimoChunk.type === 'usage' && mimoChunk.usage) {
              this.usage = mimoChunk.usage
            } else if (mimoChunk.type === 'dialogId' && mimoChunk.content) {
              this.dialogId = mimoChunk.content
            }
          } catch {
            // Skip malformed SSE data
          }
        }
      }
    }

    if (providerFrameCount === 0) {
      yield `data: ${JSON.stringify({
        error: {
          code: 'EMPTY_PROVIDER_STREAM',
          message: 'Mimo provider stream closed before emitting any provider event',
        },
      })}\n\n`
      return
    }

    const flushChunks = this.toolStreamParser?.flush(this.createBaseChunk(id, created)) ?? []
    for (const chunk of flushChunks) {
      yield `data: ${JSON.stringify(chunk)}\n\n`
    }

    yield this.formatOpenAIChunk(id, created, {}, this.toolStreamParser?.hasEmittedToolCall() ? 'tool_calls' : 'stop')

    if (this.usage) {
      yield this.formatOpenAIUsageChunk(id, created, this.usage)
    }
  }

  async handleNonStream(stream: NodeJS.ReadableStream): Promise<string> {
    let buffer = ''
    let currentEvent = ''

    for await (const chunk of stream) {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()

        if (trimmed.startsWith('event:')) {
          currentEvent = trimmed.slice(6).trim()
        } else if (trimmed.startsWith('data:')) {
          try {
            const data = JSON.parse(trimmed.slice(5).trim())
            const mimoChunk: MimoChunk = { type: currentEvent as any, ...data }

            if ((mimoChunk.type === 'message' || mimoChunk.type === 'text') && mimoChunk.content) {
              const text = (mimoChunk.content ?? '').replace(/\u0000/g, '')
              this.content += text
            } else if (mimoChunk.type === 'usage' && mimoChunk.usage) {
              this.usage = mimoChunk.usage
            } else if (mimoChunk.type === 'dialogId' && mimoChunk.content) {
              this.dialogId = mimoChunk.content
            }
          } catch {
            // Skip malformed SSE data
          }
        }
      }
    }

    if (hasToolCallMarker(this.content)) {
      this.toolCalls = parseToolCalls(this.content)
    }

    let finalContent = this.content
    let reasoningContent: string | undefined

    if (this.thinkingMode === 'strip') {
      finalContent = stripThink(this.content)
    } else if (this.thinkingMode === 'separate') {
      const extracted = extractThinkContent(this.content)
      finalContent = extracted.content
      reasoningContent = extracted.thinking
    }

    finalContent = stripCitations(finalContent)
    if (reasoningContent) {
      reasoningContent = stripCitations(reasoningContent)
    }

    const id = `chatcmpl-${uuid(false)}`
    const created = Math.floor(Date.now() / 1000)

    const response: any = {
      id,
      object: 'chat.completion',
      created,
      model: this.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: finalContent,
          },
          finish_reason: this.toolCalls.length > 0 ? 'tool_calls' : 'stop',
        },
      ],
      usage: this.usage
        ? {
            prompt_tokens: this.usage.promptTokens,
            completion_tokens: this.usage.completionTokens,
            total_tokens: this.usage.totalTokens,
          }
        : undefined,
    }

    if (this.toolCalls.length > 0) {
      response.choices[0].message.tool_calls = this.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      }))
    }

    if (reasoningContent) {
      response.choices[0].message.reasoning_content = reasoningContent
    }

    return JSON.stringify(response)
  }

  // ── Private formatting helpers ──────────────────────────────────────

  private formatOpenAIChunk(
    id: string,
    created: number,
    delta: { role?: string; content?: string; reasoning_content?: string },
    finishReason?: string
  ): string {
    const chunk: any = {
      id,
      object: 'chat.completion.chunk',
      created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason || null,
        },
      ],
    }
    return `data: ${JSON.stringify(chunk)}\n\n`
  }

  private createBaseChunk(id: string, created: number): any {
    return {
      id,
      object: 'chat.completion.chunk',
      created,
      model: this.model,
    }
  }

  private formatOpenAIToolCallChunk(
    id: string,
    created: number,
    toolCalls: ParsedToolCall[]
  ): string {
    const chunk: any = {
      id,
      object: 'chat.completion.chunk',
      created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: toolCalls.map((tc, index) => ({
              index,
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            })),
          },
          finish_reason: null,
        },
      ],
    }
    return `data: ${JSON.stringify(chunk)}\n\n`
  }

  private formatOpenAIUsageChunk(id: string, created: number, usage: MimoUsage): string {
    const chunk: any = {
      id,
      object: 'chat.completion.chunk',
      created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: null,
        },
      ],
      usage: {
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        total_tokens: usage.totalTokens,
      },
    }
    return `data: ${JSON.stringify(chunk)}\n\n`
  }

  // ── Public accessors ────────────────────────────────────────────────

  getConversationId(): string {
    return this.conversationId
  }

  getAssistantContentForTitle(): string {
    let content = this.content
    if (this.thinkingMode === 'strip') {
      content = stripThink(content)
    } else if (this.thinkingMode === 'separate') {
      content = extractThinkContent(content).content
    }
    return stripCitations(content)
  }

  getDialogId(): string {
    return this.dialogId
  }

  getUsage(): MimoUsage | null {
    return this.usage
  }
}

// ── Public parser functions ────────────────────────────────────────────

/**
 * Parse a streaming Mimo SSE response into normalized runtime events.
 *
 * Creates a MimoStreamHandler, feeds the raw SSE stream through it,
 * and re-parses the OpenAI-format output into ProviderRuntimeEvent objects.
 */
export async function* parseMimoStream(
  input: ProviderRuntimeStreamInput,
): AsyncIterable<ProviderRuntimeEvent> {
  const { model, toolCallingPlan } = input
  const response = input.response
  const correlationId = input.correlationId

  const handler = new MimoStreamHandler(
    model,
    '',
    'separate',
    toolCallingPlan,
  )

  const rawResponse = (input.rawResponse && typeof input.rawResponse === 'object')
    ? input.rawResponse as Record<string, unknown>
    : response as unknown as Record<string, unknown>
  const responseStream = (rawResponse.data ?? response.data) as NodeJS.ReadableStream

  let openAiStream: NodeJS.ReadableStream | AsyncGenerator<string>
  try {
    openAiStream = handler.handleStream(responseStream)
  } catch (err: unknown) {
    yield {
      type: 'error',
      error: {
        status: 0,
        code: 'STREAM_INIT_ERROR',
        message: err instanceof Error ? err.message : 'Failed to initialize stream handler',
        retryable: true,
        classified: true,
      },
    }
    return
  }

  let buffer = ''
  let emittedSessionUpdate = false
  let parsedFrameCount = 0
  let emittedProviderEventCount = 0

  logger.info('[MimoProviderPlugin] Production stream parse start:', JSON.stringify({
    correlationId,
    model,
    status: response.status,
    contentType: response.headers?.['content-type'] ?? null,
    responseDataKind: response.data == null ? 'nullish' : typeof response.data,
    responseDataReadable: Boolean((response.data as any)?.pipe && (response.data as any)?.on),
    shouldParseTools: Boolean(toolCallingPlan?.shouldParseResponse),
    protocol: toolCallingPlan?.protocol ?? null,
    actionConstraint: input.toolActionConstraint ?? null,
  }))

  try {
    for await (const chunk of openAiStream) {
      buffer += chunk.toString()

      while (true) {
        const dblNewline = buffer.indexOf('\n\n')
        if (dblNewline === -1) break

        const eventBlock = buffer.slice(0, dblNewline)
        buffer = buffer.slice(dblNewline + 2)

        const dataLine = eventBlock
          .split('\n')
          .find((line) => line.startsWith('data:'))
        if (!dataLine) continue

        const payload = dataLine.slice(5).trim()
        if (!payload || payload === '[DONE]') continue

        let parsed: Record<string, any>
        try {
          parsed = JSON.parse(payload)
          parsedFrameCount++
        } catch {
          logger.warn('[MimoProviderPlugin] Production stream parse skipped invalid JSON frame:', JSON.stringify({
            correlationId,
            payloadLength: payload.length,
          }))
          continue
        }

        if (parsed.error) {
          const statusCode = Number(parsed.error.code ?? 0)
          const code = String(parsed.error.code ?? 'STREAM_ERROR')
          const message = String(parsed.error.message ?? 'Stream error')
          logger.error('[MimoProviderPlugin] Production stream parse provider error:', JSON.stringify({
            correlationId,
            model,
            code,
            message,
            parsedFrameCount,
            emittedProviderEventCount,
          }))
          yield {
            type: 'error',
            error: {
              status: Number.isFinite(statusCode) ? statusCode : 0,
              code,
              message,
              retryable: statusCode >= 500 || statusCode === 0,
              classified: true,
            },
          }
          return
        }

        if (!emittedSessionUpdate && handler.getDialogId()) {
          emittedSessionUpdate = true
          emittedProviderEventCount++
          yield {
            type: 'session_update',
            sessionId: handler.getDialogId() || undefined,
            parentId: handler.getDialogId() || undefined,
          }
        }

        const choice = parsed.choices?.[0]
        const delta = choice?.delta ?? {}
        const finishReason = choice?.finish_reason

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          emittedProviderEventCount++
          yield { type: 'text_delta', text: delta.content }
        }
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          emittedProviderEventCount++
          yield { type: 'text_delta', text: delta.reasoning_content }
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) {
            emittedProviderEventCount++
            yield {
              type: 'tool_call_delta',
              call: {
                index: Number(call.index ?? 0),
                id: typeof call.id === 'string' ? call.id : undefined,
                function: call.function
                  ? {
                      ...(typeof call.function.name === 'string' ? { name: call.function.name } : {}),
                      ...(typeof call.function.arguments === 'string' ? { arguments: call.function.arguments } : {}),
                    }
                  : undefined,
              },
            }
          }
        }

        if (finishReason) {
          emittedProviderEventCount++
          logger.info('[MimoProviderPlugin] Production stream parse finish:', JSON.stringify({
            correlationId,
            model,
            finishReason,
            parsedFrameCount,
            emittedProviderEventCount,
            emittedSessionUpdate,
          }))
          yield { type: 'done', finishReason }
        }
      }
    }
  } catch (err: unknown) {
    logger.error('[MimoProviderPlugin] Production stream parse error:', JSON.stringify({
      correlationId,
      model,
      message: err instanceof Error ? err.message : String(err),
    }))
    yield {
      type: 'error',
      error: {
        status: 0,
        code: 'STREAM_ERROR',
        message: err instanceof Error ? err.message : 'Stream processing error',
        retryable: true,
        classified: true,
      },
    }
  }
}

/**
 * Parse a non-streaming Mimo response into a normalized result.
 */
export async function parseMimoNonStream(
  input: ProviderWebResponse,
): Promise<ProviderRuntimeResult> {
  let sessionId = ''
  let reqId = ''

  try {
    const data = input.data as Record<string, unknown>
    if (data?.dialogId) {
      sessionId = String(data.dialogId)
    }
    if (typeof input.data === 'string' || input.data instanceof String) {
      const text = String(input.data)
      const dialogMatch = text.match(/"dialogId"\s*:\s*"([^"]+)"/)
      if (dialogMatch) {
        sessionId = dialogMatch[1]
      }
    }
  } catch {
    // Ignore parse errors, return empty strings
  }

  return {
    sessionId,
    reqId,
    response: input,
  }
}
