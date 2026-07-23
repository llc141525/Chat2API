export const SESSION_RECOVERY_SCHEMA = 'chat2api.sessionRecoveryState' as const
export const SESSION_RECOVERY_STATE_VERSION = 1 as const

const MAX_LIST_ITEMS = 50
const MAX_TEXT_LENGTH = 1000

export type SessionKind = 'main' | 'tool_child' | 'subagent_child'
export type SessionLifecycle = 'active' | 'waiting_for_child' | 'completed' | 'failed' | 'abandoned'
export type FactVerification = 'claimed' | 'executed' | 'verified'
export type FactSource =
  | 'model_summary'
  | 'assistant_message'
  | 'runtime_tool_call'
  | 'runtime_tool_result'
  | 'verification_event'
  | 'handoff'
  | 'migration'

export interface RecoveryFact {
  id: string
  text: string
  source: FactSource
  verification: FactVerification
  createdAt: number
  evidence?: string
}

export interface PendingWorkItem {
  id: string
  text: string
  status: 'pending' | 'in_progress' | 'blocked'
  createdAt: number
  updatedAt: number
}

export interface RecoveryFailure {
  id: string
  text: string
  source: string
  createdAt: number
  recoverable: boolean
}

export interface RecoveryDecision {
  id: string
  text: string
  reason?: string
  createdAt: number
}

export interface RecoveryConstraint {
  id: string
  text: string
  source: 'user' | 'system' | 'developer' | 'runtime' | 'migration'
  createdAt: number
}

export interface RecoveryArtifact {
  id: string
  kind: 'file' | 'command' | 'url' | 'log' | 'diff' | 'other'
  ref: string
  description?: string
  createdAt: number
}

export interface RecoveryNextAction {
  kind: 'message' | 'tool' | 'verification' | 'handoff' | 'none'
  description: string
  toolName?: string
  toolCallId?: string
}

export interface SessionNode {
  sessionId: string
  parentSessionId: string | null
  sessionKind: SessionKind
  providerSessionId?: string
  toolCallId?: string
  createdAt: number
  completedAt: number | null
}

export interface TypedSessionHandoff {
  handoffId: string
  fromSessionId: string
  toSessionId: string
  childKind: Exclude<SessionKind, 'main'>
  status: 'created' | 'consumed'
  createdAt: number
  consumedAt: number | null
  verifiedFactIds: string[]
  artifactIds: string[]
  failureIds: string[]
  pendingWorkIds: string[]
}

export interface SessionRecoveryState {
  schema: typeof SESSION_RECOVERY_SCHEMA
  version: typeof SESSION_RECOVERY_STATE_VERSION
  sessionId: string
  parentSessionId: string | null
  sessionKind: SessionKind
  stateVersion: number
  compactionEpoch: number
  lifecycle: SessionLifecycle
  node: SessionNode
  children: {
    pending: SessionNode[]
    completed: SessionNode[]
  }
  facts: {
    claimed: RecoveryFact[]
    executed: RecoveryFact[]
    verified: RecoveryFact[]
  }
  pendingWork: PendingWorkItem[]
  failures: RecoveryFailure[]
  decisions: RecoveryDecision[]
  constraints: RecoveryConstraint[]
  artifacts: RecoveryArtifact[]
  next: RecoveryNextAction | null
  handoffs: {
    created: TypedSessionHandoff[]
    consumed: TypedSessionHandoff[]
  }
  appliedEventIds: string[]
  createdAt: number
  updatedAt: number
}

export type RecoveryEvent =
  | RecoveryEventBase<'runtime_tool_call'> & { toolCallId: string; toolName: string; description?: string }
  | RecoveryEventBase<'runtime_tool_result'> & { toolCallId: string; toolName?: string; success: boolean; description?: string }
  | RecoveryEventBase<'verification'> & { factId: string; verified: boolean }
  | RecoveryEventBase<'failure'> & { failureId: string; recoverable: boolean }
  | RecoveryEventBase<'compaction_boundary'> & { compactionEpoch: number; source: 'client' | 'server' | 'local_fallback' | 'child_handoff' }
  | RecoveryEventBase<'child_create'> & { childSessionId: string; childKind: Exclude<SessionKind, 'main'>; toolCallId?: string; providerSessionId?: string }
  | RecoveryEventBase<'child_complete'> & { childSessionId: string; handoffId?: string }
  | RecoveryEventBase<'handoff_create'> & {
      handoffId: string
      fromSessionId: string
      toSessionId: string
      childKind: Exclude<SessionKind, 'main'>
      verifiedFactIds?: string[]
      artifactIds?: string[]
      failureIds?: string[]
      pendingWorkIds?: string[]
    }
  | RecoveryEventBase<'handoff_consume'> & { handoffId: string; fromSessionId: string }
  | RecoveryEventBase<'provider_session_change'> & { previousProviderSessionId?: string; nextProviderSessionId?: string }
  | RecoveryEventBase<'task_complete'> & { result?: 'success' | 'failure' }

interface RecoveryEventBase<T extends string> {
  type: T
  eventId: string
  sessionId: string
  occurredAt: number
  expectedStateVersion: number
}

interface CreateStateInput {
  sessionId: string
  parentSessionId?: string | null
  sessionKind: SessionKind
  providerSessionId?: string
  toolCallId?: string
  now?: number
}

interface CreateHandoffInput {
  handoffId: string
  fromSessionId: string
  toSessionId: string
  childKind: Exclude<SessionKind, 'main'>
  createdAt?: number
  verifiedFactIds?: string[]
  artifactIds?: string[]
  failureIds?: string[]
  pendingWorkIds?: string[]
}

export function createSessionRecoveryState(input: CreateStateInput): SessionRecoveryState {
  const now = input.now ?? Date.now()
  assertNonEmptyString(input.sessionId, 'sessionId')
  assertSessionKind(input.sessionKind)
  const parentSessionId = input.parentSessionId ?? null
  if (input.sessionKind !== 'main') assertNonEmptyString(parentSessionId, 'parentSessionId')

  const node: SessionNode = {
    sessionId: input.sessionId,
    parentSessionId,
    sessionKind: input.sessionKind,
    providerSessionId: input.providerSessionId,
    toolCallId: input.toolCallId,
    createdAt: now,
    completedAt: null,
  }

  return {
    schema: SESSION_RECOVERY_SCHEMA,
    version: SESSION_RECOVERY_STATE_VERSION,
    sessionId: input.sessionId,
    parentSessionId,
    sessionKind: input.sessionKind,
    stateVersion: 0,
    compactionEpoch: 0,
    lifecycle: 'active',
    node,
    children: { pending: [], completed: [] },
    facts: { claimed: [], executed: [], verified: [] },
    pendingWork: [],
    failures: [],
    decisions: [],
    constraints: [],
    artifacts: [],
    next: null,
    handoffs: { created: [], consumed: [] },
    appliedEventIds: [],
    createdAt: now,
    updatedAt: now,
  }
}

export function createTypedSessionHandoff(input: CreateHandoffInput): TypedSessionHandoff {
  assertNonEmptyString(input.handoffId, 'handoffId')
  assertNonEmptyString(input.fromSessionId, 'fromSessionId')
  assertNonEmptyString(input.toSessionId, 'toSessionId')
  assertChildSessionKind(input.childKind, 'childKind')

  return {
    handoffId: input.handoffId,
    fromSessionId: input.fromSessionId,
    toSessionId: input.toSessionId,
    childKind: input.childKind,
    status: 'created',
    createdAt: input.createdAt ?? Date.now(),
    consumedAt: null,
    verifiedFactIds: boundStringList(input.verifiedFactIds),
    artifactIds: boundStringList(input.artifactIds),
    failureIds: boundStringList(input.failureIds),
    pendingWorkIds: boundStringList(input.pendingWorkIds),
  }
}

export function serializeSessionRecoveryState(state: SessionRecoveryState): string {
  return JSON.stringify(normalizeState(state))
}

export function deserializeSessionRecoveryState(value: unknown): SessionRecoveryState {
  const raw = typeof value === 'string' ? JSON.parse(value) : value
  return normalizeState(raw)
}

export function assertValidRecoveryEvent(event: RecoveryEvent): void {
  if (!isRecord(event)) throw new Error('RecoveryEvent must be an object')
  assertNonEmptyString(event.eventId, 'eventId')
  assertNonEmptyString(event.sessionId, 'sessionId')
  assertNonNegativeNumber(event.occurredAt, 'occurredAt')
  assertNonNegativeInteger(event.expectedStateVersion, 'expectedStateVersion')

  const allowedTypes = new Set<RecoveryEvent['type']>([
    'runtime_tool_call',
    'runtime_tool_result',
    'verification',
    'failure',
    'compaction_boundary',
    'child_create',
    'child_complete',
    'handoff_create',
    'handoff_consume',
    'provider_session_change',
    'task_complete',
  ])
  if (!allowedTypes.has(event.type)) throw new Error(`Unsupported recovery event type: ${String(event.type)}`)

  switch (event.type) {
    case 'runtime_tool_call':
      assertNonEmptyString(event.toolCallId, 'toolCallId')
      assertNonEmptyString(event.toolName, 'toolName')
      break
    case 'runtime_tool_result':
      assertNonEmptyString(event.toolCallId, 'toolCallId')
      assertBoolean(event.success, 'success')
      break
    case 'verification':
      assertNonEmptyString(event.factId, 'factId')
      assertBoolean(event.verified, 'verified')
      break
    case 'failure':
      assertNonEmptyString(event.failureId, 'failureId')
      assertBoolean(event.recoverable, 'recoverable')
      break
    case 'compaction_boundary':
      assertNonNegativeInteger(event.compactionEpoch, 'compactionEpoch')
      assertCompactionBoundarySource(event.source)
      break
    case 'child_create':
      assertNonEmptyString(event.childSessionId, 'childSessionId')
      assertChildSessionKind(event.childKind, 'childKind')
      break
    case 'child_complete':
      assertNonEmptyString(event.childSessionId, 'childSessionId')
      break
    case 'handoff_create':
      assertNonEmptyString(event.handoffId, 'handoffId')
      assertNonEmptyString(event.fromSessionId, 'fromSessionId')
      assertNonEmptyString(event.toSessionId, 'toSessionId')
      assertChildSessionKind(event.childKind, 'childKind')
      break
    case 'handoff_consume':
      assertNonEmptyString(event.handoffId, 'handoffId')
      assertNonEmptyString(event.fromSessionId, 'fromSessionId')
      break
    case 'provider_session_change':
      assertProviderSessionChange(event.previousProviderSessionId, event.nextProviderSessionId)
      break
    case 'task_complete':
      assertTaskCompleteResult(event.result)
      break
  }
}

export function reduceRecoveryEvent(state: SessionRecoveryState, event: RecoveryEvent): SessionRecoveryState {
  assertValidRecoveryEvent(event)
  if (event.sessionId !== state.sessionId) throw new Error(`RecoveryEvent sessionId ${event.sessionId} does not match state sessionId ${state.sessionId}`)
  if (state.appliedEventIds.includes(event.eventId)) return state
  if (event.expectedStateVersion !== state.stateVersion) {
    if (isDomainDuplicateEvent(state, event)) return state
    throw new Error(`RecoveryEvent stateVersion conflict: expected ${event.expectedStateVersion}, current ${state.stateVersion}`)
  }

  const reduced = applyRecoveryEvent(state, event)
  return normalizeState({
    ...reduced,
    stateVersion: state.stateVersion + 1,
    appliedEventIds: [...state.appliedEventIds, event.eventId],
    updatedAt: event.occurredAt,
  })
}

function isDomainDuplicateEvent(state: SessionRecoveryState, event: RecoveryEvent): boolean {
  switch (event.type) {
    case 'runtime_tool_call':
      return hasFact(state, `tool-call:${event.toolCallId}`)
    case 'runtime_tool_result':
      return state.facts.executed.some(fact => fact.id === `tool-call:${event.toolCallId}`)
        || state.facts.verified.some(fact => fact.id === `tool-call:${event.toolCallId}`)
    case 'verification':
      return event.verified && state.facts.verified.some(fact => fact.id === event.factId)
    case 'failure':
      return state.failures.some(failure => failure.id === event.failureId)
    case 'compaction_boundary':
      return state.facts.claimed.some(fact => fact.id === `compaction:${event.eventId}`)
    case 'child_create':
      return state.children.pending.some(child => child.sessionId === event.childSessionId)
        || state.children.completed.some(child => child.sessionId === event.childSessionId)
    case 'child_complete':
      return state.children.completed.some(child => child.sessionId === event.childSessionId)
    case 'handoff_create':
      return state.handoffs.created.some(handoff => handoff.handoffId === event.handoffId)
        || state.handoffs.consumed.some(handoff => handoff.handoffId === event.handoffId)
    case 'handoff_consume':
      return state.handoffs.consumed.some(handoff =>
        handoff.handoffId === event.handoffId && handoff.fromSessionId === event.fromSessionId
      )
    case 'provider_session_change':
      return state.facts.claimed.some(fact => fact.id === `provider-session:${event.eventId}`)
    case 'task_complete':
      return state.lifecycle === (event.result === 'failure' ? 'failed' : 'completed')
        && state.node.completedAt !== null
  }
}

function hasFact(state: SessionRecoveryState, factId: string): boolean {
  return state.facts.claimed.some(fact => fact.id === factId)
    || state.facts.executed.some(fact => fact.id === factId)
    || state.facts.verified.some(fact => fact.id === factId)
}

function applyRecoveryEvent(state: SessionRecoveryState, event: RecoveryEvent): SessionRecoveryState {
  switch (event.type) {
    case 'runtime_tool_call': {
      const fact = makeFact({
        id: `tool-call:${event.toolCallId}`,
        text: event.description ?? `Runtime tool call ${event.toolName} started for ${event.toolCallId}`,
        source: 'runtime_tool_call',
        verification: 'claimed',
        createdAt: event.occurredAt,
      })
      return {
        ...state,
        facts: { ...state.facts, claimed: upsertById(state.facts.claimed, fact) },
        next: {
          kind: 'tool',
          description: `Run tool ${event.toolName} for call ${event.toolCallId}`,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
        },
      }
    }
    case 'runtime_tool_result': {
      const factId = `tool-call:${event.toolCallId}`
      const claimedFact = state.facts.claimed.find(fact => fact.id === factId)
      if (!claimedFact) throw new Error(`Unknown tool call ${event.toolCallId}`)
      const executedFact = makeFact({
        id: factId,
        text: event.description ?? `Runtime tool ${event.toolName ?? 'unknown'} ${event.success ? 'succeeded' : 'failed'} for ${event.toolCallId}`,
        source: 'runtime_tool_result',
        verification: 'executed',
        createdAt: event.occurredAt,
      })
      const failure = makeFailure({
        id: `tool-failure:${event.toolCallId}`,
        text: event.description ?? `Runtime tool ${event.toolName ?? 'unknown'} failed for ${event.toolCallId}`,
        source: 'runtime_tool_result',
        createdAt: event.occurredAt,
        recoverable: true,
      })
      return {
        ...state,
        facts: {
          ...state.facts,
          claimed: state.facts.claimed.filter(fact => fact.id !== factId),
          executed: upsertById(state.facts.executed, executedFact),
        },
        failures: event.success ? state.failures : upsertById(state.failures, failure),
        next: event.success
          ? { kind: 'verification', description: `Verify result from tool call ${event.toolCallId}`, toolCallId: event.toolCallId }
          : { kind: 'tool', description: `Recover failed tool call ${event.toolCallId}`, toolName: event.toolName, toolCallId: event.toolCallId },
      }
    }
    case 'verification': {
      if (!event.verified) throw new Error('verification event with verified=false does not promote facts')
      const claimed = state.facts.claimed.find(fact => fact.id === event.factId)
      const executed = state.facts.executed.find(fact => fact.id === event.factId)
      const sourceFact = claimed ?? executed
      if (!sourceFact) {
        if (state.facts.verified.some(fact => fact.id === event.factId)) throw new Error(`Fact ${event.factId} is already verified`)
        throw new Error(`Unknown fact ${event.factId}`)
      }
      const verifiedFact = makeFact({
        ...sourceFact,
        source: 'verification_event',
        verification: 'verified',
        createdAt: event.occurredAt,
      })
      return {
        ...state,
        facts: {
          claimed: state.facts.claimed.filter(fact => fact.id !== event.factId),
          executed: state.facts.executed.filter(fact => fact.id !== event.factId),
          verified: upsertById(state.facts.verified, verifiedFact),
        },
        next: { kind: 'message', description: `Continue after verifying ${event.factId}` },
      }
    }
    case 'failure': {
      const failure = makeFailure({
        id: event.failureId,
        text: `Failure ${event.failureId}`,
        source: 'failure_event',
        createdAt: event.occurredAt,
        recoverable: event.recoverable,
      })
      return {
        ...state,
        lifecycle: event.recoverable ? state.lifecycle : 'failed',
        failures: upsertById(state.failures, failure),
        next: event.recoverable
          ? { kind: 'verification', description: `Recover or verify failure ${event.failureId}` }
          : { kind: 'none', description: `Task failed at ${event.failureId}` },
      }
    }
    case 'compaction_boundary': {
      if (event.compactionEpoch < state.compactionEpoch) throw new Error('compactionEpoch cannot move backward')
      const fact = makeFact({
        id: `compaction:${event.eventId}`,
        text: `Compaction boundary ${event.compactionEpoch} from ${event.source}`,
        source: 'runtime_tool_call',
        verification: 'claimed',
        createdAt: event.occurredAt,
      })
      return {
        ...state,
        compactionEpoch: event.compactionEpoch,
        facts: { ...state.facts, claimed: upsertById(state.facts.claimed, fact) },
      }
    }
    case 'child_create': {
      if (state.children.pending.some(child => child.sessionId === event.childSessionId) || state.children.completed.some(child => child.sessionId === event.childSessionId)) {
        throw new Error(`Child ${event.childSessionId} already exists`)
      }
      const child: SessionNode = {
        sessionId: event.childSessionId,
        parentSessionId: state.sessionId,
        sessionKind: event.childKind,
        providerSessionId: event.providerSessionId,
        toolCallId: event.toolCallId,
        createdAt: event.occurredAt,
        completedAt: null,
      }
      return {
        ...state,
        lifecycle: 'waiting_for_child',
        children: { ...state.children, pending: [...state.children.pending, child] },
        next: { kind: 'handoff', description: `Wait for child session ${event.childSessionId}` },
      }
    }
    case 'child_complete': {
      const pendingChild = state.children.pending.find(child => child.sessionId === event.childSessionId)
      if (!pendingChild) {
        if (state.children.completed.some(child => child.sessionId === event.childSessionId)) throw new Error(`Child ${event.childSessionId} already completed`)
        throw new Error(`Unknown child ${event.childSessionId}`)
      }
      const completedChild = { ...pendingChild, completedAt: event.occurredAt }
      return {
        ...state,
        lifecycle: 'active',
        children: {
          pending: state.children.pending.filter(child => child.sessionId !== event.childSessionId),
          completed: upsertBySessionId(state.children.completed, completedChild),
        },
        next: { kind: 'handoff', description: `Consume handoff from child session ${event.childSessionId}` },
      }
    }
    case 'handoff_create': {
      if (state.handoffs.created.some(handoff => handoff.handoffId === event.handoffId) || state.handoffs.consumed.some(handoff => handoff.handoffId === event.handoffId)) {
        throw new Error(`Handoff ${event.handoffId} already exists`)
      }
      const handoff = createTypedSessionHandoff({
        handoffId: event.handoffId,
        fromSessionId: event.fromSessionId,
        toSessionId: event.toSessionId,
        childKind: event.childKind,
        createdAt: event.occurredAt,
        verifiedFactIds: event.verifiedFactIds,
        artifactIds: event.artifactIds,
        failureIds: event.failureIds,
        pendingWorkIds: event.pendingWorkIds,
      })
      return {
        ...state,
        handoffs: { ...state.handoffs, created: [...state.handoffs.created, handoff] },
        next: { kind: 'handoff', description: `Consume handoff ${event.handoffId}` },
      }
    }
    case 'handoff_consume': {
      const handoff = state.handoffs.created.find(item => item.handoffId === event.handoffId)
      if (!handoff) {
        if (state.handoffs.consumed.some(item => item.handoffId === event.handoffId)) throw new Error(`Handoff ${event.handoffId} already consumed`)
        throw new Error(`Unknown handoff ${event.handoffId}`)
      }
      if (handoff.fromSessionId !== event.fromSessionId) throw new Error(`Handoff ${event.handoffId} fromSessionId mismatch`)
      const consumed: TypedSessionHandoff = { ...handoff, status: 'consumed', consumedAt: event.occurredAt }
      return {
        ...state,
        handoffs: {
          created: state.handoffs.created.filter(item => item.handoffId !== event.handoffId),
          consumed: upsertByHandoffId(state.handoffs.consumed, consumed),
        },
        next: { kind: 'message', description: `Continue after handoff ${event.handoffId}` },
      }
    }
    case 'provider_session_change': {
      const fact = makeFact({
        id: `provider-session:${event.eventId}`,
        text: `Provider session changed from ${event.previousProviderSessionId ?? 'none'} to ${event.nextProviderSessionId ?? 'none'}`,
        source: 'runtime_tool_call',
        verification: 'claimed',
        createdAt: event.occurredAt,
      })
      return {
        ...state,
        node: { ...state.node, providerSessionId: event.nextProviderSessionId ?? state.node.providerSessionId },
        facts: { ...state.facts, claimed: upsertById(state.facts.claimed, fact) },
      }
    }
    case 'task_complete':
      return {
        ...state,
        lifecycle: event.result === 'failure' ? 'failed' : 'completed',
        node: { ...state.node, completedAt: event.occurredAt },
        next: { kind: 'none', description: event.result === 'failure' ? 'Task completed with failure' : 'Task complete' },
      }
  }
}

function normalizeState(value: unknown): SessionRecoveryState {
  if (!isRecord(value)) throw new Error('SessionRecoveryState must be an object')
  assertNonEmptyString(value.sessionId, 'sessionId')
  const sessionKind = typeof value.sessionKind === 'string' ? value.sessionKind : 'main'
  assertSessionKind(sessionKind)
  const createdAt = nonNegativeNumberOr(value.createdAt, Date.now())
  const base = createSessionRecoveryState({
    sessionId: value.sessionId,
    parentSessionId: typeof value.parentSessionId === 'string' ? value.parentSessionId : null,
    sessionKind,
    now: createdAt,
  })

  const node = isRecord(value.node) ? normalizeNode(value.node, base.node) : base.node
  return {
    ...base,
    stateVersion: nonNegativeIntegerOr(value.stateVersion, 0),
    compactionEpoch: nonNegativeIntegerOr(value.compactionEpoch, 0),
    lifecycle: normalizeLifecycle(value.lifecycle),
    node,
    children: {
      pending: boundList(value.children && isRecord(value.children) ? value.children.pending : [], item => normalizeNode(item, base.node)),
      completed: boundList(value.children && isRecord(value.children) ? value.children.completed : [], item => normalizeNode(item, base.node)),
    },
    facts: normalizeFacts(value.facts),
    pendingWork: boundList(value.pendingWork, normalizePendingWork),
    failures: boundList(value.failures, normalizeFailure),
    decisions: boundList(value.decisions, normalizeDecision),
    constraints: boundList(value.constraints, normalizeConstraint),
    artifacts: boundList(value.artifacts, normalizeArtifact),
    next: normalizeNext(value.next),
    handoffs: {
      created: boundList(value.handoffs && isRecord(value.handoffs) ? value.handoffs.created : [], normalizeHandoff),
      consumed: boundList(value.handoffs && isRecord(value.handoffs) ? value.handoffs.consumed : [], normalizeHandoff),
    },
    appliedEventIds: boundStringList(value.appliedEventIds),
    updatedAt: nonNegativeNumberOr(value.updatedAt, createdAt),
  }
}

function normalizeFacts(value: unknown): SessionRecoveryState['facts'] {
  const raw = isRecord(value) ? value : {}
  const claimed = [
    ...boundList(raw.claimed, item => normalizeFact(item, 'claimed')),
    ...boundList(raw.verified, item => normalizeFact(item, 'claimed')).filter(fact => fact.source === 'model_summary'),
  ]
  const executed = boundList(raw.executed, item => normalizeFact(item, 'executed'))
  const verified = boundList(raw.verified, item => normalizeFact(item, 'verified')).filter(fact =>
    fact.source === 'runtime_tool_result' || fact.source === 'verification_event' || fact.source === 'handoff'
  )
  return {
    claimed: claimed.slice(-MAX_LIST_ITEMS),
    executed,
    verified,
  }
}

function normalizeFact(value: unknown, verification: FactVerification): RecoveryFact {
  if (!isRecord(value)) throw new Error('fact must be an object')
  assertNonEmptyString(value.id, 'fact.id')
  return {
    id: value.id,
    text: truncate(stringOr(value.text, '')),
    source: normalizeFactSource(value.source),
    verification,
    createdAt: nonNegativeNumberOr(value.createdAt, 0),
    evidence: optionalTruncatedString(value.evidence),
  }
}

function normalizePendingWork(value: unknown): PendingWorkItem {
  if (!isRecord(value)) throw new Error('pendingWork item must be an object')
  assertNonEmptyString(value.id, 'pendingWork.id')
  return {
    id: value.id,
    text: truncate(stringOr(value.text, '')),
    status: value.status === 'in_progress' || value.status === 'blocked' ? value.status : 'pending',
    createdAt: nonNegativeNumberOr(value.createdAt, 0),
    updatedAt: nonNegativeNumberOr(value.updatedAt, nonNegativeNumberOr(value.createdAt, 0)),
  }
}

function normalizeFailure(value: unknown): RecoveryFailure {
  if (!isRecord(value)) throw new Error('failure must be an object')
  assertNonEmptyString(value.id, 'failure.id')
  return {
    id: value.id,
    text: truncate(stringOr(value.text, '')),
    source: stringOr(value.source, 'migration'),
    createdAt: nonNegativeNumberOr(value.createdAt, 0),
    recoverable: typeof value.recoverable === 'boolean' ? value.recoverable : true,
  }
}

function normalizeDecision(value: unknown): RecoveryDecision {
  if (!isRecord(value)) throw new Error('decision must be an object')
  assertNonEmptyString(value.id, 'decision.id')
  return {
    id: value.id,
    text: truncate(stringOr(value.text, '')),
    reason: optionalTruncatedString(value.reason),
    createdAt: nonNegativeNumberOr(value.createdAt, 0),
  }
}

function normalizeConstraint(value: unknown): RecoveryConstraint {
  if (!isRecord(value)) throw new Error('constraint must be an object')
  assertNonEmptyString(value.id, 'constraint.id')
  return {
    id: value.id,
    text: truncate(stringOr(value.text, '')),
    source: value.source === 'user' || value.source === 'system' || value.source === 'developer' || value.source === 'runtime' ? value.source : 'migration',
    createdAt: nonNegativeNumberOr(value.createdAt, 0),
  }
}

function normalizeArtifact(value: unknown): RecoveryArtifact {
  if (!isRecord(value)) throw new Error('artifact must be an object')
  assertNonEmptyString(value.id, 'artifact.id')
  return {
    id: value.id,
    kind: value.kind === 'file' || value.kind === 'command' || value.kind === 'url' || value.kind === 'log' || value.kind === 'diff' ? value.kind : 'other',
    ref: truncate(stringOr(value.ref, '')),
    description: optionalTruncatedString(value.description),
    createdAt: nonNegativeNumberOr(value.createdAt, 0),
  }
}

function normalizeNext(value: unknown): RecoveryNextAction | null {
  if (value === null || value === undefined) return null
  if (!isRecord(value)) throw new Error('next must be an object or null')
  const kind = value.kind === 'tool' || value.kind === 'verification' || value.kind === 'handoff' || value.kind === 'none' ? value.kind : 'message'
  return {
    kind,
    description: truncate(stringOr(value.description, '')),
    toolName: optionalTruncatedString(value.toolName),
    toolCallId: optionalTruncatedString(value.toolCallId),
  }
}

function normalizeNode(value: unknown, fallback: SessionNode): SessionNode {
  if (!isRecord(value)) throw new Error('SessionNode must be an object')
  assertNonEmptyString(value.sessionId, 'node.sessionId')
  const sessionKind = typeof value.sessionKind === 'string' ? value.sessionKind : fallback.sessionKind
  assertSessionKind(sessionKind)
  return {
    sessionId: value.sessionId,
    parentSessionId: typeof value.parentSessionId === 'string' ? value.parentSessionId : null,
    sessionKind,
    providerSessionId: optionalTruncatedString(value.providerSessionId),
    toolCallId: optionalTruncatedString(value.toolCallId),
    createdAt: nonNegativeNumberOr(value.createdAt, fallback.createdAt),
    completedAt: value.completedAt === null || value.completedAt === undefined ? null : nonNegativeNumberOr(value.completedAt, fallback.completedAt ?? 0),
  }
}

function normalizeHandoff(value: unknown): TypedSessionHandoff {
  if (!isRecord(value)) throw new Error('handoff must be an object')
  assertNonEmptyString(value.handoffId, 'handoffId')
  assertNonEmptyString(value.fromSessionId, 'fromSessionId')
  assertNonEmptyString(value.toSessionId, 'toSessionId')
  assertChildSessionKind(value.childKind, 'childKind')
  return {
    handoffId: value.handoffId,
    fromSessionId: value.fromSessionId,
    toSessionId: value.toSessionId,
    childKind: value.childKind,
    status: value.status === 'consumed' ? 'consumed' : 'created',
    createdAt: nonNegativeNumberOr(value.createdAt, 0),
    consumedAt: value.consumedAt === null || value.consumedAt === undefined ? null : nonNegativeNumberOr(value.consumedAt, 0),
    verifiedFactIds: boundStringList(value.verifiedFactIds),
    artifactIds: boundStringList(value.artifactIds),
    failureIds: boundStringList(value.failureIds),
    pendingWorkIds: boundStringList(value.pendingWorkIds),
  }
}

function makeFact(fact: RecoveryFact): RecoveryFact {
  return {
    ...fact,
    text: truncate(fact.text),
    evidence: optionalTruncatedString(fact.evidence),
  }
}

function makeFailure(failure: RecoveryFailure): RecoveryFailure {
  return {
    ...failure,
    text: truncate(failure.text),
    source: truncate(failure.source),
  }
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  return boundItems([...items.filter(existing => existing.id !== item.id), item])
}

function upsertBySessionId<T extends { sessionId: string }>(items: T[], item: T): T[] {
  return boundItems([...items.filter(existing => existing.sessionId !== item.sessionId), item])
}

function upsertByHandoffId<T extends { handoffId: string }>(items: T[], item: T): T[] {
  return boundItems([...items.filter(existing => existing.handoffId !== item.handoffId), item])
}

function boundItems<T>(items: T[]): T[] {
  return items.slice(-MAX_LIST_ITEMS)
}

function normalizeLifecycle(value: unknown): SessionLifecycle {
  return value === 'waiting_for_child' || value === 'completed' || value === 'failed' || value === 'abandoned' ? value : 'active'
}

function normalizeFactSource(value: unknown): FactSource {
  const sources: FactSource[] = ['model_summary', 'assistant_message', 'runtime_tool_call', 'runtime_tool_result', 'verification_event', 'handoff', 'migration']
  return typeof value === 'string' && sources.includes(value as FactSource) ? value as FactSource : 'migration'
}

function boundList<T>(value: unknown, normalize: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) return []
  return value.slice(-MAX_LIST_ITEMS).map(normalize)
}

function boundStringList(value: unknown): string[] {
  return boundList(value, item => {
    assertNonEmptyString(item, 'id')
    return truncate(item)
  })
}

function truncate(value: string): string {
  return value.length > MAX_TEXT_LENGTH ? value.slice(0, MAX_TEXT_LENGTH) : value
}

function optionalTruncatedString(value: unknown): string | undefined {
  return typeof value === 'string' ? truncate(value) : undefined
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function nonNegativeNumberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function nonNegativeIntegerOr(value: unknown, fallback: number): number {
  return Number.isInteger(value) && (value as number) >= 0 ? value as number : fallback
}

function assertNonNegativeNumber(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${field} must be a non-negative number`)
}

function assertNonNegativeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${field} must be a non-negative integer`)
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`)
}

function assertSessionKind(value: unknown): asserts value is SessionKind {
  if (value !== 'main' && value !== 'tool_child' && value !== 'subagent_child') throw new Error('sessionKind must be main, tool_child, or subagent_child')
}

function assertChildSessionKind(value: unknown, field: string): asserts value is Exclude<SessionKind, 'main'> {
  if (value !== 'tool_child' && value !== 'subagent_child') throw new Error(`${field} must be tool_child or subagent_child`)
}

function assertCompactionBoundarySource(value: unknown): asserts value is 'client' | 'server' | 'local_fallback' | 'child_handoff' {
  if (value !== 'client' && value !== 'server' && value !== 'local_fallback' && value !== 'child_handoff') {
    throw new Error('source must be client, server, local_fallback, or child_handoff')
  }
}

function assertProviderSessionChange(previousProviderSessionId: unknown, nextProviderSessionId: unknown): void {
  const previousValid = previousProviderSessionId === undefined || isNonEmptyString(previousProviderSessionId)
  const nextValid = nextProviderSessionId === undefined || isNonEmptyString(nextProviderSessionId)
  const hasAtLeastOne = isNonEmptyString(previousProviderSessionId) || isNonEmptyString(nextProviderSessionId)

  if (!previousValid || !nextValid || !hasAtLeastOne) {
    throw new Error('provider_session_change requires previousProviderSessionId or nextProviderSessionId to be a non-empty providerSessionId')
  }
}

function assertTaskCompleteResult(value: unknown): asserts value is 'success' | 'failure' | undefined {
  if (value !== undefined && value !== 'success' && value !== 'failure') throw new Error('result must be success or failure')
}

function assertBoolean(value: unknown, field: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} must be boolean`)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
