import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SESSION_RECOVERY_SCHEMA,
  SESSION_RECOVERY_STATE_VERSION,
  createSessionRecoveryState,
  createTypedSessionHandoff,
  deserializeSessionRecoveryState,
  serializeSessionRecoveryState,
  assertValidRecoveryEvent,
  reduceRecoveryEvent,
  type RecoveryEvent,
} from '../../src/main/proxy/services/sessionRecoveryState.ts'
import { renderRecoveryContextForProvider } from '../../src/main/proxy/services/recoveryPromptProjection.ts'

test('creates fresh main recovery state with explicit persistent defaults', () => {
  const state = createSessionRecoveryState({
    sessionId: 'main-1',
    sessionKind: 'main',
    now: 1234,
  })

  assert.equal(state.schema, SESSION_RECOVERY_SCHEMA)
  assert.equal(state.version, SESSION_RECOVERY_STATE_VERSION)
  assert.equal(state.sessionId, 'main-1')
  assert.equal(state.parentSessionId, null)
  assert.equal(state.sessionKind, 'main')
  assert.equal(state.stateVersion, 0)
  assert.equal(state.compactionEpoch, 0)
  assert.equal(state.lifecycle, 'active')
  assert.deepEqual(state.children.pending, [])
  assert.deepEqual(state.children.completed, [])
  assert.deepEqual(state.facts, { claimed: [], executed: [], verified: [] })
  assert.deepEqual(state.pendingWork, [])
  assert.deepEqual(state.failures, [])
  assert.deepEqual(state.decisions, [])
  assert.deepEqual(state.constraints, [])
  assert.deepEqual(state.artifacts, [])
  assert.equal(state.next, null)
  assert.deepEqual(state.handoffs, { created: [], consumed: [] })
  assert.deepEqual(state.appliedEventIds, [])
  assert.equal(state.createdAt, 1234)
  assert.equal(state.updatedAt, 1234)
})

test('creates child recovery state with parent, node, and typed handoff metadata', () => {
  const state = createSessionRecoveryState({
    sessionId: 'child-1',
    parentSessionId: 'main-1',
    sessionKind: 'tool_child',
    providerSessionId: 'provider-child-1',
    toolCallId: 'call-1',
    now: 2000,
  })

  assert.equal(state.parentSessionId, 'main-1')
  assert.equal(state.sessionKind, 'tool_child')
  assert.deepEqual(state.node, {
    sessionId: 'child-1',
    parentSessionId: 'main-1',
    sessionKind: 'tool_child',
    providerSessionId: 'provider-child-1',
    toolCallId: 'call-1',
    createdAt: 2000,
    completedAt: null,
  })

  const handoff = createTypedSessionHandoff({
    handoffId: 'handoff-1',
    fromSessionId: 'child-1',
    toSessionId: 'main-1',
    childKind: 'tool_child',
    createdAt: 2100,
    verifiedFactIds: ['fact-verified'],
    artifactIds: ['artifact-1'],
    failureIds: ['failure-1'],
    pendingWorkIds: ['work-1'],
  })

  assert.equal(handoff.status, 'created')
  assert.equal(handoff.consumedAt, null)
  assert.deepEqual(handoff.verifiedFactIds, ['fact-verified'])
})

test('migrates older or incomplete persisted state without trusting summary facts as verified', () => {
  const migrated = deserializeSessionRecoveryState({
    schema: 'chat2api.sessionRecoveryState',
    version: 0,
    sessionId: 'legacy-1',
    sessionKind: 'main',
    facts: {
      verified: [{ id: 'bad-summary-fact', text: 'model summary says done', source: 'model_summary' }],
      claimed: [{ id: 'claimed-1', text: 'I inspected the file', source: 'model_summary' }],
    },
    pendingWork: [{ id: 'work-1', text: 'finish tests' }],
  })

  assert.equal(migrated.version, SESSION_RECOVERY_STATE_VERSION)
  assert.equal(migrated.stateVersion, 0)
  assert.equal(migrated.compactionEpoch, 0)
  assert.equal(migrated.lifecycle, 'active')
  assert.equal(migrated.facts.verified.length, 0)
  assert.equal(migrated.facts.claimed.length, 2)
  assert.equal(migrated.facts.claimed[0]?.verification, 'claimed')
  assert.equal(migrated.pendingWork[0]?.status, 'pending')
})

test('bounds persisted arrays and truncates oversized text fields during serialization round trip', () => {
  const state = createSessionRecoveryState({ sessionId: 'bounds-1', sessionKind: 'main', now: 1 })
  const overLimit = Array.from({ length: 80 }, (_, index) => ({
    id: `fact-${index}`,
    text: 'x'.repeat(5000),
    source: 'runtime_tool_result' as const,
    verification: 'verified' as const,
    createdAt: index,
  }))

  const restored = deserializeSessionRecoveryState(serializeSessionRecoveryState({
    ...state,
    facts: { ...state.facts, verified: overLimit },
  }))

  assert.equal(restored.facts.verified.length, 50)
  assert.equal(restored.facts.verified[0]?.id, 'fact-30')
  assert.equal(restored.facts.verified.at(-1)?.id, 'fact-79')
  assert.equal(restored.facts.verified[0]?.text.length, 1000)
})

test('rejects invalid persisted state and invalid event envelopes at the boundary', () => {
  assert.throws(() => deserializeSessionRecoveryState(null), /SessionRecoveryState must be an object/)
  assert.throws(() => createSessionRecoveryState({ sessionId: '', sessionKind: 'main' }), /sessionId/)
  assert.throws(() => createSessionRecoveryState({ sessionId: 'x', sessionKind: 'global' as never }), /sessionKind/)

  const event: RecoveryEvent = {
    type: 'runtime_tool_call',
    eventId: 'event-1',
    sessionId: 'session-1',
    occurredAt: 10,
    expectedStateVersion: 0,
    toolCallId: 'call-1',
    toolName: 'read',
  }
  assert.doesNotThrow(() => assertValidRecoveryEvent(event))
  assert.throws(() => assertValidRecoveryEvent({ ...event, eventId: '' }), /eventId/)
  assert.throws(() => assertValidRecoveryEvent({ ...event, expectedStateVersion: -1 }), /expectedStateVersion/)
})

test('validates recovery event subtype payloads at the boundary', () => {
  const base = {
    eventId: 'event-1',
    sessionId: 'session-1',
    occurredAt: 10,
    expectedStateVersion: 0,
  }

  assert.throws(() => assertValidRecoveryEvent({ ...base, type: 'runtime_tool_call', toolCallId: '', toolName: 'read' } as RecoveryEvent), /toolCallId/)
  assert.throws(() => assertValidRecoveryEvent({ ...base, type: 'runtime_tool_call', toolCallId: 'call-1', toolName: '' } as RecoveryEvent), /toolName/)
  assert.throws(() => assertValidRecoveryEvent({ ...base, type: 'runtime_tool_result', toolCallId: '', success: true } as RecoveryEvent), /toolCallId/)
  assert.throws(() => assertValidRecoveryEvent({ ...base, type: 'runtime_tool_result', toolCallId: 'call-1', success: 'yes' } as unknown as RecoveryEvent), /success/)
  assert.throws(() => assertValidRecoveryEvent({ ...base, type: 'verification', factId: '', verified: true } as RecoveryEvent), /factId/)
  assert.throws(() => assertValidRecoveryEvent({ ...base, type: 'verification', factId: 'fact-1', verified: 'yes' } as unknown as RecoveryEvent), /verified/)
  assert.throws(() => assertValidRecoveryEvent({ ...base, type: 'failure', failureId: '', recoverable: true } as RecoveryEvent), /failureId/)
  assert.throws(() => assertValidRecoveryEvent({ ...base, type: 'failure', failureId: 'failure-1', recoverable: 'yes' } as unknown as RecoveryEvent), /recoverable/)
  assert.throws(() => assertValidRecoveryEvent({ ...base, type: 'compaction_boundary', compactionEpoch: -1, source: 'client' } as RecoveryEvent), /compactionEpoch/)
  assert.throws(() => assertValidRecoveryEvent({ ...base, type: 'compaction_boundary', compactionEpoch: 1, source: 'unknown' } as unknown as RecoveryEvent), /source/)
  assert.throws(() => assertValidRecoveryEvent({ ...base, type: 'child_create', childSessionId: '', childKind: 'tool_child' } as RecoveryEvent), /childSessionId/)
  assert.throws(() => assertValidRecoveryEvent({ ...base, type: 'child_create', childSessionId: 'child-1', childKind: 'main' } as unknown as RecoveryEvent), /childKind/)
  assert.throws(() => assertValidRecoveryEvent({ ...base, type: 'child_complete', childSessionId: '' } as RecoveryEvent), /childSessionId/)
  assert.throws(() => assertValidRecoveryEvent({ ...base, type: 'handoff_create', handoffId: '', fromSessionId: 'child-1', toSessionId: 'session-2', childKind: 'tool_child' } as RecoveryEvent), /handoffId/)
  assert.throws(() => assertValidRecoveryEvent({ ...base, type: 'handoff_create', handoffId: 'handoff-1', fromSessionId: '', toSessionId: 'session-2', childKind: 'tool_child' } as RecoveryEvent), /fromSessionId/)
  assert.throws(() => assertValidRecoveryEvent({ ...base, type: 'handoff_create', handoffId: 'handoff-1', fromSessionId: 'child-1', toSessionId: '', childKind: 'tool_child' } as RecoveryEvent), /toSessionId/)
  assert.throws(() => assertValidRecoveryEvent({ ...base, type: 'handoff_create', handoffId: 'handoff-1', fromSessionId: 'child-1', toSessionId: 'session-2', childKind: 'main' } as unknown as RecoveryEvent), /childKind/)
  assert.throws(() => assertValidRecoveryEvent({ ...base, type: 'handoff_consume', handoffId: '', fromSessionId: 'child-1' } as RecoveryEvent), /handoffId/)
  assert.throws(() => assertValidRecoveryEvent({ ...base, type: 'handoff_consume', handoffId: 'handoff-1', fromSessionId: '' } as RecoveryEvent), /fromSessionId/)
  assert.throws(() => assertValidRecoveryEvent({ ...base, type: 'provider_session_change' } as RecoveryEvent), /providerSessionId/)
  assert.throws(() => assertValidRecoveryEvent({ ...base, type: 'provider_session_change', previousProviderSessionId: '', nextProviderSessionId: undefined } as unknown as RecoveryEvent), /providerSessionId/)
  assert.throws(() => assertValidRecoveryEvent({ ...base, type: 'task_complete', result: 'partial' } as unknown as RecoveryEvent), /result/)

  const validEvents: RecoveryEvent[] = [
    { ...base, type: 'runtime_tool_call', toolCallId: 'call-1', toolName: 'read' },
    { ...base, type: 'runtime_tool_result', toolCallId: 'call-1', success: false },
    { ...base, type: 'verification', factId: 'fact-1', verified: true },
    { ...base, type: 'failure', failureId: 'failure-1', recoverable: false },
    { ...base, type: 'compaction_boundary', compactionEpoch: 1, source: 'local_fallback' },
    { ...base, type: 'child_create', childSessionId: 'child-1', childKind: 'subagent_child' },
    { ...base, type: 'child_complete', childSessionId: 'child-1' },
    { ...base, type: 'handoff_create', handoffId: 'handoff-1', fromSessionId: 'child-1', toSessionId: 'main-1', childKind: 'tool_child' },
    { ...base, type: 'handoff_consume', handoffId: 'handoff-1', fromSessionId: 'child-1' },
    { ...base, type: 'provider_session_change', nextProviderSessionId: 'provider-2' },
    { ...base, type: 'task_complete', result: 'success' },
  ]

  for (const event of validEvents) {
    assert.doesNotThrow(() => assertValidRecoveryEvent(event))
  }
})

test('rejects invalid handoff child kind instead of coercing it', () => {
  assert.throws(() => createTypedSessionHandoff({
    handoffId: 'handoff-1',
    fromSessionId: 'child-1',
    toSessionId: 'main-1',
    childKind: 'main' as never,
  }), /childKind/)

  const state = createSessionRecoveryState({ sessionId: 'main-1', sessionKind: 'main', now: 1 })
  assert.throws(() => deserializeSessionRecoveryState({
    ...state,
    handoffs: {
      created: [{
        handoffId: 'handoff-1',
        fromSessionId: 'child-1',
        toSessionId: 'main-1',
        childKind: 'main',
        status: 'created',
        createdAt: 1,
      }],
      consumed: [],
    },
  }), /childKind/)
})

test('reduceRecoveryEvent is idempotent, versioned, session-scoped, and immutable', () => {
  const state = createSessionRecoveryState({ sessionId: 'main-1', sessionKind: 'main', now: 1 })
  const original = structuredClone(state)
  const event: RecoveryEvent = {
    type: 'runtime_tool_call',
    eventId: 'evt-call',
    sessionId: 'main-1',
    occurredAt: 2,
    expectedStateVersion: 0,
    toolCallId: 'call-1',
    toolName: 'read',
  }

  const next = reduceRecoveryEvent(state, event)
  assert.deepEqual(state, original)
  assert.equal(next.stateVersion, 1)
  assert.deepEqual(next.appliedEventIds, ['evt-call'])
  assert.equal(next.facts.claimed[0]?.source, 'runtime_tool_call')
  assert.equal(next.facts.claimed[0]?.verification, 'claimed')
  assert.equal(next.facts.verified.length, 0)
  assert.deepEqual(next.next, {
    kind: 'tool',
    description: 'Run tool read for call call-1',
    toolName: 'read',
    toolCallId: 'call-1',
  })

  assert.equal(reduceRecoveryEvent(next, { ...event, expectedStateVersion: 999 }), next)
  assert.throws(() => reduceRecoveryEvent(next, { ...event, eventId: 'evt-stale', expectedStateVersion: 0, toolCallId: 'call-new' }), /stateVersion/)
  assert.throws(() => reduceRecoveryEvent(next, { ...event, eventId: 'evt-other-session', sessionId: 'other', expectedStateVersion: 1 }), /sessionId/)
})

test('reduceRecoveryEvent records tool results, failures, and explicit verification only for existing facts', () => {
  let state = createSessionRecoveryState({ sessionId: 'main-1', sessionKind: 'main', now: 1 })
  state = reduceRecoveryEvent(state, {
    type: 'runtime_tool_call',
    eventId: 'evt-call',
    sessionId: 'main-1',
    occurredAt: 2,
    expectedStateVersion: 0,
    toolCallId: 'call-1',
    toolName: 'read',
  })

  state = reduceRecoveryEvent(state, {
    type: 'runtime_tool_result',
    eventId: 'evt-result',
    sessionId: 'main-1',
    occurredAt: 3,
    expectedStateVersion: 1,
    toolCallId: 'call-1',
    toolName: 'read',
    success: true,
  })
  assert.equal(state.facts.claimed.length, 0)
  assert.equal(state.facts.executed[0]?.id, 'tool-call:call-1')
  assert.equal(state.facts.executed[0]?.verification, 'executed')
  assert.equal(state.facts.verified.length, 0)

  state = reduceRecoveryEvent(state, {
    type: 'verification',
    eventId: 'evt-verify',
    sessionId: 'main-1',
    occurredAt: 4,
    expectedStateVersion: 2,
    factId: 'tool-call:call-1',
    verified: true,
  })
  assert.equal(state.facts.verified[0]?.id, 'tool-call:call-1')
  assert.equal(state.facts.executed.length, 0)

  assert.throws(() => reduceRecoveryEvent(state, {
    type: 'verification',
    eventId: 'evt-unknown-verify',
    sessionId: 'main-1',
    occurredAt: 5,
    expectedStateVersion: 3,
    factId: 'missing-fact',
    verified: true,
  }), /Unknown fact/)
  assert.throws(() => reduceRecoveryEvent(state, {
    type: 'verification',
    eventId: 'evt-false-verify',
    sessionId: 'main-1',
    occurredAt: 5,
    expectedStateVersion: 3,
    factId: 'tool-call:call-1',
    verified: false,
  }), /verified=false/)

  assert.throws(() => reduceRecoveryEvent(state, {
    type: 'runtime_tool_result',
    eventId: 'evt-result-duplicate',
    sessionId: 'main-1',
    occurredAt: 5,
    expectedStateVersion: 3,
    toolCallId: 'call-1',
    toolName: 'read',
    success: true,
  }), /Unknown tool call/)

  state = reduceRecoveryEvent(state, {
    type: 'runtime_tool_call',
    eventId: 'evt-call-failed',
    sessionId: 'main-1',
    occurredAt: 5,
    expectedStateVersion: 3,
    toolCallId: 'call-2',
    toolName: 'write',
  })
  state = reduceRecoveryEvent(state, {
    type: 'runtime_tool_result',
    eventId: 'evt-result-failed',
    sessionId: 'main-1',
    occurredAt: 5,
    expectedStateVersion: 4,
    toolCallId: 'call-2',
    toolName: 'write',
    success: false,
  })
  assert.equal(state.facts.claimed.some(fact => fact.id === 'tool-call:call-2'), false)
  assert.equal(state.facts.executed.some(fact => fact.id === 'tool-call:call-2'), true)
  assert.equal(state.failures[0]?.id, 'tool-failure:call-2')
  assert.equal(state.next?.kind, 'tool')

  assert.throws(() => reduceRecoveryEvent(state, {
    type: 'runtime_tool_result',
    eventId: 'evt-result-missing',
    sessionId: 'main-1',
    occurredAt: 6,
    expectedStateVersion: 5,
    toolCallId: 'missing-call',
    toolName: 'read',
    success: true,
  }), /Unknown tool call/)
})

test('reduceRecoveryEvent handles failures, compaction boundaries, children, handoffs, provider sessions, and completion', () => {
  let state = createSessionRecoveryState({ sessionId: 'main-1', sessionKind: 'main', now: 1 })

  state = reduceRecoveryEvent(state, {
    type: 'failure',
    eventId: 'evt-failure',
    sessionId: 'main-1',
    occurredAt: 2,
    expectedStateVersion: 0,
    failureId: 'failure-1',
    recoverable: true,
  })
  assert.equal(state.failures[0]?.id, 'failure-1')
  assert.equal(state.next?.kind, 'verification')

  state = reduceRecoveryEvent(state, {
    type: 'compaction_boundary',
    eventId: 'evt-compact-1',
    sessionId: 'main-1',
    occurredAt: 3,
    expectedStateVersion: 1,
    compactionEpoch: 1,
    source: 'client',
  })
  state = reduceRecoveryEvent(state, {
    type: 'compaction_boundary',
    eventId: 'evt-compact-2',
    sessionId: 'main-1',
    occurredAt: 4,
    expectedStateVersion: 2,
    compactionEpoch: 1,
    source: 'server',
  })
  assert.equal(state.compactionEpoch, 1)
  assert.equal(state.facts.claimed.filter(fact => fact.id.startsWith('compaction:')).length, 2)
  assert.throws(() => reduceRecoveryEvent(state, {
    type: 'compaction_boundary',
    eventId: 'evt-compact-back',
    sessionId: 'main-1',
    occurredAt: 5,
    expectedStateVersion: 3,
    compactionEpoch: 0,
    source: 'server',
  }), /compactionEpoch/)

  state = reduceRecoveryEvent(state, {
    type: 'child_create',
    eventId: 'evt-child-create',
    sessionId: 'main-1',
    occurredAt: 5,
    expectedStateVersion: 3,
    childSessionId: 'child-1',
    childKind: 'tool_child',
    toolCallId: 'call-child',
    providerSessionId: 'provider-child',
  })
  assert.equal(state.lifecycle, 'waiting_for_child')
  assert.equal(state.children.pending[0]?.sessionId, 'child-1')
  assert.equal(state.children.pending[0]?.toolCallId, 'call-child')
  assert.equal(reduceRecoveryEvent(state, { ...{
    type: 'child_create',
    eventId: 'evt-child-create',
    sessionId: 'main-1',
    occurredAt: 5,
    expectedStateVersion: 999,
    childSessionId: 'child-1',
    childKind: 'tool_child',
  } as RecoveryEvent }), state)

  state = reduceRecoveryEvent(state, {
    type: 'child_complete',
    eventId: 'evt-child-complete',
    sessionId: 'main-1',
    occurredAt: 6,
    expectedStateVersion: 4,
    childSessionId: 'child-1',
  })
  assert.equal(state.children.pending.length, 0)
  assert.equal(state.children.completed[0]?.sessionId, 'child-1')
  assert.throws(() => reduceRecoveryEvent(state, {
    type: 'child_complete',
    eventId: 'evt-child-missing',
    sessionId: 'main-1',
    occurredAt: 7,
    expectedStateVersion: 5,
    childSessionId: 'missing-child',
  }), /Unknown child/)

  state = reduceRecoveryEvent(state, {
    type: 'handoff_create',
    eventId: 'evt-handoff-create',
    sessionId: 'main-1',
    occurredAt: 7,
    expectedStateVersion: 5,
    handoffId: 'handoff-1',
    fromSessionId: 'child-1',
    toSessionId: 'main-1',
    childKind: 'tool_child',
    verifiedFactIds: ['fact-1'],
    artifactIds: ['artifact-1'],
    failureIds: ['failure-1'],
    pendingWorkIds: ['work-1'],
  })
  assert.equal(state.handoffs.created[0]?.fromSessionId, 'child-1')

  state = reduceRecoveryEvent(state, {
    type: 'handoff_consume',
    eventId: 'evt-handoff-consume',
    sessionId: 'main-1',
    occurredAt: 8,
    expectedStateVersion: 6,
    handoffId: 'handoff-1',
    fromSessionId: 'child-1',
  })
  assert.equal(state.handoffs.created.length, 0)
  assert.equal(state.handoffs.consumed[0]?.status, 'consumed')
  assert.throws(() => reduceRecoveryEvent(state, {
    type: 'handoff_consume',
    eventId: 'evt-handoff-consume-again',
    sessionId: 'main-1',
    occurredAt: 9,
    expectedStateVersion: 7,
    handoffId: 'handoff-1',
    fromSessionId: 'child-1',
  }), /already consumed/)
  assert.throws(() => reduceRecoveryEvent(state, {
    type: 'handoff_consume',
    eventId: 'evt-handoff-missing',
    sessionId: 'main-1',
    occurredAt: 9,
    expectedStateVersion: 7,
    handoffId: 'missing-handoff',
    fromSessionId: 'child-1',
  }), /Unknown handoff/)

  state = reduceRecoveryEvent(state, {
    type: 'provider_session_change',
    eventId: 'evt-provider',
    sessionId: 'main-1',
    occurredAt: 9,
    expectedStateVersion: 7,
    previousProviderSessionId: 'provider-old',
    nextProviderSessionId: 'provider-new',
  })
  assert.equal(state.node.providerSessionId, 'provider-new')
  assert.ok(state.facts.claimed.some(fact => fact.id === 'provider-session:evt-provider'))

  state = reduceRecoveryEvent(state, {
    type: 'task_complete',
    eventId: 'evt-complete',
    sessionId: 'main-1',
    occurredAt: 10,
    expectedStateVersion: 8,
    result: 'success',
  })
  assert.equal(state.lifecycle, 'completed')
  assert.equal(state.next?.kind, 'none')
})

test('reduceRecoveryEvent keeps reducer-created fields bounded', () => {
  let state = createSessionRecoveryState({ sessionId: 'bounds-reducer', sessionKind: 'main', now: 1 })

  for (let index = 0; index < 80; index++) {
    state = reduceRecoveryEvent(state, {
      type: 'runtime_tool_call',
      eventId: `evt-${index}`,
      sessionId: 'bounds-reducer',
      occurredAt: index + 2,
      expectedStateVersion: index,
      toolCallId: `call-${index}`,
      toolName: 'x'.repeat(2000),
    })
  }

  assert.equal(state.facts.claimed.length, 50)
  assert.equal(state.appliedEventIds.length, 50)
  assert.equal(state.facts.claimed[0]?.id, 'tool-call:call-30')
  assert.equal(state.facts.claimed.at(-1)?.text.length, 1000)
})

test('reduceRecoveryEvent keeps long-run idempotency after appliedEventIds are bounded', () => {
  let state = createSessionRecoveryState({ sessionId: 'long-idempotency', sessionKind: 'main', now: 1 })

  state = reduceRecoveryEvent(state, {
    type: 'runtime_tool_call',
    eventId: 'evt-first-call',
    sessionId: 'long-idempotency',
    occurredAt: 2,
    expectedStateVersion: 0,
    toolCallId: 'call-first',
    toolName: 'read',
  })

  for (let index = 0; index < 60; index++) {
    state = reduceRecoveryEvent(state, {
      type: 'failure',
      eventId: `evt-filler-${index}`,
      sessionId: 'long-idempotency',
      occurredAt: index + 3,
      expectedStateVersion: index + 1,
      failureId: `failure-${index}`,
      recoverable: true,
    })
  }

  assert.equal(state.appliedEventIds.includes('evt-first-call'), false)
  const beforeReplay = state
  const replayed = reduceRecoveryEvent(state, {
    type: 'runtime_tool_call',
    eventId: 'evt-first-call',
    sessionId: 'long-idempotency',
    occurredAt: 100,
    expectedStateVersion: 0,
    toolCallId: 'call-first',
    toolName: 'read',
  })

  assert.equal(replayed, beforeReplay)
  assert.equal(replayed.stateVersion, beforeReplay.stateVersion)
  assert.equal(replayed.facts.claimed.filter(fact => fact.id === 'tool-call:call-first').length, 1)

  const advanced = reduceRecoveryEvent(replayed, {
    type: 'runtime_tool_call',
    eventId: 'evt-new-call',
    sessionId: 'long-idempotency',
    occurredAt: 101,
    expectedStateVersion: replayed.stateVersion,
    toolCallId: 'call-new',
    toolName: 'write',
  })
  assert.equal(advanced.stateVersion, replayed.stateVersion + 1)
  assert.ok(advanced.facts.claimed.some(fact => fact.id === 'tool-call:call-new'))
})

test('reduceRecoveryEvent keeps handoff and tool result exactly-once after receipt eviction', () => {
  let state = createSessionRecoveryState({ sessionId: 'long-handoff', sessionKind: 'main', now: 1 })
  state = reduceRecoveryEvent(state, {
    type: 'child_create',
    eventId: 'evt-child-create',
    sessionId: 'long-handoff',
    occurredAt: 2,
    expectedStateVersion: 0,
    childSessionId: 'child-1',
    childKind: 'tool_child',
  })
  state = reduceRecoveryEvent(state, {
    type: 'child_complete',
    eventId: 'evt-child-complete',
    sessionId: 'long-handoff',
    occurredAt: 3,
    expectedStateVersion: 1,
    childSessionId: 'child-1',
  })
  state = reduceRecoveryEvent(state, {
    type: 'handoff_create',
    eventId: 'evt-handoff-create',
    sessionId: 'long-handoff',
    occurredAt: 4,
    expectedStateVersion: 2,
    handoffId: 'handoff-1',
    fromSessionId: 'child-1',
    toSessionId: 'long-handoff',
    childKind: 'tool_child',
  })
  state = reduceRecoveryEvent(state, {
    type: 'handoff_consume',
    eventId: 'evt-handoff-consume',
    sessionId: 'long-handoff',
    occurredAt: 5,
    expectedStateVersion: 3,
    handoffId: 'handoff-1',
    fromSessionId: 'child-1',
  })
  state = reduceRecoveryEvent(state, {
    type: 'runtime_tool_call',
    eventId: 'evt-tool-call',
    sessionId: 'long-handoff',
    occurredAt: 6,
    expectedStateVersion: 4,
    toolCallId: 'call-1',
    toolName: 'read',
  })
  state = reduceRecoveryEvent(state, {
    type: 'runtime_tool_result',
    eventId: 'evt-tool-result',
    sessionId: 'long-handoff',
    occurredAt: 7,
    expectedStateVersion: 5,
    toolCallId: 'call-1',
    toolName: 'read',
    success: true,
  })

  for (let index = 0; index < 60; index++) {
    state = reduceRecoveryEvent(state, {
      type: 'failure',
      eventId: `evt-padding-${index}`,
      sessionId: 'long-handoff',
      occurredAt: index + 8,
      expectedStateVersion: index + 6,
      failureId: `padding-failure-${index}`,
      recoverable: true,
    })
  }

  const beforeReplay = state
  assert.equal(state.appliedEventIds.includes('evt-handoff-consume'), false)
  assert.equal(state.appliedEventIds.includes('evt-tool-result'), false)

  assert.equal(reduceRecoveryEvent(state, {
    type: 'handoff_consume',
    eventId: 'evt-handoff-consume',
    sessionId: 'long-handoff',
    occurredAt: 100,
    expectedStateVersion: 3,
    handoffId: 'handoff-1',
    fromSessionId: 'child-1',
  }), beforeReplay)

  assert.equal(reduceRecoveryEvent(state, {
    type: 'runtime_tool_result',
    eventId: 'evt-tool-result',
    sessionId: 'long-handoff',
    occurredAt: 101,
    expectedStateVersion: 5,
    toolCallId: 'call-1',
    toolName: 'read',
    success: true,
  }), beforeReplay)
  assert.equal(beforeReplay.facts.executed.filter(fact => fact.id === 'tool-call:call-1').length, 1)
  assert.equal(beforeReplay.handoffs.consumed.filter(handoff => handoff.handoffId === 'handoff-1').length, 1)
})

test('renderRecoveryContextForProvider projects bounded structured main and child recovery state', () => {
  const main = {
    ...createSessionRecoveryState({ sessionId: 'main-recovery', sessionKind: 'main', now: 1 }),
    facts: {
      claimed: [],
      executed: [],
      verified: Array.from({ length: 12 }, (_, index) => ({
        id: `fact-${index}`,
        text: `Verified runtime fact ${index}`,
        source: 'verification_event' as const,
        verification: 'verified' as const,
        createdAt: index,
      })),
    },
    constraints: [{
      id: 'constraint-1',
      text: 'Runtime constraint wins over narrative summary.',
      source: 'runtime' as const,
      createdAt: 1,
    }],
    next: { kind: 'tool' as const, description: 'Run focused projection test.', toolName: 'node' },
  }
  const toolChild = createSessionRecoveryState({
    sessionId: 'tool-child-recovery',
    parentSessionId: 'main-recovery',
    sessionKind: 'tool_child',
    toolCallId: 'call_read',
    now: 1,
  })
  const subagentChild = createSessionRecoveryState({
    sessionId: 'subagent-child-recovery',
    parentSessionId: 'main-recovery',
    sessionKind: 'subagent_child',
    now: 1,
  })

  const mainText = renderRecoveryContextForProvider(main)
  assert.match(mainText ?? '', /Session recovery context/)
  assert.match(mainText ?? '', /main-recovery \(main\)/)
  assert.match(mainText ?? '', /Runtime constraint wins/)
  assert.match(mainText ?? '', /Run focused projection test/)
  assert.doesNotMatch(mainText ?? '', /fact-0/)
  assert.match(mainText ?? '', /fact-11/)
  assert.ok((mainText ?? '').length <= 3000)
  assert.match(renderRecoveryContextForProvider(toolChild) ?? '', /tool-child-recovery \(tool_child\)/)
  assert.match(renderRecoveryContextForProvider(subagentChild) ?? '', /subagent-child-recovery \(subagent_child\)/)
})
