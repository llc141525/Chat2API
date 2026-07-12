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
  | 'summary_generator_missing'
  | 'summary_generator_failed'
  | 'summary_not_needed'
  | 'summary_contaminated'

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

function collectPinnedInstructionToolMessages(messages: ChatMessage[]): ChatMessage[] {
  const pinnedToolCallIds = new Set<string>()

  for (const message of messages) {
    if (message.role !== 'assistant') continue

    for (const call of message.tool_calls ?? []) {
      if (call?.id && call.function?.name === 'skill') {
        pinnedToolCallIds.add(call.id)
      }
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

function collectActiveToolWorkflowMessages(messages: ChatMessage[]): ChatMessage[] {
  const lastSettledAssistantIndex = [...messages]
    .map((message, index) => ({ message, index }))
    .reverse()
    .find(({ message }) => isSettledAssistantReply(message))
    ?.index ?? -1

  const suffix = messages.slice(lastSettledAssistantIndex + 1)
  const hasActiveToolWorkflow = suffix.some(isToolWorkflowMessage)

  if (!hasActiveToolWorkflow) {
    return []
  }

  return suffix.slice(-MAX_ACTIVE_TOOL_WORKFLOW_MESSAGES)
}

function preserveOriginalOrder(
  messages: ChatMessage[],
  keptMessages: ChatMessage[]
): ChatMessage[] {
  const keptSet = new Set<ChatMessage>(keptMessages)
  return messages.filter(message => keptSet.has(message))
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

    const activeToolWorkflowMessages = collectActiveToolWorkflowMessages(messages)
    const pinnedInstructionToolMessages = collectPinnedInstructionToolMessages(messages)
    const protectedMessages = messages.filter(
      msg => msg.role === 'system'
        || containsToolDefinitions(msg)
        || activeToolWorkflowMessages.includes(msg)
        || pinnedInstructionToolMessages.includes(msg)
    )
    const trimableMessages = messages.filter(
      msg => msg.role !== 'system'
        && !containsToolDefinitions(msg)
        && !activeToolWorkflowMessages.includes(msg)
        && !pinnedInstructionToolMessages.includes(msg)
    )

    const maxTrimableMessages = this.config.maxMessages - protectedMessages.length
    const keptTrimableMessages = trimableMessages.slice(-Math.max(0, maxTrimableMessages))

    // Preserve original insertion order — protected messages must not float to array front
    const result = preserveOriginalOrder(messages, [...protectedMessages, ...keptTrimableMessages])

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

    const activeToolWorkflowMessages = collectActiveToolWorkflowMessages(messages)
    const pinnedInstructionToolMessages = collectPinnedInstructionToolMessages(messages)
    const protectedMessages = messages.filter(
      msg => msg.role === 'system'
        || containsToolDefinitions(msg)
        || activeToolWorkflowMessages.includes(msg)
        || pinnedInstructionToolMessages.includes(msg)
    )
    const nonProtectedMessages = messages.filter(
      msg => msg.role !== 'system'
        && !containsToolDefinitions(msg)
        && !activeToolWorkflowMessages.includes(msg)
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
      
      const result = [...trimmedProtected, ...keptNonProtected]
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
    const result = preserveOriginalOrder(messages, [...protectedMessages, ...keptNonProtectedMessages])
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
      console.warn('[SummaryStrategy] No summary generator provided, falling back to sliding window')
      const activeToolWorkflowMessages = collectActiveToolWorkflowMessages(messages)
      const pinnedInstructionToolMessages = collectPinnedInstructionToolMessages(messages)
      const protectedMessages = messages.filter(
        msg => msg.role === 'system'
          || containsToolDefinitions(msg)
          || activeToolWorkflowMessages.includes(msg)
          || pinnedInstructionToolMessages.includes(msg)
      )
      const trimableMessages = messages.filter(
        msg => msg.role !== 'system'
          && !containsToolDefinitions(msg)
          && !activeToolWorkflowMessages.includes(msg)
          && !pinnedInstructionToolMessages.includes(msg)
      )
      const recentMessages = trimableMessages.slice(-this.config.keepRecentMessages)
      const fallbackMessages = preserveOriginalOrder(messages, [...protectedMessages, ...recentMessages])
      return {
        messages: fallbackMessages,
        originalCount,
        processedCount: fallbackMessages.length,
        strategyName: 'summary',
        trimmed: true,
        subkind: 'summary_generator_missing',
      }
    }

    const activeToolWorkflowMessages = collectActiveToolWorkflowMessages(messages)
    const pinnedInstructionToolMessages = collectPinnedInstructionToolMessages(messages)
    const protectedMessages = messages.filter(
      msg => msg.role === 'system'
        || containsToolDefinitions(msg)
        || activeToolWorkflowMessages.includes(msg)
        || pinnedInstructionToolMessages.includes(msg)
    )
    const trimableMessages = messages.filter(
      msg => msg.role !== 'system'
        && !containsToolDefinitions(msg)
        && !activeToolWorkflowMessages.includes(msg)
        && !pinnedInstructionToolMessages.includes(msg)
    )

    const recentMessages = trimableMessages.slice(-this.config.keepRecentMessages)
    const oldMessages = trimableMessages.slice(0, -this.config.keepRecentMessages)

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

      if (summary.trim().length === 0) {
        throw new Error('Summary generator returned empty summary')
      }

      // INV-005: Guard against the summarizer reproducing tool catalog content.
      // If contaminated, fall back to sliding-window for this compaction round.
      const contamination = detectSummaryContamination(summary)
      if (contamination.contaminated) {
        console.warn(
          `[SummaryStrategy] Summary contamination detected (${contamination.signatures.length} signature(s)) — ` +
            `falling back to sliding-window for this round`,
          contamination.signatures.map(h => h.signature)
        )
        const fallbackMessages = preserveOriginalOrder(messages, [...protectedMessages, ...recentMessages])
        return {
          messages: fallbackMessages,
          originalCount,
          processedCount: fallbackMessages.length,
          strategyName: 'summary',
          trimmed: true,
          subkind: 'summary_contaminated',
        }
      }

      const summaryMessage: ChatMessage = buildSummaryMessage(summary)

      const result = insertSummaryBeforeRecentMessages(
        messages,
        protectedMessages,
        recentMessages,
        summaryMessage
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
      const fallbackMessages = preserveOriginalOrder(messages, [...protectedMessages, ...recentMessages])
      return {
        messages: fallbackMessages,
        originalCount,
        processedCount: fallbackMessages.length,
        strategyName: 'summary',
        trimmed: true,
        subkind: 'summary_generator_failed',
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
          if (result.subkind === 'summary_success') {
            summaryGenerated = true
          }
          break

        default:
          console.warn(`[ContextManagementService] Unknown strategy: ${strategyName}`)
          continue
      }

      const preservedMessages = preserveToolExchangePairs(currentMessages, result.messages)
      result = {
        ...result,
        messages: preservedMessages,
        processedCount: preservedMessages.length,
      }

      strategyResults.push(result)
      currentMessages = result.messages

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
