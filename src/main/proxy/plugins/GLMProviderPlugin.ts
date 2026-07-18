/**
 * GLMProviderPlugin — Phase 3b wrapper
 *
 * Delegates rendering to providers/glm/renderer.ts and parsing to
 * providers/glm/parser.ts. Inlines file upload, token acquisition,
 * and conversation deletion logic from the GLM adapter.
 *
 * Implements the WebProviderPlugin interface to bridge between
 * ProviderRuntime normalized types and the GLM web provider protocol.
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
import { GLMAdapter } from '../adapters/glm.ts'
import { renderGLMRequest } from '../providers/glm/renderer.ts'
import { parseGLMStream, parseGLMNonStream } from '../providers/glm/parser.ts'
import { buildCleanedRequest } from '../core/requestCleaner.ts'
import axios from 'axios'
import crypto from 'node:crypto'

const GLM_API_BASE = 'https://chatglm.cn/chatglm'
const DEFAULT_ASSISTANT_ID = '65940acff94777010aa6b796'
const SIGN_SECRET = '8a1317a7468aa3ad86e997d08f3f31cb'

/**
 * Generate a UUID string with dashes.
 */
function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/**
 * Generate a request-scoped ID (no dashes).
 */
function generateId(): string {
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/**
 * MD5 hash of a string.
 */
function md5(str: string): string {
  return crypto.createHash('md5').update(str).digest('hex')
}

/**
 * Generate GLM request signing parameters (pure, no HTTP calls).
 */
function generateSign(): { timestamp: string; nonce: string; sign: string } {
  const e = Date.now()
  const A = e.toString()
  const t = A.length
  const o = A.split('').map((c) => Number(c))
  const i = o.reduce((acc, val) => acc + val, 0) - o[t - 2]
  const a = i % 10
  const timestamp = A.substring(0, t - 2) + a + A.substring(t - 1, t)
  const nonce = uuid()
  const sign = md5(`${timestamp}-${nonce}-${SIGN_SECRET}`)
  return { timestamp, nonce, sign }
}

/**
 * Upload file/image references for GLM assembly messages.
 * Uses private methods of GLMAdapter via prototype access.
 */
async function uploadGLMAssemblyRefs(
  adapter: GLMAdapter,
  messages: Array<{ role: string; content: unknown }>,
): Promise<any[]> {
  // Access private methods via any cast for file upload
  const adapterAny = adapter as any
  const { fileUrls, imageUrls } = adapterAny.extractFileUrls(messages)
  const refs: any[] = []

  for (const fileUrl of fileUrls) {
    try {
      const result = await adapterAny.uploadFile(fileUrl)
      refs.push({ source_id: result.source_id, file_url: result.file_url || fileUrl })
    } catch (error) {
      console.error('[GLM] Failed to upload file from runtime assembly:', error)
    }
  }

  for (const imageUrl of imageUrls) {
    try {
      const result = await adapterAny.uploadFile(imageUrl)
      refs.push({
        source_id: result.source_id,
        image_url: result.file_url || imageUrl,
        width: 0,
        height: 0,
      })
    } catch (error) {
      console.error('[GLM] Failed to upload image from runtime assembly:', error)
    }
  }

  return refs
}

/**
 * Log probe request assembly details for debugging.
 */
function traceProbeAssembly(messages: Array<{ role: string; content: unknown }>): void {
  const text = messages.flatMap((message) => Array.isArray(message.content)
    ? message.content
      .filter((part): part is { type?: unknown; text?: unknown } => typeof part === 'object' && part !== null)
      .map((part) => part.type === 'text' && typeof part.text === 'string' ? part.text : '')
    : [],
  ).join('\n')

  const hasWarmupInstruction = text.includes('WARMUP_ACK_')
  const hasLongTaskInstruction = text.includes('LONG_CONVERSATION_PROBE')
  if (!hasWarmupInstruction && !hasLongTaskInstruction) return

  console.log('[GLM] Probe request assembly:', JSON.stringify({
    messageCount: messages.length,
    roleCounts: messages.reduce<Record<string, number>>((counts, message) => {
      counts[message.role] = (counts[message.role] ?? 0) + 1
      return counts
    }, {}),
    textChars: text.length,
    textSha256: crypto.createHash('sha256').update(text).digest('hex').slice(0, 16),
    runtimeMarkerCount: (text.match(/superpowers/g) ?? []).length,
    rawSkillDocumentCount: (text.match(/<skill_content\b/gi) ?? []).length,
    activeSkillCheckpointCount: (text.match(/\[Active skill workflow state checkpoint\]/g) ?? []).length,
    hasWarmupInstruction,
    hasLongTaskInstruction,
  }))
}

export const GLMProviderPlugin: WebProviderPlugin = {
  id: 'glm',
  version: '1.0.0',

  matches(provider: { id: string }): boolean {
    return provider.id.toLowerCase() === 'glm'
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
    reuseProviderSessionForToolChild: true,
    requestThrottle: {
      minIntervalMs: 2000,
      rateLimitBackoffMs: 30000,
    },
    firstStreamEventTimeoutMs: 20000,
  },

  async buildRequest(input: ProviderRuntimeRequest): Promise<ProviderWebRequest> {
    // Create adapter instance for token refresh and file upload utilities.
    const adapter = new GLMAdapter(input.provider, input.account)
    const hasManagedToolHistory = input.assembly.messages.some((message) => (
      (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
      || (message.role === 'tool' && typeof message.tool_call_id === 'string' && message.tool_call_id.length > 0)
    ))
    const startsManagedConversation = Boolean(
      input.sessionId && input.assembly.toolManifest && !hasManagedToolHistory,
    )
    const effectiveSessionId = startsManagedConversation ? undefined : input.sessionId

    // Build cleaned request
    const cleaned = buildCleanedRequest(input.assembly, {
      promptRefreshMode: input.promptRefreshMode ?? 'full',
      hasProviderSession: !!effectiveSessionId,
    })

    // For file uploads, we need the original assembly messages
    const assemblyMessages = input.assembly.messages.filter((m) => m.role !== 'system')
    const refs = effectiveSessionId ? [] : await uploadGLMAssemblyRefs(adapter, assemblyMessages)

    // Debug probe logging
    traceProbeAssembly([
      { role: 'user', content: cleaned.messages.map((m) => m.content as string).join('\n') },
    ])

    const reqId = generateId()
    const token = await adapter.acquireToken()
    const conversationId = effectiveSessionId || ''

    const webReq = renderGLMRequest(
      cleaned,
      {
        model: input.model,
        originalModel: input.originalModel,
        sessionId: conversationId,
        reqId,
        parentReqId: input.parentReqId,
        enableThinking: input.enableThinking ?? false,
        enableWebSearch: input.enableWebSearch ?? false,
      },
      token,
      refs,
    )

    // Add transport options
    return {
      ...webReq,
      transportOptions: {
        responseType: 'stream',
        timeout: 45000,
        validateStatus: () => true,
      },
    }
  },

  async parseNonStream(input: ProviderWebResponse): Promise<ProviderRuntimeResult> {
    return parseGLMNonStream(input)
  },

  async deleteSession(input: ProviderDeleteSessionInput): Promise<ProviderDeleteSessionResult> {
    // Inline conversation deletion — acquire token and call delete API directly
    try {
      const adapter = new GLMAdapter(input.provider, input.account)
      const token = await adapter.acquireToken()
      const sign = generateSign()

      const response = await axios.post(
        `${GLM_API_BASE}/backend-api/assistant/conversation/delete`,
        {
          assistant_id: DEFAULT_ASSISTANT_ID,
          conversation_id: input.sessionId,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Referer: 'https://chatglm.cn/main/alltoolsdetail',
            'X-Device-Id': uuid(),
            'X-Request-Id': uuid(),
            'X-Sign': sign.sign,
            'X-Timestamp': sign.timestamp,
            'X-Nonce': sign.nonce,
            'Accept': 'text/event-stream',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
            'App-Name': 'chatglm',
            'Cache-Control': 'no-cache',
            'Content-Type': 'application/json',
            Origin: 'https://chatglm.cn',
            Pragma: 'no-cache',
          },
          timeout: 15000,
          validateStatus: () => true,
        },
      )

      console.log('[GLM] Conversation deleted:', input.sessionId, response.status)
      return { success: response.status === 200 }
    } catch (error) {
      console.error('[GLM] Failed to delete conversation:', error)
      return { success: false }
    }
  },

  parseStream(input: ProviderRuntimeStreamInput): AsyncIterable<ProviderRuntimeEvent> {
    return parseGLMStream(input)
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
