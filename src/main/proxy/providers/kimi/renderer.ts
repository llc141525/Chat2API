/**
 * renderer.ts — Phase 3c
 *
 * Pure rendering logic for Kimi provider.
 * Takes a CleanedRequest (already filtered, truncated, and delta-selected)
 * and produces the Kimi-specific gRPC-Web request body + headers.
 *
 * Does NOT do: filtering, truncation, delta selection, infrastructure prompt
 * building, token acquisition, or session creation — those are the
 * responsibility of requestCleaner.ts and the plugin.
 */

import { createKimiChatPayload, encodeKimiGrpcFrame } from '../../adapters/providerModelOptions.ts'
import type { CleanedRequest } from '../../core/requestCleaner.ts'
import { getMaxToolResultLength } from '../../shared/toolResultLimit.ts'

// ── Types ───────────────────────────────────────────────────────────

export interface RenderKimiRequestInput {
  model: string
  originalModel?: string
  sessionId: string
  reqId: string
  enableThinking: boolean
  enableWebSearch: boolean
}

export interface KimiWebRequest {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: Buffer
  sessionId: string
  reqId: string
}

// ── Constants ───────────────────────────────────────────────────────

const KIMI_API_BASE = 'https://www.kimi.com'

// ── Public API ──────────────────────────────────────────────────────

/**
 * Build the Kimi web request (URL, headers, gRPC-Web frame body) for a
 * streaming or non-streaming call.
 *
 * @param cleaned  — CleanedRequest from requestCleaner.ts
 * @param input    — RenderKimiRequestInput with session/request metadata
 * @param token    — Access token (acquired by the caller)
 * @returns KimiWebRequest ready for the transport layer
 */
export function renderKimiRequest(
  cleaned: CleanedRequest,
  input: RenderKimiRequestInput,
  token: string,
): KimiWebRequest {
  const {
    model,
    sessionId,
    reqId,
    enableThinking,
    enableWebSearch,
  } = input

  // Build conversation text from cleaned request
  const content = buildKimiContent(cleaned)

  // Create Kimi gRPC-Web payload
  const payload = createKimiChatPayload({
    model,
    content,
    enableWebSearch,
    enableThinking,
  })
  const frameBuffer = encodeKimiGrpcFrame(payload)

  return {
    url: `${KIMI_API_BASE}/apiv2/kimi.gateway.chat.v1.ChatService/Chat`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/connect+json',
    },
    body: frameBuffer,
    sessionId,
    reqId,
  }
}

// ── Content building ────────────────────────────────────────────────

/**
 * Build Kimi conversation text from a CleanedRequest.
 * Mirrors KimiAdapter.messagesPrepare() logic.
 */
function buildKimiContent(cleaned: CleanedRequest): string {
  const parts: string[] = []
  let system = ''

  for (const msg of cleaned.messages) {
    const txt = extractTextContent(msg.content as any)
    if (msg.role === 'system') {
      if (!txt) continue
      system = txt
    } else if (msg.role === 'assistant' && msg.tool_calls && (msg.tool_calls as any[]).length > 0) {
      parts.push(`Assistant: ${formatToolCallsText(msg.tool_calls as any[])}`)
    } else if (msg.role === 'tool' && msg.tool_call_id) {
      if (!txt) continue
      const MAX_TOOL_RESULT_LENGTH = getMaxToolResultLength()
      const truncated = txt.length > MAX_TOOL_RESULT_LENGTH
        ? txt.slice(0, MAX_TOOL_RESULT_LENGTH) + '\n...(truncated)'
        : txt
      parts.push(`[Tool Result for ${msg.tool_call_id}]: ${truncated}`)
    } else if (msg.role === 'assistant') {
      if (!txt) continue
      parts.push(`Assistant: ${txt}`)
    } else {
      if (!txt) continue
      parts.push(wrapUrlsToTags(txt))
    }
  }

  const joined = parts.join('\n\n')
  const text = system ? `${system}\n\nUser: ${joined}` : joined
  // Append tool contract text if available (managed by ToolCallingEngine)
  return cleaned.toolContractText ? `${text}\n\n${cleaned.toolContractText}` : text
}

/**
 * Wrap URLs in Kimi-style <url> tags.
 */
function wrapUrlsToTags(content: string): string {
  return content.replace(
    /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)/gi,
    url => `<url id="" type="url" status="" title="" wc="">${url}</url>`,
  )
}

/**
 * Format tool calls into text for the content string.
 */
function formatToolCallsText(toolCalls: any[]): string {
  return toolCalls.map((tc) => {
    const fn = tc.function || {}
    return `[Call: ${fn.name || 'unknown'}] ${fn.arguments || '{}'}`
  }).join('\n')
}

// ── Helper ──────────────────────────────────────────────────────────

function extractTextContent(content: string | any[] | null | undefined): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((item) => item.type === 'text')
      .map((item) => item.text || '')
      .join('\n')
  }
  return String(content ?? '')
}
