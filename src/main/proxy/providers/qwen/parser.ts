/**
 * parser.ts — Phase 3a
 *
 * Pure parsing logic for Qwen provider.
 *
 * Exports:
 *   - parseQwenStream(rawResponse, model, toolCallingPlan): AsyncIterable<ProviderRuntimeEvent>
 *   - parseQwenNonStream(rawResponse): Promise<ProviderRuntimeResult>
 */

import { createGunzip, createInflate, createBrotliDecompress } from 'zlib'
import { PassThrough } from 'stream'
import { createHash } from 'crypto'
import * as ZstdCodec from 'zstd-codec'
import { logger } from '../../shared/logger.ts'
import { parseToolCallsFromText } from '../../utils/toolParser.ts'
import { createBaseChunk } from '../../utils/streamToolHandler.ts'
import { ToolStreamParser } from '../../toolCalling/ToolStreamParser.ts'
import { inspectStreamAssistantOutput } from '../../toolCalling/outputInspection.ts'
import type { ToolCallingPlan } from '../../toolCalling/types.ts'
import type {
  ProviderRuntimeEvent,
  ProviderRuntimeResult,
  ProviderWebResponse,
  ProviderRuntimeStreamInput,
} from '../../plugins/types.ts'

// ── Public streaming parser ─────────────────────────────────────────

/**
 * Parse a streaming Qwen response into normalized runtime events.
 *
 * Accepts ProviderRuntimeStreamInput with:
 *   response.data — the response body stream (Readable)
 *   response.headers — content-encoding for auto-decompression
 *
 * Yields ProviderRuntimeEvent objects.
 */
export async function* parseQwenStream(
  input: ProviderRuntimeStreamInput,
): AsyncIterable<ProviderRuntimeEvent> {
  const { model, toolCallingPlan } = input
  const response = input.response

  const qwenHandler = new QwenEventParser(
    model,
    toolCallingPlan,
    input.correlationId,
    input.toolActionConstraint,
  )
  const contentEncoding = (response.headers?.['content-encoding'] as string)?.toLowerCase()

  // Build an axios-like response object for the handler
  const rawResponse = (input.rawResponse && typeof input.rawResponse === 'object')
    ? input.rawResponse as Record<string, unknown>
    : response as unknown as Record<string, unknown>
  const responseStream = (rawResponse.data ?? response.data) as NodeJS.ReadableStream

  const axiosLikeResponse = rawResponse.data !== undefined
    ? rawResponse
    : {
        ...rawResponse,
        status: rawResponse.status ?? response.status,
        headers: rawResponse.headers ?? response.headers,
        data: responseStream,
      }

  // Let the handler produce OpenAI-format stream
  const openAiStream = qwenHandler.handleStream(
    responseStream,
    axiosLikeResponse as any,
  )

  let buffer = ''
  let emittedSessionUpdate = false

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
        } catch {
          continue
        }

        if (parsed.error) {
          const statusCode = Number(parsed.error.code ?? 0)
          yield {
            type: 'error',
            error: {
              status: Number.isFinite(statusCode) ? statusCode : 0,
              code: String(parsed.error.code ?? 'STREAM_ERROR'),
              message: String(parsed.error.message ?? 'Stream error'),
              retryable: statusCode >= 500 || statusCode === 0,
              classified: true,
            },
          }
          return
        }

        if (!emittedSessionUpdate && (qwenHandler.getSessionId() || qwenHandler.getResponseId())) {
          emittedSessionUpdate = true
          yield {
            type: 'session_update',
            sessionId: qwenHandler.getSessionId() || undefined,
            parentId: qwenHandler.getResponseId() || undefined,
          }
        }

        const choice = parsed.choices?.[0]
        const delta = choice?.delta ?? {}
        const finishReason = choice?.finish_reason

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          yield { type: 'text_delta', text: delta.content }
        }
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          yield { type: 'text_delta', text: delta.reasoning_content }
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) {
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
          yield { type: 'done', finishReason }
        }
      }
    }

    const inspectionError = qwenHandler.getInspectionError()
    if (inspectionError) {
      yield {
        type: 'error',
        error: {
          status: 422,
          code: 'MALFORMED_TOOL_OUTPUT',
          message: inspectionError,
          retryable: true,
          classified: true,
        },
      }
    }
  } catch (err: unknown) {
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

// ── Public non-streaming parser ─────────────────────────────────────

/**
 * Parse a non-streaming Qwen response into a normalized result.
 */
export async function parseQwenNonStream(
  input: ProviderWebResponse,
): Promise<ProviderRuntimeResult> {
  // If response data is a stream (e.g. Axios with responseType: 'stream')
  if (input.data && typeof (input.data as any).on === 'function') {
    const handler = new QwenEventParser('qwen')
    const body = await handler.handleNonStream(input.data, input as any)
    return {
      sessionId: handler.getSessionId(),
      reqId: handler.getResponseId(),
      response: {
        ...input,
        data: body,
      },
    }
  }

  // Plain JSON response
  let sessionId = ''
  let reqId = ''

  try {
    const data = input.data as Record<string, any>
    if (data?.communication?.sessionid) {
      sessionId = String(data.communication.sessionid)
    }
    if (data?.communication?.reqid) {
      reqId = String(data.communication.reqid)
    }
  } catch {
    // Ignore parse errors
  }

  return {
    sessionId,
    reqId,
    response: input,
  }
}

// ── QwenEventParser — SSE stream → OpenAI-format chunks ────────────

class QwenEventParser {
  private sessionId: string = ''
  private model: string
  private created: number
  private content: string = ''
  private responseId: string = ''
  private stopSent: boolean = false
  private hasError: boolean = false
  private toolStreamParser?: ToolStreamParser
  private toolCallingPlan?: ToolCallingPlan
  private correlationId?: string
  private toolActionConstraint?: ProviderRuntimeStreamInput['toolActionConstraint']
  private sentRole: boolean = false
  private thinkingContent: string = ''
  private sentThinkingRole: boolean = false
  private finalized = false
  private inspectionError?: string

  constructor(
    model: string,
    toolCallingPlan?: ToolCallingPlan,
    correlationId?: string,
    toolActionConstraint?: ProviderRuntimeStreamInput['toolActionConstraint'],
  ) {
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
    this.toolCallingPlan = toolCallingPlan
    this.correlationId = correlationId
    this.toolActionConstraint = toolActionConstraint ?? undefined
    this.toolStreamParser = toolCallingPlan?.shouldParseResponse
      ? new ToolStreamParser(toolCallingPlan)
      : undefined
  }

  getSessionId(): string {
    return this.sessionId
  }

  getResponseId(): string {
    return this.responseId
  }

  getInspectionError(): string | undefined {
    return this.inspectionError
  }

  /**
   * Process a raw Qwen SSE stream → OpenAI-format event stream (PassThrough).
   * Handles gzip/deflate/br/zstd decompression.
   */
  handleStream(stream: any, response?: any): PassThrough {
    const transStream = new PassThrough()
    const contentEncoding = response?.headers?.['content-encoding']?.toLowerCase()
    const loggerInfo = (msg: string, ...args: any[]) => logger.info('[Qwen] ' + msg, ...args)

    let buffer = ''
    let streamEnded = false

    const safeEnd = (data?: string) => {
      if (streamEnded) return
      streamEnded = true
      if (data) transStream.end(data)
      else transStream.end()
    }

    const processBuffer = () => {
      while (true) {
        const doubleNewlineIndex = buffer.indexOf('\n\n')
        if (doubleNewlineIndex === -1) break

        const eventBlock = buffer.substring(0, doubleNewlineIndex)
        buffer = buffer.substring(doubleNewlineIndex + 2)

        const lines = eventBlock.split('\n')
        let eventType = 'message'
        let eventData = ''

        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventType = line.substring(6).trim()
          } else if (line.startsWith('data:')) {
            eventData = line.substring(5)
          }
        }

        if (eventData && eventData !== '[DONE]') {
          try {
            const result = JSON.parse(eventData)

            if (result.communication) {
              if (!this.sessionId && result.communication.sessionid) {
                this.sessionId = result.communication.sessionid
              }
              if (!this.responseId && result.communication.reqid) {
                this.responseId = result.communication.reqid
              }
            }

            if (result.data?.messages) {
              // First pass: collect thinking content
              let eventThinkingContent = ''
              const eventMessages: Array<{ msg: any; hasMultiLoad: boolean }> = []

              for (const msg of result.data.messages) {
                const metaData = msg.meta_data || {}
                const multiLoad = metaData.multi_load || []
                let msgHasMultiLoad = false

                for (const load of multiLoad) {
                  if (load.type === 'deep_think' && load.content) {
                    const newThinking = load.content.think_content || load.content.content || ''
                    if (newThinking.length > eventThinkingContent.length) {
                      eventThinkingContent = newThinking
                    }
                    msgHasMultiLoad = true
                  } else if (load.type === 'multimodal_chat_think') {
                    if (!msgHasMultiLoad && load.content) {
                      const newThinking = load.content.think_content || load.content.content || ''
                      if (newThinking.length > eventThinkingContent.length) {
                        eventThinkingContent = newThinking
                      }
                      msgHasMultiLoad = true
                    }
                  }
                }
                eventMessages.push({ msg, hasMultiLoad: msgHasMultiLoad })
              }

              // Emit thinking deltas (once per event, only before answer phase)
              if (!this.sentRole && eventThinkingContent.length > this.thinkingContent.length) {
                const chunk = eventThinkingContent.substring(this.thinkingContent.length)
                this.thinkingContent = eventThinkingContent

                if (chunk.trim()) {
                  if (!this.sentThinkingRole) {
                    transStream.write(
                      `data: ${JSON.stringify({
                        id: this.responseId || this.sessionId,
                        model: this.model,
                        object: 'chat.completion.chunk',
                        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
                        created: this.created,
                      })}\n\n`,
                    )
                    this.sentThinkingRole = true
                  }

                  transStream.write(
                    `data: ${JSON.stringify({
                      id: this.responseId || this.sessionId,
                      model: this.model,
                      object: 'chat.completion.chunk',
                      choices: [{ index: 0, delta: { reasoning_content: chunk }, finish_reason: null }],
                      created: this.created,
                    })}\n\n`,
                  )
                }
              }

              // Second pass: process answer content
              for (const { msg } of eventMessages) {
                if (this.isAnswerMessage(msg)) {
                  let newContent = msg.content
                  if (newContent === '[(deep_think)]' || newContent.trim() === '[(deep_think)]') continue
                  newContent = newContent.replace(/\[\(deep_think\)\]/g, '')
                  newContent = newContent.replace(/\[\(multimodal_chat_think_\d+\)\]/g, '')

                  if (!newContent.trim()) continue

                  const deltaDecision = resolveQwenContentDelta({
                    previousContent: this.content,
                    nextContent: newContent,
                    toolCallingPlan: this.toolCallingPlan,
                    toolStreamParser: this.toolStreamParser,
                  })

                  if (deltaDecision.shouldEmit) {
                    const chunk = deltaDecision.chunk
                    this.content = newContent

                    const baseChunk = createBaseChunk(
                      this.responseId || this.sessionId,
                      this.model,
                      this.created,
                    )

                    if (deltaDecision.resetParser && this.toolCallingPlan) {
                      this.toolStreamParser = new ToolStreamParser(this.toolCallingPlan)
                    }

                    const outputChunks = this.toolStreamParser?.push(chunk, baseChunk, !this.sentRole) ?? [
                      {
                        ...baseChunk,
                        choices: [
                          {
                            index: 0,
                            delta: {
                              ...(!this.sentRole ? { role: 'assistant' } : {}),
                              content: chunk,
                            },
                            finish_reason: null,
                          },
                        ],
                      },
                    ]

                    for (const outChunk of outputChunks) {
                      transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
                    }

                    if (outputChunks.length > 0) this.sentRole = true
                  }
                }

                if ((msg.status === 'complete' || msg.status === 'finished')) {
                  if (this.isAnswerMessage(msg) && !this.stopSent) {
                    this.stopSent = true
                    this.finalizeStream(transStream, safeEnd)
                  }
                }
              }
            }

            if (result.error_code && result.error_code !== 0) {
              this.hasError = true
              transStream.write(
                `data: ${JSON.stringify({
                  error: {
                    code: String(result.error_code),
                    message: result.error_msg || String(result.error_code),
                  },
                })}\n\n`,
              )
              safeEnd('data: [DONE]\n\n')
            }
          } catch (err) {
            logger.error('[Qwen] Parse error:', err)
          }
        }

        if (eventType === 'complete') {
          if (!streamEnded && !this.stopSent) {
            this.stopSent = true
            this.finalizeStream(transStream, safeEnd)
          }
        }
      }
    }

    // Decompression
    let decompressStream: any = stream

    if (contentEncoding === 'gzip') {
      loggerInfo('Decompressing gzip stream...')
      decompressStream = stream.pipe(createGunzip())
    } else if (contentEncoding === 'deflate') {
      loggerInfo('Decompressing deflate stream...')
      decompressStream = stream.pipe(createInflate())
    } else if (contentEncoding === 'br') {
      loggerInfo('Decompressing brotli stream...')
      decompressStream = stream.pipe(createBrotliDecompress())
    } else if (contentEncoding === 'zstd') {
      loggerInfo('Decompressing zstd stream...')
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.once('end', () => {
        if (streamEnded) return
        try {
          ZstdCodec.run((zstd) => {
            const simple = new zstd.Simple()
            const decompressed = simple.decompress(Buffer.concat(chunks))
            buffer = Buffer.from(decompressed).toString('utf8')
            processBuffer()
            if (!this.stopSent) {
              this.stopSent = true
              this.finalizeStream(transStream, safeEnd)
            }
          })
        } catch (err) {
          logger.error('[Qwen] Zstd decompression error:', err)
          safeEnd('data: [DONE]\n\n')
        }
      })
      stream.once('error', (err: Error) => {
        logger.error('[Qwen] Stream error:', err)
        safeEnd('data: [DONE]\n\n')
      })
      return transStream
    }

    decompressStream.on('data', (bufferChunk: Buffer) => {
      if (streamEnded) return
      buffer += bufferChunk.toString()
      processBuffer()
    })

    decompressStream.once('error', (err: Error) => {
      logger.error('[Qwen] Stream error:', err)
      safeEnd('data: [DONE]\n\n')
    })

    decompressStream.once('close', () => {
      if (streamEnded) return
      processBuffer()
      if (!this.stopSent) {
        this.stopSent = true
        this.finalizeStream(transStream, safeEnd)
      }
    })

    return transStream
  }

  async handleNonStream(stream: any, response?: any): Promise<any> {
    logger.info('[Qwen] Starting non-stream handler...')

    return new Promise((resolve, reject) => {
      const data: any = {
        id: '',
        model: this.model,
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        created: this.created,
      }

      let contentAccumulator = ''
      let thinkingAccumulator = ''
      let buffer = ''
      let resolved = false

      const processBuffer = () => {
        while (true) {
          const doubleNewlineIndex = buffer.indexOf('\n\n')
          if (doubleNewlineIndex === -1) break

          const eventBlock = buffer.substring(0, doubleNewlineIndex)
          buffer = buffer.substring(doubleNewlineIndex + 2)

          const lines = eventBlock.split('\n')
          let eventType = 'message'
          let eventData = ''

          for (const line of lines) {
            if (line.startsWith('event:')) eventType = line.substring(6).trim()
            else if (line.startsWith('data:')) eventData = line.substring(5)
          }

          if (eventData && eventData !== '[DONE]') {
            try {
              const result = JSON.parse(eventData)

              if (result.communication) {
                if (!data.id && result.communication.sessionid) {
                  data.id = result.communication.sessionid
                  this.sessionId = result.communication.sessionid
                }
                if (result.communication.reqid) {
                  this.responseId = result.communication.reqid
                }
              }

              if (result.data?.messages) {
                for (const msg of result.data.messages) {
                  // Thinking content from multi_load
                  const metaData = msg.meta_data || {}
                  const multiLoad = metaData.multi_load || []
                  let hasDeepThink = false
                  for (const load of multiLoad) {
                    if (load.type === 'deep_think' && load.content) {
                      const tc = load.content.think_content || load.content.content || ''
                      if (tc && tc.length > thinkingAccumulator.length) {
                        thinkingAccumulator = tc
                      }
                      hasDeepThink = true
                    }
                  }
                  if (!hasDeepThink) {
                    for (const load of multiLoad) {
                      if (load.type === 'multimodal_chat_think' && load.content) {
                        const tc = load.content.think_content || load.content.content || ''
                        if (tc && tc.length > thinkingAccumulator.length) {
                          thinkingAccumulator = tc
                        }
                      }
                    }
                  }

                  if (this.isAnswerMessage(msg)) {
                    let filtered = msg.content.replace(/\[\(deep_think\)\]/g, '')
                    filtered = filtered.replace(/\[\(multimodal_chat_think_\d+\)\]/g, '')
                    if (filtered.length > contentAccumulator.length) {
                      contentAccumulator = filtered
                    }
                  }

                  if (msg.status === 'complete' || msg.status === 'finished') {
                    if (this.isAnswerMessage(msg) && !resolved) {
                      resolveWithContent(contentAccumulator, thinkingAccumulator, data)
                      resolved = true
                      return
                    }
                  }
                }
              }
            } catch (err) {
              logger.error('[Qwen] Non-stream parse error:', err)
            }
          }

          if (eventType === 'complete' && !resolved) {
            resolveWithContent(contentAccumulator, thinkingAccumulator, data)
            resolved = true
            return
          }
        }
      }

      const contentEncoding = response?.headers?.['content-encoding']?.toLowerCase()
      let decompressStream: any = stream

      if (contentEncoding === 'gzip') {
        logger.info('[Qwen] Decompressing gzip stream...')
        decompressStream = stream.pipe(createGunzip())
      } else if (contentEncoding === 'deflate') {
        logger.info('[Qwen] Decompressing deflate stream...')
        decompressStream = stream.pipe(createInflate())
      } else if (contentEncoding === 'br') {
        logger.info('[Qwen] Decompressing brotli stream...')
        decompressStream = stream.pipe(createBrotliDecompress())
      } else if (contentEncoding === 'zstd') {
        logger.info('[Qwen] Decompressing zstd stream...')
        const chunks: Buffer[] = []
        stream.on('data', (chunk: Buffer) => chunks.push(chunk))
        stream.once('end', () => {
          try {
            ZstdCodec.run((zstd) => {
              const simple = new zstd.Simple()
              const decompressed = simple.decompress(Buffer.concat(chunks))
              buffer = Buffer.from(decompressed).toString('utf8')
              processBuffer()
              if (!resolved) {
                resolveWithContent(contentAccumulator, thinkingAccumulator, data)
              }
              resolve(data)
            })
          } catch (err) {
            reject(err)
          }
        })
        stream.once('error', (err: Error) => reject(err))
        return
      }

      decompressStream.on('data', (chunk: Buffer) => {
        if (resolved) return
        buffer += chunk.toString()
        processBuffer()
      })

      decompressStream.once('error', (err: Error) => {
        if (!resolved) reject(err)
      })

      decompressStream.once('close', () => {
        if (!resolved) {
          processBuffer()
          resolveWithContent(contentAccumulator, thinkingAccumulator, data)
        }
      })
    })
  }

  // ── Private helpers ───────────────────────────────────────────────

  private isAnswerMessage(msg: any): boolean {
    if (!msg || typeof msg !== 'object') return false
    const mimeType = typeof msg.mime_type === 'string' ? msg.mime_type : ''
    if (mimeType === 'signal/post' || mimeType === 'bar/progress') return false
    return typeof msg.content === 'string' && msg.content.length > 0
  }

  private finalizeStream(transStream: PassThrough, safeEnd: (data?: string) => void): void {
    if (this.finalized) return
    this.finalized = true

    const baseChunk = createBaseChunk(this.responseId || this.sessionId, this.model, this.created)
    const flushChunks = this.toolStreamParser?.flush(baseChunk) ?? []
    for (const outChunk of flushChunks) {
      transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
    }

    const finishReason = this.toolStreamParser?.hasEmittedToolCall() ? 'tool_calls' : 'stop'
    const inspection = this.toolCallingPlan && this.toolStreamParser
      ? inspectStreamAssistantOutput({
          plan: this.toolCallingPlan,
          observation: this.toolStreamParser.getObservation(),
          finishReason,
        })
      : { ok: true as const, outcome: finishReason === 'tool_calls' ? 'tool_calls' as const : 'content' as const }

    logger.info('[Qwen] Production response parse:', JSON.stringify({
      correlationId: this.correlationId ?? null,
      model: this.model,
      responseId: this.responseId || null,
      sessionId: this.sessionId || null,
      assistantContentChars: this.content.length,
      assistantContentHasManagedXml: containsManagedToolMarker(this.content),
      parserObservedToolCall: this.toolStreamParser?.hasEmittedToolCall() ?? false,
      finishReason,
      inspectionOk: inspection.ok,
      inspectionOutcome: inspection.outcome,
      allowedToolNames: this.toolCallingPlan ? [...this.toolCallingPlan.allowedToolNames] : [],
      parserFormat: this.toolCallingPlan?.diagnostics.parserFormat ?? null,
      parsedToolCallCount: this.toolCallingPlan?.diagnostics.parsedToolCallCount ?? 0,
      malformedReason: this.toolCallingPlan?.diagnostics.malformedReason ?? null,
      responseSha256: sha256(this.content),
      constraintOutcome: this.toolActionConstraint?.kind === 'next_required_tool'
        ? (this.toolStreamParser?.hasEmittedToolCall() ? 'required_tool_emitted' : 'required_tool_not_emitted')
        : null,
    }))

    this.inspectionError = inspection.ok ? undefined : inspection.error

    if (!inspection.ok && inspection.outcome !== 'malformed_tool_output') {
      transStream.write(
        `data: ${JSON.stringify({
          ...baseChunk,
          choices: [{
            index: 0,
            delta: {
              ...(!this.sentRole && !this.sentThinkingRole ? { role: 'assistant' } : {}),
              content: `Error: ${inspection.error}`,
            },
            finish_reason: null,
          }],
        })}\n\n`,
      )
      this.sentRole = true
    }

    transStream.write(
      `data: ${JSON.stringify({
        ...baseChunk,
        choices: [{ index: 0, delta: {}, finish_reason: inspection.ok ? finishReason : 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}\n\n`,
    )
    safeEnd('data: [DONE]\n\n')
  }
}

// ── resolveQwenContentDelta — most fragile piece, do NOT rewrite ────

interface QwenContentDeltaDecision {
  shouldEmit: boolean
  chunk: string
  resetParser: boolean
}

function resolveQwenContentDelta(input: {
  previousContent: string
  nextContent: string
  toolCallingPlan?: ToolCallingPlan
  toolStreamParser?: ToolStreamParser
}): QwenContentDeltaDecision {
  const { previousContent, nextContent, toolCallingPlan, toolStreamParser } = input

  if (nextContent === previousContent) {
    return { shouldEmit: false, chunk: '', resetParser: false }
  }

  if (nextContent.startsWith(previousContent)) {
    return {
      shouldEmit: true,
      chunk: nextContent.slice(previousContent.length),
      resetParser: false,
    }
  }

  const isManagedToolRewrite = Boolean(
    toolCallingPlan
    && toolStreamParser
    && (
      toolStreamParser.isBuffering()
      || containsManagedToolMarker(previousContent)
      || containsManagedToolMarker(nextContent)
    ),
  )

  if (isManagedToolRewrite) {
    return {
      shouldEmit: true,
      chunk: nextContent,
      resetParser: true,
    }
  }

  if (nextContent.length > previousContent.length) {
    return {
      shouldEmit: true,
      chunk: nextContent.substring(previousContent.length),
      resetParser: false,
    }
  }

  return { shouldEmit: false, chunk: '', resetParser: false }
}

function containsManagedToolMarker(value: string): boolean {
  return value.includes('<|CHAT2API|') || value.includes('<tool_calls>')
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

// ── Non-stream finalize helper ──────────────────────────────────────

function resolveWithContent(
  content: string,
  thinking: string,
  data: any,
): void {
  let cleanContent: string
  let toolCalls: any[]

  const result = parseToolCallsFromText(content, 'qwen')
  cleanContent = result.content
  toolCalls = result.toolCalls

  logger.info('[Qwen] Production non-stream response parse:', JSON.stringify({
    assistantContentChars: content.length,
    assistantContentHasManagedXml: containsManagedToolMarker(content),
    parsedToolCallCount: toolCalls.length,
    parserFormat: result.protocol ?? null,
  }))

  if (toolCalls.length > 0) {
    data.choices[0].message.content = null
    data.choices[0].message.tool_calls = toolCalls
    data.choices[0].finish_reason = 'tool_calls'
  } else {
    data.choices[0].message.content = cleanContent.trim()
  }

  if (thinking) {
    data.choices[0].message.reasoning_content = thinking
  }
}
