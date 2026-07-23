import test from 'node:test'
import assert from 'node:assert/strict'

import {
  addMessageToSessionsWithRecoveryState,
  applyRecoveryEventToSessions,
  ensureSessionRecoveryState,
  removeSessionById,
} from '../../src/main/store/sessionRecoveryPersistence.ts'
import type { SessionRecord } from '../../src/main/store/types.ts'

function legacySession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'session-1',
    providerId: 'provider-1',
    accountId: 'account-1',
    sessionType: 'agent',
    messages: [],
    createdAt: 100,
    lastActiveAt: 200,
    status: 'active',
    model: 'model-1',
    ...overrides,
  }
}

test('ensureSessionRecoveryState creates fresh recovery state for legacy session without losing provider/account/model', () => {
  const session = legacySession()
  const next = ensureSessionRecoveryState(session)

  assert.notEqual(next, session)
  assert.equal(next.providerId, 'provider-1')
  assert.equal(next.accountId, 'account-1')
  assert.equal(next.model, 'model-1')
  assert.equal(next.recoveryState?.sessionId, 'session-1')
  assert.equal(next.recoveryState?.sessionKind, 'main')
  assert.equal(next.recoveryState?.createdAt, 100)
  assert.equal(next.recoveryState?.updatedAt, 100)
  assert.equal(session.recoveryState, undefined)
})

test('ensureSessionRecoveryState migrates persisted state and rejects illegal recovery state', () => {
  const migrated = ensureSessionRecoveryState(legacySession({
    recoveryState: {
      schema: 'chat2api.sessionRecoveryState',
      version: 0,
      sessionId: 'session-1',
      sessionKind: 'main',
      facts: {
        verified: [{ id: 'summary-fact', text: 'summary claims done', source: 'model_summary' }],
      },
    } as never,
  }))

  assert.equal(migrated.recoveryState?.facts.verified.length, 0)
  assert.equal(migrated.recoveryState?.facts.claimed.length, 1)

  assert.throws(() => ensureSessionRecoveryState(legacySession({
    recoveryState: { sessionId: '', sessionKind: 'main' } as never,
  })), /sessionId/)
})

test('applyRecoveryEventToSessions immutably saves recovery state with session record', () => {
  const session = ensureSessionRecoveryState(legacySession())
  const sessions = [session]

  const nextSessions = applyRecoveryEventToSessions(sessions, 'session-1', {
    type: 'runtime_tool_call',
    eventId: 'event-1',
    sessionId: 'session-1',
    occurredAt: 300,
    expectedStateVersion: 0,
    toolCallId: 'call-1',
    toolName: 'read',
  })

  assert.notEqual(nextSessions, sessions)
  assert.notEqual(nextSessions[0], session)
  assert.equal(session.recoveryState?.stateVersion, 0)
  assert.equal(nextSessions[0]?.providerId, 'provider-1')
  assert.equal(nextSessions[0]?.accountId, 'account-1')
  assert.equal(nextSessions[0]?.model, 'model-1')
  assert.equal(nextSessions[0]?.recoveryState?.stateVersion, 1)
  assert.equal(nextSessions[0]?.recoveryState?.facts.claimed[0]?.id, 'tool-call:call-1')
})

test('removeSessionById deletes session scoped recovery state without orphan data', () => {
  const session = ensureSessionRecoveryState(legacySession())
  const nextSessions = removeSessionById([session], 'session-1')

  assert.deepEqual(nextSessions, [])
})

test('addMessageToSessionsWithRecoveryState hydrates legacy session and immutably preserves message write semantics', () => {
  const session = legacySession({
    messages: [
      { role: 'user', content: 'one', timestamp: 1 },
      { role: 'assistant', content: 'two', timestamp: 2 },
    ],
  })
  const message = { role: 'user' as const, content: 'three', timestamp: 3 }

  const result = addMessageToSessionsWithRecoveryState([session], 'session-1', message, 2, 400)

  assert.equal(session.recoveryState, undefined)
  assert.deepEqual(session.messages.map(item => item.content), ['one', 'two'])
  assert.equal(result.session?.recoveryState?.sessionId, 'session-1')
  assert.equal(result.session?.lastActiveAt, 400)
  assert.deepEqual(result.session?.messages.map(item => item.content), ['two', 'three'])
  assert.equal(result.sessions[0], result.session)
})

test('session recovery state survives serialize and reload simulation', () => {
  const saved = applyRecoveryEventToSessions([ensureSessionRecoveryState(legacySession())], 'session-1', {
    type: 'runtime_tool_call',
    eventId: 'event-1',
    sessionId: 'session-1',
    occurredAt: 300,
    expectedStateVersion: 0,
    toolCallId: 'call-1',
    toolName: 'read',
  })

  const reloaded = JSON.parse(JSON.stringify(saved)) as SessionRecord[]
  const hydrated = ensureSessionRecoveryState(reloaded[0]!)

  assert.equal(hydrated.recoveryState?.stateVersion, 1)
  assert.equal(hydrated.recoveryState?.facts.claimed[0]?.id, 'tool-call:call-1')
  assert.equal(hydrated.providerId, 'provider-1')
  assert.equal(hydrated.accountId, 'account-1')
  assert.equal(hydrated.model, 'model-1')
})
