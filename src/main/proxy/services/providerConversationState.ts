import type { ChatCompletionRequest, ProxyContext } from '../types.ts'
import {
  buildProviderConversationStateWritePlan,
  decideProviderConversationStateWriteTargets,
  type ChildSessionHandoff,
} from '../sessionBoundary.ts'

export interface ConversationState {
  parentMessageId?: string
  conversationId?: string
  /** ProviderRuntime generic session tracking — the canonical fields for all providers */
  providerSessionId?: string
  providerParentReqId?: string
  /** Legacy Qwen-specific fields — retained only for backward compat with dedicated forwarders */
  qwenSessionId?: string
  qwenParentReqId?: string
  childSessionHandoff?: ChildSessionHandoff
  /** Legacy Qwen-specific child session ID */
  childQwenSessionId?: string
  /** Provider-neutral child session ID for cleanup after parent handoff consumption */
  childProviderSessionId?: string
  lastUsedAt: number
}

export const CONVERSATION_STATE_TTL = 5 * 60 * 1000
export const conversationStateCache = new Map<string, ConversationState>()

export function getConversationState(key: string): ConversationState | undefined {
  const state = conversationStateCache.get(key)
  if (state && Date.now() - state.lastUsedAt < CONVERSATION_STATE_TTL) {
    return state
  }
  conversationStateCache.delete(key)
  return undefined
}

export function setConversationState(key: string, update: Partial<ConversationState>): void {
  const existing = conversationStateCache.get(key)
  conversationStateCache.set(key, {
    ...existing,
    ...update,
    lastUsedAt: Date.now(),
  } as ConversationState)
}

function hasManagedToolHistory(messages?: ChatCompletionRequest['messages']): boolean {
  if (!messages || messages.length === 0) return false
  return messages.some((message) => (
    (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
    || (message.role === 'tool' && typeof message.tool_call_id === 'string' && message.tool_call_id.length > 0)
  ))
}

export function shouldUseProviderConversationFallback(context: ProxyContext): boolean {
  return !context.sessionBoundaryReason || context.sessionBoundaryReason === 'normal'
}

export function getProviderConversationState(input: {
  primaryKey: string
  fallbackToolSessionKey?: string | null
  messages?: ChatCompletionRequest['messages']
  allowFallback?: boolean
}): ConversationState | undefined {
  const primary = getConversationState(input.primaryKey)
  if (primary) return primary

  if (input.allowFallback === false || !input.fallbackToolSessionKey || !hasManagedToolHistory(input.messages)) {
    return undefined
  }

  return getConversationState(input.fallbackToolSessionKey)
}

export function setProviderConversationState(input: {
  context: ProxyContext
  primaryKey: string
  update: Partial<ConversationState>
  fallbackToolSessionKey?: string | null
  messages?: ChatCompletionRequest['messages']
  mirrorToFallback?: boolean
  parentHandoff?: ChildSessionHandoff
}): void {
  const targets = decideProviderConversationStateWriteTargets(input)
  const allowMirror = !(input.mirrorToFallback === false || !input.fallbackToolSessionKey || !hasManagedToolHistory(input.messages))
  const writes = buildProviderConversationStateWritePlan<ConversationState>({
    targets: {
      ...targets,
      ...(allowMirror ? {} : { mirrorKey: undefined }),
    },
    primaryUpdate: input.update,
    parentHandoff: input.parentHandoff,
  })
  for (const write of writes) {
    setConversationState(write.key, write.update)
  }
}
