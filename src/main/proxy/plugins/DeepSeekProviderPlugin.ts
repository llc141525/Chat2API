/**
 * DeepSeekProviderPlugin — Phase 1 wrapper around DeepSeekAdapter
 *
 * Implements the WebProviderPlugin interface to bridge between
 * ProviderRuntime normalized types and the DeepSeek web provider protocol.
 */

import type { WebProviderPlugin } from './WebProviderPlugin.ts'
import type {
  ProviderRuntimeRequest,
  ProviderWebRequest,
  ProviderWebResponse,
  ProviderRuntimeResult,
  ProviderRuntimeEvent,
  ProviderRuntimeError,
  ProviderDeleteSessionInput,
  ProviderDeleteSessionResult,
} from './types.ts'
import { DeepSeekAdapter } from '../adapters/deepseek.ts'
import { resolveDeepSeekChatOptions } from '../adapters/providerModelOptions.ts'
import { getProviderToolProfile } from '../toolCalling/providerProfiles.ts'
import axios from 'axios'

const DEEPSEEK_API_BASE = 'https://chat.deepseek.com/api'

const FAKE_HEADERS: Record<string, string> = {
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
  Origin: 'https://chat.deepseek.com',
  Referer: 'https://chat.deepseek.com/',
  'Sec-Ch-Ua': '"Not/A)Brand";v="99", "Chromium";v="148"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'X-App-Version': '2.0.0',
  'X-Client-Locale': 'zh_CN',
  'X-Client-Platform': 'web',
  'x-Client-Timezone-Offset': '28800',
  'X-Client-Version': '2.0.0',
}

/**
 * Generate a UUID-like string without dashes.
 */
function generateId(): string {
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/**
 * Generate a random alphanumeric string.
 */
function generateRandomString(length: number): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

/**
 * Generate a cookie string for DeepSeek requests.
 */
function generateCookie(): string {
  const timestamp = Date.now()
  return [
    `intercom-HWWAFSESTIME=${timestamp}`,
    `HWWAFSESID=${generateRandomString(18)}`,
    `Hm_lvt_${generateRandomString(8)}=${Math.floor(timestamp / 1000)}`,
    `Hm_lpvt_${generateRandomString(8)}=${Math.floor(timestamp / 1000)}`,
    `_frid=${generateRandomString(12)}`,
    `_fr_ssid=${generateRandomString(12)}`,
    `_fr_pvid=${generateRandomString(12)}`,
  ].join('; ')
}

/**
 * Convert normalized messages into the DeepSeek prompt format.
 *
 * This replicates the logic of DeepSeekAdapter.messagesToPrompt()
 * without instantiating the adapter or making HTTP calls.
 */
function deepseekMessagesToPrompt(
  messages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: unknown[] }>,
  isMultiTurn: boolean = false,
): string {
  const toolProfile = getProviderToolProfile('deepseek')
  const processedMessages = messages.map((message) => {
    let text: string

    // Handle tool calls in assistant message
    if (message.role === 'assistant' && message.tool_calls && (message.tool_calls as any[]).length > 0) {
      text = toolProfile.formatAssistantToolCalls(
        (message.tool_calls as any[]).map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        })),
      )
    }
    // Handle tool response message
    else if (message.role === 'tool' && message.tool_call_id) {
      const rawContent = String((message.content as any) || '')
      const truncated = rawContent.length > 2000
        ? rawContent.slice(0, 2000) + '\n...(truncated)'
        : rawContent
      text = toolProfile.formatToolResult({
        toolCallId: message.tool_call_id,
        content: truncated,
      })
    } else if (Array.isArray(message.content)) {
      const texts = (message.content as any[])
        .filter((item: any) => item.type === 'text')
        .map((item: any) => item.text)
      text = texts.join('\n')
    } else {
      text = String((message.content as any) || '')
    }
    return { role: message.role, text }
  })

  if (processedMessages.length === 0) return ''

  // For multi-turn mode, find the last assistant tool_call and send delta from there
  if (isMultiTurn) {
    let lastAssistantToolIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && (messages[i].tool_calls as any[])?.length > 0) {
        lastAssistantToolIdx = i
        break
      }
    }

    if (lastAssistantToolIdx !== -1) {
      const parts: string[] = []
      for (let i = lastAssistantToolIdx; i < processedMessages.length; i++) {
        parts.push(processedMessages[i].text)
      }
      return `<｜User｜>${parts.join('\n\n')}`
    }

    // Fallback: only send the last user message + tool results
    let lastUserIdx = -1
    for (let i = processedMessages.length - 1; i >= 0; i--) {
      if (processedMessages[i].role === 'user') {
        lastUserIdx = i
        break
      }
    }

    if (lastUserIdx !== -1) {
      const lastUserMsg = processedMessages[lastUserIdx]
      let text = lastUserMsg.text
      for (let i = lastUserIdx + 1; i < processedMessages.length; i++) {
        if (processedMessages[i].role === 'tool') {
          text += `\n\n${processedMessages[i].text}`
        }
      }
      return `<｜User｜>${text}`
    }
  }

  const mergedBlocks: { role: string; text: string }[] = []
  let currentBlock = { ...processedMessages[0] }

  for (let i = 1; i < processedMessages.length; i++) {
    const msg = processedMessages[i]
    if (msg.role === currentBlock.role) {
      currentBlock.text += `\n\n${msg.text}`
    } else {
      mergedBlocks.push(currentBlock)
      currentBlock = { ...msg }
    }
  }
  mergedBlocks.push(currentBlock)

  return mergedBlocks
    .map((block, index) => {
      if (block.role === 'assistant') {
        return `<｜Assistant｜>${block.text}<｜end of sentence｜>`
      }
      if (block.role === 'user' || block.role === 'system') {
        return index > 0 ? `<｜User｜>${block.text}` : block.text
      }
      if (block.role === 'tool') {
        return `<｜User｜>${block.text}`
      }
      return block.text
    })
    .join('\n\n')
    .replace(/!\[.+\]\(.+\)/g, '')
}

export const DeepSeekProviderPlugin: WebProviderPlugin = {
  id: 'deepseek',
  version: '1.0.0',

  matches(provider: { id: string }): boolean {
    return provider.id.toLowerCase() === 'deepseek'
  },

  capabilities: {
    supportsProviderSession: true,
    supportsParentMessageId: true,
    supportsDeleteSession: true,
    supportsStreaming: true,
    supportsNonStreaming: true,
    supportsNativeTools: false,
    preferredManagedProtocol: 'managed_xml',
    sessionIdKind: 'session_id',
    transport: 'provider_chat_api',
  },

  async buildRequest(input: ProviderRuntimeRequest): Promise<ProviderWebRequest> {
    const token = input.account.credentials.token
      || input.account.credentials.apiKey
      || input.account.credentials.refreshToken
      || ''

    const sessionId = input.sessionId || ''
    const reqId = generateId()

    // Convert messages to DeepSeek prompt format
    const prompt = deepseekMessagesToPrompt(
      input.messages as any,
      !!input.parentReqId,
    )

    // Resolve model options using the same utility the adapter uses
    const { modelType, searchEnabled, thinkingEnabled } = resolveDeepSeekChatOptions(
      {
        model: input.originalModel || input.model,
        web_search: input.enableWebSearch,
        reasoning_effort: input.enableThinking ? 'high' : undefined,
      },
      prompt,
    )

    const body = {
      chat_session_id: sessionId,
      parent_message_id: input.parentReqId || null,
      prompt,
      model_type: modelType,
      ref_file_ids: [] as string[],
      search_enabled: searchEnabled,
      thinking_enabled: thinkingEnabled,
      preempt: false,
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...FAKE_HEADERS,
      Referer: sessionId
        ? `https://chat.deepseek.com/a/chat/s/${sessionId}`
        : 'https://chat.deepseek.com/',
      Cookie: generateCookie(),
    }

    return {
      url: `${DEEPSEEK_API_BASE}/v0/chat/completion`,
      method: 'POST',
      headers,
      body,
      sessionId,
      reqId,
    }
  },

  async parseNonStream(input: ProviderWebResponse): Promise<ProviderRuntimeResult> {
    let sessionId = ''
    let reqId = ''

    try {
      const data = input.data as Record<string, any>
      if (data?.chat_session_id) {
        sessionId = String(data.chat_session_id)
      }
      if (data?.id) {
        reqId = String(data.id)
      }
    } catch {
      // Ignore parse errors, return empty strings
    }

    return {
      sessionId,
      reqId,
      response: input,
    }
  },

  async deleteSession(input: ProviderDeleteSessionInput): Promise<ProviderDeleteSessionResult> {
    const adapter = new DeepSeekAdapter(input.provider, input.account)
    const success = await adapter.deleteSession(input.sessionId)
    return { success }
  },

  classifyError(error: unknown): ProviderRuntimeError {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status ?? 0
      return {
        status,
        code: `HTTP_${status}`,
        message: error.message || 'Unknown Axios error',
        retryable: status >= 500 || status === 429 || status === 0,
        classified: true,
      }
    }

    return {
      status: 0,
      code: 'UNKNOWN',
      message: error instanceof Error ? error.message : 'Unknown error',
      retryable: false,
      classified: false,
    }
  },
}
