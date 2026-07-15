import type { ChatMessage } from './types.ts'
import type { ToolActionConstraint, ToolManifest } from './toolCalling/ToolManifest.ts'

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
  /** One-turn high-priority tool action constraint, when present */
  toolActionConstraint?: ToolActionConstraint | null
  /** Metadata for diagnostics */
  metadata: AssemblyMetadata
}

export interface BuildRequestAssemblyInput {
  messages: ChatMessage[]
  toolManifest: ToolManifest | null
  summaryText?: string | null
  contextResult?: {
    summaryGenerated?: boolean
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

function extractTextContent(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
}

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

  return {
    messages: input.messages,
    toolManifest: input.toolManifest,
    summaryText: input.summaryText ?? extractStructuredCompactSummaryText(input.messages),
    toolActionConstraint: input.toolManifest?.actionConstraint ?? null,
    metadata: {
      contextManagementApplied: input.contextResult?.summaryGenerated ?? false,
      strategiesExecuted,
      originalMessageCount: input.contextResult?.originalCount ?? input.messages.length,
      finalMessageCount: input.contextResult?.finalCount ?? input.messages.length,
    },
  }
}

export function selectProviderMessagesForAssembly(assembly: RequestAssembly): ChatMessage[] {
  const constraint = assembly.toolActionConstraint
  if (constraint?.kind !== 'first_skill_required') {
    const activeSkillCheckpoint = findLastTextContaining(assembly.messages, ACTIVE_SKILL_CHECKPOINT_MARKER)
    if (!activeSkillCheckpoint) {
      return assembly.messages
    }

    return [{
      role: 'user',
      content: [
        'The runtime generated this checkpoint from completed OpenCode tool events.',
        'Treat it as the only conversation state needed for the next assistant action.',
        'Do not re-evaluate earlier user task text, skill documents, or tool result payloads before making the required next tool call.',
        '',
        activeSkillCheckpoint,
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

function findLastTextContaining(messages: ChatMessage[], marker: string): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = extractTextContent(messages[index].content).trim()
    if (content.includes(marker)) {
      return content
    }
  }
  return null
}
