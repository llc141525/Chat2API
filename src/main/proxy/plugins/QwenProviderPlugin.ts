/**
 * QwenProviderPlugin — Phase 3a
 *
 * Implements the WebProviderPlugin interface by delegating to:
 *   - renderer.ts (build HTTP request from cleaned input)
 *   - parser.ts (parse Qwen stream/non-stream responses)
 *
 * Session deletion is inlined from the adapter.
 */

import type { WebProviderPlugin } from './WebProviderPlugin.ts'
import type {
  ProviderRuntimeRequest,
  ProviderRuntimeStreamInput,
  ProviderWebRequest,
  ProviderWebResponse,
  ProviderRuntimeResult,
  ProviderRuntimeEvent,
  ProviderRuntimeError,
  ProviderDeleteSessionInput,
  ProviderDeleteSessionResult,
} from './types.ts'
import { renderQwenRequest } from '../providers/qwen/renderer.ts'
import { parseQwenStream, parseQwenNonStream } from '../providers/qwen/parser.ts'
import { buildCleanedRequest } from '../core/requestCleaner.ts'
import { QwenAdapter } from '../adapters/qwen.ts'
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

export const QwenProviderPlugin: WebProviderPlugin = {
  id: 'qwen',
  version: '1.0.0',

  matches(provider: { id: string }): boolean {
    return provider.id.toLowerCase() === 'qwen'
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
    const ticket = input.account.credentials.ticket || input.account.credentials.tongyi_sso_ticket || ''

    const reqId = generateId()
    const sessionId = input.sessionId || generateId()
    const timestamp = Date.now()

    // Use the pre-built CleanedRequest from ProviderRuntime (Phase 3a),
    // falling back to building one from the assembly
    const cleaned = input.cleanedRequest ?? buildCleanedRequest(input.assembly, {
      promptRefreshMode: input.promptRefreshMode ?? 'full',
      hasProviderSession: Boolean(input.sessionId),
    })

    const qwenRequest = renderQwenRequest(cleaned, {
      model: input.model,
      originalModel: input.originalModel,
      sessionId,
      reqId,
      parentReqId: input.parentReqId,
      timestamp,
      enableThinking: input.enableThinking ?? false,
      enableWebSearch: input.enableWebSearch ?? false,
    }, ticket)

    return {
      ...qwenRequest,
      transportOptions: {
        responseType: 'stream',
        timeout: 120000,
        decompress: false,
        validateStatus: () => true,
      },
    }
  },

  async parseNonStream(input: ProviderWebResponse): Promise<ProviderRuntimeResult> {
    return parseQwenNonStream(input)
  },

  /**
   * Parse a streaming Qwen response into normalized runtime events.
   */
  parseStream(input: ProviderRuntimeStreamInput): AsyncIterable<ProviderRuntimeEvent> {
    return parseQwenStream(input)
  },

  async deleteSession(input: ProviderDeleteSessionInput): Promise<ProviderDeleteSessionResult> {
    const adapter = new QwenAdapter(input.provider, input.account)
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
