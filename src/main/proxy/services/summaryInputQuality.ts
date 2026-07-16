import type { ChatMessage } from '../types.ts'
import {
  classifyTextPayload,
  extractTextContent,
  summarizePayloadClasses,
  type PayloadClassSummary,
} from './contextPayloadClassifier.ts'

export interface SummaryInputQuality {
  shouldCallProvider: boolean
  reason:
    | 'has_user_goal_or_workflow_facts'
    | 'empty_after_sanitization'
    | 'tool_placeholder_only'
    | 'runtime_config_only'
    | 'skill_doc_only'
    | 'too_contaminated'
  classSummary: PayloadClassSummary
  estimatedUsefulChars: number
  estimatedDiscardedChars: number
}

const TOOL_PLACEHOLDER = /^\s*\[(?:tool calls|tool result) summarized\b/i
const SKILL_DOCUMENT = /\b(?:superpowers|SUBAGENT-STOP|SKILL\.md|available skills|skill workflow)\b/i

export function evaluateSummaryInputQuality(messages: ChatMessage[]): SummaryInputQuality {
  const classSummary = summarizePayloadClasses(messages)
  const nonEmpty = messages
    .map(message => ({ message, text: extractTextContent(message.content).trim() }))
    .filter(entry => entry.text.length > 0)

  const estimatedUsefulChars = nonEmpty.reduce((total, { message, text }) => {
    const className = classifyForQuality(message, text)
    return total + (isUseful(className) ? text.length : 0)
  }, 0)
  const estimatedDiscardedChars = nonEmpty.reduce((total, { message, text }) => {
    const className = classifyForQuality(message, text)
    return total + (isUseful(className) ? 0 : text.length)
  }, 0)

  const result = (reason: SummaryInputQuality['reason'], shouldCallProvider = false): SummaryInputQuality => ({
    shouldCallProvider,
    reason,
    classSummary,
    estimatedUsefulChars,
    estimatedDiscardedChars,
  })

  if (nonEmpty.length === 0) return result('empty_after_sanitization')
  if (nonEmpty.every(({ text }) => TOOL_PLACEHOLDER.test(text))) return result('tool_placeholder_only')
  if (nonEmpty.every(({ text }) => SKILL_DOCUMENT.test(text))) return result('skill_doc_only')
  if (estimatedUsefulChars === 0) return result('runtime_config_only')
  // Allow up to 8× useful-to-discarded ratio with a 2000-char floor.
  // Skill workflows naturally produce large tool_exchange payloads that
  // aren't "contamination" — they're legitimate work output.
  if (estimatedDiscardedChars > Math.max(2000, estimatedUsefulChars * 8)) return result('too_contaminated')
  return result('has_user_goal_or_workflow_facts', true)
}

function classifyForQuality(message: ChatMessage, text: string) {
  if (message.role === 'tool' || (message.tool_calls?.length ?? 0) > 0 || TOOL_PLACEHOLDER.test(text)) {
    return 'tool_exchange' as const
  }
  const classified = classifyTextPayload(text).className
  if (classified !== 'unknown') return classified
  if (message.role === 'user') return 'user_goal' as const
  if (message.role === 'assistant') return 'workflow_fact' as const
  if (message.role === 'system') return 'runtime_config' as const
  return 'runtime_config' as const
}

function isUseful(className: ReturnType<typeof classifyForQuality>): boolean {
  // runtime_config (agent definitions, system instructions) is expected
  // overhead, not contamination. Exclude it from the discarded count so
  // skill workflows with large agent definitions don't get falsely rejected.
  if (className === 'runtime_config') return true
  return className === 'user_goal'
    || className === 'workflow_fact'
    || className === 'workflow_instruction'
    || className === 'provider_checkpoint'
    || className === 'tool_exchange'
}
