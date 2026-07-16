import type { ChatCompletionRequest, ProxyContext } from '../types.ts'
import type { ConversationState } from './providerConversationState.ts'

export interface SessionBoundaryPlan {
  boundary: NonNullable<ProxyContext['sessionBoundaryReason']>
  providerSessionAction: 'reuse_parent' | 'start_fresh' | 'start_child' | 'consume_child_handoff'
  parentProviderSessionKey?: string
  childProviderSessionKey?: string
  expectedProviderSessionIdReuse: boolean
}

export function buildSessionBoundaryPlan(input: {
  context: ProxyContext
  priorState?: ConversationState
  request: ChatCompletionRequest
  reuseProviderSessionForToolChild?: boolean
}): SessionBoundaryPlan {
  const boundary = input.context.sessionBoundaryReason ?? 'normal'
  const parentProviderSessionKey = input.context.parentProviderConversationSessionKey
    ?? input.context.providerConversationSessionKey
  const childProviderSessionKey = boundary === 'normal'
    ? undefined
    : input.context.providerConversationSessionKey

  if (boundary === 'tool_child' || boundary === 'subagent_child') {
    return {
      boundary,
      providerSessionAction: input.reuseProviderSessionForToolChild ? 'reuse_parent' : 'start_child',
      ...(parentProviderSessionKey ? { parentProviderSessionKey } : {}),
      ...(childProviderSessionKey ? { childProviderSessionKey } : {}),
      expectedProviderSessionIdReuse: !!input.reuseProviderSessionForToolChild,
    }
  }

  if (boundary !== 'normal') {
    // server_summary means the context was compacted. The first turn in the
    // compaction epoch creates a fresh provider session, but subsequent turns
    // must reuse it — otherwise the model loses continuity and loops forever.
    // Instead of checking individual fields (which may not be populated until
    // the stream completes), just check if ANY prior state exists for this key.
    const hasReusableSession = boundary === 'server_summary' && input.priorState != null
    return {
      boundary,
      providerSessionAction: hasReusableSession ? 'reuse_parent' : 'start_fresh',
      ...(parentProviderSessionKey ? { parentProviderSessionKey } : {}),
      ...(childProviderSessionKey ? { childProviderSessionKey } : {}),
      expectedProviderSessionIdReuse: hasReusableSession,
    }
  }

  if (input.priorState?.childSessionHandoff) {
    return {
      boundary,
      providerSessionAction: 'consume_child_handoff',
      ...(parentProviderSessionKey ? { parentProviderSessionKey } : {}),
      expectedProviderSessionIdReuse: true,
    }
  }

  const hasReusableSession = Boolean(
    input.request.sessionId
    || input.priorState?.providerSessionId
    || input.priorState?.conversationId
    || input.priorState?.parentMessageId,
  )
  return {
    boundary,
    providerSessionAction: hasReusableSession ? 'reuse_parent' : 'start_fresh',
    ...(parentProviderSessionKey ? { parentProviderSessionKey } : {}),
    expectedProviderSessionIdReuse: hasReusableSession,
  }
}
