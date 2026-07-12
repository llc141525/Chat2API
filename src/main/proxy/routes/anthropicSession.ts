import crypto from 'node:crypto'

import { textFromAnthropicContent, type AnthropicMessagesRequest } from './anthropicCompat.ts'
import { extractPromptEmbeddedTools } from '../toolCalling/clientAdapters/promptEmbeddedToolExtractor.ts'

type HeaderValue = string | string[] | undefined

export interface AnthropicSessionIdentity {
  claudeSessionKey: string
  source: 'header' | 'metadata' | 'derived_hash' | 'process_fallback'
}

export interface AnthropicCatalogEvidence {
  topLevelToolCount: number
  topLevelToolNames: string[]
  messageCount: number
  hasToolUseHistory: boolean
  hasToolResultHistory: boolean
  hasContractHeaderText: boolean
  contractHeaderAllowedToolNames: string[]
  compactSuspected: boolean
}

const HEADER_SESSION_KEYS = [
  'x-claude-code-session-id',
  'x-claude-session-id',
  'x-session-id',
  'x-conversation-id',
  'anthropic-conversation-id',
  'x-chat-session-id',
] as const

const METADATA_SESSION_KEYS = [
  'session_id',
  'sessionId',
  'conversation_id',
  'conversationId',
  'thread_id',
  'threadId',
] as const

const MANUAL_COMPACT_MARKERS = [
  '/compact',
  'compact summary',
  'conversation summary',
  'summarized conversation',
] as const

let processFallbackCounter = 0

export function deriveAnthropicSessionIdentity(input: {
  request: AnthropicMessagesRequest
  headers?: Record<string, HeaderValue>
  clientIP?: string
  providerId?: string
}): AnthropicSessionIdentity {
  for (const headerName of HEADER_SESSION_KEYS) {
    const raw = input.headers?.[headerName]
    const value = Array.isArray(raw) ? raw[0] : raw
    if (typeof value === 'string' && value.trim().length > 0) {
      return {
        claudeSessionKey: `claude:${hashStable({ source: headerName, value: value.trim() })}`,
        source: 'header',
      }
    }
  }

  const metadata = requestMetadata(input.request)
  for (const metadataKey of METADATA_SESSION_KEYS) {
    const value = metadata[metadataKey]
    if (typeof value === 'string' && value.trim().length > 0) {
      return {
        claudeSessionKey: `claude:${hashStable({ source: metadataKey, value: value.trim() })}`,
        source: 'metadata',
      }
    }
  }

  const stablePrefix = getStablePrefix(input.request)
  if (stablePrefix.length > 0) {
    return {
      claudeSessionKey: `claude:${hashStable({
        source: 'derived_hash',
        clientIP: input.clientIP || 'unknown',
        providerId: input.providerId || 'unknown',
        model: input.request.model,
        stablePrefix,
      })}`,
      source: 'derived_hash',
    }
  }

  processFallbackCounter += 1
  return {
    claudeSessionKey: `claude:fallback:${processFallbackCounter}`,
    source: 'process_fallback',
  }
}

export function collectAnthropicCatalogEvidence(request: AnthropicMessagesRequest): AnthropicCatalogEvidence {
  const topLevelToolNames = (request.tools ?? [])
    .map((tool) => tool?.name)
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)

  const hasToolUseHistory = request.messages.some((message) =>
    Array.isArray(message.content) && message.content.some((block) => block.type === 'tool_use')
  )
  const hasToolResultHistory = request.messages.some((message) =>
    Array.isArray(message.content) && message.content.some((block) => block.type === 'tool_result')
  )

  const promptEmbedded = extractPromptEmbeddedTools(toPromptEmbeddedMessages(request))
  const contractHeaderAllowedToolNames = promptEmbedded.tools.map((tool) => tool.name)
  const hasContractHeaderText = contractHeaderAllowedToolNames.length > 0

  const narrative = [
    textFromAnthropicContent(request.system),
    ...request.messages.map((message) => textFromAnthropicContent(message.content)),
  ].join('\n').toLowerCase()

  const compactSuspected = topLevelToolNames.length === 0 && (
    hasToolUseHistory
    || hasToolResultHistory
    || hasContractHeaderText
    || MANUAL_COMPACT_MARKERS.some((marker) => narrative.includes(marker))
  )

  return {
    topLevelToolCount: topLevelToolNames.length,
    topLevelToolNames,
    messageCount: request.messages.length,
    hasToolUseHistory,
    hasToolResultHistory,
    hasContractHeaderText,
    contractHeaderAllowedToolNames,
    compactSuspected,
  }
}

function requestMetadata(request: AnthropicMessagesRequest): Record<string, unknown> {
  const candidate = (request as AnthropicMessagesRequest & { metadata?: unknown }).metadata
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return {}
  return candidate as Record<string, unknown>
}

function getStablePrefix(request: AnthropicMessagesRequest): string {
  const systemText = textFromAnthropicContent(request.system).replace(/\s+/g, ' ').trim()
  if (systemText) {
    return systemText.slice(0, 240)
  }

  const firstNarrative = request.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => textFromAnthropicContent(message.content).replace(/\s+/g, ' ').trim())
    .find(Boolean)

  return firstNarrative?.slice(0, 240) ?? ''
}

function toPromptEmbeddedMessages(request: AnthropicMessagesRequest): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = []
  const systemText = textFromAnthropicContent(request.system)
  if (systemText) {
    messages.push({ role: 'system', content: systemText })
  }

  for (const message of request.messages) {
    const text = textFromAnthropicContent(message.content)
    if (!text) continue
    messages.push({ role: message.role, content: text })
  }

  return messages
}

function hashStable(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)
}
