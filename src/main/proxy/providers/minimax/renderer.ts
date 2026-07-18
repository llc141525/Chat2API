/**
 * renderer.ts — Phase 3c
 *
 * Pure rendering logic for MiniMax provider.
 * Takes a CleanedRequest (already filtered, truncated, and delta-selected)
 * and produces the MiniMax-specific HTTP request body + headers.
 *
 * MiniMax uses HTTP/2 + polling for streaming. This renderer computes
 * the auth headers and body for the send_msg request.
 *
 * Does NOT do: token parsing, device registration, or polling — those
 * are the responsibility of the plugin.
 */

import type { CleanedRequest } from '../../core/requestCleaner.ts'
import crypto from 'node:crypto'

// ── Types ───────────────────────────────────────────────────────────

export interface RenderMiniMaxRequestInput {
  model: string
  originalModel?: string
  sessionId: string
  reqId: string
}

export interface MiniMaxWebRequest {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: Record<string, unknown>
  sessionId: string
  reqId: string
}

// ── Constants ───────────────────────────────────────────────────────

const AGENT_BASE_URL = 'https://agent.minimaxi.com'

// ── Public API ──────────────────────────────────────────────────────

/**
 * Build the MiniMax web request (URL, headers, body) for a send_msg call.
 *
 * @param cleaned  — CleanedRequest from requestCleaner.ts
 * @param input    — RenderMiniMaxRequestInput with session/request metadata
 * @param jwtToken — JWT token (acquired by the caller)
 * @param realUserID — Real user ID (parsed by the caller)
 * @returns MiniMaxWebRequest ready for the transport layer
 */
export function renderMiniMaxRequest(
  cleaned: CleanedRequest,
  input: RenderMiniMaxRequestInput,
  jwtToken: string,
  realUserID: string,
): MiniMaxWebRequest {
  const {
    model,
    sessionId,
    reqId,
  } = input

  // Build request body
  const requestBody = buildMiniMaxBody(cleaned, sessionId)

  // Compute MiniMax auth headers
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
}

// ── Body building ───────────────────────────────────────────────────

/**
 * Build the MiniMax send_msg request body from cleaned request messages.
 */
function buildMiniMaxBody(
  cleaned: CleanedRequest,
  chatId?: string,
): Record<string, unknown> {
  const parts: string[] = []
  let system = ''

  for (const msg of cleaned.messages) {
    const txt = extractTextContent(msg.content as any)
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
  // Append tool contract text if available (managed by ToolCallingEngine)
  const finalText = cleaned.toolContractText ? `${text}\n\n${cleaned.toolContractText}` : text

  const body: Record<string, unknown> = {
    msg_type: 1,
    text: finalText,
    chat_type: 1,
    attachments: [],
    selected_mcp_tools: [],
    backend_config: {},
    sub_agent_ids: [],
  }

  if (chatId) {
    body.chat_id = chatId
  }

  return body
}

// ── Helpers ─────────────────────────────────────────────────────────

function extractTextContent(content: string | any[] | null | undefined): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((item) => item.type === 'text')
      .map((item) => item.text || '')
      .join('\n')
  }
  return ''
}

function md5(input: string): string {
  return crypto.createHash('md5').update(input).digest('hex')
}
