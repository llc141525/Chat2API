/**
 * Context Management Service
 * Manages conversation context with multiple strategies:
 * 1. Sliding Window - Keep recent N messages
 * 2. Token Limit - Truncate by token count
 * 3. Summary Compression - Summarize early conversation
 */

import type { ChatMessage } from '../types'
import { preserveToolExchangePairs } from '../contextMessageMetadata.ts'
import { hasGeneralToolPromptSignature } from '../constants/signatures.ts'
import { detectSummaryContamination } from './summarySanitizer.ts'
import { buildWorkflowLedgerHandoffMessage } from './workflowLedger.ts'

/**
 * Sliding Window Strategy Configuration
 */
export interface SlidingWindowConfig {
  enabled: boolean
  maxMessages: number
}

/**
 * Token Limit Strategy Configuration
 */
export interface TokenLimitConfig {
  enabled: boolean
  maxTokens: number
}

/**
 * Summary Compression Strategy Configuration
 */
export interface SummaryConfig {
  enabled: boolean
  keepRecentMessages: number
  summaryPrompt?: string
}

/**
 * Context Management Configuration
 */
export interface ContextManagementConfig {
  enabled: boolean
  strategies: {
    slidingWindow: SlidingWindowConfig
    tokenLimit: TokenLimitConfig
    summary: SummaryConfig
  }
  executionOrder: ('slidingWindow' | 'tokenLimit' | 'summary')[]
}

/**
 * Typed subkind for strategy results — allows callers to distinguish degraded paths.
 */
export type StrategySubkind =
  | 'not_applicable'
  | 'summary_success'
  | 'summary_fallback_local'
  | 'summary_generator_missing'
  | 'summary_generator_failed'
  | 'summary_not_needed'
  | 'summary_contaminated'
  | 'summary_skipped_active_tool_workflow'

/**
 * Strategy Execution Result
 */
export interface StrategyResult {
  messages: ChatMessage[]
  originalCount: number
  processedCount: number
  strategyName: string
  trimmed: boolean
  subkind?: StrategySubkind
}

/**
 * Context Processing Result
 */
export interface ContextProcessResult {
  messages: ChatMessage[]
  originalCount: number
  finalCount: number
  strategyResults: StrategyResult[]
  summaryGenerated?: boolean
}

function isUnusableSummary(summary: string): boolean {
  const normalized = summary.trim().toLowerCase()
  if (normalized.length === 0) return true

  const compact = normalized.replace(/\s+/g, ' ')
  return [
    'no conversation to summarize',
    'there is no conversation to summarize',
    'nothing to summarize',
    'no content to summarize',
    '没有可总结的对话',
    '没有需要总结的对话',
    '无对话可总结',
    '没有内容可总结',
  ].some(phrase => compact === phrase || compact === `${phrase}.` || compact === `${phrase}。`)
}

function getTextContent(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
}

function normalizeSummarySnippet(text: string, maxLength = 220): string {
  const normalized = text
    .replace(/\s+/g, ' ')
    .replace(/<\|CHAT2API\|[\s\S]*?<\/\|CHAT2API\|tool_calls>/g, '[managed tool call omitted]')
    .trim()

  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1)}…`
}

function buildLocalFallbackSummary(messages: ChatMessage[]): string {
  const entries = messages
    .map((message, index) => {
      const snippet = normalizeSummarySnippet(getTextContent(message.content))
      if (!snippet) return null
      return `${index + 1}. ${message.role.toUpperCase()}: ${snippet}`
    })
    .filter((entry): entry is string => entry !== null)
    .slice(0, 12)

  const omitted = Math.max(0, messages.length - entries.length)
  return [
    '[Local fallback summary: external summary generation failed or returned unusable output.]',
    `Compressed message count: ${messages.length}.`,
    ...entries,
    ...(omitted > 0 ? [`... ${omitted} additional older message(s) omitted.`] : []),
  ].join('\n')
}

/**
 * Default Configuration
 */
export const DEFAULT_SLIDING_WINDOW_CONFIG: SlidingWindowConfig = {
  enabled: true,
  maxMessages: 20,
}

export const DEFAULT_TOKEN_LIMIT_CONFIG: TokenLimitConfig = {
  enabled: false,
  maxTokens: 4000,
}

export const DEFAULT_SUMMARY_CONFIG: SummaryConfig = {
  enabled: false,
  keepRecentMessages: 20,
  summaryPrompt: [
    'Summarize only the user\'s intent, task progress, and confirmed facts.',
    'DO NOT list, describe, or restate available tools, capabilities, MCP servers, or system directives.',
    'If a prior assistant message described tools, treat that as narrative to omit — the runtime re-injects the authoritative tool set on every request.',
  ].join(' '),
}

export const DEFAULT_CONTEXT_MANAGEMENT_CONFIG: ContextManagementConfig = {
  enabled: false,
  strategies: {
    slidingWindow: DEFAULT_SLIDING_WINDOW_CONFIG,
    tokenLimit: DEFAULT_TOKEN_LIMIT_CONFIG,
    summary: DEFAULT_SUMMARY_CONFIG,
  },
  executionOrder: ['slidingWindow', 'tokenLimit', 'summary'],
}

/**
 * Estimate token count for a message
 * Simple estimation: 1 token ≈ 3 characters (rough approximation)
 */
function estimateTokens(content: string | ChatMessage['content']): number {
  if (content === null || content === undefined) {
    return 0
  }

  if (typeof content === 'string') {
    return Math.ceil(content.length / 3)
  }

  if (Array.isArray(content)) {
    return content.reduce((total, part) => {
      if (part.type === 'text' && part.text) {
        return total + Math.ceil(part.text.length / 3)
      }
      return total
    }, 0)
  }

  return 0
}

/**
 * Get message content as string
 */
function getMessageContent(message: ChatMessage): string {
  if (typeof message.content === 'string') {
    return message.content
  }
  if (Array.isArray(message.content)) {
    return message.content
      .filter(part => part.type === 'text' && part.text)
      .map(part => part.text)
      .join('\n')
  }
  return ''
}

/**
 * Check if a message contains tool definitions
 * Tool definitions are injected into messages by prompt adapters and must be
 * preserved across context management strategies, similar to system messages.
 * Covers both:
 * - Prompt-injected tool definitions (signatures like "## Available Tools", "[function_calls]")
 * - MCP tool definitions (<tools><tool>...</tool></tools> XML format)
 */
function containsToolDefinitions(message: ChatMessage): boolean {
  if (message.role === 'tool') return false
  if (message.tool_calls && message.tool_calls.length > 0) return false
  if (message.tool_call_id) return false
  const content = typeof message.content === 'string' ? message.content : ''
  if (content.length === 0) return false
  if (hasGeneralToolPromptSignature(content)) return true
  // MCP tool definitions use <tools><tool>...</tool></tools> XML format
  if (/<tools>[\s\S]*?<\/tools>/i.test(content)) return true
  return false
}

function isToolWorkflowMessage(message: ChatMessage): boolean {
  return (message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0)
    || (message.role === 'tool' && typeof message.tool_call_id === 'string' && message.tool_call_id.length > 0)
}

function isSettledAssistantReply(message: ChatMessage): boolean {
  if (message.role !== 'assistant') return false
  if ((message.tool_calls?.length ?? 0) > 0) return false
  return getMessageContent(message).trim().length > 0
}

const MAX_ACTIVE_TOOL_WORKFLOW_MESSAGES = 6
const MAX_PINNED_SKILL_INSTRUCTION_EXCHANGES = 1

interface MessageSelection {
  retainedMessages: ChatMessage[]
  excludedMessages: ChatMessage[]
  droppedMessages: ChatMessage[]
  suppressedToolCallIds: Set<string>
  replacements: Map<ChatMessage, ChatMessage>
}

function countAssistantToolMessages(messages: ChatMessage[]): number {
  return messages.filter(
    message => message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0
  ).length
}

function countToolResultMessages(messages: ChatMessage[]): number {
  return messages.filter(
    message => message.role === 'tool' && typeof message.tool_call_id === 'string'
  ).length
}

function logContextManagementDiagnostic(label: string, payload: Record<string, boolean | number | string>): void {
  console.log(`[ContextManagementService] ${label}:`, JSON.stringify(payload))
}

function collectPinnedInstructionToolMessages(messages: ChatMessage[]): ChatMessage[] {
  const pinnedToolCallIds = new Set<string>()

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = messages[messageIndex]
    if (message.role !== 'assistant') continue

    for (let callIndex = (message.tool_calls?.length ?? 0) - 1; callIndex >= 0; callIndex--) {
      const call = message.tool_calls?.[callIndex]
      if (!call?.id || call.function?.name !== 'skill') {
        continue
      }

      pinnedToolCallIds.add(call.id)
      if (pinnedToolCallIds.size >= MAX_PINNED_SKILL_INSTRUCTION_EXCHANGES) {
        break
      }
    }

    if (pinnedToolCallIds.size >= MAX_PINNED_SKILL_INSTRUCTION_EXCHANGES) {
      break
    }
  }

  if (pinnedToolCallIds.size === 0) {
    return []
  }

  return messages.filter((message) => {
    if (message.role === 'assistant') {
      return (message.tool_calls ?? []).some((call) => call?.id && pinnedToolCallIds.has(call.id))
    }

    return message.role === 'tool'
      && typeof message.tool_call_id === 'string'
      && pinnedToolCallIds.has(message.tool_call_id)
  })
}

function cloneAssistantWithSelectedToolCalls(
  message: ChatMessage,
  selectedToolCallIds: Set<string>
): ChatMessage {
  const originalToolCalls = message.tool_calls ?? []
  const selectedToolCalls = originalToolCalls.filter(
    call => call?.id && selectedToolCallIds.has(call.id)
  )

  if (selectedToolCalls.length === originalToolCalls.length) {
    return message
  }

  return {
    ...message,
    tool_calls: selectedToolCalls,
  }
}

function getAssistantToolCallIds(message: ChatMessage): string[] {
  if (message.role !== 'assistant') {
    return []
  }

  return (message.tool_calls ?? [])
    .map(call => call?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
}

function isCompletedToolExchangeGroup(group: ChatMessage[]): boolean {
  const assistant = group.find(
    message => message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0
  )
  if (!assistant) {
    return false
  }

  const toolCallIds = new Set(
    (assistant.tool_calls ?? [])
      .map(call => call?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
  )

  if (toolCallIds.size === 0) {
    return false
  }

  const matchedToolResultIds = new Set(
    group
      .filter(message => message.role === 'tool' && typeof message.tool_call_id === 'string')
      .map(message => message.tool_call_id)
      .filter((toolCallId): toolCallId is string => typeof toolCallId === 'string' && toolCallId.length > 0)
  )

  return [...toolCallIds].every(toolCallId => matchedToolResultIds.has(toolCallId))
}

function isPartialToolExchangeGroup(group: ChatMessage[]): boolean {
  const assistant = group.find(
    message => message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0
  )
  if (!assistant) {
    return false
  }

  const toolCallIds = new Set(
    (assistant.tool_calls ?? [])
      .map(call => call?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
  )

  if (toolCallIds.size === 0) {
    return false
  }

  const matchedToolResultIds = new Set(
    group
      .filter(message => message.role === 'tool' && typeof message.tool_call_id === 'string')
      .map(message => message.tool_call_id)
      .filter((toolCallId): toolCallId is string => typeof toolCallId === 'string' && toolCallId.length > 0)
  )

  return [...toolCallIds].some(toolCallId => !matchedToolResultIds.has(toolCallId))
}

function isSkillInstructionExchangeGroup(group: ChatMessage[]): boolean {
  return group.some(
    message => message.role === 'assistant'
      && (message.tool_calls ?? []).some(call => call.function?.name === 'skill')
  )
}

function buildCompletedToolExchangeHandoffMessage(
  groups: ChatMessage[][],
  options?: {
    latestSkillInstructionPinned?: boolean
    retainedGroups?: ChatMessage[][]
  }
): ChatMessage {
  return buildWorkflowLedgerHandoffMessage({
    groups,
    latestSkillInstructionPinned: options?.latestSkillInstructionPinned,
    retainedGroups: options?.retainedGroups,
  })
}

function buildBoundedActiveToolGroupSelection(
  group: ChatMessage[],
  budget: number
): MessageSelection {
  if (group.length === 0 || budget <= 0) {
    return {
      retainedMessages: [],
      excludedMessages: group,
      droppedMessages: [],
      suppressedToolCallIds: new Set(),
      replacements: new Map(),
    }
  }

  const assistant = group.find(
    message => message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0
  )

  if (!assistant) {
    return {
      retainedMessages: group.slice(-budget),
      excludedMessages: group,
      droppedMessages: [],
      suppressedToolCallIds: new Set(),
      replacements: new Map(),
    }
  }

  if (group.length <= budget) {
    return {
      retainedMessages: group,
      excludedMessages: group,
      droppedMessages: [],
      suppressedToolCallIds: new Set(),
      replacements: new Map(),
    }
  }

  const toolResults = group.filter(
    (message) => message.role === 'tool' && typeof message.tool_call_id === 'string'
  )

  if (budget === 1) {
    const lastToolCallId = assistant.tool_calls?.at(-1)?.id
    const replacements = new Map<ChatMessage, ChatMessage>()

    if (lastToolCallId) {
      replacements.set(
        assistant,
        cloneAssistantWithSelectedToolCalls(assistant, new Set([lastToolCallId]))
      )
    }

    return {
      retainedMessages: [assistant],
      excludedMessages: group,
      droppedMessages: [],
      suppressedToolCallIds: new Set(
        getAssistantToolCallIds(assistant).filter(toolCallId => toolCallId !== lastToolCallId)
      ),
      replacements,
    }
  }

  const selectedToolResults = toolResults.slice(-(budget - 1))
  const selectedToolCallIds = new Set(
    selectedToolResults
      .map(message => message.tool_call_id)
      .filter((toolCallId): toolCallId is string => typeof toolCallId === 'string' && toolCallId.length > 0)
  )

  const assistantReplacement = cloneAssistantWithSelectedToolCalls(assistant, selectedToolCallIds)
  const replacements = new Map<ChatMessage, ChatMessage>()

  if (assistantReplacement !== assistant) {
    replacements.set(assistant, assistantReplacement)
  }

  return {
    retainedMessages: [assistant, ...selectedToolResults],
    excludedMessages: group,
    droppedMessages: [],
    suppressedToolCallIds: new Set(
      getAssistantToolCallIds(assistant).filter(toolCallId => !selectedToolCallIds.has(toolCallId))
    ),
    replacements,
  }
}

function collectActiveToolWorkflowMessages(messages: ChatMessage[]): MessageSelection {
  const lastSettledAssistantIndex = [...messages]
    .map((message, index) => ({ message, index }))
    .reverse()
    .find(({ message }) => isSettledAssistantReply(message))
    ?.index ?? -1

  const suffix = messages.slice(lastSettledAssistantIndex + 1)
  const hasActiveToolWorkflow = suffix.some(isToolWorkflowMessage)

  if (!hasActiveToolWorkflow) {
    return {
      retainedMessages: [],
      excludedMessages: [],
      droppedMessages: [],
      suppressedToolCallIds: new Set(),
      replacements: new Map(),
    }
  }

  const groups = groupTrimableMessages(suffix).filter(
    group => group.some(isToolWorkflowMessage)
  )

  if (groups.length === 0) {
    return {
      retainedMessages: [],
      excludedMessages: [],
      droppedMessages: [],
      suppressedToolCallIds: new Set(),
      replacements: new Map(),
    }
  }

  const excludedMessages = groups.flat()
  const droppedMessages: ChatMessage[] = []
  const suppressedToolCallIds = new Set<string>()
  const retainedGroups: ChatMessage[][] = []
  const replacements = new Map<ChatMessage, ChatMessage>()
  const retainedGroupIndexes = new Set<number>()
  const latestSkillInstructionGroupIndex = [...groups]
    .map((group, index) => ({ group, index }))
    .reverse()
    .find(({ group }) => isSkillInstructionExchangeGroup(group))
    ?.index
  let usedCount = 0
  const shouldCollapseCompletedHistory = groups.length > 2
  const postPinnedPartialGroupIndexes = latestSkillInstructionGroupIndex === undefined
    ? []
    : groups
      .map((group, index) => ({ group, index }))
      .filter(({ index, group }) =>
        index > latestSkillInstructionGroupIndex && isPartialToolExchangeGroup(group)
      )
      .map(({ index }) => index)
      .reverse()
  const shouldRetainOnlyPartialPostSkillGroups =
    latestSkillInstructionGroupIndex !== undefined
  const iterationIndexes = shouldRetainOnlyPartialPostSkillGroups
    ? postPinnedPartialGroupIndexes
    : shouldCollapseCompletedHistory
      ? [groups.length - 1]
    : Array.from({ length: groups.length }, (_, offset) => groups.length - 1 - offset)

  if (
    latestSkillInstructionGroupIndex !== undefined
    && !retainedGroupIndexes.has(latestSkillInstructionGroupIndex)
  ) {
    const latestSkillInstructionGroup = groups[latestSkillInstructionGroupIndex]
    retainedGroups.unshift(latestSkillInstructionGroup)
    retainedGroupIndexes.add(latestSkillInstructionGroupIndex)
    usedCount += latestSkillInstructionGroup.length
  }

  for (const index of iterationIndexes) {
    if (retainedGroupIndexes.has(index)) {
      continue
    }

    const group = groups[index]
    const remainingBudget = MAX_ACTIVE_TOOL_WORKFLOW_MESSAGES - usedCount

    if (remainingBudget <= 0) {
      break
    }

    if (group.length <= remainingBudget) {
      retainedGroups.unshift(group)
      retainedGroupIndexes.add(index)
      usedCount += group.length
      continue
    }

    if (retainedGroups.length === 0) {
      const selection = buildBoundedActiveToolGroupSelection(group, remainingBudget)
      retainedGroups.unshift(selection.retainedMessages)
      retainedGroupIndexes.add(index)
      for (const [original, replacement] of selection.replacements.entries()) {
        replacements.set(original, replacement)
      }
      for (const toolCallId of selection.suppressedToolCallIds) {
        suppressedToolCallIds.add(toolCallId)
      }
    }
    break
  }

  const summarizedGroups = groups.filter(
    (group, index) =>
      !retainedGroupIndexes.has(index)
      && isCompletedToolExchangeGroup(group)
      && (
        latestSkillInstructionGroupIndex === undefined
        || index > latestSkillInstructionGroupIndex
        || !isSkillInstructionExchangeGroup(group)
      )
  )
  const handoffAnchor = summarizedGroups[0]?.find(
    message => message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0
  )

  if (handoffAnchor) {
    retainedGroups.unshift([handoffAnchor])
    replacements.set(handoffAnchor, buildCompletedToolExchangeHandoffMessage(
      summarizedGroups,
      {
        latestSkillInstructionPinned: latestSkillInstructionGroupIndex !== undefined,
        retainedGroups,
      }
    ))
    for (const group of summarizedGroups) {
      for (const message of group) {
        if (message.role === 'assistant') {
          for (const toolCallId of getAssistantToolCallIds(message)) {
            suppressedToolCallIds.add(toolCallId)
          }
        }
        if (message !== handoffAnchor) {
          droppedMessages.push(message)
        }
      }
    }
  }

  logContextManagementDiagnostic('Active tool workflow selection', {
    suffixLength: suffix.length,
    toolWorkflowGroupCount: groups.length,
    retainedGroupCount: retainedGroups.length,
    summarizedGroupCount: summarizedGroups.length,
    handoffApplied: Boolean(handoffAnchor),
    replacementCount: replacements.size,
    latestSkillInstructionGroupPinned: latestSkillInstructionGroupIndex !== undefined,
  })

  return {
    retainedMessages: retainedGroups.flat(),
    excludedMessages,
    droppedMessages,
    suppressedToolCallIds,
    replacements,
  }
}

function preserveOriginalOrder(
  messages: ChatMessage[],
  keptMessages: ChatMessage[]
): ChatMessage[] {
  const keptSet = new Set<ChatMessage>(keptMessages)
  return messages.filter(message => keptSet.has(message))
}

function applyMessageReplacements(
  messages: ChatMessage[],
  replacements: Map<ChatMessage, ChatMessage>
): ChatMessage[] {
  if (replacements.size === 0) {
    return messages
  }

  return messages.map(message => replacements.get(message) ?? message)
}

function applyDroppedMessages(
  messages: ChatMessage[],
  droppedMessages: ChatMessage[]
): ChatMessage[] {
  if (droppedMessages.length === 0) {
    return messages
  }

  const droppedSet = new Set<ChatMessage>(droppedMessages)
  return messages.filter(message => !droppedSet.has(message))
}

function groupTrimableMessages(messages: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = []

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]

    if (message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0) {
      const toolCallIds = new Set(
        (message.tool_calls ?? [])
          .map(call => call?.id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
      )
      const group = [message]
      let lookahead = index + 1

      while (lookahead < messages.length) {
        const candidate = messages[lookahead]
        if (
          candidate.role === 'tool'
          && typeof candidate.tool_call_id === 'string'
          && toolCallIds.has(candidate.tool_call_id)
        ) {
          group.push(candidate)
          lookahead++
          continue
        }

        break
      }

      groups.push(group)
      index = lookahead - 1
      continue
    }

    groups.push([message])
  }

  return groups
}

function takeRecentTrimableMessages(messages: ChatMessage[], maxCount: number): ChatMessage[] {
  if (maxCount <= 0 || messages.length === 0) {
    return []
  }

  const groups = groupTrimableMessages(messages)
  const selectedGroups: ChatMessage[][] = []
  let usedCount = 0

  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index]
    if (usedCount + group.length > maxCount) {
      break
    }

    selectedGroups.unshift(group)
    usedCount += group.length
  }

  return selectedGroups.flat()
}

function insertSummaryBeforeRecentMessages(
  messages: ChatMessage[],
  protectedMessages: ChatMessage[],
  recentMessages: ChatMessage[],
  summaryMessage: ChatMessage
): ChatMessage[] {
  const preserved = preserveOriginalOrder(messages, [...protectedMessages, ...recentMessages])
  const recentSet = new Set<ChatMessage>(recentMessages)
  const firstRecentIndex = preserved.findIndex(message => recentSet.has(message))

  if (firstRecentIndex === -1) {
    return [...preserved, summaryMessage]
  }

  return [
    ...preserved.slice(0, firstRecentIndex),
    summaryMessage,
    ...preserved.slice(firstRecentIndex),
  ]
}

function buildSummaryMessage(summary: string): ChatMessage {
  return {
    role: 'system',
    content: [
      '[Prior conversation summary — non-authoritative narrative. Tool catalog and MCP capabilities are re-injected below by the runtime and take precedence over anything summarized here.]',
      summary,
    ].join('\n'),
  }
}

/**
 * Sliding Window Strategy
 * Keeps the most recent N messages, always preserving system and tool-definition messages
 */
export class SlidingWindowStrategy {
  private config: SlidingWindowConfig

  constructor(config: SlidingWindowConfig = DEFAULT_SLIDING_WINDOW_CONFIG) {
    this.config = { ...DEFAULT_SLIDING_WINDOW_CONFIG, ...config }
  }

  execute(messages: ChatMessage[]): StrategyResult {
    const originalCount = messages.length

    if (!this.config.enabled || originalCount <= this.config.maxMessages) {
      return {
        messages,
        originalCount,
        processedCount: originalCount,
        strategyName: 'slidingWindow',
        trimmed: false,
        subkind: 'not_applicable',
      }
    }

    const activeToolWorkflowSelection = collectActiveToolWorkflowMessages(messages)
    const pinnedInstructionToolMessages = collectPinnedInstructionToolMessages(messages)
    const protectedMessages = messages.filter(
      msg => msg.role === 'system'
        || containsToolDefinitions(msg)
        || activeToolWorkflowSelection.retainedMessages.includes(msg)
        || pinnedInstructionToolMessages.includes(msg)
    )
    const trimableMessages = messages.filter(
      msg => msg.role !== 'system'
        && !containsToolDefinitions(msg)
        && !activeToolWorkflowSelection.excludedMessages.includes(msg)
        && !pinnedInstructionToolMessages.includes(msg)
    )

    const maxTrimableMessages = this.config.maxMessages - protectedMessages.length
    const keptTrimableMessages = takeRecentTrimableMessages(
      trimableMessages,
      Math.max(0, maxTrimableMessages)
    )

    // Preserve original insertion order — protected messages must not float to array front
    const result = applyDroppedMessages(
      applyMessageReplacements(
        preserveOriginalOrder(messages, [...protectedMessages, ...keptTrimableMessages]),
        activeToolWorkflowSelection.replacements
      ),
      activeToolWorkflowSelection.droppedMessages
    )

    console.log(
      `[SlidingWindowStrategy] Trimmed from ${originalCount} to ${result.length} messages ` +
        `(protected: ${protectedMessages.length}, trimable: ${keptTrimableMessages.length})`
    )

    return {
      messages: result,
      originalCount,
      processedCount: result.length,
      strategyName: 'slidingWindow',
      trimmed: result.length < originalCount,
    }
  }
}

/**
 * Token Limit Strategy
 * Truncates history by token count, always preserving system messages
 */
export class TokenLimitStrategy {
  private config: TokenLimitConfig

  constructor(config: TokenLimitConfig = DEFAULT_TOKEN_LIMIT_CONFIG) {
    this.config = { ...DEFAULT_TOKEN_LIMIT_CONFIG, ...config }
  }

  execute(messages: ChatMessage[]): StrategyResult {
    const originalCount = messages.length

    if (!this.config.enabled) {
      return {
        messages,
        originalCount,
        processedCount: originalCount,
        strategyName: 'tokenLimit',
        trimmed: false,
        subkind: 'not_applicable',
      }
    }

    const activeToolWorkflowSelection = collectActiveToolWorkflowMessages(messages)
    const pinnedInstructionToolMessages = collectPinnedInstructionToolMessages(messages)
    const protectedMessages = messages.filter(
      msg => msg.role === 'system'
        || containsToolDefinitions(msg)
        || activeToolWorkflowSelection.retainedMessages.includes(msg)
        || pinnedInstructionToolMessages.includes(msg)
    )
    const nonProtectedMessages = messages.filter(
      msg => msg.role !== 'system'
        && !containsToolDefinitions(msg)
        && !activeToolWorkflowSelection.excludedMessages.includes(msg)
        && !pinnedInstructionToolMessages.includes(msg)
    )

    const protectedTokens = protectedMessages.reduce(
      (total, msg) => total + estimateTokens(msg.content),
      0
    )

    const availableTokens = this.config.maxTokens - protectedTokens

    if (availableTokens <= 0) {
      console.warn(
        `[TokenLimitStrategy] Protected messages already exceed token limit ` +
          `(${protectedTokens} > ${this.config.maxTokens})`
      )
      // Trim protected messages content to fit, then add non-protected messages
      const reserveForNonProtected = Math.min(this.config.maxTokens * 0.3, this.config.maxTokens)
      const protectedMax = this.config.maxTokens - reserveForNonProtected
      
      const trimmedProtected = protectedMessages.map(msg => {
        if (typeof msg.content === 'string') {
          return { ...msg, content: msg.content.slice(-protectedMax) }
        }
        return msg
      })
      
      const keptNonProtected: ChatMessage[] = []
      let usedTokens = reserveForNonProtected > 0 ? protectedMax : 0
      for (let i = nonProtectedMessages.length - 1; i >= 0; i--) {
        const msg = nonProtectedMessages[i]
        const msgTokens = estimateTokens(msg.content)
        if (usedTokens + msgTokens <= this.config.maxTokens) {
          keptNonProtected.unshift(msg)
          usedTokens += msgTokens
        } else if (keptNonProtected.length === 0 && nonProtectedMessages.length > 0) {
          // Always keep at least the last user message
          keptNonProtected.unshift(nonProtectedMessages[nonProtectedMessages.length - 1])
          break
        } else {
          break
        }
      }
      
      const result = applyDroppedMessages(
        applyMessageReplacements(
          [...trimmedProtected, ...keptNonProtected],
          activeToolWorkflowSelection.replacements
        ),
        activeToolWorkflowSelection.droppedMessages
      )
      console.log(
        `[TokenLimitStrategy] Protected exceeded limit - kept ${result.length} messages ` +
          `(trimmed protected + ${keptNonProtected.length} non-protected)`
      )
      
      return {
        messages: result,
        originalCount,
        processedCount: result.length,
        strategyName: 'tokenLimit',
        trimmed: true,
      }
    }

    const keptNonProtectedMessages: ChatMessage[] = []
    let currentTokens = 0

    // Walk backwards to select the most-recent messages that fit within the budget.
    // Skip over oversized messages so earlier tool-call/tool-result pairs can still survive
    // and be restored by preserveToolExchangePairs.
    for (let i = nonProtectedMessages.length - 1; i >= 0; i--) {
      const msg = nonProtectedMessages[i]
      const msgTokens = estimateTokens(msg.content)

      if (currentTokens + msgTokens <= availableTokens) {
        keptNonProtectedMessages.unshift(msg)
        currentTokens += msgTokens
      } else {
        continue
      }
    }

    // Preserve original insertion order — filter original array rather than concatenating buckets
    const result = applyDroppedMessages(
      applyMessageReplacements(
        preserveOriginalOrder(messages, [...protectedMessages, ...keptNonProtectedMessages]),
        activeToolWorkflowSelection.replacements
      ),
      activeToolWorkflowSelection.droppedMessages
    )
    const totalTokens = protectedTokens + currentTokens

    console.log(
      `[TokenLimitStrategy] Trimmed from ${originalCount} to ${result.length} messages ` +
        `(tokens: ${totalTokens}/${this.config.maxTokens})`
    )

    return {
      messages: result,
      originalCount,
      processedCount: result.length,
      strategyName: 'tokenLimit',
      trimmed: result.length < originalCount,
    }
  }
}

/**
 * Summary Generation Function Type
 */
export type SummaryGenerator = (
  messages: ChatMessage[],
  prompt?: string
) => Promise<string>

/**
 * Summary Compression Strategy
 * Generates summary for early conversation, keeps recent messages + summary
 */
export class SummaryStrategy {
  private config: SummaryConfig
  private summaryGenerator?: SummaryGenerator

  constructor(
    config: SummaryConfig = DEFAULT_SUMMARY_CONFIG,
    summaryGenerator?: SummaryGenerator
  ) {
    this.config = { ...DEFAULT_SUMMARY_CONFIG, ...config }
    this.summaryGenerator = summaryGenerator
  }

  async execute(messages: ChatMessage[]): Promise<StrategyResult> {
    const originalCount = messages.length

    if (!this.config.enabled) {
      return {
        messages,
        originalCount,
        processedCount: originalCount,
        strategyName: 'summary',
        trimmed: false,
        subkind: 'not_applicable',
      }
    }

    if (originalCount <= this.config.keepRecentMessages) {
      return {
        messages,
        originalCount,
        processedCount: originalCount,
        strategyName: 'summary',
        trimmed: false,
        subkind: 'summary_not_needed',
      }
    }

    if (!this.summaryGenerator) {
      console.warn('[SummaryStrategy] No summary generator provided, using local fallback summary')
      const activeToolWorkflowSelection = collectActiveToolWorkflowMessages(messages)
      const pinnedInstructionToolMessages = collectPinnedInstructionToolMessages(messages)
      const protectedMessages = messages.filter(
        msg => msg.role === 'system'
          || containsToolDefinitions(msg)
          || activeToolWorkflowSelection.retainedMessages.includes(msg)
          || pinnedInstructionToolMessages.includes(msg)
      )
      const trimableMessages = messages.filter(
        msg => msg.role !== 'system'
          && !containsToolDefinitions(msg)
          && !activeToolWorkflowSelection.excludedMessages.includes(msg)
          && !pinnedInstructionToolMessages.includes(msg)
      )
      const recentMessages = takeRecentTrimableMessages(
        trimableMessages,
        this.config.keepRecentMessages
      )
      const oldMessages = trimableMessages.slice(0, trimableMessages.length - recentMessages.length)
      const fallbackSummaryMessage = buildSummaryMessage(buildLocalFallbackSummary(oldMessages))
      const fallbackMessages = applyDroppedMessages(
        applyMessageReplacements(
          insertSummaryBeforeRecentMessages(
            messages,
            protectedMessages,
            recentMessages,
            fallbackSummaryMessage
          ),
          activeToolWorkflowSelection.replacements
        ),
        activeToolWorkflowSelection.droppedMessages
      )
      return {
        messages: fallbackMessages,
        originalCount,
        processedCount: fallbackMessages.length,
        strategyName: 'summary',
        trimmed: true,
        subkind: 'summary_fallback_local',
      }
    }

    const activeToolWorkflowSelection = collectActiveToolWorkflowMessages(messages)
    const pinnedInstructionToolMessages = collectPinnedInstructionToolMessages(messages)
    const protectedMessages = messages.filter(
      msg => msg.role === 'system'
        || containsToolDefinitions(msg)
        || activeToolWorkflowSelection.retainedMessages.includes(msg)
        || pinnedInstructionToolMessages.includes(msg)
    )
    const trimableMessages = messages.filter(
      msg => msg.role !== 'system'
        && !containsToolDefinitions(msg)
        && !activeToolWorkflowSelection.excludedMessages.includes(msg)
        && !pinnedInstructionToolMessages.includes(msg)
    )

    const recentMessages = takeRecentTrimableMessages(
      trimableMessages,
      this.config.keepRecentMessages
    )
    const oldMessages = trimableMessages.slice(0, trimableMessages.length - recentMessages.length)

    if (activeToolWorkflowSelection.replacements.size > 0) {
      const fallbackMessages = applyDroppedMessages(
        applyMessageReplacements(
          preserveOriginalOrder(messages, [...protectedMessages, ...recentMessages]),
          activeToolWorkflowSelection.replacements
        ),
        activeToolWorkflowSelection.droppedMessages
      )
      console.log(
        `[SummaryStrategy] Skipping external summary generation during active tool workflow; ` +
          `using structured handoff (${originalCount} -> ${fallbackMessages.length})`
      )
      return {
        messages: fallbackMessages,
        originalCount,
        processedCount: fallbackMessages.length,
        strategyName: 'summary',
        trimmed: true,
        subkind: 'summary_skipped_active_tool_workflow',
      }
    }

    if (oldMessages.length === 0) {
      return {
        messages,
        originalCount,
        processedCount: originalCount,
        strategyName: 'summary',
        trimmed: false,
        subkind: 'summary_not_needed',
      }
    }

    try {
      console.log(
        `[SummaryStrategy] Generating summary for ${oldMessages.length} old messages`
      )

      const summary = await this.summaryGenerator(
        oldMessages,
        this.config.summaryPrompt
      )

      if (isUnusableSummary(summary)) {
        throw new Error(`Summary generator returned unusable summary: ${summary.trim()}`)
      }

      // INV-005: Guard against the summarizer reproducing tool catalog content.
      // If contaminated, fall back to sliding-window for this compaction round.
      const contamination = detectSummaryContamination(summary)
      if (contamination.contaminated) {
        console.warn(
          `[SummaryStrategy] Summary contamination detected (${contamination.signatures.length} signature(s)) — ` +
            `using local fallback summary for this round`,
          contamination.signatures.map(h => h.signature)
        )
        const fallbackSummaryMessage = buildSummaryMessage(buildLocalFallbackSummary(oldMessages))
        const fallbackMessages = applyDroppedMessages(
          applyMessageReplacements(
            insertSummaryBeforeRecentMessages(
              messages,
              protectedMessages,
              recentMessages,
              fallbackSummaryMessage
            ),
            activeToolWorkflowSelection.replacements
          ),
          activeToolWorkflowSelection.droppedMessages
        )
        return {
          messages: fallbackMessages,
          originalCount,
          processedCount: fallbackMessages.length,
          strategyName: 'summary',
          trimmed: true,
          subkind: 'summary_fallback_local',
        }
      }

      const summaryMessage: ChatMessage = buildSummaryMessage(summary)

      const result = applyDroppedMessages(
        applyMessageReplacements(
          insertSummaryBeforeRecentMessages(
            messages,
            protectedMessages,
            recentMessages,
            summaryMessage
          ),
          activeToolWorkflowSelection.replacements
        ),
        activeToolWorkflowSelection.droppedMessages
      )

      console.log(
        `[SummaryStrategy] Compressed from ${originalCount} to ${result.length} messages ` +
          `(summary generated for ${oldMessages.length} messages)`
      )

      return {
        messages: result,
        originalCount,
        processedCount: result.length,
        strategyName: 'summary',
        trimmed: true,
        subkind: 'summary_success',
      }
    } catch (error) {
      console.error('[SummaryStrategy] Failed to generate summary:', error)
      const fallbackSummaryMessage = buildSummaryMessage(buildLocalFallbackSummary(oldMessages))
      const fallbackMessages = applyDroppedMessages(
        applyMessageReplacements(
          insertSummaryBeforeRecentMessages(
            messages,
            protectedMessages,
            recentMessages,
            fallbackSummaryMessage
          ),
          activeToolWorkflowSelection.replacements
        ),
        activeToolWorkflowSelection.droppedMessages
      )
      return {
        messages: fallbackMessages,
        originalCount,
        processedCount: fallbackMessages.length,
        strategyName: 'summary',
        trimmed: true,
        subkind: 'summary_fallback_local',
      }
    }
  }
}

/**
 * Context Management Service
 * Orchestrates multiple context management strategies
 */
export class ContextManagementService {
  private config: ContextManagementConfig
  private slidingWindowStrategy: SlidingWindowStrategy
  private tokenLimitStrategy: TokenLimitStrategy
  private summaryStrategy: SummaryStrategy

  constructor(
    config: ContextManagementConfig = DEFAULT_CONTEXT_MANAGEMENT_CONFIG,
    summaryGenerator?: SummaryGenerator
  ) {
    this.config = { ...DEFAULT_CONTEXT_MANAGEMENT_CONFIG, ...config }
    this.slidingWindowStrategy = new SlidingWindowStrategy(
      this.config.strategies.slidingWindow
    )
    this.tokenLimitStrategy = new TokenLimitStrategy(
      this.config.strategies.tokenLimit
    )
    this.summaryStrategy = new SummaryStrategy(
      this.config.strategies.summary,
      summaryGenerator
    )
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<ContextManagementConfig>): void {
    this.config = {
      ...this.config,
      ...config,
      strategies: {
        ...this.config.strategies,
        ...(config.strategies || {}),
      },
    }

    this.slidingWindowStrategy = new SlidingWindowStrategy(
      this.config.strategies.slidingWindow
    )
    this.tokenLimitStrategy = new TokenLimitStrategy(
      this.config.strategies.tokenLimit
    )
    this.summaryStrategy = new SummaryStrategy(
      this.config.strategies.summary,
      this.summaryStrategy['summaryGenerator']
    )
  }

  /**
   * Process messages through all enabled strategies
   */
  async process(messages: ChatMessage[]): Promise<ContextProcessResult> {
    const originalCount = messages.length
    const strategyResults: StrategyResult[] = []

    if (!this.config.enabled) {
      return {
        messages,
        originalCount,
        finalCount: originalCount,
        strategyResults: [],
        summaryGenerated: false,
      }
    }

    console.log(
      `[ContextManagementService] Processing ${originalCount} messages ` +
        `with order: ${this.config.executionOrder.join(', ')}`
    )
    console.log('[ContextManagementService] Config trace:', JSON.stringify({
      slidingWindow: {
        enabled: this.config.strategies.slidingWindow.enabled,
        maxMessages: this.config.strategies.slidingWindow.maxMessages,
      },
      tokenLimit: {
        enabled: this.config.strategies.tokenLimit.enabled,
        maxTokens: this.config.strategies.tokenLimit.maxTokens,
      },
      summary: {
        enabled: this.config.strategies.summary.enabled,
        keepRecentMessages: this.config.strategies.summary.keepRecentMessages,
      },
      messageRoles: messages.map(message => message.role),
      systemMessageCount: messages.filter(message => message.role === 'system').length,
      toolCallMessageCount: messages.filter(message => message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0).length,
      toolResultMessageCount: messages.filter(message => message.role === 'tool' && typeof message.tool_call_id === 'string').length,
    }))

    let currentMessages = [...messages]
    let summaryGenerated = false

    for (const strategyName of this.config.executionOrder) {
      let result: StrategyResult

      switch (strategyName) {
        case 'slidingWindow':
          result = this.slidingWindowStrategy.execute(currentMessages)
          break

        case 'tokenLimit':
          result = this.tokenLimitStrategy.execute(currentMessages)
          break

        case 'summary':
          result = await this.summaryStrategy.execute(currentMessages)
          if (result.subkind === 'summary_success' || result.subkind === 'summary_fallback_local') {
            summaryGenerated = true
          }
          break

        default:
          console.warn(`[ContextManagementService] Unknown strategy: ${strategyName}`)
          continue
      }

      logContextManagementDiagnostic('Preserve tool exchange pairs before', {
        strategyName,
        beforePreserveCount: result.messages.length,
        beforeToolCallCount: countAssistantToolMessages(result.messages),
        beforeToolResultCount: countToolResultMessages(result.messages),
      })

      const activeToolWorkflowSelection = collectActiveToolWorkflowMessages(currentMessages)
      const preservedMessages = preserveToolExchangePairs(
        currentMessages,
        result.messages,
        { suppressedToolCallIds: activeToolWorkflowSelection.suppressedToolCallIds }
      )

      logContextManagementDiagnostic('Preserve tool exchange pairs after', {
        strategyName,
        beforePreserveCount: result.messages.length,
        afterPreserveCount: preservedMessages.length,
        beforeToolCallCount: countAssistantToolMessages(result.messages),
        afterToolCallCount: countAssistantToolMessages(preservedMessages),
        beforeToolResultCount: countToolResultMessages(result.messages),
        afterToolResultCount: countToolResultMessages(preservedMessages),
      })

      result = {
        ...result,
        messages: preservedMessages,
        processedCount: preservedMessages.length,
      }

      strategyResults.push(result)
      currentMessages = result.messages
      console.log('[ContextManagementService] Strategy trace:', JSON.stringify({
        strategyName,
        subkind: result.subkind,
        trimmed: result.trimmed,
        originalCount: result.originalCount,
        processedCount: result.processedCount,
        preservedToolCallMessages: result.messages.filter(
          message => message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0
        ).length,
        preservedToolResultMessages: result.messages.filter(
          message => message.role === 'tool' && typeof message.tool_call_id === 'string'
        ).length,
        systemMessageCount: result.messages.filter(message => message.role === 'system').length,
      }))

      if (result.trimmed) {
        console.log(
          `[ContextManagementService] Strategy ${strategyName} trimmed ` +
            `${result.originalCount} -> ${result.processedCount} messages`
        )
      }
    }

    console.log(
      `[ContextManagementService] Final result: ${originalCount} -> ${currentMessages.length} messages`
    )

    return {
      messages: currentMessages,
      originalCount,
      finalCount: currentMessages.length,
      strategyResults,
      summaryGenerated,
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): ContextManagementConfig {
    return { ...this.config }
  }

  /**
   * Estimate total tokens for messages
   */
  static estimateTotalTokens(messages: ChatMessage[]): number {
    return messages.reduce((total, msg) => total + estimateTokens(msg.content), 0)
  }
}

/**
 * Create default context management service instance
 */
export function createContextManagementService(
  config?: Partial<ContextManagementConfig>,
  summaryGenerator?: SummaryGenerator
): ContextManagementService {
  const finalConfig: ContextManagementConfig = {
    ...DEFAULT_CONTEXT_MANAGEMENT_CONFIG,
    ...config,
    strategies: {
      ...DEFAULT_CONTEXT_MANAGEMENT_CONFIG.strategies,
      ...(config?.strategies || {}),
    },
  }

  return new ContextManagementService(finalConfig, summaryGenerator)
}
