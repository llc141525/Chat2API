/**
 * Summary Sanitizer
 *
 * Strips static runtime configuration (tool catalogs, MCP definitions, system directives)
 * from conversation history before it is handed to the summarizer, and detects whether a
 * generated summary has reproduced catalog content despite sanitization.
 *
 * INV-005 Config-vs-History Split: tools, MCP definitions, system prompts describing
 * capabilities, and prompt-embedded tool catalogs are runtime configuration re-derived
 * on every request. They must not travel as narrated content inside messages produced
 * by the summarizer or by prior model turns.
 */

import type { ChatMessage } from '../types'
import { hasGeneralToolPromptSignature, GENERAL_TOOL_SIGNATURES } from '../constants/signatures.ts'

const TOOLS_XML_TEST = /<tools>[\s\S]*?<\/tools>/i
const TOOLS_XML_REPLACE = /<tools>[\s\S]*?<\/tools>/gi

export interface SanitizeResult {
  sanitized: ChatMessage[]
  droppedCount: number
  strippedSignatureCount: number
}

export interface SummarySignatureHit {
  signature: string
  position: number
}

export interface SummaryContaminationResult {
  contaminated: boolean
  signatures: readonly SummarySignatureHit[]
}

/**
 * Sanitize a message list before handing it to the summary generator.
 *
 * - Drops system messages that carry tool catalog signatures or <tools>…</tools> blocks.
 * - Replaces tool-exchange messages (role:tool, messages with tool_calls) with a compact
 *   typed placeholder so the summarizer knows tool activity occurred without replicating schema.
 * - For assistant messages: strips structural tool-catalog spans, keeping natural-language prose.
 *
 * The operation is idempotent: sanitize(sanitize(x)) ≡ sanitize(x).
 */
export function sanitizeMessagesForSummary(messages: ChatMessage[]): SanitizeResult {
  let droppedCount = 0
  let strippedSignatureCount = 0
  const sanitized: ChatMessage[] = []

  for (const msg of messages) {
    if (msg.role === 'system') {
      const content = typeof msg.content === 'string' ? msg.content : ''
      if (hasGeneralToolPromptSignature(content) || TOOLS_XML_TEST.test(content)) {
        droppedCount++
        continue
      }
      sanitized.push(msg)
      continue
    }

    // Tool exchange messages: replace body with placeholder
    if (msg.role === 'tool') {
      if (typeof msg.content === 'string' && msg.content.startsWith('[tool result summarized')) {
        sanitized.push(msg)
        continue
      }
      sanitized.push({
        role: msg.role,
        content: summarizeToolResultMessage(msg),
      })
      strippedSignatureCount++
      continue
    }

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      sanitized.push({
        role: msg.role,
        content: summarizeAssistantToolCalls(msg.tool_calls),
      })
      strippedSignatureCount++
      continue
    }

    if (msg.role === 'assistant') {
      const content = typeof msg.content === 'string' ? msg.content : ''
      if (content.length > 0 && (hasGeneralToolPromptSignature(content) || TOOLS_XML_TEST.test(content))) {
        const stripped = stripToolCatalogSpans(content)
        strippedSignatureCount++
        if (stripped.length === 0) {
          // Don't emit empty assistant turns — they confuse downstream models
          droppedCount++
        } else {
          sanitized.push({ ...msg, content: stripped })
        }
        continue
      }
      sanitized.push(msg)
      continue
    }

    sanitized.push(msg)
  }

  return { sanitized, droppedCount, strippedSignatureCount }
}

/**
 * Detect whether a generated summary text contains tool catalog signatures.
 *
 * Called after summary generation as a safety net: even if the sanitizer ran
 * correctly, the model may have reproduced catalog signatures from other content.
 */
export function detectSummaryContamination(summaryContent: string): SummaryContaminationResult {
  const hits: SummarySignatureHit[] = []

  for (const sig of GENERAL_TOOL_SIGNATURES) {
    const pos = summaryContent.indexOf(sig)
    if (pos !== -1) {
      hits.push({ signature: sig, position: pos })
    }
  }

  const toolsXml = TOOLS_XML_TEST.exec(summaryContent)
  if (toolsXml) {
    hits.push({ signature: '<tools>', position: toolsXml.index })
  }

  return { contaminated: hits.length > 0, signatures: hits }
}

/**
 * Strip tool-catalog spans from an assistant message's content.
 * Removes <tools>…</tools> blocks, then filters out paragraphs that open
 * with a known tool-prompt signature (section headers like "## Available Tools").
 */
function stripToolCatalogSpans(content: string): string {
  let result = content.replace(TOOLS_XML_REPLACE, '')

  // Split into paragraphs and drop any that begin with a tool-catalog signature
  const paragraphs = result.split(/\n{2,}/)
  const kept = paragraphs.filter(para => !hasGeneralToolPromptSignature(para.trimStart()))
  result = kept.join('\n\n')

  return result.trim()
}

function summarizeAssistantToolCalls(toolCalls: NonNullable<ChatMessage['tool_calls']>): string {
  const summarizedCalls = toolCalls.map((toolCall) => {
    const toolName = toolCall.function?.name || 'unknown_tool'
    const args = summarizeArguments(toolCall.function?.arguments)
    return args.length > 0
      ? `${toolName}(${args.join(', ')})`
      : `${toolName}(no arguments)`
  })

  return `[tool calls summarized for workflow continuity] ${summarizedCalls.join('; ')}`
}

function summarizeToolResultMessage(message: ChatMessage): string {
  const toolCallId = typeof message.tool_call_id === 'string' && message.tool_call_id.length > 0
    ? ` ${message.tool_call_id}`
    : ''
  const preview = summarizeResultPreview(message.content)
  return preview.length > 0
    ? `[tool result summarized${toolCallId}] ${preview}`
    : `[tool result summarized${toolCallId}] result received`
}

function summarizeArguments(rawArguments: unknown): string[] {
  const parsed = safeParseJsonObject(rawArguments)
  const entries = Object.entries(parsed)
    .filter(([, value]) => value !== null && value !== undefined)
    .slice(0, 3)

  return entries.map(([key, value]) => `${key}=${formatSummaryValue(value)}`)
}

function safeParseJsonObject(rawArguments: unknown): Record<string, unknown> {
  if (typeof rawArguments !== 'string' || rawArguments.trim().length === 0) {
    return {}
  }

  try {
    const parsed = JSON.parse(rawArguments)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function formatSummaryValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(truncateForSummary(cleanSummaryText(value), 120))
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  return JSON.stringify(truncateForSummary(cleanSummaryText(JSON.stringify(value)), 120))
}

function summarizeResultPreview(content: ChatMessage['content']): string {
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
        .map((item) => (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') ? item.text : '')
        .filter(Boolean)
        .join('\n')
      : ''

  const withoutToolCatalog = stripToolCatalogSpans(text)
  const cleaned = cleanSummaryText(withoutToolCatalog)
  return truncateForSummary(cleaned, 220)
}

function cleanSummaryText(value: string): string {
  return value
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function truncateForSummary(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value
  }
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}
