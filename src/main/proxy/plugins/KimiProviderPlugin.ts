/**
 * KimiProviderPlugin — Phase 3c wrapper
 *
 * Delegates rendering to providers/kimi/renderer.ts and parsing to
 * providers/kimi/parser.ts. Inlines session deletion from the
 * Kimi adapter.
 *
 * Implements the WebProviderPlugin interface to bridge between
 * ProviderRuntime normalized types and the Kimi web provider protocol.
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
import { KimiAdapter } from '../adapters/kimi.ts'
import { renderKimiRequest } from '../providers/kimi/renderer.ts'
import { parseKimiStream, parseKimiNonStream } from '../providers/kimi/parser.ts'
import { buildCleanedRequest } from '../core/requestCleaner.ts'
import axios from 'axios'

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

export const KimiProviderPlugin: WebProviderPlugin = {
  id: 'kimi',
  version: '1.0.0',

  matches(provider: { id: string }): boolean {
    return provider.id.toLowerCase() === 'kimi'
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
    const token = input.account.credentials.token
      || input.account.credentials.refreshToken
      || ''
    const sessionId = input.sessionId || generateId()
    const reqId = generateId()

    // Build cleaned request
    const cleaned = buildCleanedRequest(input.assembly, {
      promptRefreshMode: input.promptRefreshMode ?? 'full',
      hasProviderSession: Boolean(input.sessionId),
    })

    // Determine thinking / web search from model hints
    const modelLower = (input.originalModel || input.model).toLowerCase()
    // Kimi K3 is only selected when thinking is enabled. The web service
    // otherwise routes the request back to K2.6, even when model=k3.
    const enableThinking = input.enableThinking
      ?? (modelLower === 'k3'
        || modelLower === 'kimi-k3'
        || modelLower.includes('think')
        || modelLower.includes('r1'))
    const enableWebSearch = input.enableWebSearch
      ?? modelLower.includes('search')

    // Delegate to renderer
    const kimiRequest = renderKimiRequest(cleaned, {
      model: input.model,
      originalModel: input.originalModel,
      sessionId,
      reqId,
      enableThinking,
      enableWebSearch,
    }, token)

    return {
      ...kimiRequest,
      transportOptions: {
        responseType: 'stream',
        timeout: 120000,
        validateStatus: () => true,
      },
    }
  },

  async parseNonStream(input: ProviderWebResponse): Promise<ProviderRuntimeResult> {
    return parseKimiNonStream(input)
  },

  parseStream(input: ProviderRuntimeStreamInput): AsyncIterable<ProviderRuntimeEvent> {
    return parseKimiStream(input)
  },

  async deleteSession(input: ProviderDeleteSessionInput): Promise<ProviderDeleteSessionResult> {
    const adapter = new KimiAdapter(input.provider, input.account)
    const success = await adapter.deleteConversation(input.sessionId)
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
