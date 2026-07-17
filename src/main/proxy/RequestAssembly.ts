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
  /** Infrastructure prompt injected after compaction (agent definition + skill summary), or null */
  infrastructurePrompt?: string | null
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

  const filteredMessages = filterProviderMessageHistory(input.messages, {
    dropRuntimeConfig: true,
  })
  const compactMessages = workflowDigest
    ? filteredMessages.filter(message => !STRUCTURED_COMPACT_MESSAGE_MARKERS.some(
      marker => extractTextContent(message.content).includes(marker),
    ))
    : filteredMessages
  const providerMessages = compactMessages.length === input.messages.length
    && compactMessages.every((message, index) => message === input.messages[index])
    ? input.messages
    : compactMessages
  // Extract infrastructure from raw messages BEFORE filtering — compaction
  // strips agent definitions and skill content. Re-inject them so the model
  // retains its role and multi-step skill workflow across compactions.
  const infrastructurePrompt = buildInfrastructurePromptFromMessages(input.messages)

  return {
    messages: providerMessages,
    infrastructurePrompt,
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
    dropRuntimeConfig?: boolean
    maxCheckpointChars?: number
  } = {},
): ChatMessage[] {
  const messages = filterProviderMessageHistory(assembly.messages, options)
  const constraint = assembly.toolActionConstraint
  if (constraint?.kind !== 'first_skill_required') {
    const activeSkillCheckpoint = findLastTextContaining(messages, ACTIVE_SKILL_CHECKPOINT_MARKER)
    if (activeSkillCheckpoint) {
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
  }

  // Raw skill tool results are runtime configuration, not conversation state.
  // The assembly already carries a bounded infrastructure projection extracted
  // from the latest skill result, so replace raw documents with that projection.
  const hasRawSkillHistory = messages.some(message => isRawSkillMessage(message))
  if (hasRawSkillHistory && assembly.infrastructurePrompt?.trim()) {
    return messages.map(message => {
      if (!isRawSkillMessage(message)) {
        return message
      }
      return { ...message, content: assembly.infrastructurePrompt.trim() }
    })
  }

  if (constraint?.kind !== 'first_skill_required') {
    return messages
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

function filterProviderMessageHistory(
  messages: ChatMessage[],
  options: {
    stripRuntimeConfig?: boolean
    stripToolContractHistory?: boolean
    dropRuntimeConfig?: boolean
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
    if (options.dropRuntimeConfig && className === 'runtime_config') {
      continue
    }
    const hasConfigurationMarker = [
      'You are opencode',
      'Tool Contract Header',
      '## Available Tools',
      '## Tool Call Protocol',
      'contract_header_version:',
      'catalog_fingerprint:',
      'allowed_tools:',
      'TOOL_WRAP_HINT',
      'superpowers',
      'SUBAGENT-STOP',
    ].some(marker => text.includes(marker))
    const hasHistoricalContractBlock = [
      'Tool Contract Header',
      'catalog_fingerprint:',
      'allowed_tools:',
      'superpowers',
    ].some(marker => text.includes(marker))
    const shouldStrip = (stripRuntimeConfig && className === 'runtime_config')
      || (stripToolContractHistory && className === 'tool_contract')
      || (message.role === 'system' && hasConfigurationMarker)
      || (message.role === 'user' && hasHistoricalContractBlock)

    if (shouldStrip) {
      if (message.role !== 'user' && message.role !== 'system') continue
      if (!isLikelyConfigurationPayload(text) && !hasHistoricalContractBlock) {
        if (message.role === 'user') {
          filtered.push(message)
          continue
        }
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
      /^\s*(?:You are opencode\b|## Available Tools|## Tool Call Protocol|## Tool Use|## Tools|Tool Contract Header|TOOL USE|Tool Call Formatting|You can invoke the following developer tools).*$/i.test(line)
      || /^\s*(?:contract_header_version|catalog_fingerprint|allowed_tools):\s*/i.test(line)
      || /^\s*(?:superpowers\b|SUBAGENT-STOP\b).*$/i.test(line)
      || /^\s*Tool `[^`]+`\s*(?::|$)/i.test(line)
      || /^\s*JSON schema\s*:/i.test(line)
      || line.includes('<|CHAT2API|tool_calls>')
      || line.includes('[function_calls]')
      || line.includes('TOOL_WRAP_HINT')
    ))
    .join('\n')
    .trim()
}

function buildInfrastructurePromptFromMessages(messages: ChatMessage[]): string | null {
  const sections: string[] = []

  // Agent definition: first system-role message not containing tool contract markers
  const agentDef = messages.find(m => {
    if (m.role !== 'system') return false
    const text = extractTextContent(m.content).trim()
    return text.length > 0
      && !isLikelyConfigurationPayload(text)
      && !text.includes('## Available Tools')
      && !text.includes('Tool Contract Header')
      && !text.includes('[Prior conversation summary')
      && !text.includes('[Local fallback summary')
  })
  if (agentDef) {
    const text = extractTextContent(agentDef.content).trim()
    if (text.length > 0) {
      sections.push(`[Role definition — authoritative for this session]\n${text.slice(0, 2000)}`)
    }
  }

  // Active skill summary: numbered steps from the last tool result with <skill_content>
  const skillMessages = messages.filter(m => isRawSkillMessage(m))
  if (skillMessages.length > 0) {
    const lastSkill = skillMessages[skillMessages.length - 1]
    const content = extractTextContent(lastSkill.content)
    const steps = extractSkillStepLines(content)
    if (steps) {
      sections.push(`[Active skill workflow — follow these steps in order]\n${steps}`)
    }
  }

  return sections.length > 0 ? sections.join('\n\n') : null
}

function isRawSkillMessage(message: ChatMessage): boolean {
  return extractTextContent(message.content).includes('<skill_content')
}

function extractSkillStepLines(skillContent: string): string | null {
  const lines = skillContent.split(/\r?\n/)
  const steps: string[] = []
  let inSteps = false
  let collectingCommand = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\d+\.\s+Use\s+the\s+`/.test(line)) {
      inSteps = true
      collectingCommand = /\brun:?\s*$/.test(line.trimEnd())
      steps.push(line.trim())
    } else if (inSteps && /^\d+\./.test(line) && !collectingCommand) {
      collectingCommand = /\brun:?\s*$/.test(line.trimEnd())
      steps.push(line.trim())
    } else if (collectingCommand && line.trim() && !/^\d+\.\s+Use\s+the\s+`/.test(line)) {
      const cmdMatch = line.match(/`([^`]+)`/)
      if (cmdMatch) {
        steps.push(`  ${cmdMatch[1]}`)
        collectingCommand = false
      }
    } else if (inSteps && line.trim() === '' && steps.length >= 2 && !collectingCommand) {
      break
    }
    if (steps.join('\n').length > 800) break
  }
  return steps.length > 0 ? steps.join('\n') : null
}
