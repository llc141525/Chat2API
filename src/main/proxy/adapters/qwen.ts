import { logger } from '../shared/logger.ts'
/**
 * ADR-001: Tool prompt injection is owned by ToolCallingEngine.
 * This file is a Provider Adapter — it must NEVER import
 * hasToolPromptInjected, toolsToSystemPrompt, TOOL_WRAP_HINT,
 * or shouldInjectToolPrompt.
 *
 * Qwen Adapter
 * Implements Qwen (Tongyi Qianwen) web API protocol
 * Based on new chat2.qianwen.com API
 */

import axios from 'axios'
import type { AxiosResponse } from 'axios'
import { PassThrough } from 'stream'
import { createGunzip, createInflate, createBrotliDecompress } from 'zlib'
import * as ZstdCodec from 'zstd-codec'
import { createParser } from 'eventsource-parser'
import type { Account, Provider } from '../../store/types.ts'
import { parseToolCallsFromText, type ParsedToolCall } from '../utils/toolParser.ts'
import { createBaseChunk } from '../utils/streamToolHandler.ts'
import { getProviderToolProfile } from '../toolCalling/providerProfiles.ts'
import { ToolStreamParser } from '../toolCalling/ToolStreamParser.ts'
import { getToolProtocol } from '../toolCalling/protocols/index.ts'
import type { ToolCallingPlan } from '../toolCalling/types.ts'
import { inspectStreamAssistantOutput } from '../toolCalling/outputInspection.ts'
import { renderFinalPrompt } from './renderFinalPrompt.ts'
import { selectProviderMessagesForAssembly, type RequestAssembly } from '../RequestAssembly.ts'
import type { PromptRefreshMode } from '../promptBudgetPolicy.ts'

const QWEN_API_BASE = 'https://chat2.qianwen.com'
const QWEN_CHAT2_API_BASE = 'https://chat2-api.qianwen.com'
const QWEN_CHAT_SIDE_API_BASE = 'https://chat-side.qianwen.com'

const MODEL_MAP: Record<string, string> = {
  'Qwen3.6': 'Qwen',
  'Qwen3.7-Max': 'Qwen3.7-Max',
  'Qwen3.5-Flash': 'Qwen3.5-Flash',
  'Qwen3-Max': 'Qwen3-Max',
  'Qwen3-Max-Thinking-Preview': 'Qwen3-Max-Thinking-Preview',
  'Qwen3-Coder': 'Qwen3-Coder',
}

export const DEFAULT_HEADERS = {
  Accept: 'application/json, text/event-stream, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Cache-Control': 'no-cache',
  Origin: 'https://www.qianwen.com',
  Pragma: 'no-cache',
  'Sec-Ch-Ua': '"Chromium";v="145", "Not(A:Brand";v="24", "Google Chrome";v="145"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
  Referer: 'https://www.qianwen.com/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
}

interface QwenMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | any[]
  tool_call_id?: string
  tool_calls?: any[]
}

interface ChatCompletionRequest {
  model: string
  originalModel?: string
  messages: QwenMessage[]
  tools?: any[]
  stream?: boolean
  temperature?: number
  web_search?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high'
  enableThinking?: boolean
  enableWebSearch?: boolean
  sessionId?: string
  parentReqId?: string
  promptRefreshMode?: PromptRefreshMode
}

interface QwenSessionListPage {
  sessionIds: string[]
  hasMore: boolean
  nextCursor: string
}

function uuid(separator: boolean = true): string {
  const id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
  return separator ? id : id.replace(/-/g, '')
}

function generateNonce(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

function extractTextContent(content: string | any[]): string {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .filter((item) => item.type === 'text')
      .map((item) => item.text || '')
      .join('\n')
  }
  return ''
}

interface QwenContentDeltaDecision {
  shouldEmit: boolean
  chunk: string
  resetParser: boolean
}

interface QwenAssemblyRequestBodyInput {
  assembly: RequestAssembly
  request: ChatCompletionRequest
  actualModel: string
  sessionId: string
  reqId: string
  parentReqId?: string
  timestamp: number
  enableThinking: boolean
  enableWebSearch: boolean
}

function selectQwenDeltaMessages(messages: Array<QwenMessage | import('../types.ts').ChatMessage>, hasProviderSession: boolean) {
  if (!hasProviderSession) {
    return messages
  }

  let lastAssistantToolCallIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as QwenMessage
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      lastAssistantToolCallIndex = index
      break
    }
  }

  if (lastAssistantToolCallIndex === -1) {
    return messages
  }

  return messages.slice(lastAssistantToolCallIndex)
}

function traceQwenRequestAssembly(input: {
  model: string
  messageCount: number
  systemMessageCount: number
  conversationPartCount: number
  hasManagedToolContract: boolean
  hasSummaryIsolationHeader: boolean
  finalContentLength: number
  promptRefreshMode?: PromptRefreshMode
}): void {
  logger.info('[Qwen] Request assembly trace:', JSON.stringify(input))
}

function hasManagedToolContractMarker(value: string | null | undefined): boolean {
  if (!value) {
    return false
  }

  return value.includes('catalog_fingerprint:')
    || value.includes('Tool Contract Header')
    || value.includes('<|CHAT2API|tool_calls>')
    || value.includes('<|CHAT2API|invoke')
    || value.includes('<tool_calls>')
}

function buildQwenAssemblyRequestBody(input: QwenAssemblyRequestBodyInput): any {
  const {
    assembly,
    request,
    actualModel,
    sessionId,
    reqId,
    parentReqId,
    timestamp,
    enableThinking,
    enableWebSearch,
  } = input

  const toolProfile = getProviderToolProfile('qwen')
  const baseSystemPrompts: string[] = []
  const summaryPrompts: string[] = []
  const conversationParts: string[] = []
  const activeSkillCheckpointPrompts: string[] = []
  const providerMessages = selectProviderMessagesForAssembly(assembly, {
    stripRuntimeConfig: true,
    stripToolContractHistory: true,
    dropRuntimeConfig: true,
  }) as QwenMessage[]
  const lastUserText = extractLastUserText(providerMessages)
  const explicitSummaryText = assembly.summaryText?.trim() || null
  const promptRefreshMode = request.promptRefreshMode

  // Only use delta mode when the provider already tracks the conversation server-side.
  // tool_ready without a provider session must send the full context so the model
  // sees earlier instructions, not just the latest assistant/tool delta.
  const useDeltaMessages = Boolean(request.sessionId)
  let conversationMessages = selectQwenDeltaMessages(providerMessages, useDeltaMessages)

  // Apply mode-based conversation filtering on top of delta selection
  conversationMessages = filterConversationForMode(conversationMessages, promptRefreshMode)

  const MAX_TOOL_RESULT_LENGTH = 2000
  for (const msg of providerMessages) {
    if (msg.role === 'system') {
      const content = extractTextContent(msg.content as any)
      const trimmedContent = content.trim()
      if (trimmedContent.length === 0) {
        continue
      }
      const isSummaryMessage = trimmedContent.includes('[Prior conversation summary')

      if (isSummaryMessage) {
        if (!explicitSummaryText || trimmedContent !== explicitSummaryText) {
          summaryPrompts.push(content)
        }
      } else {
        baseSystemPrompts.push(content)
        if (trimmedContent.includes('[Active skill workflow state checkpoint]')) {
          activeSkillCheckpointPrompts.push(content)
        }
      }
      continue
    }
  }

  for (const msg of conversationMessages) {
    if (msg.role === 'system') {
      continue
    }

    if (msg.role === 'user') {
      conversationParts.push(extractTextContent(msg.content as any))
    } else if (msg.role === 'assistant' && msg.tool_calls && (msg.tool_calls as any[]).length > 0) {
      const calls = (msg.tool_calls as any[]).map(tc => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }))
      conversationParts.push(toolProfile.formatAssistantToolCalls(calls))
    } else if (msg.role === 'assistant') {
      conversationParts.push(`Assistant: ${extractTextContent(msg.content as any)}`)
    } else if (msg.role === 'tool' && msg.tool_call_id) {
      const rawContent = extractTextContent(msg.content as any)
      const truncated = rawContent.length > MAX_TOOL_RESULT_LENGTH
        ? rawContent.slice(0, MAX_TOOL_RESULT_LENGTH) + '\n...(truncated)'
        : rawContent
      conversationParts.push(toolProfile.formatToolResult({
        toolCallId: msg.tool_call_id as string,
        content: truncated,
      }))
    }
  }

  if (promptRefreshMode === 'tool_ready' && activeSkillCheckpointPrompts.length > 0) {
    conversationParts.push(activeSkillCheckpointPrompts[activeSkillCheckpointPrompts.length - 1])
  }

  const effectiveSummaryText = explicitSummaryText || (summaryPrompts.length > 0 ? summaryPrompts.join('\n\n') : null)

  // Mode-based section inclusion:
  // - digest: fresh compact session receives the bounded digest plus re-derived current contract
  // - minimal: stable provider session omits summary replay but MUST keep tool contract
  //            because Qwen uses managed XML protocol — tools are embedded in the prompt,
  //            not natively supported by the provider API.
  // - full/repair/tool_ready/undefined: keep all sections
  const includeToolContract = true
  const includeSummary = promptRefreshMode !== 'minimal'

  const finalContent = renderFinalPrompt({
    systemText: baseSystemPrompts.join('\n\n') || null,
    summaryText: includeSummary ? effectiveSummaryText : null,
    toolContractText: includeToolContract ? (assembly.toolManifest?.renderedPrompt ?? null) : null,
    infrastructurePrompt: assembly.infrastructurePrompt ?? null,
    conversationText: conversationParts.length > 0 ? `User: ${conversationParts.join('\n\n')}` : '',
    template: 'prefix',
  })
  const renderedToolContract = includeToolContract ? (assembly.toolManifest?.renderedPrompt ?? null) : null
  traceQwenRequestAssembly({
    model: actualModel,
    messageCount: providerMessages.length,
    systemMessageCount: baseSystemPrompts.length + summaryPrompts.length,
    conversationPartCount: conversationParts.length,
    hasManagedToolContract: hasManagedToolContractMarker(renderedToolContract)
      || hasManagedToolContractMarker(finalContent),
    hasSummaryIsolationHeader: Boolean(effectiveSummaryText?.includes('[Prior conversation summary')),
    finalContentLength: finalContent.length,
    promptRefreshMode,
  })

  return {
    deep_search: (enableWebSearch || enableThinking) ? '1' : '0',
    req_id: reqId,
    model: actualModel,
    scene: 'chat',
    session_id: sessionId,
    sub_scene: 'chat',
    temporary: false,
    messages: [
      {
        content: finalContent,
        mime_type: 'text/plain',
        meta_data: {
          ori_query: lastUserText || finalContent,
        },
      },
    ],
    from: 'default',
    parent_req_id: parentReqId || '0',
    enable_search: enableWebSearch,
    biz_data: '{"entryPoint":"tongyigw"}',
    scene_param: request.sessionId ? 'chat' : 'first_turn',
    chat_client: 'h5',
    client_tm: timestamp.toString(),
    protocol_version: 'v2',
    biz_id: 'ai_qwen',
  }
}

export function buildQwenAssemblyRequestBodyForTest(input: QwenAssemblyRequestBodyInput): any {
  return buildQwenAssemblyRequestBody(input)
}

function filterConversationForMode(
  messages: QwenMessage[],
  mode?: PromptRefreshMode
): QwenMessage[] {
  if (mode === 'digest') {
    const nonSystem = messages.filter((m) => m.role !== 'system')
    return nonSystem.slice(-4)
  }

  if (mode === 'minimal') {
    const nonSystem = messages.filter((m) => m.role !== 'system')
    return nonSystem.slice(-4)
  }

  return messages
}

function findLastIndexOfRole(messages: QwenMessage[], role: string): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === role) return i
  }
  return -1
}

function extractLastUserText(messages: QwenMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'user') {
      return extractTextContent(message.content)
    }
  }
  return ''
}

export class QwenAdapter {
  private provider: Provider
  private account: Account
  private axiosInstance = axios.create({
    timeout: 120000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  })

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
  }

  private getTicket(): string {
    const credentials = this.account.credentials
    return credentials.ticket || credentials.tongyi_sso_ticket || ''
  }

  private mapModel(model: string): string {
    if (MODEL_MAP[model]) {
      return MODEL_MAP[model]
    }
    return model
  }

  private getApiHeaders(ticket: string): Record<string, string> {
    return {
      Cookie: `tongyi_sso_ticket=${ticket}`,
      ...DEFAULT_HEADERS,
      'Content-Type': 'application/json',
      'X-Platform': 'pc_tongyi',
      'X-DeviceId': '5b68c267-cd8e-fd0e-148a-18345bc9a104',
    }
  }

  private getApiParams(extra: Record<string, string | number> = {}): Record<string, string | number> {
    return {
      biz_id: 'ai_qwen',
      chat_client: 'h5',
      device: 'pc',
      fr: 'pc',
      pr: 'qwen',
      ut: '5b68c267-cd8e-fd0e-148a-18345bc9a104',
      la: 'zh_CN',
      tz: 'Asia/Shanghai',
      wv: '1',
      ve: '1',
      ...extra,
    }
  }

  private extractSessionIds(data: any): string[] {
    const candidateLists = [
      data?.data?.list,
      data?.data?.sessions,
      data?.data?.sessionList,
      data?.data?.records,
      data?.data?.items,
      data?.data?.dataList,
      data?.data?.result?.list,
      data?.data?.result?.records,
      data?.data?.pageData?.list,
      data?.data?.pageData?.records,
      data?.list,
      data?.sessions,
    ].filter(Array.isArray)

    const sessionIds = candidateLists.flatMap((items: any[]) => (
      items
        .map((item: any) => item?.session_id || item?.sessionId || item?.session?.id || item?.id)
        .filter((sessionId: any): sessionId is string => typeof sessionId === 'string' && sessionId.length > 0)
    ))

    return [...new Set(sessionIds)]
  }

  private async listSessions(pageNum: number, cursor?: string): Promise<QwenSessionListPage> {
    const ticket = this.getTicket()
    if (!ticket) {
      throw new Error('Qwen ticket not configured, please add ticket in account settings')
    }

    const response = await axios.post(
      `${QWEN_CHAT2_API_BASE}/api/v2/session/page/list`,
      {
        pageSize: 100,
        pageNum,
        ...(cursor ? { cursor } : {}),
      },
      {
        headers: this.getApiHeaders(ticket),
        params: this.getApiParams(),
        timeout: 15000,
        validateStatus: () => true,
      }
    )

    if (response.status !== 200 || response.data?.success === false) {
      throw new Error(`Qwen session list failed: HTTP ${response.status}`)
    }

    const data = response.data?.data || {}
    const nextCursor = data.nextCursor || data.next_cursor || data.cursor || ''

    return {
      sessionIds: this.extractSessionIds(response.data),
      hasMore: Boolean(data.hasMore ?? data.has_more ?? data.page?.hasMore ?? data.result?.hasMore),
      nextCursor: typeof nextCursor === 'string' ? nextCursor : '',
    }
  }

  private async deleteRelatedFileRecords(sessionIds: string[]): Promise<boolean> {
    const ticket = this.getTicket()
    if (!ticket || sessionIds.length === 0) {
      return true
    }

    const timestamp = Date.now()
    const response = await axios.post(
      `${QWEN_CHAT_SIDE_API_BASE}/api/v2/file/record/delete`,
      { sessionIds },
      {
        headers: this.getApiHeaders(ticket),
        params: this.getApiParams({
          nonce: generateNonce(),
          timestamp,
        }),
        timeout: 15000,
        validateStatus: () => true,
      }
    )

    if (response.status !== 200 || response.data?.success === false) {
      logger.warn('[Qwen] Failed to delete related file records:', response.status, response.data)
      return false
    }

    return true
  }

  private async deleteSessions(sessionIds: string[]): Promise<boolean> {
    const ticket = this.getTicket()
    if (!ticket || sessionIds.length === 0) {
      return sessionIds.length === 0
    }

    const response = await axios.post(
      `${QWEN_CHAT2_API_BASE}/api/v1/session/delete/batch`,
      { session_ids: sessionIds },
      {
        headers: this.getApiHeaders(ticket),
        params: this.getApiParams(),
        timeout: 15000,
        validateStatus: () => true,
      }
    )

    if (response.status !== 200) {
      logger.warn(`[Qwen] Failed to delete sessions: status ${response.status}`)
      return false
    }

    const { success, code, msg } = response.data || {}
    if (success === false || (typeof code === 'number' && code !== 0)) {
      logger.warn(`[Qwen] Failed to delete sessions: ${msg || 'Unknown error'}`)
      return false
    }

    const fileRecordSuccess = await this.deleteRelatedFileRecords(sessionIds)
    if (!fileRecordSuccess) {
      logger.warn('[Qwen] Sessions deleted but related file record cleanup failed')
    }

    return true
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    try {
      if (!sessionId) {
        return false
      }

      const success = await this.deleteSessions([sessionId])
      if (success) {
        logger.info('[Qwen] Session deleted successfully:', sessionId)
      }
      return success
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      logger.warn('[Qwen] Failed to delete session:', errorMessage)
      return false
    }
  }

  async deleteAllChats(): Promise<boolean> {
    try {
      let allSessionIds: string[] = []
      let nextCursor = ''

      for (let pageNum = 1; pageNum <= 100; pageNum++) {
        const result = await this.listSessions(pageNum, nextCursor || undefined)
        allSessionIds = [...allSessionIds, ...result.sessionIds]

        if (!result.hasMore || result.sessionIds.length === 0) {
          break
        }

        nextCursor = result.nextCursor
      }

      allSessionIds = [...new Set(allSessionIds)]

      if (allSessionIds.length === 0) {
        logger.info('[Qwen] No sessions to delete')
        return true
      }

      logger.info('[Qwen] Found', allSessionIds.length, 'sessions to delete')

      for (let i = 0; i < allSessionIds.length; i += 100) {
        const batch = allSessionIds.slice(i, i + 100)
        const success = await this.deleteSessions(batch)
        if (!success) {
          return false
        }
      }

      logger.info('[Qwen] All sessions deleted successfully')
      return true
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      logger.warn('[Qwen] Failed to delete all sessions:', errorMessage)
      return false
    }
  }

  static isQwenProvider(provider: Provider): boolean {
    return provider.id === 'qwen' || provider.apiEndpoint.includes('qianwen.com') || provider.apiEndpoint.includes('aliyun.com')
  }
}

export class QwenStreamHandler {
  private sessionId: string = ''
  private model: string
  private created: number
  private onEnd?: (sessionId: string) => void
  private content: string = ''
  private responseId: string = ''
  private stopSent: boolean = false
  private toolCallsSent: boolean = false
  private hasError: boolean = false
  private toolStreamParser?: ToolStreamParser
  private toolCallingPlan?: ToolCallingPlan
  private sentRole: boolean = false
  private thinkingContent: string = ''
  private sentThinkingRole: boolean = false
  private finalized = false
  private finalAssistantResponseForHandoff?: {
    message: {
      role: 'assistant'
      content: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: {
          name: string
          arguments: string
        }
      }>
    }
    finish_reason: 'stop' | 'tool_calls'
  }

  constructor(model: string, onEnd?: (sessionId: string) => void, toolCallingPlan?: ToolCallingPlan) {
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
    this.toolCallingPlan = toolCallingPlan
    this.toolStreamParser = toolCallingPlan?.shouldParseResponse ? new ToolStreamParser(toolCallingPlan) : undefined
  }

  /**
   * Qwen has changed the mime type used for answer snapshots several times.
   * Keep protocol/control messages out, but accept any message carrying a
   * textual answer payload instead of coupling the parser to two legacy types.
   */
  private isAnswerMessage(msg: any): boolean {
    if (!msg || typeof msg !== 'object') return false
    const mimeType = typeof msg.mime_type === 'string' ? msg.mime_type : ''
    if (mimeType === 'signal/post' || mimeType === 'bar/progress') return false
    return typeof msg.content === 'string' && msg.content.length > 0
  }

  hasSessionError(): boolean {
    return this.hasError
  }

  private sendToolCalls(transStream: PassThrough): void {
    if (this.toolCallsSent) return
    
    // Use the new parser that supports both bracket and XML formats
    const { toolCalls } = parseToolCallsFromText(this.content, 'default')
    
    if (toolCalls && toolCalls.length > 0) {
      this.toolCallsSent = true
      
      // Send tool_calls delta
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i]
        transStream.write(
          `data: ${JSON.stringify({
            id: this.responseId || this.sessionId,
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: i,
                  id: tc.id,
                  type: 'function',
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments,
                  },
                }],
              },
              finish_reason: null,
            }],
            created: this.created,
          })}\n\n`
        )
      }
      
      // Send finish with tool_calls
      transStream.write(
        `data: ${JSON.stringify({
          id: this.responseId || this.sessionId,
          model: this.model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created: this.created,
        })}\n\n`
      )
      transStream.end('data: [DONE]\n\n')
      this.onEnd?.(this.sessionId)
    }
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
      : { ok: true as const, outcome: finishReason === 'tool_calls' ? 'tool_calls' : 'content' }
    this.finalAssistantResponseForHandoff = {
      message: {
        role: 'assistant',
        content: finishReason === 'tool_calls' || inspection.outcome === 'malformed_tool_output' ? null : this.content.trim(),
        ...(finishReason === 'tool_calls'
          ? {
              tool_calls: parseToolCallsFromText(this.content, 'default').toolCalls,
            }
          : {}),
      },
      finish_reason: finishReason,
    }

    if (!inspection.ok && inspection.outcome === 'malformed_tool_output') {
      logger.warn('[Qwen] Suppressed managed stream inspection failure:', JSON.stringify({
        outcome: inspection.outcome,
        error: inspection.error,
      }))
    } else if (!inspection.ok) {
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
        })}\n\n`
      )
      this.sentRole = true
    }

    transStream.write(
      `data: ${JSON.stringify({
        ...baseChunk,
        choices: [{ index: 0, delta: {}, finish_reason: inspection.ok ? finishReason : 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}\n\n`
    )
    safeEnd('data: [DONE]\n\n')
    this.onEnd?.(this.sessionId)
  }

  handleStream(stream: any, response?: AxiosResponse): PassThrough {
    const transStream = new PassThrough()

    logger.info('[Qwen] Starting stream handler...')
    
    const contentEncoding = response?.headers?.['content-encoding']
    logger.info('[Qwen] Content-Encoding:', contentEncoding)

    let buffer = ''
    let streamEnded = false

    const safeEnd = (data?: string) => {
      if (streamEnded) return
      streamEnded = true
      if (data) {
        transStream.end(data)
      } else {
        transStream.end()
      }
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
            logger.info('[Qwen] Parsed event:', eventType, 'data keys:', Object.keys(result))
            if (result.data?.messages) {
              logger.info('[Qwen] Messages count:', result.data.messages.length)
              for (const msg of result.data.messages) {
                logger.info('[Qwen] Message:', msg.mime_type, 'status:', msg.status, 'content length:', msg.content?.length || 0)
              }
            }

            if (result.communication) {
              if (!this.sessionId && result.communication.sessionid) {
                this.sessionId = result.communication.sessionid
              }
              if (!this.responseId && result.communication.reqid) {
                this.responseId = result.communication.reqid
              }
            }

            if (result.data?.messages) {
              // First pass: collect thinking content and answer content
              // Strategy: only use deep_think type to avoid duplicate content from multimodal_chat_think
              let eventThinkingContent = ''
              let eventThinkingType = ''
              const eventMessages: Array<{ msg: any, hasMultiLoad: boolean }> = []

              for (const msg of result.data.messages) {
                logger.info('[Qwen] Message detail:', JSON.stringify(msg).substring(0, 500))

                // Collect thinking content from meta_data.multi_load
                const metaData = msg.meta_data || {}
                const multiLoad = metaData.multi_load || []
                let msgHasMultiLoad = false
                for (const load of multiLoad) {
                  if (load.type === 'deep_think' && load.content) {
                    // Only use deep_think type for thinking content
                    // multimodal_chat_think may contain slightly different content causing duplicates
                    const newThinkingContent = load.content.think_content || load.content.content || ''
                    if (newThinkingContent.length > eventThinkingContent.length) {
                      eventThinkingContent = newThinkingContent
                      eventThinkingType = load.type
                    }
                    msgHasMultiLoad = true
                  } else if (load.type === 'multimodal_chat_think') {
                    // Only fall back to multimodal_chat_think if no deep_think exists in this event
                    if (!msgHasMultiLoad && load.content) {
                      const newThinkingContent = load.content.think_content || load.content.content || ''
                      if (newThinkingContent.length > eventThinkingContent.length) {
                        eventThinkingContent = newThinkingContent
                        eventThinkingType = load.type
                      }
                      msgHasMultiLoad = true
                    }
                  }
                }
                eventMessages.push({ msg, hasMultiLoad: msgHasMultiLoad })
              }

              // Process thinking content (once per event, only before answer phase starts)
              // Once answer content has been sent (sentRole), stop emitting reasoning_content
              if (!this.sentRole && eventThinkingContent.length > this.thinkingContent.length) {
                const chunk = eventThinkingContent.substring(this.thinkingContent.length)
                this.thinkingContent = eventThinkingContent
                logger.info('[Qwen] Thinking chunk, length:', chunk.length, 'content:', chunk.substring(0, 50), 'type:', eventThinkingType, 'prev:', this.thinkingContent.length - chunk.length, '->', this.thinkingContent.length)

                if (chunk.trim()) {
                  // Send reasoning_content delta
                  if (!this.sentThinkingRole) {
                    transStream.write(`data: ${JSON.stringify({
                      id: this.responseId || this.sessionId,
                      model: this.model,
                      object: 'chat.completion.chunk',
                      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
                      created: this.created,
                    })}\n\n`)
                    this.sentThinkingRole = true
                  }

                  transStream.write(`data: ${JSON.stringify({
                    id: this.responseId || this.sessionId,
                    model: this.model,
                    object: 'chat.completion.chunk',
                    choices: [{ index: 0, delta: { reasoning_content: chunk }, finish_reason: null }],
                    created: this.created,
                  })}\n\n`)
                }
              }

              // Second pass: process answer content and completion status
              for (const { msg } of eventMessages) {
                
                // Filter out [(deep_think)] and [(multimodal_chat_think_*)] markers from content
                if (this.isAnswerMessage(msg)) {
                  // Skip content that is just the deep_think marker
                  let newContent = msg.content
                  if (newContent === '[(deep_think)]' || newContent.trim() === '[(deep_think)]') {
                    logger.info('[Qwen] Skipping deep_think marker')
                    continue
                  }
                  // Remove any deep_think and multimodal_chat_think markers from content
                  newContent = newContent.replace(/\[\(deep_think\)\]/g, '')
                  newContent = newContent.replace(/\[\(multimodal_chat_think_\d+\)\]/g, '')
                  
                  if (!newContent.trim()) {
                    logger.info('[Qwen] Skipping empty content after filtering')
                    continue
                  }
                  
                  logger.info('[Qwen] newContent.length:', newContent.length, 'this.content.length:', this.content.length)
                  const deltaDecision = resolveQwenContentDelta({
                    previousContent: this.content,
                    nextContent: newContent,
                    toolCallingPlan: this.toolCallingPlan,
                    toolStreamParser: this.toolStreamParser,
                  })
                  if (deltaDecision.shouldEmit) {
                    const chunk = deltaDecision.chunk
                    this.content = newContent
                    logger.info('[Qwen] Writing chunk, length:', chunk.length)

                    // Process tool call interception
                    const baseChunk = createBaseChunk(this.responseId || this.sessionId, this.model, this.created)
                    if (deltaDecision.resetParser && this.toolCallingPlan) {
                      this.toolStreamParser = new ToolStreamParser(this.toolCallingPlan)
                    }
                    const outputChunks = this.toolStreamParser?.push(chunk, baseChunk, !this.sentRole) ?? [{
                      ...baseChunk,
                      choices: [{ index: 0, delta: { ...(!this.sentRole ? { role: 'assistant' } : {}), content: chunk }, finish_reason: null }],
                    }]

                    for (const outChunk of outputChunks) {
                      transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
                    }

                    if (outputChunks.length > 0) this.sentRole = true
                    logger.info('[Qwen] Chunk written to stream')
                  } else {
                    logger.info('[Qwen] Skipping - no new content')
                  }
                }

                if (msg.status === 'complete' || msg.status === 'finished') {
                  // Complete answer snapshots may use different mime types.
                  if (this.isAnswerMessage(msg) && !this.stopSent) {
                    this.stopSent = true
                    logger.info('[Qwen] Sending stop for multi_load/iframe, content so far:', this.content.length)
                    this.finalizeStream(transStream, safeEnd)
                  }
                }
              }
            }

            if (result.error_code && result.error_code !== 0) {
              logger.error('[Qwen] API error:', result.error_code, result.error_msg)
              this.hasError = true
              transStream.write(
                `data: ${JSON.stringify({
                  error: {
                    code: String(result.error_code),
                    message: result.error_msg || String(result.error_code),
                  },
                })}\n\n`
              )
              safeEnd('data: [DONE]\n\n')
            }
          } catch (err) {
            logger.error('[Qwen] Parse error:', err, 'Data:', eventData.substring(0, 200))
          }
        }

        if (eventType === 'complete') {
          logger.info('[Qwen] Received complete event')
          if (!streamEnded && !this.stopSent) {
            this.stopSent = true
            this.finalizeStream(transStream, safeEnd)
          }
        }
      }
    }

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
        if (streamEnded) return
        try {
          const compressedData = Buffer.concat(chunks)
          ZstdCodec.run((zstd) => {
            const simple = new zstd.Simple()
            const decompressed = simple.decompress(compressedData)
            const decompressedStr = Buffer.from(decompressed).toString('utf8')
            buffer = decompressedStr
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
      logger.info('[Qwen] Stream closed')
      if (streamEnded) return
      processBuffer()
      if (!this.stopSent) {
        this.stopSent = true
        this.finalizeStream(transStream, safeEnd)
      }
    })

    return transStream
  }

  async handleNonStream(stream: any, response?: AxiosResponse): Promise<any> {
    logger.info('[Qwen] Starting non-stream handler...')

    return new Promise((resolve, reject) => {
      const data: {
        id: string
        model: string
        object: string
        choices: Array<{
          index: number
          message: { role: string; content: string | null; reasoning_content?: string; tool_calls?: any[] }
          finish_reason: string
        }>
        usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
        created: number
      } = {
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

      const finalizeWithData = (content: string) => {
        let cleanContent: string
        let toolCalls: ParsedToolCall[]
        if (this.toolCallingPlan?.shouldParseResponse) {
          const protocol = getToolProtocol(this.toolCallingPlan.protocol)
          const parsed = protocol.parse(content, { tools: this.toolCallingPlan.tools, protocol: this.toolCallingPlan.protocol })
          cleanContent = parsed.content || content
          toolCalls = parsed.toolCalls || []
        } else {
          const result = parseToolCallsFromText(content, 'qwen')
          cleanContent = result.content
          toolCalls = result.toolCalls
        }
        if (toolCalls.length > 0) {
          data.choices[0].message.content = null
          data.choices[0].message.tool_calls = toolCalls
          data.choices[0].finish_reason = 'tool_calls'
        } else {
          data.choices[0].message.content = cleanContent.trim()
        }
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
              logger.info('[Qwen] Non-stream parsed event:', eventType, 'data keys:', Object.keys(result))

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
                  // Handle thinking content from meta_data.multi_load
                  // Strategy: prefer deep_think, fall back to multimodal_chat_think only if no deep_think
                  const metaData = msg.meta_data || {}
                  const multiLoad = metaData.multi_load || []
                  let hasDeepThink = false
                  for (const load of multiLoad) {
                    if (load.type === 'deep_think' && load.content) {
                      const thinkContent = load.content.think_content || load.content.content || ''
                      if (thinkContent && thinkContent.length > thinkingAccumulator.length) {
                        thinkingAccumulator = thinkContent
                        logger.info('[Qwen] Non-stream: Thinking content length:', thinkingAccumulator.length, 'type: deep_think')
                      }
                      hasDeepThink = true
                    }
                  }
                  // Fall back to multimodal_chat_think only if no deep_think found
                  if (!hasDeepThink) {
                    for (const load of multiLoad) {
                      if (load.type === 'multimodal_chat_think' && load.content) {
                        const thinkContent = load.content.think_content || load.content.content || ''
                        if (thinkContent && thinkContent.length > thinkingAccumulator.length) {
                          thinkingAccumulator = thinkContent
                          logger.info('[Qwen] Non-stream: Thinking content length:', thinkingAccumulator.length, 'type: multimodal_chat_think (fallback)')
                        }
                      }
                    }
                  }
                  
                  if (this.isAnswerMessage(msg)) {
                    // Filter out deep_think and multimodal_chat_think markers
                    let filteredContent = msg.content.replace(/\[\(deep_think\)\]/g, '')
                    filteredContent = filteredContent.replace(/\[\(multimodal_chat_think_\d+\)\]/g, '')
                    if (filteredContent.length > contentAccumulator.length) {
                      contentAccumulator = filteredContent
                    }
                  }

                  if (msg.status === 'complete' || msg.status === 'finished') {
                    if (this.isAnswerMessage(msg)) {
                      logger.info('[Qwen] Non-stream finished, content length:', contentAccumulator.length)
                      this.content = contentAccumulator
                      
                      // Parse tool calls from content
                      let cleanContent: string
                      let toolCalls: ParsedToolCall[]
                      if (this.toolCallingPlan?.shouldParseResponse) {
                        const protocol = getToolProtocol(this.toolCallingPlan.protocol)
                        const parsed = protocol.parse(contentAccumulator, { tools: this.toolCallingPlan.tools, protocol: this.toolCallingPlan.protocol })
                        cleanContent = parsed.content || contentAccumulator
                        toolCalls = parsed.toolCalls || []
                      } else {
                        const result = parseToolCallsFromText(contentAccumulator, 'qwen')
                        cleanContent = result.content
                        toolCalls = result.toolCalls
                      }

                      if (toolCalls.length > 0) {
                        data.choices[0].message.content = null
                        ;(data.choices[0].message as any).tool_calls = toolCalls
                        data.choices[0].finish_reason = 'tool_calls'
                      } else {
                        data.choices[0].message.content = cleanContent.trim()
                      }
                      
                      // Add reasoning_content if available
                      if (thinkingAccumulator) {
                        data.choices[0].message.reasoning_content = thinkingAccumulator
                      }
                      
                      this.onEnd?.(this.sessionId)
                      resolved = true
                      resolve(data)
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
            logger.info('[Qwen] Non-stream complete event, content length:', contentAccumulator.length)
            this.content = contentAccumulator
            finalizeWithData(contentAccumulator)
            // Add reasoning_content if available
            if (thinkingAccumulator) {
              data.choices[0].message.reasoning_content = thinkingAccumulator
            }
            resolved = true
            resolve(data)
            return
          }
        }
      }

      let decompressStream: any = stream
      
      const contentEncoding = response?.headers?.['content-encoding']?.toLowerCase()
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
            const compressedData = Buffer.concat(chunks)
            ZstdCodec.run((zstd) => {
              const simple = new zstd.Simple()
              const decompressed = simple.decompress(compressedData)
              const decompressedStr = Buffer.from(decompressed).toString('utf8')
              buffer = decompressedStr
              processBuffer()
              logger.info('[Qwen] Zstd non-stream finished, content length:', contentAccumulator.length)
              this.content = contentAccumulator
              finalizeWithData(contentAccumulator)
              // Add reasoning_content if available
              if (thinkingAccumulator) {
                data.choices[0].message.reasoning_content = thinkingAccumulator
              }
              resolve(data)
            })
          } catch (err) {
            logger.error('[Qwen] Zstd decompression error:', err)
            reject(err)
          }
        })
        stream.once('error', (err: Error) => {
          logger.error('[Qwen] Non-stream error:', err)
          reject(err)
        })
        return
      }

      decompressStream.on('data', (chunk: Buffer) => {
        if (resolved) return
        buffer += chunk.toString()
        processBuffer()
      })
      decompressStream.once('error', (err: Error) => {
        if (resolved) return
        logger.error('[Qwen] Non-stream error:', err)
        reject(err)
      })
      decompressStream.once('close', () => {
        logger.info('[Qwen] Non-stream closed, content length:', contentAccumulator.length)
        if (!resolved) {
          processBuffer()
          this.content = contentAccumulator
          finalizeWithData(contentAccumulator)
          // Add reasoning_content if available
          if (thinkingAccumulator) {
            data.choices[0].message.reasoning_content = thinkingAccumulator
          }
          resolve(data)
        }
      })
      decompressStream.once('end', () => {
        logger.info('[Qwen] Non-stream ended, content length:', contentAccumulator.length)
        if (!resolved) {
          processBuffer()
          this.content = contentAccumulator
          finalizeWithData(contentAccumulator)
          // Add reasoning_content if available
          if (thinkingAccumulator) {
            data.choices[0].message.reasoning_content = thinkingAccumulator
          }
          resolve(data)
        }
      })
    })
  }

  getSessionId(): string {
    return this.sessionId
  }

  getResponseId(): string {
    return this.responseId
  }

  getFinalAssistantResponseForHandoff():
    | {
        message: {
          role: 'assistant'
          content: string | null
          tool_calls?: Array<{
            id: string
            type: 'function'
            function: {
              name: string
              arguments: string
            }
          }>
        }
        finish_reason: 'stop' | 'tool_calls'
      }
    | undefined {
    return this.finalAssistantResponseForHandoff
  }
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

export const qwenAdapter = {
  QwenAdapter,
  QwenStreamHandler,
}
