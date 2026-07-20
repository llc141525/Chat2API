/**
 * MiniMaxProviderPlugin — Phase 3c
 *
 * Delegates rendering to providers/minimax/renderer.ts and parsing to
 * providers/minimax/parser.ts. Inlines token parsing and session
 * deletion from the adapter.
 *
 * Implements the WebProviderPlugin interface to bridge between
 * ProviderRuntime normalized types and the MiniMax web provider protocol.
 *
 * Transport: polling_stream — the provider processes messages asynchronously
 * and the client polls for results.
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
  ProviderRuntimeStreamInput,
} from './types.ts'
import { MiniMaxAdapter } from '../adapters/minimax.ts'
import { renderMiniMaxRequest } from '../providers/minimax/renderer.ts'
import { parseMiniMaxStream, parseMiniMaxNonStream } from '../providers/minimax/parser.ts'
import { buildCleanedRequest } from '../core/requestCleaner.ts'
import axios from 'axios'

/**
 * Parse realUserID and jwtToken from a MiniMax credentials token.
 *
 * The token can be in one of three formats:
 * 1. realUserID+JWTtoken  (separate realUserID and JWT)
 * 2. Just JWT token        (parse realUserID from JWT payload)
 * 3. Provided via credentials.realUserID
 */
function parseMiniMaxToken(
  credentials: Record<string, unknown>,
): { jwtToken: string; realUserID: string } {
  const rawToken = String(credentials.token ?? '')
  const providedRealUserID = String(credentials.realUserID ?? '').trim()

  if (providedRealUserID) {
    return { jwtToken: rawToken, realUserID: providedRealUserID }
  }

  if (rawToken.includes('+')) {
    const parts = rawToken.split('+')
    return { jwtToken: parts[1], realUserID: parts[0] }
  }

  // Try to parse realUserID from JWT payload
  let realUserID = ''
  try {
    const payload = rawToken.split('.')[1]
    if (payload) {
      const padding = 4 - (payload.length % 4)
      const padded = padding !== 4 ? payload + '='.repeat(padding) : payload
      const decoded = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
      realUserID = decoded?.user?.id || ''
    }
  } catch {
    // Ignore parse failure
  }

  return { jwtToken: rawToken, realUserID }
}

export const MiniMaxProviderPlugin: WebProviderPlugin = {
  id: 'minimax',
  version: '1.0.0',

  matches(provider: { id: string }): boolean {
    return provider.id.toLowerCase() === 'minimax'
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
    transport: 'polling_stream',
    firstStreamEventTimeoutMs: 20000,
  },

  async buildRequest(input: ProviderRuntimeRequest): Promise<ProviderWebRequest> {
    const sessionId = input.sessionId || ''
    const reqId = '' // MiniMax uses chat_id, not reqId

    // Parse token credentials
    const { jwtToken, realUserID } = parseMiniMaxToken(
      input.account.credentials as Record<string, unknown>,
    )

    // Build cleaned request
    const cleaned = buildCleanedRequest(input.assembly, {
      promptRefreshMode: input.promptRefreshMode ?? 'full',
      hasProviderSession: Boolean(input.sessionId),
    })

    // Delegate to renderer
    const minimaxRequest = renderMiniMaxRequest(cleaned, {
      model: input.model,
      originalModel: input.originalModel,
      sessionId,
      reqId,
    }, jwtToken, realUserID)

    return minimaxRequest
  },

  async parseNonStream(input: ProviderWebResponse): Promise<ProviderRuntimeResult> {
    return parseMiniMaxNonStream(input)
  },

  parseStream(input: ProviderRuntimeStreamInput): AsyncIterable<ProviderRuntimeEvent> {
    return parseMiniMaxStream(input)
  },

  async deleteSession(input: ProviderDeleteSessionInput): Promise<ProviderDeleteSessionResult> {
    const adapter = new MiniMaxAdapter(input.provider, input.account)
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
