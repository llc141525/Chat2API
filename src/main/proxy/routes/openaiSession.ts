import crypto from 'node:crypto'

import type { ChatCompletionRequest, ChatMessage, ProxyContext } from '../types.ts'

type HeaderValue = string | string[] | undefined

export interface OpenAISessionIdentity {
  sessionKey: string
  source: 'header' | 'user' | 'metadata' | 'derived_hash' | 'process_fallback'
}

const HEADER_SESSION_KEYS = [
  'x-session-id',
  'x-conversation-id',
  'x-chat-session-id',
  'x-client-session-id',
] as const

const METADATA_SESSION_KEYS = [
  'session_id',
  'sessionId',
  'conversation_id',
  'conversationId',
  'thread_id',
  'threadId',
] as const

let processFallbackCounter = 0

export function deriveOpenAISessionIdentity(input: {
  request: ChatCompletionRequest
  headers?: Record<string, HeaderValue>
  clientIP?: string
  providerId?: string
}): OpenAISessionIdentity {
  for (const headerName of HEADER_SESSION_KEYS) {
    const raw = input.headers?.[headerName]
    const value = Array.isArray(raw) ? raw[0] : raw
    if (typeof value === 'string' && value.trim().length > 0) {
      return {
        sessionKey: `openai-chat:${hashStable({ source: headerName, value: value.trim() })}`,
        source: 'header',
      }
    }
  }

  if (typeof input.request.user === 'string' && input.request.user.trim().length > 0) {
    return {
      sessionKey: `openai-chat:${hashStable({ source: 'user', value: input.request.user.trim() })}`,
      source: 'user',
    }
  }

  const metadata = requestMetadata(input.request)
  for (const metadataKey of METADATA_SESSION_KEYS) {
    const value = metadata[metadataKey]
    if (typeof value === 'string' && value.trim().length > 0) {
      return {
        sessionKey: `openai-chat:${hashStable({ source: metadataKey, value: value.trim() })}`,
        source: 'metadata',
      }
    }
  }

  const stablePrefix = getStablePrefix(input.request.messages)
  if (stablePrefix.length > 0) {
    return {
      sessionKey: `openai-chat:${hashStable({
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
    sessionKey: `openai-chat:fallback:${processFallbackCounter}`,
    source: 'process_fallback',
  }
}

export function applyOpenAISessionIdentity(
  context: ProxyContext,
  request: ChatCompletionRequest,
  headers?: Record<string, HeaderValue>
): ProxyContext {
  const sessionIdentity = deriveOpenAISessionIdentity({
    request,
    headers,
    clientIP: context.clientIP,
    providerId: context.providerId,
  })

  return {
    ...context,
    toolCatalogSessionKey: sessionIdentity.sessionKey,
    providerConversationSessionKey: sessionIdentity.sessionKey,
  }
}

function requestMetadata(request: ChatCompletionRequest): Record<string, unknown> {
  const candidate = (request as ChatCompletionRequest & { metadata?: unknown }).metadata
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return {}
  return candidate as Record<string, unknown>
}

function getStablePrefix(messages: ChatMessage[]): string {
  const firstStableMessage = messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map(messageText)
    .filter(Boolean)
    .at(0) || ''

  const stableNarrative = firstStableMessage
    .replace(/\s+/g, ' ')
    .trim()

  return stableNarrative.slice(0, 240)
}

function messageText(message: ChatMessage): string {
  if (typeof message.content === 'string') {
    return message.content
  }

  if (!Array.isArray(message.content)) {
    return ''
  }

  return message.content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text ?? '')
    .join(' ')
}

function hashStable(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)
}
