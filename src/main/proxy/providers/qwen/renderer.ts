/**
 * renderer.ts — Phase 3a
 *
 * Pure rendering logic for Qwen provider.
 * Takes a CleanedRequest (already filtered, truncated, and delta-selected)
 * and produces the Qwen-specific HTTP request body + headers.
 *
 * Does NOT do: filtering, truncation, delta selection, infrastructure prompt
 * building — those are the responsibility of requestCleaner.ts.
 */

import { renderFinalPrompt } from '../../adapters/renderFinalPrompt.ts'
import type { CleanedRequest } from '../../core/requestCleaner.ts'

// ── Types ───────────────────────────────────────────────────────────

export interface RenderQwenRequestInput {
  model: string
  originalModel?: string
  sessionId: string
  reqId: string
  parentReqId?: string
  timestamp: number
  enableThinking: boolean
  enableWebSearch: boolean
  /** The request-level promptRefreshMode for decision-making */
}

export interface QwenWebRequest {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: Record<string, unknown>
  sessionId: string
  reqId: string
}

// ── Constants ───────────────────────────────────────────────────────

const QWEN_API_BASE = 'https://chat2.qianwen.com'

export const DEFAULT_HEADERS = {
  Accept: 'application/json, text/event-stream, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Cache-Control': 'no-cache',
  Origin: 'https://www.qianwen.com',
  Pragma: 'no-cache',
  'Sec-Ch-Ua': '"Chromium";v="145", "Not(A:Brand";v="24", "Google Chrome";v="145"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
  Referer: 'https://www.qianwen.com/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
}

// ── Public API ──────────────────────────────────────────────────────

export function renderQwenRequest(
  cleaned: CleanedRequest,
  input: RenderQwenRequestInput,
  ticket: string,
): QwenWebRequest {
  const {
    model,
    sessionId,
    reqId,
    parentReqId,
    timestamp,
    enableThinking,
    enableWebSearch,
  } = input

  // Separate messages into buckets
  const { baseSystemPrompts, summaryPrompts, conversationParts, lastUserText } = separateMessageBuckets(cleaned)

  const effectiveSummaryText = cleaned.summaryText
    || (summaryPrompts.length > 0 ? summaryPrompts.join('\n\n') : null)

  // Mode-based section inclusion
  const includeSummary = cleaned.mode !== 'minimal'
  const includeToolContract = true

  const finalContent = renderFinalPrompt({
    systemText: baseSystemPrompts.join('\n\n') || null,
    summaryText: includeSummary ? effectiveSummaryText : null,
    toolContractText: includeToolContract ? (cleaned.toolContractText ?? null) : null,
    infrastructurePrompt: cleaned.infrastructurePrompt,
    conversationText: conversationParts.length > 0
      ? `User: ${conversationParts.join('\n\n')}`
      : '',
    template: 'prefix',
  })

  const nonce = generateNonce()
  const queryString = `biz_id=ai_qwen&chat_client=h5&device=pc&fr=pc&pr=qwen&ut=${generateId()}&nonce=${nonce}&timestamp=${timestamp}`

  return {
    url: `${QWEN_API_BASE}/api/v2/chat?${queryString}`,
    method: 'POST',
    headers: {
      ...DEFAULT_HEADERS,
      'Content-Type': 'application/json',
      Cookie: `tongyi_sso_ticket=${ticket}`,
    },
    body: {
      deep_search: (enableWebSearch || enableThinking) ? '1' : '0',
      req_id: reqId,
      model,
      scene: 'chat',
      session_id: sessionId,
      sub_scene: 'chat',
      temporary: false,
      messages: [
        {
          content: finalContent,
          mime_type: 'text/plain',
          meta_data: {
            ori_query: lastUserText || finalContent,
          },
        },
      ],
      from: 'default',
      parent_req_id: parentReqId || '0',
      enable_search: enableWebSearch,
      biz_data: '{"entryPoint":"tongyigw"}',
      scene_param: input.sessionId ? 'chat' : 'first_turn',
      chat_client: 'h5',
      client_tm: timestamp.toString(),
      protocol_version: 'v2',
      biz_id: 'ai_qwen',
    },
    sessionId,
    reqId,
  }
}

// ── Message bucketing ───────────────────────────────────────────────

interface MessageBuckets {
  baseSystemPrompts: string[]
  summaryPrompts: string[]
  conversationParts: string[]
  lastUserText: string
}

function separateMessageBuckets(cleaned: CleanedRequest): MessageBuckets {
  const baseSystemPrompts: string[] = []
  const summaryPrompts: string[] = []
  const conversationParts: string[] = []
  const MAX_TOOL_RESULT_LENGTH = 2000

  // Build a tool profile reference (simulated — we just need format helpers)
  // Since we have tool definitions in CleanedRequest, we use simple formatting

  for (const msg of cleaned.messages) {
    if (msg.role === 'system') {
      const content = extractTextContent(msg.content as any)
      const trimmedContent = content.trim()
      if (trimmedContent.length === 0) continue

      const isSummaryMessage = trimmedContent.includes('[Prior conversation summary')
      if (isSummaryMessage) {
        if (!cleaned.summaryText || trimmedContent !== cleaned.summaryText) {
          summaryPrompts.push(content)
        }
      } else {
        baseSystemPrompts.push(content)
      }
      continue
    }
  }

  for (const msg of cleaned.messages) {
    if (msg.role === 'system') continue

    if (msg.role === 'user') {
      conversationParts.push(extractTextContent(msg.content as any))
    } else if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const calls = msg.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }))
      conversationParts.push(formatAssistantToolCalls(calls))
    } else if (msg.role === 'assistant') {
      conversationParts.push(`Assistant: ${extractTextContent(msg.content as any)}`)
    } else if (msg.role === 'tool' && msg.tool_call_id) {
      const rawContent = extractTextContent(msg.content as any)
      const truncated = rawContent.length > MAX_TOOL_RESULT_LENGTH
        ? rawContent.slice(0, MAX_TOOL_RESULT_LENGTH) + '\n...(truncated)'
        : rawContent
      conversationParts.push(formatToolResult({
        toolCallId: msg.tool_call_id,
        content: truncated,
      }))
    }
  }

  // Inject active skill checkpoint if present
  if (cleaned.activeSkillCheckpoint) {
    conversationParts.push(cleaned.activeSkillCheckpoint)
  }

  const lastUserText = findLastUserText(cleaned.messages)

  return { baseSystemPrompts, summaryPrompts, conversationParts, lastUserText }
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

function findLastUserText(messages: Array<{ role: string; content: unknown }>): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      return extractTextContent(messages[index].content)
    }
  }
  return ''
}

function formatAssistantToolCalls(
  calls: Array<{ id: string; name: string; arguments: string }>,
): string {
  return calls
    .map(
      (call) =>
        `<tool_call>\\nTool: ${call.name}\\nArguments: ${call.arguments}\\nTool Call ID: ${call.id}\\n</tool_call>`,
    )
    .join('\\n')
}

function formatToolResult(input: { toolCallId: string; content: string }): string {
  return `<tool_result>\\nTool Call ID: ${input.toolCallId}\\n${input.content}\\n</tool_result>`
}

let nonceCounter = Date.now()

function generateNonce(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  nonceCounter++
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor((nonceCounter * (i + 1)) % chars.length))
  }
  return result
}

function generateId(): string {
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
