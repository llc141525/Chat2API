/**
 * MimoProviderPlugin — Phase 1 wrapper around MimoAdapter
 *
 * Implements the WebProviderPlugin interface to bridge between
 * ProviderRuntime normalized types and the Mimo web provider protocol.
 */

import type { WebProviderPlugin } from './WebProviderPlugin.ts'
import type {
  ProviderRuntimeRequest,
  ProviderWebRequest,
  ProviderWebResponse,
  ProviderRuntimeResult,
  ProviderRuntimeError,
  ProviderDeleteSessionInput,
  ProviderDeleteSessionResult,
} from './types.ts'
import { MimoAdapter, buildMimoQuery } from '../adapters/mimo.ts'
import axios from 'axios'

const MIMO_API_BASE = 'https://aistudio.xiaomimimo.com'

/**
 * Generate a UUID-like string without dashes.
 */
function generateId(separator: boolean = true): string {
  const id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
  return separator ? id : id.replace(/-/g, '')
}

export const MimoProviderPlugin: WebProviderPlugin = {
  id: 'mimo',
  version: '1.0.0',

  matches(provider: { id: string }): boolean {
    return provider.id.toLowerCase() === 'mimo'
  },

  capabilities: {
    supportsProviderSession: true,
    supportsParentMessageId: true,
    supportsDeleteSession: true,
    supportsStreaming: true,
    supportsNonStreaming: true,
    supportsNativeTools: false,
    preferredManagedProtocol: 'managed_xml',
    sessionIdKind: 'conversation_id',
    transport: 'provider_chat_api',
  },

  async buildRequest(input: ProviderRuntimeRequest): Promise<ProviderWebRequest> {
    const credentials = input.account.credentials as Record<string, string>
    const serviceToken = credentials.service_token ?? ''
    const userId = credentials.user_id ?? ''
    const phToken = credentials.ph_token ?? ''

    const conversationId = input.sessionId || generateId(false)
    const msgId = generateId(false).slice(0, 32)
    const reqId = msgId

    // Build query from messages using the exported pure function
    const query = buildMimoQuery(
      input.messages as Parameters<typeof buildMimoQuery>[0],
    )

    // Check model name hints for thinking
    const modelLower = (input.originalModel || input.model).toLowerCase()
    const enableThinking = input.enableThinking
      ?? (modelLower.includes('think') || modelLower.includes('r1'))

    const requestBody = {
      msgId,
      conversationId,
      query,
      isEditedQuery: false,
      modelConfig: {
        enableThinking,
        webSearchStatus: 'disabled' as const,
        model: input.model,
        temperature: input.temperature ?? 0.8,
        topP: 0.95,
      },
      multiMedias: [],
    }

    const queryString = `xiaomichatbot_ph=${encodeURIComponent(phToken)}`
    const url = `${MIMO_API_BASE}/open-apis/bot/chat?${queryString}`

    return {
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `serviceToken=${serviceToken}; userId=${userId}; xiaomichatbot_ph=${phToken}`,
        Origin: MIMO_API_BASE,
        Referer: `${MIMO_API_BASE}/`,
      },
      body: requestBody,
      sessionId: conversationId,
      reqId,
    }
  },

  async parseNonStream(input: ProviderWebResponse): Promise<ProviderRuntimeResult> {
    let sessionId = ''
    let reqId = ''

    try {
      const data = input.data as Record<string, unknown>
      // Mimo sends dialogId in the SSE event stream
      if (data?.dialogId) {
        sessionId = String(data.dialogId)
      }
      // Also try to extract from the raw SSE text if data is a string buffer
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
  },

  async deleteSession(input: ProviderDeleteSessionInput): Promise<ProviderDeleteSessionResult> {
    const adapter = new MimoAdapter(input.provider, input.account)
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
