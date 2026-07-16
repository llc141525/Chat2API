import type { ChatMessage } from '../types.ts'

export type ContextPayloadClass =
  | 'runtime_config'
  | 'tool_contract'
  | 'tool_exchange'
  | 'workflow_fact'
  | 'workflow_instruction'
  | 'provider_checkpoint'
  | 'user_goal'
  | 'unknown'

export interface ClassifiedPayload {
  className: ContextPayloadClass
  chars: number
  markerHits: string[]
}

export interface PayloadClassSummary {
  counts: Record<ContextPayloadClass, number>
  chars: Record<ContextPayloadClass, number>
  markerCounts: Record<string, number>
}

export interface ContextEconomyDiagnostics {
  boundary: string
  promptRefreshMode: string
  promptChars: number
  payloadClassCounts: Record<ContextPayloadClass, number>
  payloadClassChars: Record<ContextPayloadClass, number>
  repeatedRuntimeConfigMarkers: number
  repeatedToolContractMarkers: number
  markerCounts: Record<string, number>
}

const MARKERS: ReadonlyArray<{ marker: string; className: ContextPayloadClass }> = [
  { marker: '<|CHAT2API|tool_calls>', className: 'tool_exchange' },
  { marker: '<|CHAT2API|invoke', className: 'tool_exchange' },
  { marker: '[function_calls]', className: 'tool_exchange' },
  { marker: '<|CHAT2API|tool_result', className: 'tool_exchange' },
  { marker: '[tool calls summarized', className: 'tool_exchange' },
  { marker: '[tool result summarized', className: 'tool_exchange' },
  { marker: '[Active skill workflow state checkpoint]', className: 'provider_checkpoint' },
  { marker: '[Prior conversation summary', className: 'workflow_fact' },
  { marker: '[Child session handoff state]', className: 'workflow_fact' },
  { marker: '[Completed tool exchange handoff]', className: 'workflow_fact' },
  { marker: 'Tool Contract Header', className: 'tool_contract' },
  { marker: '## Available Tools', className: 'tool_contract' },
  { marker: '## Tool Call Protocol', className: 'tool_contract' },
  { marker: 'contract_header_version:', className: 'tool_contract' },
  { marker: 'catalog_fingerprint:', className: 'tool_contract' },
  { marker: 'allowed_tools:', className: 'tool_contract' },
  { marker: 'TOOL_WRAP_HINT', className: 'tool_contract' },
  { marker: 'You can invoke the following developer tools', className: 'tool_contract' },
  { marker: 'Tool Call Formatting', className: 'tool_contract' },
  { marker: 'TOOL USE', className: 'tool_contract' },
  { marker: '## Tool Use', className: 'tool_contract' },
  { marker: '## Tools', className: 'tool_contract' },
  { marker: '<tools>', className: 'tool_contract' },
  { marker: 'You are opencode', className: 'runtime_config' },
  { marker: 'superpowers', className: 'runtime_config' },
  { marker: 'SUBAGENT-STOP', className: 'runtime_config' },
]

const CLASS_PRECEDENCE: ContextPayloadClass[] = [
  'tool_exchange',
  'provider_checkpoint',
  'workflow_fact',
  'tool_contract',
  'runtime_config',
  'workflow_instruction',
  'user_goal',
  'unknown',
]

export function classifyTextPayload(text: string): ClassifiedPayload {
  const value = typeof text === 'string' ? text : ''
  const markerHits = MARKERS
    .filter(({ marker }) => value.includes(marker))
    .map(({ marker }) => marker)
  const hitClasses = new Set(
    MARKERS
      .filter(({ marker }) => value.includes(marker))
      .map(({ className }) => className),
  )

  let className = CLASS_PRECEDENCE.find(candidate => hitClasses.has(candidate)) ?? 'unknown'
  if (className === 'unknown' && /(?:^|\n)\s*(?:next|todo|pending|remaining|下一步|待办)\s*[:：]/im.test(value)) {
    className = 'workflow_instruction'
  }
  if (className === 'unknown' && /(?:^|\n)\s*(?:goal|objective|user goal|目标)\s*[:：]/im.test(value)) {
    className = 'user_goal'
  }

  return { className, chars: value.length, markerHits }
}

/**
 * Distinguishes an actual prompt/config block from ordinary user prose that only
 * names one of its markers. This is intentionally conservative for user text.
 */
export function isLikelyConfigurationPayload(text: string): boolean {
  const value = typeof text === 'string' ? text : ''
  const classified = classifyTextPayload(value)
  if (classified.className !== 'runtime_config' && classified.className !== 'tool_contract') {
    return false
  }
  if (classified.markerHits.length >= 2) return true

  const trimmed = value.trimStart()
  if (trimmed.startsWith('You are opencode') && value.length > 300) return true
  if (/^(?:Tool Contract Header|## Available Tools|<tools>)/.test(trimmed)) {
    return /(?:^|\n)\s*(?:Tool `[^`]+`|JSON schema\s*:|catalog_fingerprint:|allowed_tools:)/im.test(value)
  }
  return false
}

export function summarizePayloadClasses(messages: ChatMessage[]): PayloadClassSummary {
  const counts = emptyClassRecord()
  const chars = emptyClassRecord()
  const markerCounts: Record<string, number> = {}

  for (const message of messages) {
    const text = extractTextContent(message.content)
    const classified = classifyTextPayload(text)
    const className = normalizeMessageClass(message, classified.className)
    counts[className] += 1
    chars[className] += text.length

    for (const { marker } of MARKERS) {
      const count = countOccurrences(text, marker)
      if (count > 0) markerCounts[marker] = (markerCounts[marker] ?? 0) + count
    }
  }

  return { counts, chars, markerCounts }
}

export function buildContextEconomyDiagnostics(
  messages: ChatMessage[],
  input: { boundary?: string | null; promptRefreshMode?: string | null; promptChars?: number },
): ContextEconomyDiagnostics {
  const summary = summarizePayloadClasses(messages)
  const promptChars = input.promptChars ?? messages.reduce(
    (total, message) => total + extractTextContent(message.content).length,
    0,
  )

  return {
    boundary: input.boundary || 'normal',
    promptRefreshMode: input.promptRefreshMode || 'legacy_undefined',
    promptChars,
    payloadClassCounts: summary.counts,
    payloadClassChars: summary.chars,
    repeatedRuntimeConfigMarkers: repeatedMarkerCount(summary.markerCounts, 'runtime_config'),
    repeatedToolContractMarkers: repeatedMarkerCount(summary.markerCounts, 'tool_contract'),
    markerCounts: summary.markerCounts,
  }
}

export function extractTextContent(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
}

function normalizeMessageClass(message: ChatMessage, className: ContextPayloadClass): ContextPayloadClass {
  if (message.role === 'tool' || (message.tool_calls?.length ?? 0) > 0) return 'tool_exchange'
  if (className !== 'unknown') return className
  if (message.role === 'user') return 'user_goal'
  if (message.role === 'assistant') return 'workflow_fact'
  if (message.role === 'system') return 'runtime_config'
  return className
}

function emptyClassRecord(): Record<ContextPayloadClass, number> {
  return {
    runtime_config: 0,
    tool_contract: 0,
    tool_exchange: 0,
    workflow_fact: 0,
    workflow_instruction: 0,
    provider_checkpoint: 0,
    user_goal: 0,
    unknown: 0,
  }
}

function countOccurrences(text: string, marker: string): number {
  if (!text || !marker) return 0
  let count = 0
  let offset = 0
  while ((offset = text.indexOf(marker, offset)) !== -1) {
    count += 1
    offset += marker.length
  }
  return count
}

function repeatedMarkerCount(markerCounts: Record<string, number>, className: ContextPayloadClass): number {
  const markers = new Set(MARKERS.filter(marker => marker.className === className).map(marker => marker.marker))
  return Object.entries(markerCounts).reduce(
    (total, [marker, count]) => total + (markers.has(marker) ? Math.max(0, count - 1) : 0),
    0,
  )
}
