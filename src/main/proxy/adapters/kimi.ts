/**
 * ADR-001: Tool prompt injection is owned by ToolCallingEngine.
 * This file is a Provider Adapter — it must NEVER import
 * hasToolPromptInjected, toolsToSystemPrompt, TOOL_WRAP_HINT,
 * or shouldInjectToolPrompt.
 *
 * Kimi K2.6 Adapter
 * Implements Kimi web API protocol with thinking mode and web search support
 */

import axios, { type AxiosResponse } from 'axios'
import type { Account, Provider } from '../../store/types.ts'
import { getMaxToolResultLength } from '../shared/toolResultLimit.ts'
import { PassThrough } from 'stream'

import { parseToolCallsFromText } from '../utils/toolParser.ts'
import { createBaseChunk } from '../utils/streamToolHandler.ts'
import { createKimiChatPayload, encodeKimiGrpcFrame } from './providerModelOptions.ts'
import { getProviderToolProfile } from '../toolCalling/providerProfiles.ts'
import { ToolStreamParser } from '../toolCalling/ToolStreamParser.ts'
import { getToolProtocol } from '../toolCalling/protocols/index.ts'
import type { ToolCallingPlan } from '../toolCalling/types.ts'

const KIMI_API_BASE = 'https://www.kimi.com'

const FAKE_HEADERS: Record<string, string> = {
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  Origin: KIMI_API_BASE,
  'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Priority: 'u=1, i',
}

interface TokenInfo {
  accessToken: string
  refreshToken: string
  userId: string
  refreshTime: number
}

interface KimiMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | any[] | null
  tool_call_id?: string
  tool_calls?: any[]
}

function extractKimiTextContent(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n')
  }
  return String(content || '')
}

interface ChatCompletionRequest {
  model: string
  messages: KimiMessage[]
  stream?: boolean
  temperature?: number
  enableThinking?: boolean
  enableWebSearch?: boolean
  tools?: any[]
  tool_choice?: any
  conversationId?: string
  parentId?: string
}

const accessTokenMap = new Map<string, TokenInfo>()

function unixTimestamp(): number {
  return Math.floor(Date.now() / 1000)
}

export function detectTokenType(token: string): 'jwt' | 'refresh' {
  if (token.startsWith('eyJ') && token.split('.').length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString())
      if (payload.app_id === 'kimi' && payload.typ === 'access') {
        return 'jwt'
      }
    } catch (e) {
      // Parse failed, treat as refresh token
    }
  }
  return 'refresh'
}

function extractUserIdFromJWT(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString())
    return payload.sub
  } catch (e) {
    return undefined
  }
}

function checkResult(result: AxiosResponse, refreshToken: string): any {
  if (result.status === 401) {
    accessTokenMap.delete(refreshToken)
    throw new Error('Token invalid or expired')
  }
  if (!result.data) {
    return null
  }
  const { error_type, message } = result.data
  if (typeof error_type !== 'string') {
    return result.data
  }
  if (error_type === 'auth.token.invalid') {
    accessTokenMap.delete(refreshToken)
  }
  throw new Error(`Kimi API error: ${message || error_type}`)
}

export class KimiAdapter {
  private provider: Provider
  private account: Account
  private token: string

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
    this.token = account.credentials.token || account.credentials.refreshToken || ''
  }

  private async acquireToken(): Promise<{ accessToken: string; userId: string }> {
    if (!this.token) {
      throw new Error('Kimi Token not configured')
    }

    let result = accessTokenMap.get(this.token)
    if (result && result.refreshTime > unixTimestamp()) {
      console.log('[Kimi] Using cached token')
      return { accessToken: result.accessToken, userId: result.userId }
    }

    const tokenType = detectTokenType(this.token)
    console.log('[Kimi] Token type:', tokenType)

    if (tokenType === 'jwt') {
      const userId = extractUserIdFromJWT(this.token) || ''
      accessTokenMap.set(this.token, {
        accessToken: this.token,
        refreshToken: this.token,
        userId,
        refreshTime: unixTimestamp() + 300,
      })
      console.log('[Kimi] Using JWT token, userId:', userId)
      return { accessToken: this.token, userId }
    }

    console.log('[Kimi] Non-JWT token detected, attempting direct use...')
    accessTokenMap.set(this.token, {
      accessToken: this.token,
      refreshToken: this.token,
      userId: '',
      refreshTime: unixTimestamp() + 300,
    })
    return { accessToken: this.token, userId: '' }
  }

  private messagesPrepare(messages: KimiMessage[], toolsPrompt?: string): string {
    const toolProfile = getProviderToolProfile('kimi')
    const conversationParts: string[] = []
    let systemPrompt = ''

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt = extractKimiTextContent(msg.content)
      } else if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        conversationParts.push(toolProfile.formatAssistantToolCalls(msg.tool_calls.map(tc => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        }))))
      } else if (msg.role === 'tool' && msg.tool_call_id) {
        const rawContent = extractKimiTextContent(msg.content)
      const maxToolResultLength = getMaxToolResultLength()
      const truncated = rawContent.length > maxToolResultLength
        ? rawContent.slice(0, maxToolResultLength) + '\n...(truncated)'
          : rawContent
        conversationParts.push(toolProfile.formatToolResult({
          toolCallId: msg.tool_call_id,
          content: truncated,
        }))
      } else if (msg.role === 'assistant') {
        conversationParts.push(`Assistant: ${extractKimiTextContent(msg.content)}`)
      } else if (msg.role === 'user') {
        conversationParts.push(this.wrapUrlsToTags(extractKimiTextContent(msg.content)))
      }
    }

    const userContent = conversationParts.join('\n\n')
    let content = systemPrompt
      ? `${systemPrompt}\n\nUser: ${userContent}`
      : userContent

    if (toolsPrompt) {
      content = content.trimEnd() + '\n\n' + toolsPrompt
    }

    return content
  }

  private wrapUrlsToTags(content: string): string {
    return content.replace(
      /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)/gi,
      url => `<url id="" type="url" status="" title="" wc="">${url}</url>`
    )
  }

  async deleteConversation(conversationId: string): Promise<boolean> {
    try {
      const { accessToken } = await this.acquireToken()
      
      const response = await axios.post(
        `${KIMI_API_BASE}/apiv2/kimi.chat.v1.ChatService/DeleteChat`,
        { chat_id: conversationId },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            ...FAKE_HEADERS,
          },
          timeout: 15000,
          validateStatus: () => true,
        }
      )

      console.log('[Kimi] Chat deleted:', conversationId, 'Status:', response.status)
      return response.status === 200
    } catch (error) {
      console.error('[Kimi] Failed to delete conversation:', error)
      return false
    }
  }

  private async listChats(pageToken?: string): Promise<{ chatIds: string[]; nextPageToken: string }> {
    const { accessToken } = await this.acquireToken()
    const response = await axios.post(
      `${KIMI_API_BASE}/apiv2/kimi.chat.v1.ChatService/ListChats`,
      {
        page_size: 100,
        ...(pageToken ? { page_token: pageToken } : {}),
        query: '',
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...FAKE_HEADERS,
        },
        timeout: 15000,
        validateStatus: () => true,
      }
    )

    const data = checkResult(response, this.token)
    const chats = Array.isArray(data?.chats) ? data.chats : []
    const chatIds = chats
      .map((chat: any) => typeof chat?.id === 'string' ? chat.id : '')
      .filter(Boolean)

    return {
      chatIds,
      nextPageToken: typeof data?.nextPageToken === 'string' ? data.nextPageToken : '',
    }
  }

  private async batchDeleteChats(chatIds: string[]): Promise<boolean> {
    if (chatIds.length === 0) {
      return true
    }

    const { accessToken } = await this.acquireToken()
    const response = await axios.post(
      `${KIMI_API_BASE}/apiv2/kimi.chat.v1.ChatService/BatchDeleteChats`,
      { chat_ids: chatIds },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...FAKE_HEADERS,
        },
        timeout: 30000,
        validateStatus: () => true,
      }
    )

    checkResult(response, this.token)
    return response.status === 200
  }

  async deleteAllChats(): Promise<boolean> {
    try {
      let allChatIds: string[] = []
      let pageToken = ''

      for (let page = 0; page < 100; page++) {
        const result = await this.listChats(pageToken || undefined)
        allChatIds = [...allChatIds, ...result.chatIds]

        if (!result.nextPageToken || result.chatIds.length === 0) {
          break
        }

        pageToken = result.nextPageToken
      }

      if (allChatIds.length === 0) {
        console.log('[Kimi] No chats to delete')
        return true
      }

      console.log('[Kimi] Found', allChatIds.length, 'chats to delete')

      for (let i = 0; i < allChatIds.length; i += 100) {
        const batch = allChatIds.slice(i, i + 100)
        const success = await this.batchDeleteChats(batch)
        if (!success) {
          return false
        }
      }

      console.log('[Kimi] All chats deleted successfully')
      return true
    } catch (error) {
      console.error('[Kimi] Failed to delete all chats:', error)
      return false
    }
  }

  static isKimiProvider(provider: Provider): boolean {
    return provider.id === 'kimi' || provider.apiEndpoint.includes('kimi.com')
  }
}

const STAGE_NAME_THINKING = 'STAGE_NAME_THINKING'

export class KimiStreamHandler {
  private model: string
  private conversationId: string
  private enableThinking: boolean
  private toolStreamParser?: ToolStreamParser
  private toolCallingPlan?: ToolCallingPlan
  private realChatId: string | null = null
  private lastMessageId: string | null = null
  private hasError: boolean = false
  private currentPhase: 'thinking' | 'answer' | undefined = undefined
  private reasoningBuffer: string = ''

  constructor(model: string, conversationId: string, enableThinking: boolean = false, toolCallingPlan?: ToolCallingPlan) {
    this.model = model
    this.conversationId = conversationId
    this.enableThinking = enableThinking
    this.toolCallingPlan = toolCallingPlan
    this.toolStreamParser = toolCallingPlan?.shouldParseResponse ? new ToolStreamParser(toolCallingPlan) : undefined
  }

  getConversationId(): string | null {
    // Return realChatId if available, otherwise return null (not empty string)
    // to prevent saving invalid session IDs
    if (this.realChatId) {
      return this.realChatId
    }
    // Only return conversationId if it's a valid ID (not empty and not a temporary ID)
    if (this.conversationId && this.conversationId.length > 0 && !this.conversationId.startsWith('kimi-')) {
      return this.conversationId
    }
    return null
  }

  getLastMessageId(): string | null {
    return this.lastMessageId
  }

  hasSessionError(): boolean {
    return this.hasError
  }

  private detectMultiStage(data: any): 'thinking' | 'answer' | undefined {
    if (!data.block?.multiStage?.stages || !Array.isArray(data.block.multiStage.stages)) {
      return undefined
    }
    
    const stages = data.block.multiStage.stages
    if (stages.length === 0) {
      return undefined
    }
    
    const firstStage = stages[0]
    if (firstStage?.name === STAGE_NAME_THINKING) {
      return firstStage.status === 'completed' ? 'answer' : 'thinking'
    }
    
    return undefined
  }

  private isThinkingMask(mask: string | undefined): boolean {
    if (!mask) return false
    return mask.includes('block.think')
  }

  private isAnswerMask(mask: string | undefined): boolean {
    if (!mask) return false
    return mask.includes('block.text')
  }

  private extractThinkContent(data: any): string | null {
    return data.block?.think?.content || null
  }

  private extractTextContent(data: any): string | null {
    return data.block?.text?.content || null
  }

  async handleStream(stream: any): Promise<PassThrough> {
    const transStream = new PassThrough()
    const created = unixTimestamp()
    let buffer = Buffer.alloc(0)
    let sentRole = false

    stream.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      this.processBuffer(buffer, transStream, created, (remaining) => { buffer = remaining }, () => sentRole, (v) => { sentRole = v })
    })

    stream.once('error', (err: Error) => {
      console.error('[Kimi] Stream error:', err.message)
      if (!transStream.closed) transStream.end('data: [DONE]\n\n')
    })

    stream.once('close', () => {
      console.log('[Kimi] Stream closed, realChatId:', this.realChatId, 'lastMessageId:', this.lastMessageId)
      if (!transStream.closed) transStream.end('data: [DONE]\n\n')
    })

    return transStream
  }

  private processBuffer(
    buffer: Buffer,
    transStream: PassThrough,
    created: number,
    setBuffer: (remaining: Buffer) => void,
    getSentRole: () => boolean,
    setSentRole: (v: boolean) => void
  ) {
    let offset = 0

    // gRPC-Web frame format: 1 byte flag + 4 bytes length (big-endian) + payload
    while (offset + 5 <= buffer.length) {
      const flag = buffer.readUInt8(offset)
      const length = buffer.readUInt32BE(offset + 1)

      if (offset + 5 + length > buffer.length) {
        break
      }

      const payload = buffer.slice(offset + 5, offset + 5 + length)

      try {
        const text = payload.toString('utf8')
        if (text.trim()) {
          const data = JSON.parse(text)
          
          // Check for error response
          if (data.error) {
            console.error('[Kimi] API Error:', data.error)
            this.hasError = true
            transStream.write(`data: ${JSON.stringify({
              id: this.conversationId,
              model: this.model,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { content: `Error: ${data.error.message || JSON.stringify(data.error)}` }, finish_reason: null }],
              created,
            })}\n\n`)
            transStream.write(`data: ${JSON.stringify({
              id: this.conversationId,
              model: this.model,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              created,
            })}\n\n`)
            transStream.end('data: [DONE]\n\n')
            return
          }
          
          this.handleMessage(data, transStream, created, getSentRole, setSentRole)
        }
      } catch (e) {
        // Skip invalid JSON
      }

      offset += 5 + length
    }

    setBuffer(buffer.slice(offset))
  }

  private handleMessage(
    data: any,
    transStream: PassThrough,
    created: number,
    getSentRole: () => boolean,
    setSentRole: (v: boolean) => void
  ) {
    if (data.heartbeat) return

    if (data.chat?.id && !this.realChatId) {
      this.realChatId = data.chat.id
      console.log('[Kimi] Extracted real chat_id from chat.id:', this.realChatId)
    }

    if (data.message?.id && data.message?.role === 'assistant' && !this.lastMessageId) {
      this.lastMessageId = data.message.id
      console.log('[Kimi] Extracted assistant message id:', this.lastMessageId)
    }

    const multiStagePhase = this.detectMultiStage(data)
    if (multiStagePhase) {
      this.currentPhase = multiStagePhase
      console.log('[Kimi] Detected multiStage phase:', this.currentPhase)
    }

    if (data.block?.text?.flags === 'thinking') {
      this.currentPhase = 'thinking'
    } else if (data.block?.text?.flags === 'answer') {
      this.currentPhase = 'answer'
    }

    if ((data.op === 'set' || data.op === 'append')) {
      const mask = data.mask
      
      if (this.isThinkingMask(mask)) {
        const thinkContent = this.extractThinkContent(data)
        if (thinkContent) {
          if (!getSentRole()) {
            transStream.write(`data: ${JSON.stringify({
              id: this.getConversationId(),
              model: this.model,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
              created,
            })}\n\n`)
            setSentRole(true)
          }
          
          this.reasoningBuffer += thinkContent
          transStream.write(`data: ${JSON.stringify({
            id: this.getConversationId(),
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { reasoning_content: thinkContent }, finish_reason: null }],
            created,
          })}\n\n`)
        }
      } else if (this.isAnswerMask(mask)) {
        const textContent = this.extractTextContent(data)
        if (textContent) {
          if (!getSentRole()) {
            transStream.write(`data: ${JSON.stringify({
              id: this.getConversationId(),
              model: this.model,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
              created,
            })}\n\n`)
            setSentRole(true)
          }
          
          this.sendChunk(transStream, textContent, created)
        }
      } else if (data.block?.text?.content) {
        const content = data.block.text.content
        
        if (!getSentRole()) {
          transStream.write(`data: ${JSON.stringify({
            id: this.getConversationId(),
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
            created,
          })}\n\n`)
          setSentRole(true)
        }
        
        if (this.currentPhase === 'thinking') {
          this.reasoningBuffer += content
          transStream.write(`data: ${JSON.stringify({
            id: this.getConversationId(),
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { reasoning_content: content }, finish_reason: null }],
            created,
          })}\n\n`)
        } else {
          this.sendChunk(transStream, content, created)
        }
      }
    }

    if (data.done !== undefined) {
      const chatId = this.getConversationId() || this.conversationId
      const baseChunk = createBaseChunk(chatId, this.model, created)
      const flushChunks = this.toolStreamParser?.flush(baseChunk) ?? []
      for (const outChunk of flushChunks) {
        transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
      }

      transStream.write(`data: ${JSON.stringify({
        id: this.getConversationId(),
        model: this.model,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: this.toolStreamParser?.hasEmittedToolCall() ? 'tool_calls' : 'stop' }],
        created,
      })}\n\n`)
      transStream.end('data: [DONE]\n\n')
    }
  }

  private sendChunk(transStream: PassThrough, content: string, created: number) {
    // Process tool call interception
    // Use getConversationId() to get the real chat_id if available
    const chatId = this.getConversationId() || this.conversationId
    const baseChunk = createBaseChunk(chatId, this.model, created)
    const outputChunks = this.toolStreamParser?.push(content, baseChunk, false) ?? []

    // Check if we emitted tool calls first
    const hasToolCalls = outputChunks.some(c => c.choices?.[0]?.delta?.tool_calls)

    for (const outChunk of outputChunks) {
      transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
    }

    if (!this.toolStreamParser || (!this.toolStreamParser.isBuffering() && !this.toolStreamParser.hasEmittedToolCall() && !hasToolCalls && outputChunks.length === 0)) {
      transStream.write(`data: ${JSON.stringify({
        ...baseChunk,
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      })}\n\n`)
    }
  }

  async handleNonStream(stream: any): Promise<any> {
    const created = unixTimestamp()
    let content = ''
    let reasoningContent = ''
    let buffer = Buffer.alloc(0)
    let currentPhase: 'thinking' | 'answer' | undefined = undefined

    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])

        let offset = 0
        while (offset + 5 <= buffer.length) {
          const flag = buffer.readUInt8(offset)
          const length = buffer.readUInt32BE(offset + 1)

          if (offset + 5 + length > buffer.length) {
            break
          }

          const payload = buffer.slice(offset + 5, offset + 5 + length)

          try {
            const text = payload.toString('utf8')
            if (text.trim()) {
              const data = JSON.parse(text)

              if (data.error) {
                reject(new Error(`Kimi API Error: ${data.error.message || JSON.stringify(data.error)}`))
                return
              }

              if (data.chat?.id && !this.realChatId) {
                this.realChatId = data.chat.id
                console.log('[Kimi] Non-stream: Extracted real chat_id from chat.id:', this.realChatId)
              }

              if (data.message?.id && data.message?.role === 'assistant' && !this.lastMessageId) {
                this.lastMessageId = data.message.id
                console.log('[Kimi] Non-stream: Extracted assistant message id:', this.lastMessageId)
              }

              const multiStagePhase = this.detectMultiStage(data)
              if (multiStagePhase) {
                currentPhase = multiStagePhase
                console.log('[Kimi] Non-stream: Detected multiStage phase:', currentPhase)
              }

              if (data.block?.text?.flags === 'thinking') {
                currentPhase = 'thinking'
              } else if (data.block?.text?.flags === 'answer') {
                currentPhase = 'answer'
              }

              if ((data.op === 'set' || data.op === 'append')) {
                const mask = data.mask
                
                if (this.isThinkingMask(mask)) {
                  const thinkContent = this.extractThinkContent(data)
                  if (thinkContent) {
                    reasoningContent += thinkContent
                  }
                } else if (this.isAnswerMask(mask)) {
                  const textContent = this.extractTextContent(data)
                  if (textContent) {
                    content += textContent
                  }
                } else if (data.block?.text?.content) {
                  const textContent = data.block.text.content
                  if (currentPhase === 'thinking') {
                    reasoningContent += textContent
                  } else {
                    content += textContent
                  }
                }
              }

              if (data.done !== undefined) {
                let cleanContent: string
                let toolCalls: any[]
                if (this.toolCallingPlan?.shouldParseResponse) {
                  const protocol = getToolProtocol(this.toolCallingPlan.protocol)
                  const parsed = protocol.parse(content, { tools: this.toolCallingPlan.tools, protocol: this.toolCallingPlan.protocol })
                  cleanContent = parsed.content || content
                  toolCalls = parsed.toolCalls || []
                } else {
                  const result = parseToolCallsFromText(content, 'kimi')
                  cleanContent = result.content
                  toolCalls = result.toolCalls
                }

                const message: any = {
                  role: 'assistant',
                  content: toolCalls.length > 0 ? null : cleanContent.trim(),
                }

                if (reasoningContent.trim()) {
                  message.reasoning_content = reasoningContent.trim()
                }

                if (toolCalls.length > 0) {
                  message.tool_calls = toolCalls
                }

                resolve({
                  id: this.realChatId || this.conversationId,
                  model: this.model,
                  object: 'chat.completion',
                  created,
                  choices: [{
                    index: 0,
                    message,
                    finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
                  }],
                  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                })
              }
            }
          } catch (e) {
            // Skip invalid JSON
          }

          offset += 5 + length
        }

        buffer = buffer.slice(offset)
      })

      stream.once('error', reject)
      stream.once('close', () => {
        const { content: cleanContent, toolCalls } = this.toolCallingPlan?.shouldParseResponse
          ? { content, toolCalls: [] }
          : parseToolCallsFromText(content, 'kimi')

        const message: any = {
          role: 'assistant',
          content: toolCalls.length > 0 ? null : cleanContent.trim(),
        }

        if (reasoningContent.trim()) {
          message.reasoning_content = reasoningContent.trim()
        }

        if (toolCalls.length > 0) {
          message.tool_calls = toolCalls
        }

        resolve({
          id: this.conversationId,
          model: this.model,
          object: 'chat.completion',
          created,
          choices: [{
            index: 0,
            message,
            finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      })
    })
  }
}

export const kimiAdapter = {
  KimiAdapter,
  KimiStreamHandler,
}
