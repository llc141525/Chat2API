/**
 * renderer.ts — Phase 3b
 *
 * Pure rendering logic for DeepSeek provider.
 * Takes a CleanedRequest (already filtered, truncated, and delta-selected)
 * and produces the DeepSeek-specific HTTP request body + headers.
 *
 * Does NOT do: filtering, truncation, delta selection, infrastructure prompt
 * building, PoW challenge solving, or session creation — those are the
 * responsibility of requestCleaner.ts and the plugin.
 */

import { renderFinalPrompt } from '../../adapters/renderFinalPrompt.ts'
import { resolveDeepSeekChatOptions } from '../../adapters/providerModelOptions.ts'
import type { CleanedRequest } from '../../core/requestCleaner.ts'

// ── Types ───────────────────────────────────────────────────────────

export interface RenderDeepSeekRequestInput {
  model: string
  originalModel?: string
  sessionId: string
  reqId: string
  parentReqId?: string
  enableThinking: boolean
  enableWebSearch: boolean
}

export interface DeepSeekWebRequest {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: Record<string, unknown>
  sessionId: string
  reqId: string
}

// ── Constants ───────────────────────────────────────────────────────

const DEEPSEEK_API_BASE = 'https://chat.deepseek.com/api'

export const FAKE_HEADERS: Record<string, string> = {
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
  Origin: 'https://chat.deepseek.com',
  Referer: 'https://chat.deepseek.com/',
  'Sec-Ch-Ua': '"Not/A)Brand";v="99", "Chromium";v="148"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'X-App-Version': '2.0.0',
  'X-Client-Locale': 'zh_CN',
  'X-Client-Platform': 'web',
  'x-Client-Timezone-Offset': '28800',
  'X-Client-Version': '2.0.0',
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Build the DeepSeek web request (URL, headers, body) for a streaming or
 * non-streaming call.
 *
 * @param cleaned  — CleanedRequest from requestCleaner.ts
 * @param input    — RenderDeepSeekRequestInput with session/request metadata
 * @param token    — Access token (acquired by the caller)
 * @param cookie   — Generated cookie string (optional, generated if not provided)
 * @returns DeepSeekWebRequest ready for the transport layer
 */
export function renderDeepSeekRequest(
  cleaned: CleanedRequest,
  input: RenderDeepSeekRequestInput,
  token: string,
  cookie?: string,
): DeepSeekWebRequest {
  const {
    model,
    originalModel,
    sessionId,
    reqId,
    parentReqId,
    enableThinking,
    enableWebSearch,
  } = input

  // Convert messages to DeepSeek prompt format (bracket-style)
  const prompt = deepseekMessagesToCleanPrompt(cleaned, !!parentReqId)

  // Resolve model options
  const { modelType, searchEnabled, thinkingEnabled } = resolveDeepSeekChatOptions(
    {
      model: originalModel || model,
      web_search: enableWebSearch,
      reasoning_effort: enableThinking ? 'high' : undefined,
    },
    prompt,
  )

  const body = {
    chat_session_id: sessionId,
    parent_message_id: parentReqId || null,
    prompt,
    model_type: modelType,
    ref_file_ids: [] as string[],
    search_enabled: searchEnabled,
    thinking_enabled: thinkingEnabled,
    preempt: false,
  }

  const effectiveCookie = cookie || generateCookie()

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...FAKE_HEADERS,
    Referer: sessionId
      ? `https://chat.deepseek.com/a/chat/s/${sessionId}`
      : 'https://chat.deepseek.com/',
    Cookie: effectiveCookie,
  }

  return {
    url: `${DEEPSEEK_API_BASE}/v0/chat/completion`,
    method: 'POST',
    headers,
    body,
    sessionId,
    reqId,
  }
}

// ── Message-to-prompt conversion ────────────────────────────────────

/**
 * Convert CleanedRequest messages into the DeepSeek bracket prompt format.
 *
 * Uses managed bracket protocol for tool calls/results.
 */
function deepseekMessagesToCleanPrompt(
  cleaned: CleanedRequest,
  isMultiTurn: boolean = false,
): string {
  const MAX_TOOL_RESULT_LENGTH = 2000

  // Process messages into text
  const processedMessages: Array<{ role: string; text: string }> = []

  // First pass: extract system prompts for infrastructure
  const systemTexts: string[] = []
  for (const msg of cleaned.messages) {
    if (msg.role === 'system') {
      const content = extractTextContent(msg.content as any)
      if (content.trim()) {
        systemTexts.push(content.trim())
      }
    }
  }

  // Second pass: process assistant/tool/user messages
  for (const msg of cleaned.messages) {
    if (msg.role === 'system') continue

    let text: string

    if (msg.role === 'assistant' && (msg.tool_calls as any[] | undefined)?.length) {
      const calls = (msg.tool_calls as any[]).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }))
      text = formatBracketAssistantToolCalls(calls)
    } else if (msg.role === 'tool' && msg.tool_call_id) {
      const rawContent = extractTextContent(msg.content as any)
      const truncated = rawContent.length > MAX_TOOL_RESULT_LENGTH
        ? rawContent.slice(0, MAX_TOOL_RESULT_LENGTH) + '\n...(truncated)'
        : rawContent
      text = formatBracketToolResult({
        toolCallId: msg.tool_call_id,
        content: truncated,
      })
    } else if (msg.role === 'assistant') {
      text = extractTextContent(msg.content as any)
    } else if (msg.role === 'user') {
      text = extractTextContent(msg.content as any)
    } else {
      text = String((msg.content as any) || '')
    }

    processedMessages.push({ role: msg.role, text })
  }

  // Build final prompt
  // Start with system text from messages + infrastructure prompt + summary
  const promptParts: string[] = []

  // Add system/infrastructure text
  const infraParts: string[] = []
  if (systemTexts.length > 0) {
    infraParts.push(systemTexts.join('\n\n'))
  }
  if (cleaned.infrastructurePrompt) {
    infraParts.push(cleaned.infrastructurePrompt)
  }
  if (cleaned.summaryText) {
    infraParts.push(cleaned.summaryText)
  }
  if (infraParts.length > 0) {
    promptParts.push(infraParts.join('\n\n'))
  }

  if (processedMessages.length === 0) {
    promptParts.push('')
  }

  // For multi-turn mode, find the last assistant tool_call and send delta from there
  if (isMultiTurn && processedMessages.length > 0) {
    let lastAssistantToolIdx = -1
    for (let i = processedMessages.length - 1; i >= 0; i--) {
      if (processedMessages[i].role === 'assistant' && processedMessages[i].text.includes('[function_calls]')) {
        lastAssistantToolIdx = i
        break
      }
    }

    if (lastAssistantToolIdx !== -1) {
      const parts: string[] = []
      for (let i = lastAssistantToolIdx; i < processedMessages.length; i++) {
        parts.push(processedMessages[i].text)
      }
      promptParts.push(`<｜User｜>${parts.join('\n\n')}`)
    } else {
      // Fallback: only send the last user message + tool results
      let lastUserIdx = -1
      for (let i = processedMessages.length - 1; i >= 0; i--) {
        if (processedMessages[i].role === 'user') {
          lastUserIdx = i
          break
        }
      }

      if (lastUserIdx !== -1) {
        const lastUserMsg = processedMessages[lastUserIdx]
        let text = lastUserMsg.text
        for (let i = lastUserIdx + 1; i < processedMessages.length; i++) {
          if (processedMessages[i].role === 'tool') {
            text += `\n\n${processedMessages[i].text}`
          }
        }
        promptParts.push(`<｜User｜>${text}`)
      }
    }

    // Add tool contract at the end
    if (cleaned.toolDefinitions.length > 0) {
      promptParts.push(buildDeepSeekToolManifestPrompt(cleaned.toolDefinitions))
    }

    return promptParts.join('\n\n')
  }

  // Full prompt mode: merge consecutive same-role blocks
  const mergedBlocks: { role: string; text: string }[] = []
  if (processedMessages.length > 0) {
    let currentBlock = { ...processedMessages[0] }
    for (let i = 1; i < processedMessages.length; i++) {
      const msg = processedMessages[i]
      if (msg.role === currentBlock.role) {
        currentBlock.text += `\n\n${msg.text}`
      } else {
        mergedBlocks.push(currentBlock)
        currentBlock = { ...msg }
      }
    }
    mergedBlocks.push(currentBlock)
  }

  const conversationPrompt = mergedBlocks
    .map((block, index) => {
      if (block.role === 'assistant') {
        return `<｜Assistant｜>${block.text}<｜end of sentence｜>`
      }
      if (block.role === 'user' || block.role === 'system') {
        return index > 0 ? `<｜User｜>${block.text}` : block.text
      }
      if (block.role === 'tool') {
        return `<｜User｜>${block.text}`
      }
      return block.text
    })
    .join('\n\n')
    .replace(/!\[.+\]\(.+\)/g, '')

  promptParts.push(conversationPrompt)

  // Add tool contract at the end
  if (cleaned.toolContractText) {
    promptParts.push(cleaned.toolContractText)
  }

  return promptParts.join('\n\n')
}

// ── Tool manifest prompt ────────────────────────────────────────────

function buildDeepSeekToolManifestPrompt(
  toolDefinitions: Array<{ type: string; function: { name: string; description?: string; parameters?: Record<string, unknown> } }>,
): string {
  if (toolDefinitions.length === 0) return ''

  const toolDescriptions = toolDefinitions.map((tool) => {
    const fn = tool.function
    return `Tool \`${fn.name}\`${fn.description ? `: ${fn.description}` : ''}${
      fn.parameters ? `\nJSON schema: ${JSON.stringify(fn.parameters, null, 2)}` : ''
    }`
  }).join('\n\n')

  return `## Available Tools\n${toolDescriptions}\n\n## Tool Call Protocol\nWhen you decide to call a tool, respond with ONLY a [function_calls] block:\n[function_calls]\n[call:exact_tool_name]{"argument": "value"}[/call]\n[/function_calls]\n\nWhen you receive a tool result, it will be in:\n[TOOL_RESULT for call_id] result_content`
}

// ── Bidirectional bracket protocol helpers ───────────────────────────

function formatBracketAssistantToolCalls(
  calls: Array<{ id: string; name: string; arguments: string }>,
): string {
  const callBlocks = calls
    .map((call) => `[call:${call.name}]${call.arguments}[/call]`)
    .join('\n')
  return `[function_calls]\n${callBlocks}\n[/function_calls]`
}

function formatBracketToolResult(input: { toolCallId: string; content: string }): string {
  return `[TOOL_RESULT for ${input.toolCallId}] ${input.content}`
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

function generateRandomString(length: number): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

function generateCookie(): string {
  const timestamp = Date.now()
  return [
    `intercom-HWWAFSESTIME=${timestamp}`,
    `HWWAFSESID=${generateRandomString(18)}`,
    `Hm_lvt_${generateRandomString(8)}=${Math.floor(timestamp / 1000)}`,
    `Hm_lpvt_${generateRandomString(8)}=${Math.floor(timestamp / 1000)}`,
    `_frid=${generateRandomString(12)}`,
    `_fr_ssid=${generateRandomString(12)}`,
    `_fr_pvid=${generateRandomString(12)}`,
  ].join('; ')
}
