/**
 * PerplexityProviderPlugin — Phase 1 wrapper around PerplexityAdapter
 *
 * Implements the WebProviderPlugin interface to bridge between
 * ProviderRuntime normalized types and the Perplexity web provider protocol.
 *
 * Perplexity uses Electron's net API for HTTP calls — buildRequest
 * returns the URL/headers/body, and the actual HTTP call is handled
 * by forwarder / ProviderRuntime.
 */

import type { WebProviderPlugin } from './WebProviderPlugin.ts'
import type {
  ProviderRuntimeRequest,
  ProviderWebRequest,
  ProviderWebResponse,
  ProviderRuntimeResult,
  ProviderRuntimeStreamInput,
  ProviderRuntimeEvent,
  ProviderRuntimeError,
  ProviderDeleteSessionInput,
  ProviderDeleteSessionResult,
} from './types.ts'
import type { CleanedRequest } from '../core/requestCleaner.ts'
import { PerplexityAdapter } from '../adapters/perplexity.ts'
import axios from 'axios'
import { renderPerplexityRequest } from '../providers/perplexity/renderer.ts'
import { parsePerplexityStream } from '../providers/perplexity/parser.ts'
import { parsePerplexityNonStream } from '../providers/perplexity/parser.ts'

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

export const PerplexityProviderPlugin: WebProviderPlugin = {
  id: 'perplexity',
  version: '1.0.0',

  matches(provider: { id: string }): boolean {
    return provider.id.toLowerCase() === 'perplexity'
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
    const cookieToken = input.account.credentials.sessionToken
      || input.account.credentials.cookie
      || input.account.credentials.token
      || ''

    const sessionId = input.sessionId || generateId()
    const reqId = generateId()

    const cleaned: CleanedRequest = input.cleanedRequest ?? {
      messages: input.messages,
    } as CleanedRequest

    return renderPerplexityRequest(
      cleaned,
      { model: input.model, originalModel: input.originalModel, sessionId, reqId },
      cookieToken,
    )
  },

  async parseNonStream(input: ProviderWebResponse): Promise<ProviderRuntimeResult> {
    return parsePerplexityNonStream(input)
  },

  /**
   * Parse a streaming Perplexity response into normalized runtime events.
   *
   * Delegates to parsePerplexityStream from the dedicated parser module.
   */
  parseStream(input: ProviderRuntimeStreamInput): AsyncIterable<ProviderRuntimeEvent> {
    return parsePerplexityStream(input)
  },

  async deleteSession(input: ProviderDeleteSessionInput): Promise<ProviderDeleteSessionResult> {
    const adapter = new PerplexityAdapter(input.provider, input.account)
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
