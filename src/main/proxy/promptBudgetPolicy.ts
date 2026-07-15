export type PromptRefreshMode = 'full' | 'digest' | 'tool_ready' | 'minimal' | 'repair'

export type PromptBudgetReasonCode =
  | 'recent_schema_failure'
  | 'recent_malformed_tool_output'
  | 'recent_unknown_tool'
  | 'missing_provider_conversation_session_key'
  | 'missing_tool_catalog_session_key'
  | 'fresh_provider_session'
  | 'session_boundary_client_compact'
  | 'session_boundary_server_summary'
  | 'session_boundary_summary_generator'
  | 'session_boundary_tool_child'
  | 'session_boundary_subagent_child'
  | 'provider_identity_changed'
  | 'model_identity_changed'
  | 'account_identity_changed'
  | 'tool_catalog_fingerprint_changed'
  | 'skill_fingerprint_changed'
  | 'identity_uncertain'
  | 'fingerprint_uncertain'
  | 'current_tool_result_present'
  | 'previous_assistant_tool_calls_present'
  | 'managed_tool_turn_present'
  | 'server_summary_active_tool_continuation'
  | 'skill_fingerprint_present'
  | 'stable_normal_continuation'

export type PromptBudgetSessionBoundaryReason =
  | 'normal'
  | 'client_compact'
  | 'server_summary'
  | 'summary_generator'
  | 'tool_child'
  | 'subagent_child'

export interface PromptBudgetPolicyInput {
  toolCatalogSessionKey?: string | null
  providerConversationSessionKey?: string | null
  sessionBoundaryReason?: PromptBudgetSessionBoundaryReason | null
  providerId?: string | null
  previousProviderId?: string | null
  modelId?: string | null
  previousModelId?: string | null
  accountId?: string | null
  previousAccountId?: string | null
  toolCatalogFingerprint?: string | null
  previousToolCatalogFingerprint?: string | null
  skillFingerprint?: string | null
  previousSkillFingerprint?: string | null
  hasActiveTools?: boolean
  hasCurrentToolResult?: boolean
  hasPreviousAssistantToolCalls?: boolean
  hasManagedToolCapableTurn?: boolean
  recentSchemaFailure?: boolean
  recentMalformedToolOutput?: boolean
  recentUnknownToolFailure?: boolean
  isFreshProviderSession?: boolean
}

export interface PromptBudgetPolicyDecision {
  promptRefreshMode: PromptRefreshMode
  reasons: PromptBudgetReasonCode[]
}

export interface PromptBudgetPolicySnapshot {
  providerId?: string
  modelId?: string
  accountId?: string
  toolCatalogFingerprint?: string
  skillFingerprint?: string
}

export const PROMPT_BUDGET_SNAPSHOT_CACHE_LIMIT = 512

export const promptBudgetSnapshotCache = new Map<string, PromptBudgetPolicySnapshot>()

const SESSION_BOUNDARY_REASON_CODES: Record<Exclude<PromptBudgetSessionBoundaryReason, 'normal'>, PromptBudgetReasonCode> = {
  client_compact: 'session_boundary_client_compact',
  server_summary: 'session_boundary_server_summary',
  summary_generator: 'session_boundary_summary_generator',
  tool_child: 'session_boundary_tool_child',
  subagent_child: 'session_boundary_subagent_child',
}

export function decidePromptBudgetPolicy(input: PromptBudgetPolicyInput): PromptBudgetPolicyDecision {
  const repairReasons = collectRepairReasons(input)
  if (repairReasons.length > 0) {
    return { promptRefreshMode: 'repair', reasons: repairReasons }
  }

  const blockingFullReasons = collectBlockingFullReasons(input)
  if (blockingFullReasons.length > 0) {
    return {
      promptRefreshMode: 'full',
      reasons: dedupeReasons([
        ...blockingFullReasons,
        ...collectBoundaryFullReasons(input),
      ]),
    }
  }

  const toolReadyReasons = collectToolReadyReasons(input)
  if (toolReadyReasons.length > 0) {
    return { promptRefreshMode: 'tool_ready', reasons: toolReadyReasons }
  }

  const boundaryFullReasons = collectBoundaryFullReasons(input)
  if (boundaryFullReasons.length > 0) {
    return { promptRefreshMode: 'full', reasons: boundaryFullReasons }
  }

  if (hasNonEmpty(input.skillFingerprint)) {
    return {
      promptRefreshMode: 'digest',
      reasons: ['skill_fingerprint_present'],
    }
  }

  return {
    promptRefreshMode: 'minimal',
    reasons: ['stable_normal_continuation'],
  }
}

export function getPromptBudgetSnapshot(key: string): PromptBudgetPolicySnapshot | undefined {
  return promptBudgetSnapshotCache.get(key)
}

export function recordPromptBudgetSnapshot(key: string, snapshot: PromptBudgetPolicySnapshot): void {
  promptBudgetSnapshotCache.set(key, {
    providerId: snapshot.providerId,
    modelId: snapshot.modelId,
    accountId: snapshot.accountId,
    toolCatalogFingerprint: snapshot.toolCatalogFingerprint,
    skillFingerprint: snapshot.skillFingerprint,
  })

  while (promptBudgetSnapshotCache.size > PROMPT_BUDGET_SNAPSHOT_CACHE_LIMIT) {
    const oldestKey = promptBudgetSnapshotCache.keys().next().value
    if (typeof oldestKey !== 'string') {
      break
    }
    promptBudgetSnapshotCache.delete(oldestKey)
  }
}

export function inspectRecentPromptBudgetToolSignals(
  messages?: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool'
    tool_call_id?: string
    tool_calls?: Array<unknown>
  }>
): Pick<PromptBudgetPolicyInput, 'hasCurrentToolResult' | 'hasPreviousAssistantToolCalls'> {
  const recentMessages = (messages ?? []).filter((message) => message.role !== 'system')
  if (recentMessages.length === 0) {
    return {
      hasCurrentToolResult: false,
      hasPreviousAssistantToolCalls: false,
    }
  }

  const latestMessage = recentMessages[recentMessages.length - 1]
  const trailingToolMessages: typeof recentMessages = []

  if (latestMessage.role === 'tool') {
    for (let index = recentMessages.length - 1; index >= 0; index -= 1) {
      const message = recentMessages[index]
      if (message.role !== 'tool') break
      if (typeof message.tool_call_id !== 'string' || message.tool_call_id.trim().length === 0) {
        trailingToolMessages.length = 0
        break
      }
      trailingToolMessages.unshift(message)
    }
  }

  const hasCurrentToolResult = trailingToolMessages.length > 0
  if (latestMessage.role === 'assistant' && Array.isArray(latestMessage.tool_calls) && latestMessage.tool_calls.length > 0) {
    return {
      hasCurrentToolResult: false,
      hasPreviousAssistantToolCalls: true,
    }
  }

  if (hasCurrentToolResult) {
    const assistantBeforeTrailingTools = recentMessages[recentMessages.length - trailingToolMessages.length - 1]
    if (
      assistantBeforeTrailingTools?.role === 'assistant'
      && Array.isArray(assistantBeforeTrailingTools.tool_calls)
      && assistantBeforeTrailingTools.tool_calls.length > 0
    ) {
      return {
        hasCurrentToolResult: true,
        hasPreviousAssistantToolCalls: true,
      }
    }
  }

  return {
    hasCurrentToolResult,
    hasPreviousAssistantToolCalls: false,
  }
}

export function buildPromptBudgetPolicyInput(input: {
  requestMessages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool'
    tool_call_id?: string
    tool_calls?: Array<unknown>
  }>
  sessionBoundaryReason?: PromptBudgetPolicyInput['sessionBoundaryReason']
  providerId: string
  accountId: string
  actualModel: string
  toolSessionKey: string
  providerConversationSessionKey: string
  toolCatalogFingerprint?: string
  hasActiveTools: boolean
  hasManagedToolCapableTurn: boolean
  previousSnapshot?: PromptBudgetPolicySnapshot
  skillFingerprint?: string
}): PromptBudgetPolicyInput {
  const recentSignals = inspectRecentPromptBudgetToolSignals(input.requestMessages)

  return {
    toolCatalogSessionKey: input.toolSessionKey,
    providerConversationSessionKey: input.providerConversationSessionKey,
    sessionBoundaryReason: input.sessionBoundaryReason,
    providerId: input.providerId,
    previousProviderId: input.previousSnapshot?.providerId,
    modelId: input.actualModel,
    previousModelId: input.previousSnapshot?.modelId,
    accountId: input.accountId,
    previousAccountId: input.previousSnapshot?.accountId,
    toolCatalogFingerprint: input.toolCatalogFingerprint,
    previousToolCatalogFingerprint: input.previousSnapshot?.toolCatalogFingerprint,
    skillFingerprint: input.skillFingerprint,
    previousSkillFingerprint: input.previousSnapshot?.skillFingerprint,
    hasActiveTools: input.hasActiveTools,
    hasManagedToolCapableTurn: input.hasManagedToolCapableTurn,
    hasCurrentToolResult: recentSignals.hasCurrentToolResult,
    hasPreviousAssistantToolCalls: recentSignals.hasPreviousAssistantToolCalls,
    isFreshProviderSession: !input.previousSnapshot,
  }
}

function collectRepairReasons(input: PromptBudgetPolicyInput): PromptBudgetReasonCode[] {
  const reasons: PromptBudgetReasonCode[] = []
  if (input.recentSchemaFailure) reasons.push('recent_schema_failure')
  if (input.recentMalformedToolOutput) reasons.push('recent_malformed_tool_output')
  if (input.recentUnknownToolFailure) reasons.push('recent_unknown_tool')
  return reasons
}

function collectBlockingFullReasons(input: PromptBudgetPolicyInput): PromptBudgetReasonCode[] {
  const reasons: PromptBudgetReasonCode[] = []
  const exemptEphemeralSummaryFork = shouldExemptEphemeralSummaryForkBlockingReasons(input)

  if (!hasNonEmpty(input.providerConversationSessionKey)) {
    reasons.push('missing_provider_conversation_session_key')
  }
  if (!hasNonEmpty(input.toolCatalogSessionKey)) {
    reasons.push('missing_tool_catalog_session_key')
  }
  if (input.isFreshProviderSession && !exemptEphemeralSummaryFork) {
    reasons.push('fresh_provider_session')
  }

  if (identityChanged(input.previousProviderId, input.providerId)) {
    reasons.push('provider_identity_changed')
  }
  if (identityChanged(input.previousModelId, input.modelId)) {
    reasons.push('model_identity_changed')
  }
  if (identityChanged(input.previousAccountId, input.accountId)) {
    reasons.push('account_identity_changed')
  }

  if (fingerprintChanged(input.previousToolCatalogFingerprint, input.toolCatalogFingerprint)) {
    reasons.push('tool_catalog_fingerprint_changed')
  }
  if (fingerprintChanged(input.previousSkillFingerprint, input.skillFingerprint)) {
    reasons.push('skill_fingerprint_changed')
  }

  if (hasUncertainIdentity(input) && !exemptEphemeralSummaryFork) {
    reasons.push('identity_uncertain')
  }
  if (hasUncertainFingerprint(input) && !exemptEphemeralSummaryFork) {
    reasons.push('fingerprint_uncertain')
  }

  return dedupeReasons(reasons)
}

function collectBoundaryFullReasons(input: PromptBudgetPolicyInput): PromptBudgetReasonCode[] {
  if (!input.sessionBoundaryReason || input.sessionBoundaryReason === 'normal' || shouldPreferToolReadyAcrossBoundary(input)) {
    return []
  }

  return [SESSION_BOUNDARY_REASON_CODES[input.sessionBoundaryReason]]
}

function collectToolReadyReasons(input: PromptBudgetPolicyInput): PromptBudgetReasonCode[] {
  const reasons: PromptBudgetReasonCode[] = []
  if (shouldPreferToolReadyAcrossBoundary(input)) reasons.push('server_summary_active_tool_continuation')
  if (input.hasCurrentToolResult) reasons.push('current_tool_result_present')
  if (input.hasPreviousAssistantToolCalls) reasons.push('previous_assistant_tool_calls_present')
  if (input.hasManagedToolCapableTurn && input.hasActiveTools) reasons.push('managed_tool_turn_present')
  return reasons
}

function shouldPreferToolReadyAcrossBoundary(input: PromptBudgetPolicyInput): boolean {
  if (input.sessionBoundaryReason !== 'server_summary') {
    return false
  }

  return input.hasCurrentToolResult === true
    || input.hasPreviousAssistantToolCalls === true
}

function shouldExemptEphemeralSummaryForkBlockingReasons(input: PromptBudgetPolicyInput): boolean {
  return shouldPreferToolReadyAcrossBoundary(input)
}

function hasUncertainIdentity(input: PromptBudgetPolicyInput): boolean {
  return isUncertainPair(input.previousProviderId, input.providerId)
    || isUncertainPair(input.previousModelId, input.modelId)
    || isUncertainPair(input.previousAccountId, input.accountId)
}

function hasUncertainFingerprint(input: PromptBudgetPolicyInput): boolean {
  return isUncertainPair(input.previousToolCatalogFingerprint, input.toolCatalogFingerprint)
    || isUncertainPair(input.previousSkillFingerprint, input.skillFingerprint)
}

function identityChanged(previousValue?: string | null, currentValue?: string | null): boolean {
  return hasNonEmpty(previousValue) && hasNonEmpty(currentValue) && normalize(previousValue) !== normalize(currentValue)
}

function fingerprintChanged(previousValue?: string | null, currentValue?: string | null): boolean {
  return hasNonEmpty(previousValue) && hasNonEmpty(currentValue) && normalize(previousValue) !== normalize(currentValue)
}

function isUncertainPair(previousValue?: string | null, currentValue?: string | null): boolean {
  return (hasNonEmpty(previousValue) && !hasNonEmpty(currentValue))
    || (!hasNonEmpty(previousValue) && hasNonEmpty(currentValue))
}

function hasNonEmpty(value?: string | null): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function normalize(value: string): string {
  return value.trim()
}

function dedupeReasons(reasons: PromptBudgetReasonCode[]): PromptBudgetReasonCode[] {
  return [...new Set(reasons)]
}
