/**
 * requestCleaner.ts — Phase 3a
 *
 * Central entry point for cleaning a RequestAssembly into a CleanedRequest.
 * Merges logic previously spread across RequestAssembly.ts, qwen.ts, and
 * providerPromptProjection.ts:
 *   - filterProviderMessageHistory (strictest params)
 *   - mode-based truncation (parameterised as ModeTruncationOptions)
 *   - delta selection
 *   - buildInfrastructurePrompt (non-truncating variant)
 *
 * The result is a canonical intermediate that any provider renderer can consume.
 */

import type { ChatMessage } from '../types.ts'
import type { RequestAssembly } from '../RequestAssembly.ts'
import type { ToolActionConstraint } from '../toolCalling/ToolManifest.ts'
import type { PromptRefreshMode } from '../promptBudgetPolicy.ts'
import { extractTextContent, isLikelyConfigurationPayload } from '../services/contextPayloadClassifier.ts'

// ── CleanedRequest interface ────────────────────────────────────────

export interface ToolDef {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export interface CleanedRequest {
  /** Provider-facing messages after filtering + delta + truncation */
  messages: ChatMessage[]
  /** Summary text from context compaction, or null */
  summaryText: string | null
  /** Infrastructure prompt injected after compaction, or null */
  infrastructurePrompt: string | null
  /** Available tool definitions */
  toolDefinitions: ToolDef[]
  /** Active skill workflow state checkpoint, or null */
  activeSkillCheckpoint: string | null
  /** Pre-rendered tool contract prompt from ToolCallingEngine (managed XML) */
  toolContractText: string | null
  /** Structured constraint that must be reflected in the next assistant action */
  toolActionConstraint: ToolActionConstraint | null
  /** Request-level prompt refresh mode */
  mode: PromptRefreshMode
}

// ── Entry point ─────────────────────────────────────────────────────

export interface BuildCleanedRequestOptions {
  promptRefreshMode: PromptRefreshMode
  hasProviderSession: boolean
}

export function buildCleanedRequest(
  assembly: RequestAssembly,
  options: BuildCleanedRequestOptions,
): CleanedRequest {
  const { promptRefreshMode, hasProviderSession } = options

  // 1. Apply strictest message history filtering
  const filtered = filterProviderMessageHistory(assembly.messages, {
    dropRuntimeConfig: true,
    stripRuntimeConfig: true,
    stripToolContractHistory: true,
  })

  // 2. Delta selection — keep only messages since last assistant tool call
  const deltaMessages = selectDeltaMessages(filtered, hasProviderSession)

  // 3. Mode-based conversation truncation
  const truncatedMessages = truncateForMode(deltaMessages, promptRefreshMode)

  // 4. Build infrastructure from the filtered history so repeated runtime
  // configuration cannot inflate every provider prompt after compaction.
  // Extract the bounded skill summary from the original history before the
  // raw skill document is removed; never use the raw document as prompt text.
  const infrastructurePrompt = assembly.infrastructurePrompt
    ?? buildInfrastructurePromptFromMessages(assembly.messages)

  // 5. Extract summary text
  const summaryText = assembly.summaryText ?? null

  // 6. Extract tool definitions and rendered tool contract from the tool manifest
  const toolDefinitions: ToolDef[] = extractToolDefinitions(assembly)
  const toolContractText = assembly.toolManifest?.renderedPrompt ?? null

  // 7. Extract active skill checkpoint
  const activeSkillCheckpoint = findActiveSkillCheckpoint(assembly.messages)

  // 8. Collect active skill checkpoint from mode injection
  const finalCheckpoint = promptRefreshMode === 'tool_ready'
    ? activeSkillCheckpoint
    : null

  return {
    messages: truncatedMessages,
    summaryText,
    infrastructurePrompt,
    toolDefinitions,
    toolContractText,
    toolActionConstraint: assembly.toolActionConstraint ?? null,
    activeSkillCheckpoint: finalCheckpoint,
    mode: promptRefreshMode,
  }
}

// ── Delta selection (from qwen.ts selectQwenDeltaMessages) ──────────

function selectDeltaMessages(
  messages: ChatMessage[],
  hasProviderSession: boolean,
): ChatMessage[] {
  if (!hasProviderSession) {
    return messages
  }

  let lastAssistantToolCallIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      lastAssistantToolCallIndex = index
      break
    }
  }

  if (lastAssistantToolCallIndex === -1) {
    return messages
  }

  return messages.slice(lastAssistantToolCallIndex)
}

// ── Mode-based truncation (from qwen.ts filterConversationForMode) ──

export interface ModeTruncationOptions {
  /** Max non-system messages to keep in bounded modes */
  maxTailMessages?: number
}

function truncateForMode(
  messages: ChatMessage[],
  mode?: PromptRefreshMode,
  _options: ModeTruncationOptions = {},
): ChatMessage[] {
  if (!mode || mode === 'full' || mode === 'repair' || mode === 'tool_ready') {
    return messages
  }

  // 'digest' and 'minimal' both use the same tail count
  const maxTail = _options.maxTailMessages ?? 4
  const nonSystem = messages.filter((m) => m.role !== 'system')
  const tail = nonSystem.slice(-maxTail)

  // If tail starts with a tool result, widen to include its trigger call
  if (tail[0]?.role === 'tool' && tail[0]?.tool_call_id) {
    const toolCallId = tail[0].tool_call_id
    for (let index = nonSystem.length - maxTail - 1; index >= Math.max(0, nonSystem.length - maxTail - 2); index -= 1) {
      if (nonSystem[index]?.tool_calls?.some((call) => call.id === toolCallId)) {
        return nonSystem.slice(index)
      }
    }
  }

  return tail
}

// ── Message history filtering (from RequestAssembly.ts) ─────────────

interface FilterOptions {
  stripRuntimeConfig?: boolean
  stripToolContractHistory?: boolean
  dropRuntimeConfig?: boolean
  maxCheckpointChars?: number
}

function filterProviderMessageHistory(
  messages: ChatMessage[],
  options: FilterOptions = {},
): ChatMessage[] {
  const stripRuntimeConfig = options.stripRuntimeConfig !== false
  const stripToolContractHistory = options.stripToolContractHistory !== false
  const maxCheckpointChars = options.maxCheckpointChars ?? 4000
  const filtered: ChatMessage[] = []

  for (const message of messages) {
    if (message.role === 'tool' && isRawSkillMessage(message)) {
      const skillResidue = stripRawSkillDocument(extractTextContent(message.content))
      if (skillResidue.trim()) {
        filtered.push({ ...message, content: skillResidue.trim() })
      }
      continue
    }

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
    ].some((marker) => text.includes(marker))

    const hasHistoricalContractBlock = [
      'Tool Contract Header',
      'catalog_fingerprint:',
      'allowed_tools:',
      'superpowers',
    ].some((marker) => text.includes(marker))

    const shouldStrip =
      (stripRuntimeConfig && className === 'runtime_config')
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

function isDiscardableRuntimeConfiguration(message: ChatMessage, text: string): boolean {
  if (message.role !== 'system' && message.role !== 'user') return false

  const hasOnlyConfigurationLines = () => {
    const residue = stripConfigurationLines(text)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter(
        (line) => !/^(?:working directory|current directory|workspace(?: directory| root)?|project root|cwd)\s*:/i.test(line),
      )

    if (residue.length === 0) return true

    return !residue.some(
      (line) =>
        !/^[A-Z][A-Z0-9_]{7,}$/.test(line)
        && /[\p{L}]/u.test(line)
        && /(?:\s|[.!?。！？])/u.test(line),
    )
  }

  if (isLikelyConfigurationPayload(text)) return hasOnlyConfigurationLines()

  const runtimeMarkerCount = ['superpowers', 'SUBAGENT-STOP']
    .filter((marker) => text.includes(marker))
    .length

  const hasExecutionBootstrapCue =
    /(?:^|\n)\s*(?:working directory|current directory|workspace(?: root| directory)?|project root|cwd)\s*:/im.test(text)
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
  const signalCount = genericToolContractSignals.filter((signal) => text.includes(signal)).length
  return signalCount >= 2 && hasOnlyConfigurationLines()
}

function stripConfigurationLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/^\s*(?:You are opencode\b|## Available Tools|## Tool Call Protocol|## Tool Use|## Tools|Tool Contract Header|TOOL USE|Tool Call Formatting|You can invoke the following developer tools).*$/i.test(line)
        && !/^\s*(?:contract_header_version|catalog_fingerprint|allowed_tools):\s*/i.test(line)
        && !/^\s*(?:superpowers\b|SUBAGENT-STOP\b).*$/i.test(line)
        && !/^\s*Tool `[^`]+`\s*(?::|$)/i.test(line)
        && !/^\s*JSON schema\s*:/i.test(line)
        && !line.includes('<|CHAT2API|tool_calls>')
        && !line.includes('[function_calls]')
        && !line.includes('TOOL_WRAP_HINT'),
    )
    .join('\n')
    .trim()
}

// ── Infrastructure prompt (from providerPromptProjection.ts) ────────

function buildInfrastructurePromptFromMessages(messages: ChatMessage[]): string | null {
  const sections: string[] = []

  // Execution environment facts
  const execEnv = buildExecutionEnvironmentPrompt(messages)
  if (execEnv) {
    sections.push(execEnv)
  }

  // Agent definition: ALL system messages not containing tool contract or summary markers
  const agentParts: string[] = []
  for (const m of messages) {
    if (m.role !== 'system') continue
    const text = extractTextContent(m.content).trim()
    if (text.length === 0) continue
    if (text.includes('## Available Tools')) continue
    if (text.includes('Tool Contract Header')) continue
    if (text.includes('[Prior conversation summary')) continue
    if (text.includes('[Local fallback summary')) continue
    agentParts.push(text.slice(0, 2000))
    break
  }
  if (agentParts.length > 0) {
    sections.push(`[Role definition — authoritative for this session]\n${agentParts.join('\n\n')}`)
  }

  // Active skill summary: last tool result with <skill_content>
  const skillResults = messages.filter(
    (m) =>
      m.role === 'tool'
      && m.tool_call_id
      && typeof m.content === 'string'
      && m.content.includes('<skill_content'),
  )
  if (skillResults.length > 0) {
    const lastSkillResult = skillResults[skillResults.length - 1]
    const content = typeof lastSkillResult.content === 'string' ? lastSkillResult.content : ''
    const steps = extractSkillSteps(content)
    if (steps) {
      sections.push(`[Active skill workflow — follow these steps in order]\n${steps}`)
    }
  }

  return sections.length > 0 ? sections.join('\n\n') : null
}

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

function extractSkillSteps(skillContent: string): string | null {
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

// ── Helpers ─────────────────────────────────────────────────────────

function extractToolDefinitions(assembly: RequestAssembly): ToolDef[] {
  if (!assembly.toolManifest?.tools) return []
  return assembly.toolManifest.tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.inputSchema as Record<string, unknown> | undefined,
    },
  }))
}

function isRawSkillMessage(message: ChatMessage): boolean {
  return extractTextContent(message.content).includes('<skill_content')
}

function stripRawSkillDocument(text: string): string {
  return text.replace(/<skill_content\b[\s\S]*?(?:<\/skill_content>|$)/gi, '')
}

function findActiveSkillCheckpoint(messages: ChatMessage[]): string | null {
  const ACTIVE_SKILL_CHECKPOINT_MARKER = '[Active skill workflow state checkpoint]'
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = extractTextContent(messages[index].content).trim()
    if (content.includes(ACTIVE_SKILL_CHECKPOINT_MARKER)) {
      return content
    }
  }
  return null
}

/**
 * Simplified classification for provider message history filtering.
 * Mirrors the subset used in RequestAssembly.ts without importing
 * contextPayloadClassifier's full classifyTextPayload (which has a
 * different classification scope).
 */
const CONFIGURATION_CLASSES = new Set(['runtime_config', 'tool_contract', 'provider_checkpoint'])

function classifyTextPayload(text: string): { className: string } {
  const trimmed = text.trim()
  if (!trimmed) return { className: 'short_empty' }

  const words = trimmed.split(/\s+/)
  if (words.length < 5 && trimmed.length < 80) {
    return { className: 'short_utterance' }
  }

  const lower = trimmed.toLowerCase()

  // Tool contract detection
  const toolContractSignals = [
    'tool contract header',
    'catalog_fingerprint:',
    'allowed_tools:',
    '## available tools',
    '## tool call protocol',
    'contract_header_version:',
    'tool_call_id',
    '<tool_calls>',
  ]
  let toolContractScore = 0
  for (const signal of toolContractSignals) {
    if (lower.includes(signal)) toolContractScore++
  }
  if (toolContractScore >= 3) return { className: 'tool_contract' }
  if (toolContractScore >= 1) return { className: 'tool_contract' }

  // Runtime config detection
  if (
    lower.startsWith('you are opencode')
    || lower.startsWith('superpowers')
    || (lower.includes('working directory') && lower.includes('project root'))
  ) {
    return { className: 'runtime_config' }
  }

  // Provider checkpoint
  if (
    trimmed.includes('[Prior conversation summary')
    || trimmed.includes('[Local fallback summary')
    || trimmed.includes('[Completed tool exchange handoff]')
    || trimmed.includes('[Child session handoff state]')
  ) {
    return { className: 'provider_checkpoint' }
  }

  return { className: 'user_message' }
}
