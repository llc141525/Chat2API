/**
 * renderer.ts — Phase 3c
 *
 * Pure rendering logic for Z.ai (GLM International) provider.
 * Takes a CleanedRequest (already filtered, truncated, and delta-selected)
 * and produces the Z.ai-specific HTTP request body + headers.
 *
 * Does NOT do: filtering, truncation, delta selection, infrastructure prompt
 * building, token acquisition, or session creation — those are the
 * responsibility of requestCleaner.ts and the plugin.
 */

import type { CleanedRequest } from '../../core/requestCleaner.ts'
import crypto from 'node:crypto'

// ── Types ───────────────────────────────────────────────────────────

export interface RenderZaiRequestInput {
  model: string
  originalModel?: string
  sessionId: string
  reqId: string
  enableThinking: boolean
  enableWebSearch: boolean
}

export interface ZaiWebRequest {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: Record<string, unknown>
  sessionId: string
  reqId: string
}

// ── Constants ───────────────────────────────────────────────────────

const ZAI_API_BASE = 'https://chat.z.ai'
const ZAI_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
const SIGN_SECRET = 'key-@@@@)))()((9))-xxxx&&&%%%%%'

// ── Public API ──────────────────────────────────────────────────────

/**
 * Build the Z.ai web request (URL, headers, body) for a streaming call.
 *
 * @param cleaned  — CleanedRequest from requestCleaner.ts
 * @param input    — RenderZaiRequestInput with session/request metadata
 * @param token    — Bearer token (acquired by the caller)
 * @returns ZaiWebRequest ready for the transport layer
 */
export function renderZaiRequest(
  cleaned: CleanedRequest,
  input: RenderZaiRequestInput,
  token: string,
): ZaiWebRequest {
  const {
    model,
    sessionId,
    reqId,
    enableThinking,
    enableWebSearch,
  } = input

  // Map model name
  const mappedModel = mapZaiModel(model)
  const timestamp = Date.now()

  // Extract user ID from token
  const userId = extractUserIdFromToken(token)

  // Build request body
  const messageId = generateIdFlat()
  const requestBody = buildZaiRequestBody(
    mappedModel,
    cleaned,
    sessionId,
    messageId,
    enableThinking,
    enableWebSearch,
  )

  // Get last user message for signature
  const lastUserMessage = extractLastUserMessage(cleaned)
  const signature = generateZaiSignature(lastUserMessage, reqId, timestamp, userId)

  // Build query params
  const queryParams = buildZaiQueryParams(timestamp, reqId, userId, token, sessionId)
  const url = `${ZAI_API_BASE}/api/v2/chat/completions?${queryParams.toString()}`

  // Update the signature_prompt in the body with the actual last user message
  requestBody.signature_prompt = lastUserMessage

  return {
    url,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Cookie': `token=${token}`,
      'Content-Type': 'application/json',
      'Accept': '*/*',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Accept-Language': 'zh-CN',
      'Cache-Control': 'no-cache',
      'Origin': ZAI_API_BASE,
      'Referer': `${ZAI_API_BASE}/c/${sessionId}`,
      'X-FE-Version': 'prod-fe-1.1.68',
      'X-Signature': signature,
      'User-Agent': ZAI_USER_AGENT,
      'Sec-Ch-Ua': '"Not/A)Brand";v="99", "Chromium";v="148"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"macOS"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'X-Region': 'domestic',
    },
    body: requestBody,
    sessionId,
    reqId,
  }
}

// ── Model mapping ───────────────────────────────────────────────────

function mapZaiModel(model: string): string {
  const mapping: Record<string, string> = {
    'glm-5.2': 'GLM-5.2',
    'glm-5.1': 'GLM-5.1',
    'glm-5-turbo': 'GLM-5-Turbo',
    'glm-5v-turbo': 'GLM-5v-Turbo',
    'glm-5': 'glm-5',
    'glm-4.7': 'glm-4.7',
    'GLM-5.2': 'GLM-5.2',
    'GLM-5.1': 'GLM-5.1',
    'GLM-5-Turbo': 'GLM-5-Turbo',
    'GLM-5V-Turbo': 'GLM-5v-Turbo',
    'GLM-5v-Turbo': 'GLM-5v-Turbo',
    'GLM-5': 'glm-5',
    'GLM-4.7': 'glm-4.7',
  }
  return mapping[model] || mapping[model.toLowerCase()] || model
}

// ── Signature generation ────────────────────────────────────────────

function generateZaiSignature(
  messageText: string,
  requestId: string,
  timestampMs: number,
  userId: string,
): string {
  const windowIndex = Math.floor(timestampMs / (5 * 60 * 1000))
  const metaString = `requestId,${requestId},timestamp,${timestampMs},user_id,${userId}`
  const messageB64 = Buffer.from(messageText, 'utf-8').toString('base64')
  const canonicalString = `${metaString}|${messageB64}|${String(timestampMs)}`

  const derivedKey = crypto.createHmac('sha256', SIGN_SECRET).update(String(windowIndex)).digest('hex')
  return crypto.createHmac('sha256', derivedKey).update(canonicalString).digest('hex')
}

// ── Request body building ───────────────────────────────────────────

function buildZaiRequestBody(
  mappedModel: string,
  cleaned: CleanedRequest,
  chatId: string,
  messageId: string,
  enableThinking: boolean,
  enableWebSearch: boolean,
): Record<string, unknown> {
  const messages = cleaned.messages.map(m => ({
    role: m.role,
    content: m.content,
  }))
  // Inject tool contract text as system message (managed by ToolCallingEngine)
  if (cleaned.toolContractText) {
    messages.push({ role: 'system', content: cleaned.toolContractText })
  }

  return {
    stream: true,
    model: mappedModel,
    messages,
    signature_prompt: '',
    params: {},
    extra: {},
    features: {
      image_generation: false,
      web_search: false,
      auto_web_search: enableWebSearch,
      preview_mode: true,
      flags: [],
      vlm_tools_enable: false,
      vlm_web_search_enable: false,
      vlm_website_mode: false,
      enable_thinking: enableThinking,
    },
    variables: {
      '{{USER_NAME}}': 'User',
      '{{USER_LOCATION}}': 'Unknown',
      '{{CURRENT_DATETIME}}': new Date().toISOString().replace('T', ' ').substring(0, 19),
      '{{CURRENT_DATE}}': new Date().toISOString().substring(0, 10),
      '{{CURRENT_TIME}}': new Date().toISOString().substring(11, 19),
      '{{CURRENT_WEEKDAY}}': ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date().getDay()],
      '{{CURRENT_TIMEZONE}}': 'Asia/Shanghai',
      '{{USER_LANGUAGE}}': 'zh-CN',
    },
    chat_id: chatId,
    id: generateIdFlat(),
    current_user_message_id: messageId,
    current_user_message_parent_id: null,
    background_tasks: {
      title_generation: true,
      tags_generation: true,
    },
  }
}

// ── Query params building ───────────────────────────────────────────

function buildZaiQueryParams(
  timestamp: number,
  requestId: string,
  userId: string,
  token: string,
  chatId: string,
): URLSearchParams {
  const params = new URLSearchParams({
    timestamp: String(timestamp),
    requestId,
    user_id: userId,
    version: '0.0.1',
    platform: 'web',
    token,
    user_agent: ZAI_USER_AGENT,
    language: 'zh-CN',
    languages: 'zh-CN,zh',
    timezone: 'Asia/Shanghai',
    cookie_enabled: 'true',
    screen_width: '1512',
    screen_height: '982',
    screen_resolution: '1512x982',
    viewport_height: '945',
    viewport_width: '923',
    viewport_size: '923x945',
    color_depth: '30',
    pixel_ratio: '2',
    current_url: `${ZAI_API_BASE}/c/${chatId}`,
    pathname: `/c/${chatId}`,
    search: '',
    hash: '',
    host: 'chat.z.ai',
    hostname: 'chat.z.ai',
    protocol: 'https:',
    referrer: '',
    title: 'Z.ai - Free AI Chatbot & Agent powered by GLM-5 & GLM-4.7',
    timezone_offset: '-480',
    local_time: new Date().toISOString(),
    utc_time: new Date().toUTCString(),
    is_mobile: 'false',
    is_touch: 'false',
    max_touch_points: '0',
    browser_name: 'Chrome',
    os_name: 'Mac OS',
    signature_timestamp: String(timestamp),
  })
  return params
}

// ── Helpers ─────────────────────────────────────────────────────────

function extractUserIdFromToken(token: string): string {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return 'guest'
    let payload = parts[1]
    const padding = payload.length % 4
    if (padding > 0) payload += '='.repeat(4 - padding)
    payload = payload.replace(/-/g, '+').replace(/_/g, '/')
    const decoded = Buffer.from(payload, 'base64').toString('utf8')
    const data = JSON.parse(decoded)
    return data.id || data.user_id || data.uid || data.sub || 'guest'
  } catch {
    return 'guest'
  }
}

function extractLastUserMessage(cleaned: CleanedRequest): string {
  for (let i = cleaned.messages.length - 1; i >= 0; i--) {
    if (cleaned.messages[i].role === 'user') {
      const content = cleaned.messages[i].content
      if (typeof content === 'string') return content
      if (Array.isArray(content)) {
        const texts: string[] = []
        for (const part of content) {
          if (typeof part === 'object' && part !== null && part.type === 'text' && part.text) {
            texts.push(part.text)
          }
        }
        return texts.join('\n')
      }
      return ''
    }
  }
  return ''
}

function generateIdFlat(): string {
  const id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
  return id.replace(/-/g, '')
}
