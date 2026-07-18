/**
 * QwenAiProviderPlugin — Phase 3c
 *
 * Delegates rendering to providers/qwen-ai/renderer.ts and parsing to
 * providers/qwen-ai/parser.ts. Inlines session deletion from the adapter.
 *
 * Implements the WebProviderPlugin interface to bridge between
 * ProviderRuntime normalized types and the Qwen AI (chat.qwen.ai)
 * web provider protocol.
 *
 * NOTE: This is the INTERNATIONAL Qwen API (chat.qwen.ai), different
 * from the domestic Qwen plugin (chat2.qianwen.com).
 */

import type { WebProviderPlugin } from './WebProviderPlugin.ts'
import type {
  ProviderRuntimeRequest,
  ProviderRuntimeStreamInput,
  ProviderRuntimeEvent,
  ProviderWebRequest,
  ProviderWebResponse,
  ProviderRuntimeResult,
  ProviderRuntimeError,
  ProviderDeleteSessionInput,
  ProviderDeleteSessionResult,
} from './types.ts'
import { QwenAiAdapter } from '../adapters/qwen-ai.ts'
import { renderQwenAiRequest } from '../providers/qwen-ai/renderer.ts'
import { parseQwenAiStream, parseQwenAiNonStream } from '../providers/qwen-ai/parser.ts'
import { buildCleanedRequest } from '../core/requestCleaner.ts'
import axios from 'axios'

/**
 * Generate a UUID v4 string.
 */
function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export const QwenAiProviderPlugin: WebProviderPlugin = {
  id: 'qwen-ai',
  version: '1.0.0',

  matches(provider: { id: string }): boolean {
    return provider.id.toLowerCase() === 'qwen-ai'
  },

  capabilities: {
    supportsProviderSession: true,
    supportsParentMessageId: true,
    supportsDeleteSession: true,
    supportsStreaming: true,
    supportsNonStreaming: true,
    supportsNativeTools: false,
    preferredManagedProtocol: 'managed_xml',
    sessionIdKind: 'chat_id',
    transport: 'provider_chat_api',
  },

  async buildRequest(input: ProviderRuntimeRequest): Promise<ProviderWebRequest> {
    const token = input.account.credentials.token
      || input.account.credentials.accessToken
      || input.account.credentials.apiKey
      || ''

    const cookies = input.account.credentials.cookies
      || input.account.credentials.cookie
      || ''

    const sessionId = input.sessionId || generateId().replace(/-/g, '')
    const reqId = generateId().replace(/-/g, '')

    // Build cleaned request
    const cleaned = buildCleanedRequest(input.assembly, {
      promptRefreshMode: input.promptRefreshMode ?? 'full',
      hasProviderSession: Boolean(input.sessionId),
    })

    // Get model mappings from adapter for model name resolution
    const adapter = new QwenAiAdapter(input.provider, input.account)
    const modelMappings = input.provider.modelMappings as Record<string, string> | undefined

    // Determine thinking mode
    const enableThinking = input.enableThinking ?? false

    // Delegate to renderer
    const qwenAiRequest = renderQwenAiRequest(cleaned, {
      model: input.model,
      originalModel: input.originalModel,
      sessionId,
      reqId,
      enableThinking,
      modelMappings,
    }, token, cookies || undefined)

    return qwenAiRequest
  },

  async parseNonStream(input: ProviderWebResponse): Promise<ProviderRuntimeResult> {
    return parseQwenAiNonStream(input)
  },

  parseStream(input: ProviderRuntimeStreamInput): AsyncIterable<ProviderRuntimeEvent> {
    return parseQwenAiStream(input)
  },

  async deleteSession(input: ProviderDeleteSessionInput): Promise<ProviderDeleteSessionResult> {
    const adapter = new QwenAiAdapter(input.provider, input.account)
    const success = await adapter.deleteChat(input.sessionId)
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
