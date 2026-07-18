/**
 * ZaiProviderPlugin — Phase 3c
 *
 * Delegates rendering to providers/zai/renderer.ts and parsing to
 * providers/zai/parser.ts. Inlines session deletion from the adapter.
 *
 * Implements the WebProviderPlugin interface to bridge between
 * ProviderRuntime normalized types and the Z.ai (GLM International)
 * web provider protocol.
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
import { ZaiAdapter } from '../adapters/zai.ts'
import { renderZaiRequest } from '../providers/zai/renderer.ts'
import { parseZaiStream, parseZaiNonStream } from '../providers/zai/parser.ts'
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

/**
 * Generate a UUID without dashes.
 */
function generateIdFlat(): string {
  return generateId().replace(/-/g, '')
}

export const ZaiProviderPlugin: WebProviderPlugin = {
  id: 'zai',
  version: '1.0.0',

  matches(provider: { id: string }): boolean {
    return provider.id.toLowerCase() === 'zai'
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
    const sessionId = input.sessionId || generateIdFlat()
    const reqId = generateIdFlat()

    const token = input.account.credentials.token
      || input.account.credentials.accessToken
      || input.account.credentials.jwt
      || ''

    // Build cleaned request
    const cleaned = buildCleanedRequest(input.assembly, {
      promptRefreshMode: input.promptRefreshMode ?? 'full',
      hasProviderSession: Boolean(input.sessionId),
    })

    const enableThinking = input.enableThinking ?? true
    const enableWebSearch = input.enableWebSearch ?? false

    // Delegate to renderer
    const zaiRequest = renderZaiRequest(cleaned, {
      model: input.model,
      originalModel: input.originalModel,
      sessionId,
      reqId,
      enableThinking,
      enableWebSearch,
    }, token)

    return zaiRequest
  },

  async parseNonStream(input: ProviderWebResponse): Promise<ProviderRuntimeResult> {
    return parseZaiNonStream(input)
  },

  parseStream(input: ProviderRuntimeStreamInput): AsyncIterable<ProviderRuntimeEvent> {
    return parseZaiStream(input)
  },

  async deleteSession(input: ProviderDeleteSessionInput): Promise<ProviderDeleteSessionResult> {
    const adapter = new ZaiAdapter(input.provider, input.account)
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
