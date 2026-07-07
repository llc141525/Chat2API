/**
 * ADR-001: Tool prompt injection is owned by ToolCallingEngine.
 * This file is a Provider Adapter — it must NEVER import
 * hasToolPromptInjected, toolsToSystemPrompt, TOOL_WRAP_HINT,
 * or shouldInjectToolPrompt.
 *
 * GLM Adapter
 * Implements GLM (Zhipu Qingyan) web API protocol
 */

import axios from 'axios'
import type { AxiosResponse } from 'axios'
import crypto from 'crypto'
import type { Account, Provider } from '../../store/types.ts'
import { PassThrough } from 'stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'zlib'
import * as ZstdCodec from 'zstd-codec'
import { createParser } from 'eventsource-parser'
import FormData from 'form-data'
import mime from 'mime-types'
import path from 'path'

import {
  createBaseChunk,
} from '../utils/streamToolHandler.ts'
import { getProviderToolProfile } from '../toolCalling/providerProfiles.ts'
import { ToolStreamParser } from '../toolCalling/ToolStreamParser.ts'
import type { ToolCallingPlan } from '../toolCalling/types.ts'

const GLM_API_BASE = 'https://chatglm.cn/chatglm'
const DEFAULT_ASSISTANT_ID = '65940acff94777010aa6b796'
const SIGN_SECRET = '8a1317a7468aa3ad86e997d08f3f31cb'
const ACCESS_TOKEN_EXPIRES = 3600
const FILE_MAX_SIZE = 100 * 1024 * 1024 // 100MB
const TOOL_PROMPT_MARKER = '## Available Tools'
const TOOL_PROMPT_RESULT_MARKER = '<|CHAT2API|tool_result'

const FAKE_HEADERS = {
  Accept: 'text/event-stream',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
  'App-Name': 'chatglm',
  'Cache-Control': 'no-cache',
  'Content-Type': 'application/json',
  Origin: 'https://chatglm.cn',
  Pragma: 'no-cache',
  Priority: 'u=1, i',
  'Sec-Ch-Ua': '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'X-App-Fr': 'browser_extension',
  'X-App-Platform': 'pc',
  'X-App-Version': '0.0.1',
  'X-Device-Brand': '',
  'X-Device-Model': '',
  'X-Lang': 'zh',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
}

interface TokenInfo {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

interface GLMMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | any[] | null
  tool_call_id?: string
  tool_calls?: any[]
}

interface ChatCompletionRequest {
  model: string
  originalModel?: string
  messages: GLMMessage[]
  stream?: boolean
  temperature?: number
  web_search?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high'
  deep_research?: boolean
  tools?: any[]
  tool_choice?: any
  conversationId?: string
}

const tokenCache = new Map<string, TokenInfo>()

function extractGLMTextContent(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n')
  }
  return String(content || '')
}

function extractManagedToolPrompt(messages: GLMMessage[]): { messages: GLMMessage[]; toolsPrompt: string } {
  let toolsPrompt = ''
  const cleanedMessages = messages.map((message) => {
    if (message.role !== 'system' || typeof message.content !== 'string') return message

    const markerIndex = message.content.indexOf(TOOL_PROMPT_MARKER)
    if (markerIndex < 0) return message

    // Only skip extraction when tool results appear BEFORE the tool prompt
    // (indicating previous-turn results are mixed into the system message).
    // Tool result references AFTER the marker are part of the format instruction
    // and should be extracted alongside the tool prompt.
    const toolResultIndex = message.content.indexOf(TOOL_PROMPT_RESULT_MARKER)
    if (toolResultIndex >= 0 && toolResultIndex < markerIndex) return message

    // Extract tool prompt so it can be placed at the end of the final message,
    // closest to where the model generates its response.
    const beforePrompt = message.content.slice(0, markerIndex).trim()
    toolsPrompt = message.content.slice(markerIndex).trim()
    return { ...message, content: beforePrompt }
  })

  if (toolsPrompt) {
    const toolNamesInPrompt = [...toolsPrompt.matchAll(/Tool `([^`]+)`/g)].map((m) => m[1])
    console.log('[GLM] Extracted tool prompt — tool names:', toolNamesInPrompt)
  }

  return { messages: cleanedMessages, toolsPrompt }
}

export function buildGLMPromptMessagesForTest(messages: GLMMessage[], refs: any[] = []): { role: string; content: any[] }[] {
  const adapter = Object.create(GLMAdapter.prototype) as GLMAdapter
  const managedToolPrompt = extractManagedToolPrompt(messages)
  return (adapter as any).messagesToPrompt(managedToolPrompt.messages, refs, managedToolPrompt.toolsPrompt, false)
}

function shouldLogPromptPreview(messages: GLMMessage[]): boolean {
  return messages.some((message) =>
    typeof message.content === 'string' &&
    (
      message.content.includes('agent-capability-probe') ||
      message.content.includes('CAPABILITY_PROBE_DONE') ||
      message.content.includes('tests/agent-capability/input.txt')
    ),
  )
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function md5(str: string): string {
  return crypto.createHash('md5').update(str).digest('hex')
}

function generateSign(): { timestamp: string; nonce: string; sign: string } {
  const e = Date.now()
  const A = e.toString()
  const t = A.length
  const o = A.split('').map((c) => Number(c))
  const i = o.reduce((acc, val) => acc + val, 0) - o[t - 2]
  const a = i % 10
  const timestamp = A.substring(0, t - 2) + a + A.substring(t - 1, t)
  const nonce = uuid()
  const sign = md5(`${timestamp}-${nonce}-${SIGN_SECRET}`)
  return { timestamp, nonce, sign }
}

export class GLMAdapter {
  private provider: Provider
  private account: Account

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
  }

  private getRefreshToken(): string {
    const credentials = this.account.credentials
    return credentials.refresh_token || credentials.token || ''
  }

  private async acquireToken(): Promise<string> {
    const refreshToken = this.getRefreshToken()
    const cached = tokenCache.get(refreshToken)
    if (cached && Date.now() < cached.expiresAt) {
      return cached.accessToken
    }

    console.log('[GLM] Refreshing Token...')
    const sign = generateSign()
    const response = await axios.post(
      `${GLM_API_BASE}/user-api/user/refresh`,
      {},
      {
        headers: {
          Authorization: `Bearer ${refreshToken}`,
          ...FAKE_HEADERS,
          'X-Device-Id': uuid(),
          'X-Nonce': sign.nonce,
          'X-Request-Id': uuid(),
          'X-Sign': sign.sign,
          'X-Timestamp': sign.timestamp,
        },
        timeout: 15000,
        validateStatus: () => true,
      }
    )

    console.log('[GLM] Token response:', JSON.stringify(response.data, null, 2))
    const { code, status, message } = response.data || {}
    const isSuccess = code === 0 || status === 0
    if (response.status !== 200 || !isSuccess) {
      const errorMsg = message || `HTTP ${response.status}`
      throw new Error(`Token refresh failed: ${errorMsg}`)
    }

    const { access_token, refresh_token } = response.data.result
    const tokenInfo: TokenInfo = {
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: Date.now() + ACCESS_TOKEN_EXPIRES * 1000,
    }
    tokenCache.set(refreshToken, tokenInfo)

    if (refresh_token !== refreshToken) {
      console.log('[GLM] Token updated, saving new token')
      const decryptedCredentials = {
        refresh_token,
      }
      const { storeManager } = await import('../../store/store.ts')
      await storeManager.updateAccount(this.account.id, {
        credentials: decryptedCredentials,
      })
    }

    console.log('[GLM] Token refresh successful')
    return access_token
  }

  /**
   * Check if URL is base64 data
   */
  private isBase64Data(url: string): boolean {
    return url.startsWith('data:')
  }

  /**
   * Extract MIME type from base64 data URL
   */
  private extractBase64Format(url: string): string {
    const match = url.match(/^data:([^;]+);/)
    return match ? match[1] : 'application/octet-stream'
  }

  /**
   * Remove base64 data header
   */
  private removeBase64Header(url: string): string {
    return url.replace(/^data:[^;]+;base64,/, '')
  }

  /**
   * Upload file to GLM
   */
  private async uploadFile(fileUrl: string): Promise<{ source_id: string; file_url?: string }> {
    console.log('[GLM] Uploading file:', fileUrl.substring(0, 50) + '...')
    
    let filename: string
    let fileData: Buffer
    let mimeType: string

    if (this.isBase64Data(fileUrl)) {
      mimeType = this.extractBase64Format(fileUrl)
      const ext = mime.extension(mimeType) || 'bin'
      filename = `${uuid()}.${ext}`
      fileData = Buffer.from(this.removeBase64Header(fileUrl), 'base64')
    } else {
      filename = path.basename(fileUrl.split('?')[0])
      const response = await axios.get(fileUrl, {
        responseType: 'arraybuffer',
        maxContentLength: FILE_MAX_SIZE,
        timeout: 60000,
      })
      fileData = Buffer.from(response.data)
      mimeType = response.headers['content-type'] || mime.lookup(filename) || 'application/octet-stream'
    }

    const formData = new FormData()
    formData.append('file', fileData, {
      filename,
      contentType: mimeType,
    })

    const token = await this.acquireToken()
    const response = await axios.post(
      `${GLM_API_BASE}/backend-api/assistant/file_upload`,
      formData,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Referer: 'https://chatglm.cn/',
          ...FAKE_HEADERS,
          ...formData.getHeaders(),
        },
        maxBodyLength: FILE_MAX_SIZE,
        timeout: 60000,
        validateStatus: () => true,
      }
    )

    if (response.status !== 200 || !response.data?.result) {
      throw new Error(`File upload failed: HTTP ${response.status}`)
    }

    console.log('[GLM] File uploaded successfully:', response.data.result.source_id)
    return response.data.result
  }

  /**
   * Extract file URLs from message content
   */
  private extractFileUrls(messages: GLMMessage[]): { fileUrls: string[]; imageUrls: string[] } {
    const fileUrls: string[] = []
    const imageUrls: string[] = []

    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'image_url' && part.image_url?.url) {
            imageUrls.push(part.image_url.url)
          } else if (part.type === 'file' && part.file_url?.url) {
            fileUrls.push(part.file_url.url)
          }
        }
      }
    }

    return { fileUrls, imageUrls }
  }

  private messagesToPrompt(messages: GLMMessage[], refs: any[] = [], toolsPrompt?: string, isMultiTurn: boolean = false): { role: string; content: any[] }[] {
    const toolProfile = getProviderToolProfile('glm')
    // Separate image refs and file refs
    const imageRefs = refs.filter((ref) => ref.width !== undefined || ref.height !== undefined || ref.image_url)
    const fileRefs = refs.filter((ref) => !ref.width && !ref.height && !ref.image_url)

    // Build content array
    const content: any[] = []

    // Add file references first
    if (fileRefs.length > 0) {
      content.push({
        type: 'file',
        file: fileRefs.map((ref) => ({
          source_id: ref.source_id,
          file_url: ref.file_url,
        })),
      })
    }

    // Add image references
    for (const imageRef of imageRefs) {
      content.push({
        type: 'image_url',
        image_url: {
          url: imageRef.image_url || imageRef.source_id,
        },
      })
    }

    const conversationParts: string[] = []
    let systemPrompt = ''

    if (isMultiTurn) {
      // Find the last assistant message with tool_calls in ORIGINAL messages,
      // then only include the delta from there onward (server holds conversation context)
      let lastAssistantToolIdx = -1
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant' && messages[i].tool_calls && messages[i].tool_calls.length > 0) {
          lastAssistantToolIdx = i
          break
        }
      }

      if (lastAssistantToolIdx !== -1) {
        const deltaParts: string[] = []
        for (let i = lastAssistantToolIdx; i < messages.length; i++) {
          const msg = messages[i]
          if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
            deltaParts.push(toolProfile.formatAssistantToolCalls(msg.tool_calls.map(tc => ({
              id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments,
            }))))
          } else if (msg.role === 'tool' && msg.tool_call_id) {
            deltaParts.push(toolProfile.formatToolResult({
              toolCallId: msg.tool_call_id,
              content: extractGLMTextContent(msg.content),
            }))
          } else if (msg.role === 'assistant') {
            deltaParts.push(`Assistant: ${extractGLMTextContent(msg.content)}`)
          } else if (msg.role === 'user') {
            deltaParts.push(extractGLMTextContent(msg.content))
          } else if (msg.role === 'system') {
            systemPrompt = extractGLMTextContent(msg.content)
          }
        }

        const userContent = deltaParts.join('\n\n')
        let textContent = systemPrompt
          ? `${systemPrompt}\n\nUser: ${userContent}`
          : userContent

        if (toolsPrompt) {
          textContent = textContent.trimEnd() + '\n\n' + toolsPrompt
        }

        if (shouldLogPromptPreview(messages)) {
          console.log('[GLM] Final prompt preview:', textContent)
        }

        content.push({ type: 'text', text: textContent })
        return [{ role: 'user', content }]
      }
      // No assistant tool_call found — fall through to full prompt
    }

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt = extractGLMTextContent(msg.content)
      } else if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        conversationParts.push(toolProfile.formatAssistantToolCalls(msg.tool_calls.map(tc => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        }))))
      } else if (msg.role === 'tool' && msg.tool_call_id) {
        conversationParts.push(toolProfile.formatToolResult({
          toolCallId: msg.tool_call_id,
          content: extractGLMTextContent(msg.content),
        }))
      } else if (msg.role === 'assistant') {
        conversationParts.push(`Assistant: ${extractGLMTextContent(msg.content)}`)
      } else if (msg.role === 'user') {
        conversationParts.push(extractGLMTextContent(msg.content))
      }
    }

    const userContent = conversationParts.join('\n\n')
    let textContent = systemPrompt
      ? `${systemPrompt}\n\nUser: ${userContent}`
      : userContent

    if (toolsPrompt) {
      textContent = textContent.trimEnd() + '\n\n' + toolsPrompt
    }

    if (shouldLogPromptPreview(messages)) {
      console.log('[GLM] Final prompt preview:', textContent)
    }

    content.push({ type: 'text', text: textContent })
    return [{ role: 'user', content }]
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{ response: AxiosResponse; conversationId: string }> {
    const token = await this.acquireToken()
    const sign = generateSign()

    // Clone messages to avoid modifying original request
    const messages = [...request.messages]
    const managedToolPrompt = extractManagedToolPrompt(messages)

    // Tool prompts are injected by ToolCallingEngine in the forwarder.
    // Adapter only formats already-injected messages via messagesToPrompt.
    const toolsPrompt = managedToolPrompt.toolsPrompt

    // Extract and upload files (skip for multi-turn, server already has them via conversation_id)
    const refs: any[] = []
    if (!request.conversationId) {
      const { fileUrls, imageUrls } = this.extractFileUrls(managedToolPrompt.messages)

      // Upload files
      for (const fileUrl of fileUrls) {
        try {
          const result = await this.uploadFile(fileUrl)
          refs.push({
            source_id: result.source_id,
            file_url: result.file_url || fileUrl,
          })
        } catch (error) {
          console.error('[GLM] Failed to upload file:', error)
        }
      }

      // Upload images
      for (const imageUrl of imageUrls) {
        try {
          const result = await this.uploadFile(imageUrl)
          refs.push({
            source_id: result.source_id,
            image_url: result.file_url || imageUrl,
            width: 0,
            height: 0,
          })
        } catch (error) {
          console.error('[GLM] Failed to upload image:', error)
        }
      }
    }

    const preparedMessages = this.messagesToPrompt(managedToolPrompt.messages, refs, toolsPrompt, !!request.conversationId)

    let assistantId = DEFAULT_ASSISTANT_ID
    let chatMode = ''
    let isNetworking = false

    // Use request parameters for mode control (OpenAI compatible)
    if (request.reasoning_effort) {
      chatMode = 'zero'
      console.log('[GLM] Using reasoning mode, effort:', request.reasoning_effort)
    }
    
    if (request.web_search) {
      isNetworking = true
      console.log('[GLM] Web search enabled')
    }
    
    if (request.deep_research) {
      chatMode = 'deep_research'
      console.log('[GLM] Using deep research mode')
    }

    // Fallback: check model name for backward compatibility
    // Use originalModel for feature detection (preserves user's intent before mapping)
    const modelForDetection = request.originalModel || request.model
    const modelLower = modelForDetection.toLowerCase()
    if (!chatMode && (modelLower.includes('think') || modelLower.includes('zero'))) {
      chatMode = 'zero'
      console.log('[GLM] Using reasoning mode (from model name)')
    }
    if (!chatMode && modelLower.includes('deepresearch')) {
      chatMode = 'deep_research'
      console.log('[GLM] Using deep research mode (from model name)')
    }
    
    // Check if model is an assistant ID (24+ alphanumeric characters)
    if (/^[a-z0-9]{24,}$/.test(request.model)) {
      assistantId = request.model
    }

    console.log('[GLM] Sending chat request...')
    
    const response = await axios.post(
      `${GLM_API_BASE}/backend-api/assistant/stream`,
      {
        assistant_id: assistantId,
        conversation_id: request.conversationId || '',
        project_id: '',
        chat_type: 'user_chat',
        messages: preparedMessages,
        meta_data: {
          channel: '',
          chat_mode: chatMode || undefined,
          draft_id: '',
          if_plus_model: true,
          input_question_type: 'xxxx',
          is_networking: isNetworking,
          is_test: false,
          platform: 'pc',
          quote_log_id: '',
          cogview: {
            rm_label_watermark: false,
          },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS,
          'X-Device-Id': uuid(),
          'X-Request-Id': uuid(),
          'X-Sign': sign.sign,
          'X-Timestamp': sign.timestamp,
          'X-Nonce': sign.nonce,
        },
        timeout: 120000,
        validateStatus: () => true,
        responseType: 'stream',
      }
    )

    return { response, conversationId: request.conversationId || '' }
  }

  async deleteConversation(conversationId: string): Promise<boolean> {
    try {
      const token = await this.acquireToken()
      const sign = generateSign()
      await axios.post(
        `${GLM_API_BASE}/backend-api/assistant/conversation/delete`,
        {
          assistant_id: DEFAULT_ASSISTANT_ID,
          conversation_id: conversationId,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Referer: 'https://chatglm.cn/main/alltoolsdetail',
            'X-Device-Id': uuid(),
            'X-Request-Id': uuid(),
            'X-Sign': sign.sign,
            'X-Timestamp': sign.timestamp,
            'X-Nonce': sign.nonce,
            ...FAKE_HEADERS,
          },
          timeout: 15000,
          validateStatus: () => true,
        }
      )
      console.log('[GLM] Conversation deleted:', conversationId)
      return true
    } catch (error) {
      console.error('[GLM] Failed to delete conversation:', error)
      return false
    }
  }

  async deleteAllChats(): Promise<boolean> {
    try {
      const token = await this.acquireToken()

      // Step 1: Get all conversations (handle pagination)
      const allConversationIds: string[] = []
      let page = 1
      let hasMore = true

      while (hasMore) {
        const sign = generateSign()
        const listResponse = await axios.post(
          `${GLM_API_BASE}/mainchat-api/conversation/recent_list`,
          { page, page_size: 100 },
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Referer: 'https://chatglm.cn/main/alltoolsdetail',
              'X-Device-Id': uuid(),
              'X-Request-Id': uuid(),
              'X-Sign': sign.sign,
              'X-Timestamp': sign.timestamp,
              'X-Nonce': sign.nonce,
              ...FAKE_HEADERS,
            },
            timeout: 30000,
            validateStatus: () => true,
          }
        )

        console.log('[GLM] Get conversation list page', page, 'response:', JSON.stringify(listResponse.data, null, 2))

        const { status, result } = listResponse.data || {}
        if (listResponse.status !== 200 || status !== 0) {
          console.error('[GLM] Failed to get conversation list')
          return false
        }

        const conversationList = result?.conversation_list || []
        for (const c of conversationList) {
          allConversationIds.push(c.conversation_id)
        }

        hasMore = result?.has_more || false
        page++

        if (conversationList.length === 0) {
          break
        }
      }

      if (allConversationIds.length === 0) {
        console.log('[GLM] No conversations to delete')
        return true
      }

      console.log('[GLM] Found', allConversationIds.length, 'conversations to delete')

      // Step 2: Bulk delete conversations
      const sign = generateSign()
      const deleteResponse = await axios.post(
        `${GLM_API_BASE}/mainchat-api/conversation/bulk_delete`,
        { conversation_ids: allConversationIds },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Referer: 'https://chatglm.cn/main/alltoolsdetail',
            'X-Device-Id': uuid(),
            'X-Request-Id': uuid(),
            'X-Sign': sign.sign,
            'X-Timestamp': sign.timestamp,
            'X-Nonce': sign.nonce,
            ...FAKE_HEADERS,
          },
          timeout: 60000,
          validateStatus: () => true,
        }
      )

      console.log('[GLM] Bulk delete response:', JSON.stringify(deleteResponse.data, null, 2))

      const deleteResult = deleteResponse.data || {}
      const success = deleteResponse.status === 200 && deleteResult.status === 0
      if (success) {
        console.log('[GLM] All chats deleted')
      }
      return success
    } catch (error) {
      console.error('[GLM] Failed to delete all chats:', error)
      return false
    }
  }

  static isGLMProvider(provider: Provider): boolean {
    return provider.id === 'glm' || provider.apiEndpoint.includes('chatglm.cn')
  }
}

function convertNativeToolCallsToXml(toolCalls: any[]): string {
  const invokes = toolCalls.map((tc) => {
    const fn = tc.function || tc
    const name = fn.name || tc.name || ''
    if (!name) {
      console.warn('[GLM] Native tool_call without name:', JSON.stringify(tc).substring(0, 200))
      return ''
    }
    const args = typeof fn.arguments === 'string' ? safeParseJson(fn.arguments) : (fn.arguments || {})
    const params = Object.entries(args as Record<string, unknown>)
      .map(([key, value]) => {
        const text = typeof value === 'string' ? value : JSON.stringify(value)
        return `<|CHAT2API|parameter name="${key}"><![CDATA[${text}]]></|CHAT2API|parameter>`
      })
      .join('')
    return `<|CHAT2API|invoke name="${name}">${params}</|CHAT2API|invoke>`
  }).filter(Boolean).join('')

  return invokes ? `<|CHAT2API|tool_calls>${invokes}</|CHAT2API|tool_calls>` : ''
}

function safeParseJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function convertNativeToolCallsFromParts(cachedParts: any[]): string {
  const xmlParts: string[] = []
  for (const part of cachedParts) {
    if (!Array.isArray(part.content)) continue
    for (const item of part.content) {
      if (item.type === 'tool_calls' && Array.isArray(item.tool_calls) && item.tool_calls.length > 0) {
        xmlParts.push(convertNativeToolCallsToXml(item.tool_calls))
      }
    }
  }
  return xmlParts.join('')
}

export class GLMStreamHandler {
  private conversationId: string = ''
  private model: string
  private created: number
  private onEnd?: () => void
  private toolStreamParser?: ToolStreamParser
  private toolCallingPlan?: ToolCallingPlan
  private emittedNativeToolCallIds = new Set<string>()

  constructor(model: string, onEnd?: () => void, initialConversationId?: string, toolCallingPlan?: ToolCallingPlan) {
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
    this.toolCallingPlan = toolCallingPlan
    this.toolStreamParser = toolCallingPlan?.shouldParseResponse ? new ToolStreamParser(toolCallingPlan) : undefined
    if (initialConversationId) {
      this.conversationId = initialConversationId
    }
  }

  async handleStream(stream: any, response?: AxiosResponse): Promise<PassThrough> {
    const transStream = new PassThrough()
    const cachedParts: any[] = []
    let sentContent = ''
    let sentReasoning = ''
    let sentRole = false
    let finished = false

    transStream.write(
      `data: ${JSON.stringify({
        id: '',
        model: this.model,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        created: this.created,
      })}\n\n`
    )

    const finishStream = (delta: Record<string, unknown> = {}, includeUsage: boolean = false): void => {
      if (finished) return
      finished = true

      const baseChunk = createBaseChunk(this.conversationId, this.model, this.created)
      const flushChunks = this.toolStreamParser?.flush(baseChunk) ?? []
      for (const outChunk of flushChunks) {
        transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
      }

      const finishReason = this.toolStreamParser?.hasEmittedToolCall() ? 'tool_calls' : 'stop'
      transStream.write(
        `data: ${JSON.stringify({
          id: this.conversationId,
          model: this.model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta, finish_reason: finishReason }],
          ...(includeUsage ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
          created: this.created,
        })}\n\n`
      )
      transStream.end('data: [DONE]\n\n')
      this.onEnd?.()
    }

    const parser = createParser({
      onEvent: (event: any) => {
        try {
          const result = JSON.parse(event.data)

          if (!this.conversationId && result.conversation_id) {
            this.conversationId = result.conversation_id
          }

          if (result.status !== 'finish' && result.status !== 'intervene') {
            if (result.parts) {
              result.parts.forEach((part: any) => {
                const index = cachedParts.findIndex((p) => p.logic_id === part.logic_id)
                if (index !== -1) {
                  cachedParts[index] = part
                } else {
                  cachedParts.push(part)
                }
              })
            }

            const searchMap = new Map<string, any>()
            cachedParts.forEach((part) => {
              if (!part.content || !Array.isArray(part.content)) return
              const { meta_data } = part
              part.content.forEach((item: any) => {
                if (item.type === 'tool_result' && meta_data?.tool_result_extra?.search_results) {
                  meta_data.tool_result_extra.search_results.forEach((res: any) => {
                    if (res.match_key) {
                      searchMap.set(res.match_key, res)
                    }
                  })
                }
              })
            })

            const keyToIdMap = new Map<string, number>()
            let counter = 1
            let fullText = ''
            let fullReasoning = ''

            cachedParts.forEach((part) => {
              const { content, meta_data } = part
              if (!Array.isArray(content)) return

              let partText = ''
              let partReasoning = ''

              content.forEach((value: any) => {
                const { type, text, think, image, code, content: innerContent } = value

                if (type === 'text') {
                  let txt = text
                  if (searchMap.size > 0) {
                    txt = txt.replace(/【?(turn\d+[a-zA-Z]+\d+)】?/g, (match: string, key: string) => {
                      const searchInfo = searchMap.get(key)
                      if (!searchInfo) return match
                      if (!keyToIdMap.has(key)) {
                        keyToIdMap.set(key, counter++)
                      }
                      return ` [${keyToIdMap.get(key)}](${searchInfo.url})`
                    })
                  }
                  partText += txt
                } else if (type === 'think') {
                  partReasoning += think
                } else if (type === 'image' && Array.isArray(image) && part.status === 'finish') {
                  const imageText =
                    image.reduce((imgs: string, v: any) => {
                      return imgs + (/^(http|https):\/\//.test(v.image_url) ? `![image](${v.image_url})` : '')
                    }, '') + '\n'
                  partText += imageText
                } else if (type === 'code') {
                  partText += '```python\n' + code + (part.status === 'finish' ? '\n```\n' : '')
                } else if (type === 'execution_output' && typeof innerContent === 'string' && part.status === 'finish') {
                  partText += innerContent + '\n'
                }
              })

              if (partText) fullText += (fullText.length > 0 ? '\n' : '') + partText
              if (partReasoning) fullReasoning += (fullReasoning.length > 0 ? '\n' : '') + partReasoning
            })

            const reasoningChunk = fullReasoning.substring(sentReasoning.length)
            if (reasoningChunk) {
              sentReasoning += reasoningChunk
              transStream.write(
                `data: ${JSON.stringify({
                  id: this.conversationId,
                  model: this.model,
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: { reasoning_content: reasoningChunk }, finish_reason: null }],
                  created: this.created,
                })}\n\n`
              )
            }

            const chunk = fullText.substring(sentContent.length)
            if (chunk) {
              sentContent += chunk
              if (chunk.includes('<|CHAT2API|') || chunk.includes('<tool_calls>')) {
                console.log('[GLM] Tool call marker detected in chunk:', chunk.substring(0, 200))
              }
            }

            // Log unhandled content types and convert native GLM tool_calls to CHAT2API XML
            let nativeToolCallsXml = ''
            for (const part of cachedParts) {
              if (!Array.isArray(part.content)) continue
              for (const item of part.content) {
                if (item.type === 'tool_calls' && Array.isArray(item.tool_calls)) {
                  const newCalls = item.tool_calls.filter(
                    (tc: any) => !this.emittedNativeToolCallIds.has(tc.id || tc.call_id || '')
                  )
                  if (newCalls.length > 0) {
                    console.log('[GLM] Native tool_calls detected:', JSON.stringify(newCalls).substring(0, 300))
                    for (const tc of newCalls) {
                      const id = tc.id || tc.call_id || ''
                      if (id) this.emittedNativeToolCallIds.add(id)
                    }
                    nativeToolCallsXml += convertNativeToolCallsToXml(newCalls)
                  }
                } else if (!['text', 'think', 'image', 'code', 'execution_output', 'tool_result', 'tool_calls'].includes(item.type)) {
                  console.log('[GLM] Unhandled content type:', item.type, 'keys:', Object.keys(item).join(', '))
                }
              }
            }

            // Append native tool_calls XML to chunk for ToolStreamParser processing
            const effectiveChunk = chunk + nativeToolCallsXml

            // Process tool call interception with shared parser buffering.
            const baseChunk = createBaseChunk(this.conversationId, this.model, this.created)
            const outputChunks = this.toolStreamParser?.push(effectiveChunk, baseChunk, !sentRole) ?? (
              effectiveChunk ? [{
                ...baseChunk,
                choices: [{ index: 0, delta: { ...(!sentRole ? { role: 'assistant' } : {}), content: effectiveChunk }, finish_reason: null }],
              }] : []
            )

            for (const outChunk of outputChunks) {
              transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
            }

            if (outputChunks.length > 0) sentRole = true
          } else {
            finishStream(
              result.status === 'intervene' && result.last_error?.intervene_text
                ? { content: '\n\n' + result.last_error.intervene_text }
                : {},
              true,
            )
          }
        } catch (err) {
          console.error('[GLM] Stream parse error:', err)
        }
      },
    })

    const inputStream = this.createDecodedStream(stream, response, (text) => parser.feed(text), finishStream)
    if (!inputStream) return transStream

    const decoder = new TextDecoder('utf-8')
    inputStream.on('data', (buffer: Buffer) => parser.feed(decoder.decode(buffer, { stream: true })))

    // Handle stream errors - ensure proper cleanup
    inputStream.once('error', (err: Error) => {
      console.error('[GLM] Stream error:', err.message)
      finishStream()
    })

    // Handle stream close - ensure proper cleanup if not already finished
    inputStream.once('close', () => {
      console.log('[GLM] Stream closed')
      finishStream()
    })

    return transStream
  }

  async handleNonStream(stream: any, response?: AxiosResponse): Promise<any> {
    return new Promise((resolve, reject) => {
      const cachedParts: any[] = []

      const parser = createParser({
        onEvent: (event: any) => {
          try {
            const result = JSON.parse(event.data)

            if (!this.conversationId && result.conversation_id) {
              this.conversationId = result.conversation_id
            }

            if (result.status !== 'finish') {
              if (result.parts) {
                // Accumulate parts (same as handleStream), don't replace
                // GLM sends incremental parts, each event only contains new content
                result.parts.forEach((part: any) => {
                  const index = cachedParts.findIndex((p) => p.logic_id === part.logic_id)
                  if (index !== -1) {
                    cachedParts[index] = part
                  } else {
                    cachedParts.push(part)
                  }
                })
              }
            } else {
              const searchMap = new Map<string, any>()
              cachedParts.forEach((part) => {
                if (!part.content || !Array.isArray(part.content)) return
                const { meta_data } = part
                part.content.forEach((item: any) => {
                  if (item.type === 'tool_result' && meta_data?.tool_result_extra?.search_results) {
                    meta_data.tool_result_extra.search_results.forEach((res: any) => {
                      if (res.match_key) {
                        searchMap.set(res.match_key, res)
                      }
                    })
                  }
                })
              })

              const keyToIdMap = new Map<string, number>()
              let counter = 1
              let fullText = ''
              let fullReasoning = ''

              cachedParts.forEach((part) => {
                const { content, meta_data } = part
                if (!Array.isArray(content)) return

                let partText = ''
                let partReasoning = ''

                content.forEach((value: any) => {
                  const { type, text, think, image, code, content: innerContent } = value

                  if (type === 'text') {
                    let txt = text
                    if (searchMap.size > 0) {
                      txt = txt.replace(/【?(turn\d+[a-zA-Z]+\d+)】?/g, (match: string, key: string) => {
                        const searchInfo = searchMap.get(key)
                        if (!searchInfo) return match
                        if (!keyToIdMap.has(key)) {
                          keyToIdMap.set(key, counter++)
                        }
                        return ` [${keyToIdMap.get(key)}](${searchInfo.url})`
                      })
                    }
                    partText += txt
                  } else if (type === 'think') {
                    partReasoning += think
                  } else if (type === 'image' && Array.isArray(image) && part.status === 'finish') {
                    const imageText =
                      image.reduce((imgs: string, v: any) => {
                        return imgs + (/^(http|https):\/\//.test(v.image_url) ? `![image](${v.image_url})` : '')
                      }, '') + '\n'
                    partText += imageText
                  } else if (type === 'code') {
                    partText += '```python\n' + code + '\n```\n'
                  } else if (type === 'execution_output' && typeof innerContent === 'string' && part.status === 'finish') {
                    partText += innerContent + '\n'
                  }
                })

                if (partText) fullText += (fullText.length > 0 ? '\n' : '') + partText
                if (partReasoning) fullReasoning += (fullReasoning.length > 0 ? '\n' : '') + partReasoning
              })

              const cleanContent = fullText.trim()
              const nonStreamNativeXml = convertNativeToolCallsFromParts(cachedParts)
              const combinedContent = [cleanContent, nonStreamNativeXml].filter(Boolean).join('\n\n')

              resolve({
                id: this.conversationId,
                model: this.model,
                object: 'chat.completion',
                choices: [
                  {
                    index: 0,
                    message: {
                      role: 'assistant',
                      content: combinedContent,
                      reasoning_content: fullReasoning || null,
                    },
                    finish_reason: 'stop',
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                created: Math.floor(Date.now() / 1000),
              })
            }
          } catch (err) {
            reject(err)
          }
        },
      })

      const inputStream = this.createDecodedStream(
        stream,
        response,
        (text) => parser.feed(text),
        () => {
          resolve({
            id: this.conversationId,
            model: this.model,
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '', reasoning_content: null },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            created: Math.floor(Date.now() / 1000),
          })
        },
      )
      if (!inputStream) return

      inputStream.on('data', (buffer: Buffer) => parser.feed(buffer.toString()))
      inputStream.once('error', reject)
      inputStream.once('close', () => {
        resolve({
          id: this.conversationId,
          model: this.model,
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '', reasoning_content: null },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created: Math.floor(Date.now() / 1000),
        })
      })
    })
  }

  private createDecodedStream(
    stream: any,
    response: AxiosResponse | undefined,
    onDecodedZstd: (text: string) => void,
    onZstdEnd?: () => void,
  ): any | null {
    const contentEncoding = String(response?.headers?.['content-encoding'] || '').toLowerCase()
    if (contentEncoding === 'gzip') {
      console.log('[GLM] Decompressing gzip stream...')
      return stream.pipe(createGunzip())
    }
    if (contentEncoding === 'deflate') {
      console.log('[GLM] Decompressing deflate stream...')
      return stream.pipe(createInflate())
    }
    if (contentEncoding === 'br') {
      console.log('[GLM] Decompressing brotli stream...')
      return stream.pipe(createBrotliDecompress())
    }
    if (contentEncoding === 'zstd') {
      console.log('[GLM] Decompressing zstd stream...')
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.once('end', () => {
        try {
          const compressedData = Buffer.concat(chunks)
          ZstdCodec.run((zstd) => {
            const simple = new zstd.Simple()
            const decompressed = simple.decompress(compressedData)
            onDecodedZstd(Buffer.from(decompressed).toString('utf8'))
            onZstdEnd?.()
          })
        } catch (err) {
          console.error('[GLM] Zstd decompression error:', err)
          onZstdEnd?.()
        }
      })
      stream.once('error', (err: Error) => {
        console.error('[GLM] Stream error:', err)
        onZstdEnd?.()
      })
      return null
    }

    return stream
  }

  getConversationId(): string {
    return this.conversationId
  }
}

export const glmAdapter = {
  GLMAdapter,
  GLMStreamHandler,
}
