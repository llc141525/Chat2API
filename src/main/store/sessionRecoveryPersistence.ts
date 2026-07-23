import type { ChatMessage, SessionRecord } from './types.ts'
import {
  createSessionRecoveryState,
  deserializeSessionRecoveryState,
  reduceRecoveryEvent,
  type RecoveryEvent,
  type SessionKind,
} from '../proxy/services/sessionRecoveryState.ts'

export interface EnsureRecoverySessionRecordInput {
  sessionId: string
  sessionKind: SessionKind
  parentSessionId?: string
  toolCallId?: string
  providerSessionId?: string
  providerId?: string
  accountId?: string
  model?: string
  now: number
}

export function ensureSessionRecoveryState(session: SessionRecord): SessionRecord {
  if (session.recoveryState === undefined) {
    return {
      ...session,
      recoveryState: createSessionRecoveryState({
        sessionId: session.id,
        sessionKind: 'main',
        now: session.createdAt,
      }),
    }
  }

  const recoveryState = deserializeSessionRecoveryState(session.recoveryState)
  if (recoveryState.sessionId !== session.id) {
    throw new Error(`Session recoveryState sessionId ${recoveryState.sessionId} does not match session ${session.id}`)
  }

  return {
    ...session,
    recoveryState,
  }
}

export function applyRecoveryEventToSessions(
  sessions: SessionRecord[],
  sessionId: string,
  event: RecoveryEvent,
): SessionRecord[] {
  let found = false
  const nextSessions = sessions.map(session => {
    if (session.id !== sessionId) return session
    found = true
    const hydrated = ensureSessionRecoveryState(session)
    return {
      ...hydrated,
      recoveryState: reduceRecoveryEvent(hydrated.recoveryState!, event),
      lastActiveAt: Math.max(hydrated.lastActiveAt, event.occurredAt),
    }
  })

  if (!found) throw new Error(`Session ${sessionId} not found`)
  return nextSessions
}

export function ensureRecoverySessionRecordInSessions(
  sessions: SessionRecord[],
  input: EnsureRecoverySessionRecordInput,
): SessionRecord[] {
  const existing = sessions.find(session => session.id === input.sessionId)
  if (existing) {
    const hydrated = ensureSessionRecoveryState(existing)
    return sessions.map(session => session.id === input.sessionId ? hydrated : session)
  }

  const session: SessionRecord = {
    id: input.sessionId,
    providerId: input.providerId ?? 'unknown',
    accountId: input.accountId ?? 'unknown',
    sessionType: 'agent',
    messages: [],
    createdAt: input.now,
    lastActiveAt: input.now,
    status: 'active',
    model: input.model,
    recoveryState: createSessionRecoveryState({
      sessionId: input.sessionId,
      parentSessionId: input.parentSessionId,
      sessionKind: input.sessionKind,
      providerSessionId: input.providerSessionId,
      toolCallId: input.toolCallId,
      now: input.now,
    }),
  }

  return [...sessions, session]
}

export function removeSessionById(sessions: SessionRecord[], sessionId: string): SessionRecord[] {
  return sessions.filter(session => session.id !== sessionId)
}

export function addMessageToSessionsWithRecoveryState(
  sessions: SessionRecord[],
  sessionId: string,
  message: ChatMessage,
  maxMessagesPerSession: number,
  now: number,
): { sessions: SessionRecord[]; session: SessionRecord | null } {
  let updatedSession: SessionRecord | null = null
  const nextSessions = sessions.map(session => {
    if (session.id !== sessionId) return session

    const hydrated = ensureSessionRecoveryState(session)
    const messages = hydrated.messages.length >= maxMessagesPerSession
      ? hydrated.messages.slice(-maxMessagesPerSession + 1)
      : [...hydrated.messages]

    updatedSession = {
      ...hydrated,
      messages: [...messages, message],
      lastActiveAt: now,
    }
    return updatedSession
  })

  return { sessions: nextSessions, session: updatedSession }
}
