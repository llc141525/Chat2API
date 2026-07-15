import type { ChatMessage, SessionBoundaryReason } from './types.ts'
import type { ToolActionConstraint, ToolManifest } from './toolCalling/ToolManifest.ts'
import {
  classifyTextPayload,
  extractTextContent,
  isLikelyConfigurationPayload,
} from './services/contextPayloadClassifier.ts'
import {
  buildLocalWorkflowDigest,
  renderWorkflowDigestForProvider,
  type WorkflowStateDigest,
} from './services/workflowStateDigest.ts'

export interface AssemblyMetadata {
  contextManagementApplied: boolean
  strategiesExecuted: string[]
  originalMessageCount: number
  finalMessageCount: number
}

export interface RequestAssembly {
  /** Conversation messages (after context management, WITHOUT embedded tool contract strings) */
  messages: ChatMessage[]
  /** Authoritative tool contract for this turn, or null if no tools */
  toolManifest: ToolManifest | null
  /** Summary text if summary compaction occurred, null otherwise */
  summaryText: string | null
  /** Typed compact workflow state. Runtime/tool configuration never belongs here. */
  workflowDigest?: WorkflowStateDigest | null
  /** One-turn high-priority tool action constraint, when present */
  toolActionConstraint?: ToolActionConstraint | null
  /** Metadata for diagnostics */
  metadata: AssemblyMetadata
}

export interface BuildRequestAssemblyInput {
  messages: ChatMessage[]
  toolManifest: ToolManifest | null
  summaryText?: string | null
  workflowDigest?: WorkflowStateDigest | null
  sessionBoundaryReason?: SessionBoundaryReason | null
  contextResult?: {
    summaryGenerated?: boolean
    workflowDigest?: WorkflowStateDigest
    strategyResults?: Array<{ strategyName: string; trimmed: boolean }>
    originalCount: number
    finalCount: number
  }
}

const STRUCTURED_COMPACT_MESSAGE_MARKERS = [
  '[Prior conversation summary',
  '[Completed tool exchange handoff]',
  '[Child session handoff state]',
] as const

const ACTIVE_SKILL_CHECKPOINT_MARKER = '[Active skill workflow state checkpoint]'

export function extractStructuredCompactSummaryText(messages: ChatMessage[]): string | null {
  const sections = messages
    .map(message => extractTextContent(message.content).trim())
    .filter(content => content.length > 0)
    .filter(content => STRUCTURED_COMPACT_MESSAGE_MARKERS.some(marker => content.includes(marker)))

  if (sections.length === 0) {
    return null
  }

  return sections.join('\n\n')
}

export function buildRequestAssembly(input: BuildRequestAssemblyInput): RequestAssembly {
  const strategiesExecuted = input.contextResult?.strategyResults
    ?.filter(r => r.trimmed)
    .map(r => r.strategyName) ?? []

  const workflowDigest = input.workflowDigest
    ?? input.contextResult?.workflowDigest
    ?? (input.sessionBoundaryReason === 'client_compact'
      ? buildLocalWorkflowDigest(input.messages, 'client_compact')
      : null)
  let compatibilitySummary: string | null = null
  if (!workflowDigest && input.summaryText === undefined) {
    compatibilitySummary = extractStructuredCompactSummaryText(input.messages)
    if (compatibilitySummary) {
      console.warn('[ContextEconomy] compatibility_summary_extraction', JSON.stringify({
        messageCount: input.messages.length,
        summaryChars: compatibilitySummary.length,
      }))
    }
  }

  const filteredMessages = filterProviderMessageHistory(input.messages)
  const compactMessages = workflowDigest
    ? filteredMessages.filter(message => !STRUCTURED_COMPACT_MESSAGE_MARKERS.some(
      marker => extractTextContent(message.content).includes(marker),
    ))
    : filteredMessages
  const providerMessages = compactMessages.length === input.messages.length
    && compactMessages.every((message, index) => message === input.messages[index])
    ? input.messages
    : compactMessages

  return {
    messages: providerMessages,
    toolManifest: input.toolManifest,
    summaryText: workflowDigest
      ? renderWorkflowDigestForProvider(workflowDigest)
      : input.summaryText ?? compatibilitySummary,
    workflowDigest,
    toolActionConstraint: input.toolManifest?.actionConstraint ?? null,
    metadata: {
      contextManagementApplied: input.contextResult?.summaryGenerated ?? false,
      strategiesExecuted,
      originalMessageCount: input.contextResult?.originalCount ?? input.messages.length,
      finalMessageCount: input.contextResult?.finalCount ?? input.messages.length,
    },
  }
}

export function selectProviderMessagesForAssembly(
  assembly: RequestAssembly,
  options: {
    stripRuntimeConfig?: boolean
    stripToolContractHistory?: boolean
    maxCheckpointChars?: number
  } = {},
): ChatMessage[] {
  const messages = filterProviderMessageHistory(assembly.messages, options)
  const constraint = assembly.toolActionConstraint
  if (constraint?.kind !== 'first_skill_required') {
    const activeSkillCheckpoint = findLastTextContaining(messages, ACTIVE_SKILL_CHECKPOINT_MARKER)
    if (!activeSkillCheckpoint) {
      return messages
    }

    const maxCheckpointChars = options.maxCheckpointChars ?? 4000
    const boundedCheckpoint = stripConfigurationLines(activeSkillCheckpoint)
      .slice(0, Math.max(0, maxCheckpointChars))

    return [{
      role: 'user',
      content: [
        'The runtime generated this checkpoint from completed OpenCode tool events.',
        'Treat it as the only conversation state needed for the next assistant action.',
        'Do not re-evaluate earlier user task text, skill documents, or tool result payloads before making the required next tool call.',
        '',
        boundedCheckpoint,
      ].join('\n'),
    }]
  }

  return [{
    role: 'user',
    content: [
      'The runtime has constrained this turn to a single first-action tool call.',
      `The required OpenCode skill name is \`${constraint.arguments.name}\`.`,
      'Do not answer the original user task yet.',
      'Do not inspect, summarize, classify, or judge any original task text before the skill result is available.',
      'Use only the authoritative managed tool contract below for the next assistant message.',
    ].join('\n'),
  }]
}

function filterProviderMessageHistory(
  messages: ChatMessage[],
  options: {
    stripRuntimeConfig?: boolean
    stripToolContractHistory?: boolean
    maxCheckpointChars?: number
  } = {},
): ChatMessage[] {
  const stripRuntimeConfig = options.stripRuntimeConfig !== false
  const stripToolContractHistory = options.stripToolContractHistory !== false
  const maxCheckpointChars = options.maxCheckpointChars ?? 4000
  const filtered: ChatMessage[] = []

  for (const message of messages) {
    if (message.role === 'tool' || (message.tool_calls?.length ?? 0) > 0) {
      filtered.push(message)
      continue
    }

    const text = extractTextContent(message.content)
    const className = classifyTextPayload(text).className
    const shouldStrip = (stripRuntimeConfig && className === 'runtime_config')
      || (stripToolContractHistory && className === 'tool_contract')

    if (shouldStrip) {
      if (message.role !== 'user') continue
      if (!isLikelyConfigurationPayload(text)) {
        filtered.push(message)
        continue
      }
      const stripped = stripConfigurationLines(text)
      if (!stripped) continue
      filtered.push({ ...message, content: stripped })
      continue
    }

    if (className === 'provider_checkpoint') {
      filtered.push({
        ...message,
        content: stripConfigurationLines(text).slice(0, Math.max(0, maxCheckpointChars)),
      })
      continue
    }

    filtered.push(message)
  }

  return filtered
}

function stripConfigurationLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter(line => !(
      line.includes('You are opencode')
      || line.includes('## Available Tools')
      || line.includes('## Tool Call Protocol')
      || line.includes('## Tool Use')
      || line.includes('## Tools')
      || line.includes('Tool Contract Header')
      || line.includes('TOOL USE')
      || line.includes('Tool Call Formatting')
      || line.includes('You can invoke the following developer tools')
      || line.includes('contract_header_version:')
      || line.includes('catalog_fingerprint:')
      || line.includes('allowed_tools:')
      || line.includes('superpowers')
      || line.includes('SUBAGENT-STOP')
      || /^\s*Tool `[^`]+`\s*:/i.test(line)
      || /^\s*JSON schema\s*:/i.test(line)
    ))
    .join('\n')
    .trim()
}

function findLastTextContaining(messages: ChatMessage[], marker: string): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = extractTextContent(messages[index].content).trim()
    if (content.includes(marker)) {
      return content
    }
  }
  return null
}
