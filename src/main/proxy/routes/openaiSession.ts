import crypto from 'node:crypto'

import type { ChatCompletionRequest, ChatMessage, ProxyContext, SessionBoundaryReason } from '../types.ts'

type HeaderValue = string | string[] | undefined

export interface OpenAISessionIdentity {
  toolCatalogSessionKey: string
  providerConversationSessionKey: string
  providerSessionEpoch: string
  parentProviderConversationSessionKey?: string
  sessionBoundaryReason: SessionBoundaryReason
  source: 'header' | 'user' | 'metadata' | 'derived_hash' | 'process_fallback'
}

type ToolWorkflowMarkerClass =
  | 'chat2api_tool_result'
  | 'xml_tool_result'
  | 'skill_content'
  | 'completed_status_json'

type ToolWorkflowSignals = {
  latestNonSystemRole: ChatMessage['role'] | 'none'
  toolRoleCount: number
  assistantToolCallsCount: number
  compactMarkerPresent: boolean
  subagentMarkerPresent: boolean
  recognizedToolResultMarkerClass: ToolWorkflowMarkerClass | null
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

const EPOCH_KEYS = [
  'x-compact-epoch',
  'x-context-epoch',
  'x-conversation-epoch',
  'compact_epoch',
  'compactEpoch',
  'context_epoch',
  'contextEpoch',
  'conversation_epoch',
  'conversationEpoch',
] as const

const SUBAGENT_KEYS = [
  'x-subagent-id',
  'x-agent-id',
  'x-agent-run-id',
  'subagent_id',
  'subagentId',
  'agent_id',
  'agentId',
  'agent_run_id',
  'agentRunId',
] as const

const COMPACT_MARKERS = [
  '[prior conversation summary',
  '/compact',
  'compact summary',
  'conversation summary',
  'summarized conversation',
] as const

let processFallbackCounter = 0

export function deriveOpenAISessionIdentity(input: {
  request: ChatCompletionRequest
  headers?: Record<string, HeaderValue>
  clientIP?: string
  providerId?: string
}): OpenAISessionIdentity {
  const baseIdentity = deriveBaseSessionIdentity(input)
  const subagentEpoch = deriveSubagentEpoch(input.request, input.headers, baseIdentity.sessionKey)
  const parentProviderConversationSessionKey = subagentEpoch
    ? `${baseIdentity.sessionKey}:subagent:${subagentEpoch}`
    : baseIdentity.sessionKey
  const signals = inspectToolWorkflowSignals(input.request, input.headers)

  const toolChildEpoch = deriveToolChildEpoch(input.request, parentProviderConversationSessionKey)
  if (toolChildEpoch) {
    const identity = {
      toolCatalogSessionKey: baseIdentity.sessionKey,
      providerConversationSessionKey: `${parentProviderConversationSessionKey}:tool:${toolChildEpoch}`,
      providerSessionEpoch: `tool:${toolChildEpoch}`,
      parentProviderConversationSessionKey,
      sessionBoundaryReason: 'tool_child',
      source: baseIdentity.source,
    }
    logOpenAISessionIdentityDiagnostics(identity, signals)
    return identity
  }

  const compactEpoch = deriveCompactEpoch(input.request, input.headers, parentProviderConversationSessionKey)

  if (compactEpoch) {
    const identity = {
      toolCatalogSessionKey: baseIdentity.sessionKey,
      providerConversationSessionKey: `${parentProviderConversationSessionKey}:compact:${compactEpoch}`,
      providerSessionEpoch: `compact:${compactEpoch}`,
      parentProviderConversationSessionKey,
      sessionBoundaryReason: 'client_compact',
      source: baseIdentity.source,
    }
    logOpenAISessionIdentityDiagnostics(identity, signals)
    return identity
  }

  if (subagentEpoch) {
    const identity = {
      toolCatalogSessionKey: baseIdentity.sessionKey,
      providerConversationSessionKey: parentProviderConversationSessionKey,
      providerSessionEpoch: `subagent:${subagentEpoch}`,
      parentProviderConversationSessionKey: baseIdentity.sessionKey,
      sessionBoundaryReason: 'subagent_child',
      source: baseIdentity.source,
    }
    logOpenAISessionIdentityDiagnostics(identity, signals)
    return identity
  }

  const identity = {
    toolCatalogSessionKey: baseIdentity.sessionKey,
    providerConversationSessionKey: baseIdentity.sessionKey,
    providerSessionEpoch: 'main',
    sessionBoundaryReason: 'normal',
    source: baseIdentity.source,
  }
  logOpenAISessionIdentityDiagnostics(identity, signals)
  return identity
}

export function applyOpenAISessionIdentity(
  context: ProxyContext,
  request: ChatCompletionRequest,
  headers?: Record<string, HeaderValue>
): ProxyContext {
  // Preserve runtime-set boundaries (server_summary, summary_generator) that are
  // not derived from client request signals. deriveOpenAISessionIdentity only
  // produces normal, tool_child, client_compact, or subagent_child — it should not
  // overwrite internal boundaries the runtime already determined.
  const sessionIdentity = deriveOpenAISessionIdentity({
    request,
    headers,
    clientIP: context.clientIP,
    providerId: context.providerId,
  })

  const boundaryReason = context.sessionBoundaryReason && context.sessionBoundaryReason !== 'normal'
    ? context.sessionBoundaryReason
    : sessionIdentity.sessionBoundaryReason

  return {
    ...context,
    toolCatalogSessionKey: sessionIdentity.toolCatalogSessionKey,
    providerConversationSessionKey: sessionIdentity.providerConversationSessionKey,
    providerSessionEpoch: sessionIdentity.providerSessionEpoch,
    parentProviderConversationSessionKey: sessionIdentity.parentProviderConversationSessionKey,
    sessionBoundaryReason: boundaryReason,
  }
}

function deriveBaseSessionIdentity(input: {
  request: ChatCompletionRequest
  headers?: Record<string, HeaderValue>
  clientIP?: string
  providerId?: string
}): { sessionKey: string; source: OpenAISessionIdentity['source'] } {
  for (const headerName of HEADER_SESSION_KEYS) {
    const value = readHeaderValue(input.headers, headerName)
    if (value) {
      return {
        sessionKey: `openai-chat:${hashStable({ source: headerName, value })}`,
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

function deriveCompactEpoch(
  request: ChatCompletionRequest,
  headers: Record<string, HeaderValue> | undefined,
  parentProviderConversationSessionKey: string
): string | null {
  const metadata = requestMetadata(request)

  for (const epochKey of EPOCH_KEYS) {
    const headerValue = readHeaderValue(headers, epochKey)
    if (headerValue) {
      return hashStable({ parentProviderConversationSessionKey, source: epochKey, value: headerValue })
    }

    const metadataValue = metadata[epochKey]
    if (typeof metadataValue === 'string' && metadataValue.trim().length > 0) {
      return hashStable({ parentProviderConversationSessionKey, source: epochKey, value: metadataValue.trim() })
    }
  }

  const compactNarrative = getCompactNarrative(request.messages)
  if (!compactNarrative) {
    return null
  }

  return hashStable({ parentProviderConversationSessionKey, source: 'compact_marker', compactNarrative })
}

function readHeaderValue(headers: Record<string, HeaderValue> | undefined, key: string): string | null {
  const raw = headers?.[key]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function getCompactNarrative(messages: ChatMessage[]): string {
  const segments = messages
    .filter((message) => message.role === 'system' || message.role === 'user' || message.role === 'assistant')
    .map(messageText)
    .map((text) => text.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

  const match = segments.find((segment) =>
    COMPACT_MARKERS.some((marker) => segment.toLowerCase().includes(marker))
  )

  return match?.slice(0, 240) ?? ''
}

function deriveToolChildEpoch(
  request: ChatCompletionRequest,
  parentProviderConversationSessionKey: string
): string | null {
  const latestNonSystemIndex = findLatestNonSystemMessageIndex(request.messages)
  if (latestNonSystemIndex < 0) {
    return null
  }

  const latestNonSystemMessage = request.messages[latestNonSystemIndex]
  const latestMarkerClass = latestNonSystemMessage ? detectToolResultMarkerClass(latestNonSystemMessage) : null
  const latestIsWorkflowContinuation = latestNonSystemMessage?.role === 'tool' || latestMarkerClass !== null
  if (!latestIsWorkflowContinuation) {
    return null
  }

  let workflowStartIndex = latestNonSystemIndex
  for (let i = latestNonSystemIndex; i >= 0; i -= 1) {
    const message = request.messages[i]
    if (!message || message.role === 'system') continue
    const isToolWorkflowMessage = message.role === 'tool'
      || (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
      || detectToolResultMarkerClass(message) !== null
    if (!isToolWorkflowMessage) {
      break
    }
    workflowStartIndex = i
  }

  const workflowStartMessage = request.messages[workflowStartIndex]
  if (
    !workflowStartMessage
    || workflowStartMessage.role !== 'assistant'
    || !Array.isArray(workflowStartMessage.tool_calls)
    || workflowStartMessage.tool_calls.length === 0
  ) {
    return null
  }

  const boundaryMessage = findPreviousDecisionMessage(request.messages, workflowStartIndex - 1)
  const workflowStartToolCalls = workflowStartMessage.tool_calls.map((toolCall) => ({
    id: toolCall.id,
    name: toolCall.function.name,
    arguments: toolCall.function.arguments,
  }))

  return hashStable({
    parentProviderConversationSessionKey,
    source: 'tool_child',
    workflowStartToolCalls,
    boundaryMessage,
  })
}

function deriveSubagentEpoch(
  request: ChatCompletionRequest,
  headers: Record<string, HeaderValue> | undefined,
  baseSessionKey: string
): string | null {
  const metadata = requestMetadata(request)

  for (const subagentKey of SUBAGENT_KEYS) {
    const headerValue = readHeaderValue(headers, subagentKey)
    if (headerValue) {
      return hashStable({ baseSessionKey, source: subagentKey, value: headerValue })
    }

    const metadataValue = metadata[subagentKey]
    if (typeof metadataValue === 'string' && metadataValue.trim().length > 0) {
      return hashStable({ baseSessionKey, source: subagentKey, value: metadataValue.trim() })
    }
  }

  return null
}

function findLatestNonSystemMessageIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role !== 'system') {
      return i
    }
  }
  return -1
}

function inspectToolWorkflowSignals(
  request: ChatCompletionRequest,
  headers: Record<string, HeaderValue> | undefined
): ToolWorkflowSignals {
  const latestNonSystemIndex = findLatestNonSystemMessageIndex(request.messages)
  const latestNonSystemMessage = latestNonSystemIndex >= 0 ? request.messages[latestNonSystemIndex] : undefined
  const metadata = requestMetadata(request)

  return {
    latestNonSystemRole: latestNonSystemMessage?.role ?? 'none',
    toolRoleCount: request.messages.filter((message) => message.role === 'tool').length,
    assistantToolCallsCount: request.messages.filter((message) => (
      message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0
    )).length,
    compactMarkerPresent: deriveCompactEpoch(request, headers, '__diagnostic__') !== null,
    subagentMarkerPresent: deriveSubagentEpoch(request, headers, '__diagnostic__') !== null,
    recognizedToolResultMarkerClass: latestNonSystemMessage
      ? detectToolResultMarkerClass(latestNonSystemMessage) ?? detectLatestWorkflowMarkerClass(request.messages)
      : detectLatestWorkflowMarkerClass(request.messages),
  }
}

function detectLatestWorkflowMarkerClass(messages: ChatMessage[]): ToolWorkflowMarkerClass | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (!message || message.role === 'system') continue
    const markerClass = detectToolResultMarkerClass(message)
    if (markerClass) return markerClass
    if (message.role === 'tool' || (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0)) {
      return null
    }
  }
  return null
}

function detectToolResultMarkerClass(message: ChatMessage): ToolWorkflowMarkerClass | null {
  const normalized = messageText(message).toLowerCase()
  if (!normalized) return null
  if (normalized.includes('<|chat2api|tool_result')) return 'chat2api_tool_result'
  if (normalized.includes('<tool_result')) return 'xml_tool_result'
  if (normalized.includes('<skill_content ')) return 'skill_content'
  if (normalized.includes('"status":"completed"') || normalized.includes('"state":{"status":"completed"')) {
    return 'completed_status_json'
  }
  return null
}

function logOpenAISessionIdentityDiagnostics(
  identity: OpenAISessionIdentity,
  signals: ToolWorkflowSignals
): void {
  console.log('[OpenAISession] Identity diagnostics:', JSON.stringify({
    boundaryReason: identity.sessionBoundaryReason,
    latestNonSystemRole: signals.latestNonSystemRole,
    toolRoleCount: signals.toolRoleCount,
    assistantToolCallsCount: signals.assistantToolCallsCount,
    compactMarkerPresent: signals.compactMarkerPresent,
    subagentMarkerPresent: signals.subagentMarkerPresent,
    recognizedToolResultMarkerClass: signals.recognizedToolResultMarkerClass,
  }))
}

function findPreviousDecisionMessage(messages: ChatMessage[], startIndex: number): {
  role: ChatMessage['role']
  text: string
} | null {
  for (let i = startIndex; i >= 0; i -= 1) {
    const message = messages[i]
    if (!message || message.role === 'system') continue
    return {
      role: message.role,
      text: messageText(message).replace(/\s+/g, ' ').trim().slice(0, 240),
    }
  }
  return null
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
