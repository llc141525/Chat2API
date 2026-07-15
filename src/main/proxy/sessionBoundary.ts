import crypto from 'node:crypto'

import type { ChatCompletionRequest, ProxyContext } from './types.ts'

export type ChildSessionHandoff = {
  kind: 'tool_child' | 'subagent_child'
  status: 'ok' | 'failed' | 'needs_parent_decision'
  summary: string
  evidence: Array<{ label: string; value: string }>
  artifacts?: Array<{ path: string; purpose: string }>
  nextAction?: string
  errorClass?: string
  childProviderSessionId?: string
}

export type ProviderConversationStateWriteTargets = {
  primaryKey: string
  mirrorKey?: string
  parentHandoffKey?: string
}

export type ProviderConversationStateWritePlan<TState extends { childSessionHandoff?: ChildSessionHandoff }> = Array<{
  key: string
  update: Partial<TState>
}>

type SummaryEpochIdentityMessage = Pick<ChatCompletionRequest['messages'][number], 'role' | 'tool_call_id' | 'tool_calls' | 'content'>

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
}

function extractAssistantTextContent(content: unknown): string {
  if (typeof content === 'string') return normalizeWhitespace(content)
  if (!Array.isArray(content)) return ''

  const text = content
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      const maybeText = (part as { text?: unknown }).text
      return typeof maybeText === 'string' ? maybeText : ''
    })
    .filter(Boolean)
    .join(' ')

  return normalizeWhitespace(text)
}

function inferHandoffStatus(content: string, finishReason: string | null | undefined): ChildSessionHandoff['status'] {
  if (finishReason === 'length' || finishReason === 'content_filter') {
    return 'failed'
  }
  if (/(need|needs|await|waiting for).{0,24}(approval|confirmation|decision|input)/i.test(content)) {
    return 'needs_parent_decision'
  }
  return 'ok'
}

function inferNextAction(content: string): string | undefined {
  const explicit = content.match(/(?:next action|next step)[:\-]\s*(.+?)(?:[.?!]\s|$)/i)
  if (explicit?.[1]) {
    return truncate(normalizeWhitespace(explicit[1]), 160)
  }
  const continueMatch = content.match(/\b(?:continue|proceed|now)\s+with\s+(.+?)(?:[.?!]\s|$)/i)
  if (continueMatch?.[1]) {
    return truncate(`Continue with ${normalizeWhitespace(continueMatch[1])}`, 160)
  }
  return undefined
}

function collectArtifactReferences(messages?: ChatCompletionRequest['messages']): Array<{ path: string; purpose: string }> {
  if (!messages || messages.length === 0) return []

  const artifacts = new Map<string, string>()
  const pathPattern = /(?:\.?[\w-]+\/)+[\w.-]+/g

  for (const message of messages.slice(-8)) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const rawArgs = typeof call.function?.arguments === 'string' ? call.function.arguments : ''
        try {
          const parsed = JSON.parse(rawArgs) as Record<string, unknown>
          const filePath = typeof parsed.filePath === 'string'
            ? parsed.filePath
            : typeof parsed.path === 'string'
            ? parsed.path
            : typeof parsed.outputPath === 'string'
            ? parsed.outputPath
            : undefined
          if (filePath && !artifacts.has(filePath)) {
            artifacts.set(filePath, call.function?.name === 'write' ? 'tool output target' : `${call.function?.name ?? 'tool'} reference`)
          }
        } catch {
          for (const match of rawArgs.match(pathPattern) ?? []) {
            if (!artifacts.has(match)) {
              artifacts.set(match, `${call.function?.name ?? 'tool'} reference`)
            }
          }
        }
      }
    }

    if (typeof message.content === 'string') {
      for (const match of message.content.match(pathPattern) ?? []) {
        if (!artifacts.has(match)) {
          artifacts.set(match, 'artifact reference')
        }
      }
    }
  }

  return [...artifacts.entries()]
    .slice(0, 4)
    .map(([path, purpose]) => ({ path, purpose }))
}

function collectToolCallNames(messages?: ChatCompletionRequest['messages']): Map<string, string> {
  const toolCallNames = new Map<string, string>()
  for (const message of messages ?? []) {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue
    for (const call of message.tool_calls) {
      if (typeof call.id === 'string' && typeof call.function?.name === 'string') {
        toolCallNames.set(call.id, call.function.name)
      }
    }
  }
  return toolCallNames
}

function extractTextContent(content: SummaryEpochIdentityMessage['content']): string {
  if (typeof content === 'string') return normalizeWhitespace(content)
  if (!Array.isArray(content)) return ''

  return normalizeWhitespace(
    content
      .map((part) => {
        if (!part || typeof part !== 'object') return ''
        const maybeText = (part as { text?: unknown }).text
        return typeof maybeText === 'string' ? maybeText : ''
      })
      .join(' ')
  )
}

function detectSummaryKind(content: string): string | null {
  if (content.includes('[Prior conversation summary')) return 'prior_summary'
  if (content.includes('[Completed tool exchange handoff]')) return 'completed_tool_handoff'
  if (content.includes('[Active skill workflow state checkpoint]')) return 'active_skill_checkpoint'
  if (content.includes('[Child session handoff state]')) return 'child_session_handoff'
  return null
}

function parseSkillName(args: string): string | null {
  try {
    const parsed = JSON.parse(args) as { name?: unknown }
    return typeof parsed.name === 'string' && parsed.name.trim().length > 0
      ? parsed.name.trim()
      : null
  } catch {
    return null
  }
}

function sanitizeEpochSourceValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => sanitizeEpochSourceValue(item))
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  const sanitizedEntries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== 'messages' && key !== 'rawMessages' && key !== 'content')
    .map(([key, entryValue]) => [key, sanitizeEpochSourceValue(entryValue)])

  return Object.fromEntries(sanitizedEntries)
}

export function buildServerSummaryEpochSource(input: {
  model: string
  originalMessageCount: number
  finalMessageCount: number
  messages: ChatCompletionRequest['messages']
  strategyResults?: Array<{ strategyName: string; trimmed: boolean; subkind?: string }>
}): Record<string, unknown> {
  const summaryKinds = new Set<string>()
  const workflowToolNames = new Set<string>()
  const skillNames = new Set<string>()

  for (const message of input.messages) {
    const content = extractTextContent(message.content)
    const summaryKind = detectSummaryKind(content)
    if (summaryKind) {
      summaryKinds.add(summaryKind)
    }

    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        if (typeof toolCall.function?.name === 'string' && toolCall.function.name.length > 0) {
          workflowToolNames.add(toolCall.function.name)
          if (toolCall.function.name === 'skill' && typeof toolCall.function.arguments === 'string') {
            const skillName = parseSkillName(toolCall.function.arguments)
            if (skillName) {
              skillNames.add(skillName)
            }
          }
        }
      }
    }

    if (message.role === 'tool' && typeof message.tool_call_id === 'string' && message.tool_call_id.length > 0) {
      workflowToolNames.add(`tool_result:${message.tool_call_id}`)
    }
  }

  return {
    model: input.model,
    originalMessageCount: input.originalMessageCount,
    finalMessageCount: input.finalMessageCount,
    summaryKinds: [...summaryKinds],
    workflowToolNames: [...workflowToolNames].slice(-8),
    skillNames: [...skillNames].slice(-4),
    trimmedStrategies: (input.strategyResults ?? [])
      .filter(result => result.trimmed)
      .map(result => `${result.strategyName}:${result.subkind ?? 'trimmed'}`),
  }
}

export function buildChildSessionHandoff(input: {
  context: ProxyContext
  requestMessages?: ChatCompletionRequest['messages']
  responseBody?: any
  responseError?: unknown
  childProviderSessionId?: string
}): ChildSessionHandoff | undefined {
  const kind = input.context.sessionBoundaryReason
  if (kind !== 'tool_child' && kind !== 'subagent_child') return undefined

  const choice = Array.isArray(input.responseBody?.choices) ? input.responseBody.choices[0] : undefined
  const message = choice?.message
  const finishReason = choice?.finish_reason
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
  if (finishReason === 'tool_calls' || toolCalls.length > 0) {
    return undefined
  }

  const assistantContent = extractAssistantTextContent(message?.content)
  const fallbackSummary = input.responseError
    ? 'Child session failed before returning a settled assistant result.'
    : 'Child workflow settled and returned control to the parent session.'
  const summary = truncate(assistantContent || fallbackSummary, 280)
  const status = inferHandoffStatus(summary, finishReason)
  const artifacts = collectArtifactReferences(input.requestMessages)
  const toolCallNames = collectToolCallNames(input.requestMessages)
  const evidence = [
    ...(typeof input.context.parentProviderConversationSessionKey === 'string' && input.context.parentProviderConversationSessionKey
      ? [{ label: 'parent_session', value: truncate(input.context.parentProviderConversationSessionKey, 120) }]
      : []),
    ...(Array.isArray(input.requestMessages)
      ? input.requestMessages
          .filter((message) => message.role === 'tool')
          .slice(-3)
          .map((message) => ({
            label: `tool_result:${message.tool_call_id ?? 'unknown'}`,
            value: truncate(
              `${toolCallNames.get(message.tool_call_id ?? '') ?? 'tool'}:${message.tool_call_id ?? 'unknown'}`,
              120,
            ),
          }))
      : []),
  ].filter((entry) => entry.value.length > 0)

  return {
    kind,
    status,
    summary,
    evidence: evidence.slice(0, 4),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(inferNextAction(assistantContent) ? { nextAction: inferNextAction(assistantContent) } : {}),
    ...(status === 'failed' && finishReason ? { errorClass: finishReason } : {}),
    ...(typeof input.childProviderSessionId === 'string' && input.childProviderSessionId.trim().length > 0
      ? { childProviderSessionId: input.childProviderSessionId.trim() }
      : {}),
  }
}

export function buildProviderConversationStateWritePlan<TState extends { childSessionHandoff?: ChildSessionHandoff }>(input: {
  targets: ProviderConversationStateWriteTargets
  primaryUpdate: Partial<TState>
  parentHandoff?: ChildSessionHandoff
}): ProviderConversationStateWritePlan<TState> {
  const writes: ProviderConversationStateWritePlan<TState> = [
    { key: input.targets.primaryKey, update: input.primaryUpdate },
  ]

  if (input.targets.parentHandoffKey && input.parentHandoff) {
    writes.push({
      key: input.targets.parentHandoffKey,
      update: { childSessionHandoff: input.parentHandoff } as Partial<TState>,
    })
  }

  if (input.targets.mirrorKey) {
    writes.push({ key: input.targets.mirrorKey, update: input.primaryUpdate })
  }

  return writes
}

export function renderChildSessionHandoffStateMessage(handoff: ChildSessionHandoff): string {
  const lines = [
    '[Child session handoff state]',
    `kind: ${handoff.kind}`,
    `status: ${handoff.status}`,
    `summary: ${truncate(normalizeWhitespace(handoff.summary), 280)}`,
  ]

  if (handoff.evidence.length > 0) {
    lines.push('evidence:')
    for (const item of handoff.evidence.slice(0, 4)) {
      lines.push(`- ${truncate(normalizeWhitespace(item.label), 80)}: ${truncate(normalizeWhitespace(item.value), 160)}`)
    }
  }

  if (handoff.artifacts && handoff.artifacts.length > 0) {
    lines.push('artifacts:')
    for (const item of handoff.artifacts.slice(0, 4)) {
      lines.push(`- ${truncate(normalizeWhitespace(item.path), 160)} (${truncate(normalizeWhitespace(item.purpose), 80)})`)
    }
  }

  if (handoff.nextAction) {
    lines.push(`nextAction: ${truncate(normalizeWhitespace(handoff.nextAction), 160)}`)
  }

  if (handoff.errorClass) {
    lines.push(`errorClass: ${truncate(normalizeWhitespace(handoff.errorClass), 80)}`)
  }

  lines.push('Use only this bounded handoff state when continuing the parent workflow. Do not reconstruct raw child tool transcripts.')
  return lines.join('\n')
}

function hasManagedToolHistory(messages?: ChatCompletionRequest['messages']): boolean {
  if (!messages || messages.length === 0) return false
  return messages.some((message) => (
    (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
    || (message.role === 'tool' && typeof message.tool_call_id === 'string' && message.tool_call_id.length > 0)
  ))
}

function hasChildProviderAncestry(context: ProxyContext): boolean {
  const boundary = context.sessionBoundaryReason ?? 'normal'
  if (boundary === 'tool_child' || boundary === 'subagent_child') return true
  if (boundary !== 'server_summary') return false

  const providerKey = typeof context.providerConversationSessionKey === 'string'
    ? context.providerConversationSessionKey
    : ''
  const parentKey = typeof context.parentProviderConversationSessionKey === 'string'
    ? context.parentProviderConversationSessionKey
    : ''
  const toolCatalogKey = typeof context.toolCatalogSessionKey === 'string'
    ? context.toolCatalogSessionKey
    : ''

  if (parentKey && toolCatalogKey && parentKey !== toolCatalogKey) {
    return true
  }

  return providerKey.includes(':tool:')
    || providerKey.includes(':subagent:')
    || parentKey.includes(':tool:')
    || parentKey.includes(':subagent:')
}

export function decideProviderConversationStateWriteTargets(input: {
  context: ProxyContext
  primaryKey: string
  fallbackToolSessionKey?: string | null
  messages?: ChatCompletionRequest['messages']
  mirrorToFallback?: boolean
}): ProviderConversationStateWriteTargets {
  const sessionBoundaryReason = input.context.sessionBoundaryReason ?? 'normal'
  const hasFallbackMirror = input.mirrorToFallback !== false
    && !!input.fallbackToolSessionKey
    && hasManagedToolHistory(input.messages)

  if (hasChildProviderAncestry(input.context)) {
    return {
      primaryKey: input.primaryKey,
      parentHandoffKey: input.context.parentProviderConversationSessionKey,
    }
  }

  return {
    primaryKey: input.primaryKey,
    mirrorKey: hasFallbackMirror ? input.fallbackToolSessionKey ?? undefined : undefined,
    parentHandoffKey: input.context.parentProviderConversationSessionKey,
  }
}

export function forkProviderConversationContext(
  context: ProxyContext,
  input: {
    reason: NonNullable<ProxyContext['sessionBoundaryReason']>
    epochSource: unknown
  }
): ProxyContext {
  const parentProviderConversationSessionKey = typeof context.providerConversationSessionKey === 'string'
    && context.providerConversationSessionKey.trim().length > 0
    ? context.providerConversationSessionKey.trim()
    : typeof context.toolCatalogSessionKey === 'string' && context.toolCatalogSessionKey.trim().length > 0
    ? context.toolCatalogSessionKey.trim()
    : context.requestId
  const epochDigest = crypto
    .createHash('sha256')
    .update(JSON.stringify({
      parentProviderConversationSessionKey,
      reason: input.reason,
      epochSource: sanitizeEpochSourceValue(input.epochSource),
    }))
    .digest('hex')
    .slice(0, 24)
  const providerSessionEpoch = `${input.reason}:${epochDigest}`

  return {
    ...context,
    providerConversationSessionKey: `${parentProviderConversationSessionKey}:${providerSessionEpoch}`,
    parentProviderConversationSessionKey,
    providerSessionEpoch,
    sessionBoundaryReason: input.reason,
  }
}

export function deriveChildProxyContext(
  context: ProxyContext,
  input: {
    reason: 'tool_child' | 'subagent_child'
    epochSource: unknown
  }
): ProxyContext {
  return forkProviderConversationContext(context, input)
}
