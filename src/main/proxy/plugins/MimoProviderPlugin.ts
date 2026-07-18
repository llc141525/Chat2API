/**
 * MimoProviderPlugin — Phase 1 wrapper delegating to renderer/parser
 *
 * Delegates request rendering to providers/mimo/renderer.ts and
 * response parsing to providers/mimo/parser.ts.
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
  ProviderRuntimeEvent,
  ProviderDeleteSessionInput,
  ProviderDeleteSessionResult,
  ProviderRuntimeStreamInput,
} from './types.ts'
import { MimoAdapter } from '../adapters/mimo.ts'
import { renderMimoRequest } from '../providers/mimo/renderer.ts'
import { parseMimoStream, parseMimoNonStream } from '../providers/mimo/parser.ts'
import axios from 'axios'

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
    return renderMimoRequest(input)
  },

  async parseNonStream(input: ProviderWebResponse): Promise<ProviderRuntimeResult> {
    return parseMimoNonStream(input)
  },

  parseStream(input: ProviderRuntimeStreamInput): AsyncIterable<ProviderRuntimeEvent> {
    return parseMimoStream(input)
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
