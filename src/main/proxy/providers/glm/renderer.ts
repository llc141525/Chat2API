/**
 * renderer.ts — Phase 3b
 *
 * Pure rendering logic for GLM (Zhipu Qingyan) provider.
 * Takes a CleanedRequest (already filtered, truncated, and delta-selected)
 * and produces the GLM-specific HTTP request body + headers.
 *
 * Does NOT do: filtering, truncation, delta selection, infrastructure prompt
 * building, token acquisition, or file upload — those are the responsibility
 * of requestCleaner.ts and the plugin.
 */

import { renderFinalPrompt } from '../../adapters/renderFinalPrompt.ts'
import { selectProviderMessagesForAssembly } from '../../RequestAssembly.ts'
import type { CleanedRequest } from '../../core/requestCleaner.ts'
import crypto from 'node:crypto'

// ── Types ───────────────────────────────────────────────────────────

export interface RenderGLMRequestInput {
  model: string
  originalModel?: string
  sessionId: string
  reqId: string
  parentReqId?: string
  enableThinking: boolean
  enableWebSearch: boolean
}

export interface GLMWebRequest {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: Record<string, unknown>
  sessionId: string
  reqId: string
}

// ── Constants ───────────────────────────────────────────────────────

const GLM_API_BASE = 'https://chatglm.cn/chatglm'
const DEFAULT_ASSISTANT_ID = '65940acff94777010aa6b796'
const SIGN_SECRET = '8a1317a7468aa3ad86e997d08f3f31cb'

export const FAKE_HEADERS: Record<string, string> = {
  Accept: 'text/event-stream',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
  'App-Name': 'chatglm',
  'Cache-Control': 'no-cache',
  'Content-Type': 'application/json',
  Origin: 'https://chatglm.cn',
  Pragma: 'no-cache',
  Priority: 'u=1, i',
  'Sec-Ch-Ua': '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'X-App-Fr': 'browser_extension',
  'X-App-Platform': 'pc',
  'X-App-Version': '0.0.1',
  'X-Device-Brand': '',
  'X-Device-Model': '',
  'X-Lang': 'zh',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Build the GLM web request (URL, headers, body) for a streaming or
 * non-streaming call.
 *
 * @param cleaned  — CleanedRequest from requestCleaner.ts
 * @param input    — RenderGLMRequestInput with session/request metadata
 * @param token    — Access token (acquired by the caller)
 * @param refs     — Uploaded file/image references (acquired by the caller)
 * @returns GLMWebRequest ready for the transport layer
 */
export function renderGLMRequest(
  cleaned: CleanedRequest,
  input: RenderGLMRequestInput,
  token: string,
  refs: any[] = [],
): GLMWebRequest {
  const {
    model,
    sessionId,
    reqId,
    enableThinking,
    enableWebSearch,
  } = input

  // Build prepared messages using the same assembly logic as before
  const preparedMessages = buildGLMMessages(cleaned, refs, !!sessionId)

  // Determine assistant ID from model name or use default
  let assistantId = DEFAULT_ASSISTANT_ID
  if (/^[a-z0-9]{24,}$/.test(model)) {
    assistantId = model
  }

  // Determine chat mode from reasoning/thinking flags
  let chatMode = ''
  let isNetworking = false
  const modelLower = (input.originalModel || model).toLowerCase()

  if (enableThinking) {
    chatMode = 'zero'
  }
  if (enableWebSearch) {
    isNetworking = true
  }
  if (!chatMode && (modelLower.includes('think') || modelLower.includes('zero'))) {
    chatMode = 'zero'
  }

  const sign = generateSign()

  const body = {
    assistant_id: assistantId,
    conversation_id: sessionId,
    project_id: '',
    chat_type: 'user_chat',
    messages: preparedMessages,
    meta_data: {
      channel: '',
      chat_mode: chatMode || undefined,
      draft_id: '',
      if_plus_model: true,
      input_question_type: 'xxxx',
      is_networking: isNetworking,
      is_test: false,
      platform: 'pc',
      quote_log_id: '',
      cogview: {
        rm_label_watermark: false,
      },
    },
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...FAKE_HEADERS,
    'X-Device-Id': generateUUID(),
    'X-Request-Id': generateUUID(),
    'X-Sign': sign.sign,
    'X-Timestamp': sign.timestamp,
    'X-Nonce': sign.nonce,
  }

  return {
    url: `${GLM_API_BASE}/backend-api/assistant/stream`,
    method: 'POST',
    headers,
    body,
    sessionId,
    reqId,
  }
}

// ── Message assembly ────────────────────────────────────────────────

/**
 * Build the messages array for GLM request from a CleanedRequest.
 * Replicates the logic of buildGLMAssemblyPromptMessagesForTest.
 */
function buildGLMMessages(
  cleaned: CleanedRequest,
  refs: any[] = [],
  _isMultiTurn: boolean = false,
): Array<{ role: string; content: any[] }> {
  // Separate image refs and file refs
  const imageRefs = refs.filter((ref) => ref.width !== undefined || ref.height !== undefined || ref.image_url)
  const fileRefs = refs.filter((ref) => !ref.width && !ref.height && !ref.image_url)

  // Build content array
  const content: any[] = []

  // Add file references first
  if (fileRefs.length > 0) {
    content.push({
      type: 'file',
      file: fileRefs.map((ref) => ({
        source_id: ref.source_id,
        file_url: ref.file_url,
      })),
    })
  }

  // Add image references
  for (const imageRef of imageRefs) {
    content.push({
      type: 'image_url',
      image_url: {
        url: imageRef.image_url || imageRef.source_id,
      },
    })
  }

  // Build the flat text prompt from the cleaned request
  const textContent = buildGLMFlatPrompt(cleaned)

  content.push({ type: 'text', text: textContent })
  return [{ role: 'user', content }]
}

/**
 * Build the flat text prompt from a CleanedRequest for the GLM model.
 * Uses suffix template: system text first, then conversation, then tool prompt.
 */
function buildGLMFlatPrompt(cleaned: CleanedRequest): string {
  const { baseSystemPrompts, conversationParts } = separateMessageBuckets(cleaned)

  const effectiveSummaryText = cleaned.summaryText || undefined

  const parts = renderFinalPrompt({
    systemText: baseSystemPrompts.join('\n\n') || null,
    summaryText: effectiveSummaryText || null,
    toolContractText: cleaned.toolContractText ?? null,
    infrastructurePrompt: cleaned.infrastructurePrompt,
    conversationText: conversationParts.length > 0
      ? conversationParts.join('\n\n')
      : '',
    template: 'suffix',
  })

  return parts
}

// ── Tool manifest prompt ────────────────────────────────────────────

function buildToolManifestPrompt(toolDefinitions: Array<{ type: string; function: { name: string; description?: string; parameters?: Record<string, unknown> } }>): string {
  if (toolDefinitions.length === 0) return ''

  const toolDescriptions = toolDefinitions.map((tool) => {
    const fn = tool.function
    return `Tool \`${fn.name}\`${fn.description ? `: ${fn.description}` : ''}${
      fn.parameters ? `\nJSON schema: ${JSON.stringify(fn.parameters, null, 2)}` : ''
    }`
  }).join('\n\n')

  return `## Available Tools\n${toolDescriptions}\n\n## Tool Call Protocol\nWhen you decide to call a tool, use:\n<tool_calls>\n<invoke name="tool_name">\n<parameter name="arg_name">arg_value</parameter>\n</invoke>\n</tool_calls>\n\nWhen you receive a tool result, it will be in the format:\n<tool_result>\nTool Call ID: <id>\n<content>\n</tool_result>`
}

// ── Message bucketing ───────────────────────────────────────────────

interface MessageBuckets {
  baseSystemPrompts: string[]
  conversationParts: string[]
}

function separateMessageBuckets(cleaned: CleanedRequest): MessageBuckets {
  const baseSystemPrompts: string[] = []
  const conversationParts: string[] = []
  const MAX_TOOL_RESULT_LENGTH = 2000

  for (const msg of cleaned.messages) {
    if (msg.role === 'system') {
      const content = extractTextContent(msg.content as any)
      const trimmedContent = content.trim()
      if (trimmedContent.length === 0) continue
      baseSystemPrompts.push(content)
      continue
    }
  }

  for (const msg of cleaned.messages) {
    if (msg.role === 'system') continue

    if (msg.role === 'user') {
      conversationParts.push(extractTextContent(msg.content as any))
    } else if (msg.role === 'assistant' && msg.tool_calls && (msg.tool_calls as any[]).length > 0) {
      const calls = (msg.tool_calls as any[]).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }))
      conversationParts.push(formatXMLAssistantToolCalls(calls))
    } else if (msg.role === 'assistant') {
      conversationParts.push(`Assistant: ${extractTextContent(msg.content as any)}`)
    } else if (msg.role === 'tool' && msg.tool_call_id) {
      const rawContent = extractTextContent(msg.content as any)
      const truncated = rawContent.length > MAX_TOOL_RESULT_LENGTH
        ? rawContent.slice(0, MAX_TOOL_RESULT_LENGTH) + '\n...(truncated)'
        : rawContent
      conversationParts.push(formatXMLToolResult({
        toolCallId: msg.tool_call_id,
        content: truncated,
      }))
    }
  }

  // Inject active skill checkpoint if present
  if (cleaned.activeSkillCheckpoint) {
    conversationParts.push(cleaned.activeSkillCheckpoint)
  }

  return { baseSystemPrompts, conversationParts }
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

function formatXMLAssistantToolCalls(
  calls: Array<{ id: string; name: string; arguments: string }>,
): string {
  return calls
    .map((call) => {
      const args = safeParseJson(call.arguments)
      const params = Object.entries(args as Record<string, unknown>)
        .map(([key, value]) => {
          const text = typeof value === 'string' ? value : JSON.stringify(value)
          return `<parameter name="${key}"><![CDATA[${text}]]></parameter>`
        })
        .join('')
      return `<invoke name="${call.name}">${params}</invoke>`
    })
    .join('')
}

function formatXMLToolResult(input: { toolCallId: string; content: string }): string {
  return `<tool_result>\nTool Call ID: ${input.toolCallId}\n${input.content}\n</tool_result>`
}

function safeParseJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

// ── Crypto helpers ──────────────────────────────────────────────────

function md5(str: string): string {
  return crypto.createHash('md5').update(str).digest('hex')
}

function generateSign(): { timestamp: string; nonce: string; sign: string } {
  const e = Date.now()
  const A = e.toString()
  const t = A.length
  const o = A.split('').map((c) => Number(c))
  const i = o.reduce((acc, val) => acc + val, 0) - o[t - 2]
  const a = i % 10
  const timestamp = A.substring(0, t - 2) + a + A.substring(t - 1, t)
  const nonce = generateUUID()
  const sign = md5(`${timestamp}-${nonce}-${SIGN_SECRET}`)
  return { timestamp, nonce, sign }
}

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
