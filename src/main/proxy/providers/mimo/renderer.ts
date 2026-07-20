/**
 * renderer.ts — Mimo provider
 *
 * Pure rendering logic for Mimo (Xiaomi AI Studio) provider.
 * Builds the web API request (URL, headers, body) from normalized messages.
 *
 * Extracted from adapters/mimo.ts (buildMimoQuery) and
 * MimoProviderPlugin.ts (buildRequest logic).
 */

import type { ProviderWebRequest } from '../../plugins/types.ts'
import type { ProviderRuntimeRequest } from '../../plugins/types.ts'
import { getProviderToolProfile } from '../../toolCalling/providerProfiles.ts'
import { getMaxToolResultLength } from '../../shared/toolResultLimit.ts'

// ── Constants ──────────────────────────────────────────────────────────

const MIMO_API_BASE = 'https://aistudio.xiaomimimo.com'

// ── Types ──────────────────────────────────────────────────────────────

export interface RenderMimoRequestInput {
  model: string
  originalModel?: string
  sessionId: string
  reqId: string
  enableThinking: boolean
}

export interface MimoCredentials {
  serviceToken: string
  userId: string
  phToken: string
}

// ── Helpers ────────────────────────────────────────────────────────────

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .filter((part) => typeof part === 'object' && part !== null && part.type === 'text' && part.text)
      .map((part) => part.text)
      .join('\n')
  }
  return ''
}

/**
 * Generate a UUID-like string.
 */
function generateId(separator: boolean = true): string {
  const id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
  return separator ? id : id.replace(/-/g, '')
}

// ── Query building ─────────────────────────────────────────────────────

type MimoMessage = { role: string; content: unknown; tool_call_id?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }

/**
 * Build the text query from an array of chat messages.
 * Uses the Mimo tool profile to format tool calls and results.
 */
export function buildMimoQuery(messages: MimoMessage[]): string {
  const toolProfile = getProviderToolProfile('mimo')
  const entries: Array<{ role: string; content: string }> = []

  for (const message of messages) {
    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      entries.push({
        role: 'Assistant',
        content: toolProfile.formatAssistantToolCalls(message.tool_calls.map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        }))),
      })
      continue
    }

    if (message.role === 'tool' && message.tool_call_id) {
      const rawContent = extractTextContent(message.content)
      const MAX_TOOL_RESULT_LENGTH = getMaxToolResultLength()
      const truncated = rawContent.length > MAX_TOOL_RESULT_LENGTH
        ? rawContent.slice(0, MAX_TOOL_RESULT_LENGTH) + '\n...(truncated)'
        : rawContent
      entries.push({
        role: 'User',
        content: toolProfile.formatToolResult({
          toolCallId: message.tool_call_id,
          content: truncated,
        }),
      })
      continue
    }

    const content = extractTextContent(message.content).trim()
    if (!content) {
      continue
    }

    const role = message.role === 'system'
      ? 'System'
      : message.role === 'assistant'
        ? 'Assistant'
        : 'User'

    entries.push({ role, content })
  }

  if (entries.length === 1 && entries[0].role === 'User') {
    return entries[0].content
  }

  return entries.map((entry) => `${entry.role}: ${entry.content}`).join('\n\n')
}

// ── Public render function ─────────────────────────────────────────────

/**
 * Build the full Mimo web request (URL, headers, body, sessionId, reqId).
 *
 * @param input    — ProviderRuntimeRequest with messages, model, credentials
 * @returns ProviderWebRequest ready for transport
 */
export function renderMimoRequest(input: ProviderRuntimeRequest): ProviderWebRequest {
  const credentials = input.account.credentials as Record<string, string>
  const serviceToken = credentials.service_token ?? ''
  const userId = credentials.user_id ?? ''
  const phToken = credentials.ph_token ?? ''

  const conversationId = input.sessionId || generateId(false)
  const msgId = generateId(false).slice(0, 32)
  const reqId = msgId

  // Build query from messages
  let query = buildMimoQuery(input.messages as MimoMessage[])

  // Inject tool contract text if available (managed by ToolCallingEngine)
  const toolContractText = input.cleanedRequest?.toolContractText
  if (toolContractText) {
    query = `${query}\n\n${toolContractText}`
  }

  // Check model name hints for thinking
  const modelLower = (input.originalModel || input.model).toLowerCase()
  const enableThinking = input.enableThinking
    ?? (modelLower.includes('think') || modelLower.includes('r1'))

  const requestBody = {
    msgId,
    conversationId,
    query,
    isEditedQuery: false,
    modelConfig: {
      enableThinking,
      webSearchStatus: 'disabled' as const,
      model: input.model,
      temperature: input.temperature ?? 0.8,
      topP: 0.95,
    },
    multiMedias: [],
  }

  const queryString = `xiaomichatbot_ph=${encodeURIComponent(phToken)}`
  const url = `${MIMO_API_BASE}/open-apis/bot/chat?${queryString}`

  return {
    url,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `serviceToken=${serviceToken}; userId=${userId}; xiaomichatbot_ph=${phToken}`,
      Origin: MIMO_API_BASE,
      Referer: `${MIMO_API_BASE}/`,
    },
    body: requestBody,
    sessionId: conversationId,
    reqId,
  }
}
