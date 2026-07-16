/**
 * MiniMaxProviderPlugin — Phase 1 wrapper around MiniMaxAdapter
 *
 * Implements the WebProviderPlugin interface to bridge between
 * ProviderRuntime normalized types and the MiniMax web provider protocol.
 *
 * Transport: polling_stream — the provider processes messages asynchronously
 * and the client polls for results. The initial send_msg request triggers
 * processing and returns a chat_id used for subsequent polling.
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
import { MiniMaxAdapter } from '../adapters/minimax.ts'
import axios from 'axios'
import crypto from 'crypto'

const AGENT_BASE_URL = 'https://agent.minimaxi.com'

/**
 * MD5 hash helper, matching MiniMaxAdapter's internal function.
 */
function md5(input: string): string {
  return crypto.createHash('md5').update(input).digest('hex')
}

/**
 * Extract text content from a message content field.
 */
function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((c: Record<string, unknown>) => c.type === 'text')
      .map((c: Record<string, unknown>) => String(c.text ?? ''))
      .join('\n')
  }
  return String(content ?? '')
}

/**
 * Build the MiniMax send_msg request body from normalized messages.
 *
 * Mirrors MiniMaxAdapter.messagesPrepare() logic but simplified for
 * managed_xml (tool calls embedded as XML in text content).
 */
function buildMiniMaxBody(
  messages: Array<{ role: string; content: unknown }>,
): Record<string, unknown> {
  const parts: string[] = []
  let system = ''
  for (const msg of messages) {
    const txt = extractTextContent(msg.content)
    if (!txt) continue
    if (msg.role === 'system') {
      system = txt
    } else if (msg.role === 'assistant') {
      parts.push(`Assistant: ${txt}`)
    } else {
      parts.push(txt)
    }
  }
  const joined = parts.join('\n\n')
  const text = system ? `${system}\n\nUser: ${joined}` : joined

  return {
    msg_type: 1,
    text,
    chat_type: 1,
    attachments: [],
    selected_mcp_tools: [],
    backend_config: {},
    sub_agent_ids: [],
  }
}

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
  },

  async buildRequest(input: ProviderRuntimeRequest): Promise<ProviderWebRequest> {
    const sessionId = input.sessionId || ''
    const reqId = '' // MiniMax uses chat_id, not reqId

    // Parse token credentials
    const { jwtToken, realUserID } = parseMiniMaxToken(
      input.account.credentials as Record<string, unknown>,
    )

    // Build the send_msg request body
    const requestBody = buildMiniMaxBody(input.messages)

    // If we have an existing chat_id, include it for the continuation
    if (sessionId) {
      (requestBody as Record<string, unknown>).chat_id = sessionId
    }

    // Compute MiniMax auth headers (pure computation, no HTTP calls)
    const unix = `${Date.now()}`
    const timestamp = Math.floor(Date.now() / 1000)
    const dataJson = JSON.stringify(requestBody)

    // Build query string (matching MiniMaxAdapter.request() logic)
    const queryParts: string[] = [
      `device_platform=web`,
      `biz_id=3`,
      `app_id=3001`,
      `version_code=22201`,
      `uuid=${realUserID}`,
      `os_name=Mac`,
      `browser_name=chrome`,
      `device_memory=8`,
      `cpu_core_num=11`,
      `browser_language=zh-CN`,
      `browser_platform=MacIntel`,
      `user_id=${realUserID}`,
      `screen_width=1920`,
      `screen_height=1080`,
      `unix=${unix}`,
      `lang=zh`,
      `token=${jwtToken}`,
      `timezone_offset=28800`,
      `sys_language=zh`,
      `client=web`,
    ]
    const queryStr = queryParts.join('&')

    const uri = '/matrix/api/v1/chat/send_msg'
    const fullUri = `${uri}?${queryStr}`
    const yy = md5(
      `${encodeURIComponent(fullUri)}_${dataJson}${md5(unix)}ooui`,
    )
    const signature = md5(`${timestamp}${jwtToken}${dataJson}`)

    return {
      url: `${AGENT_BASE_URL}${uri}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        token: jwtToken,
        'x-timestamp': String(timestamp),
        'x-signature': signature,
        yy,
      },
      body: requestBody,
      sessionId,
      reqId,
    }
  },

  async parseNonStream(input: ProviderWebResponse): Promise<ProviderRuntimeResult> {
    let sessionId = ''
    let reqId = ''

    try {
      const data = input.data as Record<string, unknown>
      if (data?.chat_id) {
        sessionId = String(data.chat_id)
      }
      if (data?.msg_id) {
        reqId = String(data.msg_id)
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
