/**
 * renderer.ts — Phase 3c
 *
 * Pure rendering logic for Qwen AI International provider (chat.qwen.ai).
 * Takes a CleanedRequest (already filtered, truncated, and delta-selected)
 * and produces the Qwen AI-specific HTTP request body + headers.
 *
 * NOTE: This is the INTERNATIONAL Qwen API (chat.qwen.ai), different
 * from the domestic Qwen plugin (chat2.qianwen.com).
 */

import type { CleanedRequest } from '../../core/requestCleaner.ts'

// ── Types ───────────────────────────────────────────────────────────

export interface RenderQwenAiRequestInput {
  model: string
  originalModel?: string
  sessionId: string
  reqId: string
  enableThinking: boolean
  /** Model name aliases (from adapter.mapModel) */
  modelAliases?: Record<string, string>
  modelMappings?: Record<string, string>
}

export interface QwenAiWebRequest {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: Record<string, unknown>
  sessionId: string
  reqId: string
}

// ── Constants ───────────────────────────────────────────────────────

const QWEN_AI_BASE = 'https://chat.qwen.ai'

const MODEL_ALIASES: Record<string, string> = {
  qwen: 'qwen3.7-max',
  qwen3: 'qwen3.7-max',
  'qwen3.7': 'qwen3.7-max',
  'qwen3.6': 'qwen3.6-plus',
  'qwen3.6-35b': 'qwen3.6-35b-a3b',
  'qwen3.6-27b': 'qwen3.6-27b',
  'qwen3-coder': 'qwen3-coder-plus',
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Build the Qwen AI web request (URL, headers, body) for a streaming call.
 *
 * @param cleaned  — CleanedRequest from requestCleaner.ts
 * @param input    — RenderQwenAiRequestInput with session/request metadata
 * @param token    — Bearer token (acquired by the caller)
 * @param cookies  — Cookie string (acquired by the caller)
 * @returns QwenAiWebRequest ready for the transport layer
 */
export function renderQwenAiRequest(
  cleaned: CleanedRequest,
  input: RenderQwenAiRequestInput,
  token: string,
  cookies?: string,
): QwenAiWebRequest {
  const {
    model,
    originalModel,
    sessionId,
    reqId,
    enableThinking,
    modelAliases,
    modelMappings,
  } = input

  // Map model name
  const modelId = mapQwenAiModel(model, modelAliases, modelMappings)

  // Build user content from cleaned request
  const userContent = buildQwenAiContent(cleaned)

  // Build request body
  const requestBody = buildQwenAiRequestBody(userContent, modelId, sessionId, enableThinking)

  // Build headers
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'source': 'web',
    'bx-v': '2.5.36',
    'Version': '0.2.7',
    'Origin': QWEN_AI_BASE,
    'Referer': `${QWEN_AI_BASE}/`,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    'X-Request-Id': reqId,
    'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  }

  if (cookies) {
    headers['Cookie'] = cookies
  }

  const url = `${QWEN_AI_BASE}/api/v2/chat/completions?chat_id=${sessionId}`

  return {
    url,
    method: 'POST',
    headers,
    body: requestBody,
    sessionId,
    reqId,
  }
}

// ── Model mapping ───────────────────────────────────────────────────

/**
 * Map an OpenAI-style model name to the Qwen AI internal model ID.
 */
function mapQwenAiModel(
  model: string,
  modelAliases?: Record<string, string>,
  modelMappings?: Record<string, string>,
): string {
  const aliases = modelAliases ?? MODEL_ALIASES
  const lowerModel = model.toLowerCase()

  if (aliases[lowerModel]) {
    return aliases[lowerModel]
  }

  if (modelMappings) {
    for (const [key, value] of Object.entries(modelMappings)) {
      if (key.toLowerCase() === lowerModel) {
        return value
      }
    }
  }

  return model
}

// ── Content building ────────────────────────────────────────────────

/**
 * Build the user-facing query string from cleaned messages.
 */
function buildQwenAiContent(cleaned: CleanedRequest): string {
  let systemContent = ''
  let allContent = ''

  for (const msg of cleaned.messages) {
    const text = extractTextContent(msg.content as any)
    if (!text) continue

    if (msg.role === 'system') {
      systemContent += (systemContent ? '\n\n' : '') + text
    } else if (msg.role === 'user') {
      allContent += (allContent ? '\n\n' : '') + `User: ${text}`
    } else if (msg.role === 'assistant') {
      allContent += (allContent ? '\n\n' : '') + `Assistant: ${text}`
    }
  }

  const text = systemContent ? `${systemContent}\n\n${allContent}` : allContent
  // Append tool contract text if available (managed by ToolCallingEngine)
  return cleaned.toolContractText ? `${text}\n\n${cleaned.toolContractText}` : text
}

// ── Request body building ───────────────────────────────────────────

/**
 * Build the feature config object used in Qwen AI requests.
 */
function buildFeatureConfig(enableThinking: boolean): Record<string, unknown> {
  return {
    thinking_enabled: enableThinking,
    output_schema: 'phase',
    research_mode: 'normal',
    auto_thinking: enableThinking,
    thinking_format: 'summary',
    auto_search: false,
  }
}

/**
 * Build the request payload for the Qwen AI API.
 */
function buildQwenAiRequestBody(
  userContent: string,
  modelId: string,
  chatId: string,
  enableThinking: boolean,
): Record<string, unknown> {
  const fid = generateId().replace(/-/g, '')
  const childId = generateId().replace(/-/g, '')
  const ts = Math.floor(Date.now() / 1000)

  return {
    stream: true,
    version: '2.1',
    incremental_output: true,
    chat_id: chatId,
    chat_mode: 'normal',
    model: modelId,
    parent_id: null,
    messages: [
      {
        fid,
        parentId: null,
        childrenIds: [childId],
        role: 'user',
        content: userContent,
        user_action: 'chat',
        files: [],
        timestamp: ts,
        models: [modelId],
        chat_type: 't2t',
        feature_config: buildFeatureConfig(enableThinking),
        extra: { meta: { subChatType: 't2t' } },
        sub_chat_type: 't2t',
        parent_id: null,
      },
    ],
    timestamp: ts + 1,
  }
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

function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
