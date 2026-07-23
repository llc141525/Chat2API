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
  /** Authoritative runtime recovery context projected from persisted session state, null otherwise */
  recoveryContextText?: string | null
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
  recoveryContextText?: string | null
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
  // Project infrastructure only when the provider-facing history lost it to
  // compaction/configuration filtering. Replaying a still-present system role
  // at the end of an ordinary request changes instruction precedence (for
  // example, a client's auxiliary title role can override the newest task).
  // This condition is client-neutral and applies equally to coding agents,
  // chat clients, and future integrations.
  const needsInfrastructureProjection = Boolean(
    workflowDigest
    || input.summaryText
    || compatibilitySummary
    || input.contextResult?.summaryGenerated
    || providerMessages !== input.messages
    || input.messages.some(isRawSkillMessage),
  )
  const infrastructurePrompt = needsInfrastructureProjection
    ? buildInfrastructurePromptFromMessages(input.messages)
    : null

  return {
    messages: providerMessages,
    infrastructurePrompt,
    toolManifest: input.toolManifest,
    summaryText: workflowDigest
      ? renderWorkflowDigestForProvider(workflowDigest)
      : input.summaryText ?? compatibilitySummary,
    recoveryContextText: input.recoveryContextText ?? null,
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
  const filteredMessages = filterProviderMessageHistory(assembly.messages, options)
  // Raw skill tool results are runtime configuration, not conversation state.
  // Replace them before looking for a checkpoint: otherwise a checkpoint that
  // embeds the raw result can reintroduce the full skill document after the
  // history filter has already removed it.
  const hasRawSkillHistory = filteredMessages.some(message => isRawSkillMessage(message))
  const messages = hasRawSkillHistory && assembly.infrastructurePrompt?.trim()
    ? filteredMessages.map(message => isRawSkillMessage(message)
      ? { ...message, content: assembly.infrastructurePrompt!.trim() }
      : message,
    )
    : filteredMessages
  const constraint = assembly.toolActionConstraint
  if (constraint?.kind !== 'first_skill_required') {
    const activeSkillCheckpoint = findLastTextContaining(messages, ACTIVE_SKILL_CHECKPOINT_MARKER)
    if (activeSkillCheckpoint) {
      const maxCheckpointChars = options.maxCheckpointChars ?? 4000
      const boundedCheckpoint = stripConfigurationLines(stripRawSkillDocument(activeSkillCheckpoint))
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
    if (options.dropRuntimeConfig && isDiscardableRuntimeConfiguration(message, text)) {
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

/**
 * A provider must not inherit a client's unbounded runtime/tool configuration
 * after compaction. This deliberately recognizes protocol structure, not a
 * particular client brand: Codex, Claude Code, Hermes, OpenCode, and future
 * clients can all describe a tool catalog differently.
 */
function isDiscardableRuntimeConfiguration(message: ChatMessage, text: string): boolean {
  if (message.role !== 'system' && message.role !== 'user') return false
  // Drop an entire message only when no task/role residue survives the same
  // line-level projection used below. Mixed messages are common at client
  // boundaries; deleting them loses the user's current instruction.
  const hasOnlyConfigurationLines = () => {
    const residue = stripConfigurationLines(text)
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0)
      // Execution-location facts are infrastructure, not a user task. They
      // are projected separately when compaction actually needs them.
      .filter(line => !/^(?:working directory|current directory|workspace(?: directory| root)?|project root|cwd)\s*:/i.test(line))

    if (residue.length === 0) return true

    // Preserve meaningful role/task prose from a mixed boundary payload, but
    // do not let identifier-like runtime residue keep an entire bootstrap.
    return !residue.some(line => (
      !/^[A-Z][A-Z0-9_]{7,}$/.test(line)
      && /[\p{L}]/u.test(line)
      && /(?:\s|[.!?。！？])/u.test(line)
    ))
  }
  if (isLikelyConfigurationPayload(text)) return hasOnlyConfigurationLines()

  // Classification gives tool-exchange markers precedence. A bootstrap can
  // contain those markers too, so detect a repeated runtime envelope before
  // applying that precedence. This stays client-neutral: execution-location
  // labels and document size identify configuration shape, not a client name.
  const runtimeMarkerCount = ['superpowers', 'SUBAGENT-STOP']
    .filter(marker => text.includes(marker))
    .length
  const hasExecutionBootstrapCue = /(?:^|\n)\s*(?:working directory|current directory|workspace(?: root| directory)?|project root|cwd)\s*:/im.test(text)
    || /(?:^|\n)\s*you are\b/im.test(text)
    || text.length >= 1000
  if (runtimeMarkerCount >= 2 && hasExecutionBootstrapCue && hasOnlyConfigurationLines()) return true

  const genericToolContractSignals = [
    'Tool Contract Header',
    '## Available Tools',
    '## Tool Call Protocol',
    'contract_header_version:',
    'catalog_fingerprint:',
    'allowed_tools:',
    'TOOL_WRAP_HINT',
    'You can invoke the following developer tools',
    'Tool Call Formatting',
    '<tools>',
  ]
  const signalCount = genericToolContractSignals.filter(signal => text.includes(signal)).length
  return signalCount >= 2 && hasOnlyConfigurationLines()
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

  const executionEnvironment = buildExecutionEnvironmentPrompt(messages)
  if (executionEnvironment) {
    sections.push(executionEnvironment)
  }

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

/** Keep only stable project-location facts from an otherwise discarded runtime prompt. */
function buildExecutionEnvironmentPrompt(messages: ChatMessage[]): string | null {
  const labels = /^(?:working directory|current directory|workspace(?: directory| root)?|project root|cwd)\s*:\s*(.+)$/i
  const facts = new Set<string>()

  for (const message of messages) {
    if (message.role !== 'system') continue
    for (const line of extractTextContent(message.content).split(/\r?\n/)) {
      const match = line.trim().match(labels)
      if (!match || match[1].trim().length > 500) continue
      facts.add(line.trim().replace(/\s+/g, ' '))
      if (facts.size >= 8) break
    }
    if (facts.size >= 8) break
  }

  return facts.size > 0
    ? `[Execution environment — authoritative for this session]\n${[...facts].join('\n')}`
    : null
}

function isRawSkillMessage(message: ChatMessage): boolean {
  return extractTextContent(message.content).includes('<skill_content')
}

function stripRawSkillDocument(text: string): string {
  return text.replace(/<skill_content\b[\s\S]*?(?:<\/skill_content>|$)/gi, '')
}

function extractSkillStepLines(skillContent: string): string | null {
  const lines = skillContent.split(/\r?\n/)
  const steps: string[] = []
  let inSteps = false
  let collectingCommand = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\d+\.\s+\S/.test(line)) {
      inSteps = true
      collectingCommand = /\brun:?\s*$/.test(line.trimEnd())
      steps.push(line.trim())
    } else if (inSteps && /^\d+\./.test(line) && !collectingCommand) {
      collectingCommand = /\brun:?\s*$/.test(line.trimEnd())
      steps.push(line.trim())
    } else if (collectingCommand && line.trim() && !/^\d+\.\s+\S/.test(line)) {
      const cmdMatch = line.match(/`([^`]+)`/)
      if (cmdMatch) {
        steps.push(`  ${cmdMatch[1]}`)
        collectingCommand = false
      }
    }
    if (steps.join('\n').length > 3000) break
  }
  return steps.length > 0 ? steps.join('\n') : null
}
