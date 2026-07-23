/**
 * DeepSeekProviderPlugin — Phase 3b wrapper
 *
 * Delegates rendering to providers/deepseek/renderer.ts and parsing to
 * providers/deepseek/parser.ts. Inlines session creation, token
 * acquisition, PoW challenge solving, and session deletion from the
 * DeepSeek adapter.
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
  ProviderRuntimeStreamInput,
} from './types.ts'
import { renderDeepSeekRequest } from '../providers/deepseek/renderer.ts'
import { parseDeepSeekStream, parseDeepSeekNonStream } from '../providers/deepseek/parser.ts'
import { addDeepSeekPowHeader, type DeepSeekPowDependencies } from '../providers/deepseek/pow.ts'
import { buildCleanedRequest } from '../core/requestCleaner.ts'
import axios from 'axios'
import type { Account, Provider } from '../../store/types.ts'

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

export function createDeepSeekProviderPlugin(
  deps: Partial<DeepSeekPowDependencies> & {
    createSession?: (provider: Provider, account: Account) => Promise<string>
  } = {},
): WebProviderPlugin {
  return {
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
      preferredManagedProtocol: 'managed_bracket',
      sessionIdKind: 'session_id',
      transport: 'provider_chat_api',
    },

    async buildRequest(input: ProviderRuntimeRequest): Promise<ProviderWebRequest> {
      const token = input.account.credentials.token
        || input.account.credentials.apiKey
        || input.account.credentials.refreshToken
        || ''

      const sessionId = input.sessionId || await createDeepSeekSession(input.provider, input.account, deps.createSession)
      const reqId = generateId()

      // Build cleaned request for message processing
      const cleaned = buildCleanedRequest(input.assembly, {
        promptRefreshMode: input.promptRefreshMode ?? 'full',
        hasProviderSession: !!sessionId,
      })

      const webReq = renderDeepSeekRequest(
        cleaned,
        {
          model: input.model,
          originalModel: input.originalModel,
          sessionId,
          reqId,
          parentReqId: input.parentReqId,
          enableThinking: input.enableThinking ?? false,
          enableWebSearch: input.enableWebSearch ?? false,
        },
        token,
      )

      return addDeepSeekPowHeader(webReq, token, deps)
    },

    async parseNonStream(input: ProviderWebResponse): Promise<ProviderRuntimeResult> {
      return parseDeepSeekNonStream(input)
    },

    async deleteSession(input: ProviderDeleteSessionInput): Promise<ProviderDeleteSessionResult> {
      // Inline session deletion — acquire token and call delete API directly
      try {
        const { DeepSeekAdapter } = await import('../adapters/deepseek.ts')
        const adapter = new DeepSeekAdapter(input.provider, input.account)
        const success = await adapter.deleteSession(input.sessionId)
        return { success }
      } catch (error) {
        console.error('[DeepSeek] Failed to delete session:', error)
        return { success: false }
      }
    },

    parseStream(input: ProviderRuntimeStreamInput): AsyncIterable<ProviderRuntimeEvent> {
      return parseDeepSeekStream(input)
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
}

export const DeepSeekProviderPlugin: WebProviderPlugin = createDeepSeekProviderPlugin()

async function createDeepSeekSession(
  provider: Provider,
  account: Account,
  override?: (provider: Provider, account: Account) => Promise<string>,
): Promise<string> {
  const sessionId = override
    ? await override(provider, account)
    : await createSessionWithLegacyAdapter(provider, account)

  const trimmed = sessionId.trim()
  if (!trimmed) {
    throw new Error('DeepSeek session creation returned an empty chat_session_id')
  }
  return trimmed
}

async function createSessionWithLegacyAdapter(provider: Provider, account: Account): Promise<string> {
  const { DeepSeekAdapter } = await import('../adapters/deepseek.ts')
  const adapter = new DeepSeekAdapter(provider, account)
  return adapter.ensureSession()
}
