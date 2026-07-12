import type { ToolCallingPlan } from './types.ts'

/**
 * Diagnostic subkind for availability drift detections.
 * Allows callers to distinguish root cause without misattributing failures.
 *
 * provider_side        — model rejected the catalog despite clean context (genuine upstream issue).
 * summary_contamination — our compaction produced a hallucinated tool listing; bounded retry was attempted.
 * catalog_missing      — request left the proxy with no authoritative catalog to compare against.
 */
export type AvailabilityDriftSubkind = 'provider_side' | 'summary_contamination' | 'catalog_missing'

export interface AvailabilityDriftDetection {
  detected: boolean
  deniedToolNames: string[]
  mentionedUnavailableOnlyTools: string[]
  subkind?: AvailabilityDriftSubkind
}

const GENERAL_UNAVAILABLE_PATTERNS = [
  /\btool(?:s)?\b[\s\S]{0,80}\b(?:not available|unavailable|not provided|not found|does not exist|don't exist|do not exist|cannot use|can't use|no access)\b/i,
  /\b(?:not available|unavailable|not provided|not found|does not exist|don't exist|do not exist|cannot use|can't use|no access)\b[\s\S]{0,80}\btool(?:s)?\b/i,
  /不存在.{0,20}工具|工具.{0,20}不存在|没有.{0,20}工具|未提供.{0,20}工具|不能使用.{0,20}工具|没有权限使用.{0,20}工具/i,
]

const ONLY_AVAILABLE_PATTERNS = [
  /\bonly\s+(?:have|has)?\s*([a-z0-9_:-]+(?:\s*(?:,|\/|or|and)\s*[a-z0-9_:-]+)*)\s+available\b/i,
  /\bcurrently\s+only\s+([a-z0-9_:-]+(?:\s*(?:,|\/|or|and)\s*[a-z0-9_:-]+)*)\s+(?:is|are)\s+available\b/i,
  /\bthe\s+only\s+available\s+tool(?:s)?\s+(?:is|are)\s+`?([a-z0-9_:-]+(?:\s*(?:,|\/|or|and)\s*`?[a-z0-9_:-]+`?)*)`?/i,
  /当前只能使用\s*([a-z0-9_:-]+(?:\s*(?:、|,|\/|或|和)\s*[a-z0-9_:-]+)*)/i,
  /只能使用\s*([a-z0-9_:-]+(?:\s*(?:、|,|\/|或|和)\s*[a-z0-9_:-]+)*)/i,
  /唯一可用.{0,12}工具[^a-z0-9_:-]{0,8}(?:是|为)?\s*`?([a-z0-9_:-]+(?:\s*(?:、|,|\/|或|和)\s*`?[a-z0-9_:-]+`?)*)`?/i,
]

const FENCED_BLOCK_PATTERN = /```[\s\S]*?```/g
const BLOCKQUOTE_LINE_PATTERN = /^\s*>.*$/gm
const TOKEN_SPLIT_PATTERN = /(?:\s+|,|\/|、|\bor\b|\band\b|和|或)+/i

export function detectAvailabilityDrift(
  plan: ToolCallingPlan,
  rawAssistantText: string,
  opts?: { summaryContaminated?: boolean }
): AvailabilityDriftDetection {
  const allowedToolNames = [...plan.allowedToolNames]
  if (!plan.catalogSnapshot || allowedToolNames.length === 0) {
    return emptyDetection('catalog_missing')
  }

  const text = stripQuotedExamples(rawAssistantText)
  if (text.trim().length === 0) {
    return emptyDetection()
  }

  const lowerText = text.toLowerCase()
  const deniedToolNames = allowedToolNames.filter((name) => {
    const escaped = escapeRegex(name)
    return new RegExp(`\\b${escaped}\\b`, 'i').test(text) && hasNearbyDenial(text, escaped)
  })

  const mentionedUnavailableOnlyTools = extractMentionedUnavailableOnlyTools(text, allowedToolNames)
  const matchedGeneralDenial = GENERAL_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(text))

  const detected = deniedToolNames.length > 0
    || mentionedUnavailableOnlyTools.length > 0
    || (
      matchedGeneralDenial
      && (
        allowedToolNames.some((name) => lowerText.includes(name.toLowerCase()))
        || /only\s+[a-z0-9_:-]+\s+available/i.test(text)
        || /只能使用/i.test(text)
      )
    )

  if (!detected) {
    return emptyDetection()
  }

  const subkind: AvailabilityDriftSubkind = opts?.summaryContaminated
    ? 'summary_contamination'
    : 'provider_side'

  return { detected: true, deniedToolNames, mentionedUnavailableOnlyTools, subkind }
}

export function buildAvailabilityRetryClarification(
  plan: ToolCallingPlan,
  drift?: AvailabilityDriftDetection
): string {
  if (plan.allowedToolNames.size === 0) {
    console.warn('[availabilityDrift] buildAvailabilityRetryClarification called with no allowed tools — returning empty clarification')
    return 'Tool availability clarification:\nno tools available'
  }
  const allowedToolNames = [...plan.allowedToolNames]

  const subkindNote = drift?.subkind === 'summary_contamination'
    ? 'Note: a prior compaction summary contained an incorrect tool description. The authoritative catalog below supersedes it.'
    : ''

  return [
    'Tool availability clarification:',
    `catalog_fingerprint: ${plan.catalogSnapshot?.fingerprint ?? ''}`,
    `protocol: ${plan.protocol}`,
    `available_tools: ${allowedToolNames.join(', ')}`,
    ...(subkindNote ? [subkindNote] : []),
    'The runtime-provided catalog in this clarification is authoritative for this turn.',
    'Use only the exact tool names listed above for this turn.',
    'Do not say that an allowed tool is unavailable.',
    'If one of the listed tools is needed, emit a managed tool call instead of explanatory denial text.',
    'When calling tools, follow the required managed XML structure exactly.',
  ].join('\n')
}

function emptyDetection(subkind?: AvailabilityDriftSubkind): AvailabilityDriftDetection {
  return {
    detected: false,
    deniedToolNames: [],
    mentionedUnavailableOnlyTools: [],
    subkind,
  }
}

function stripQuotedExamples(value: string): string {
  return value
    .replace(FENCED_BLOCK_PATTERN, ' ')
    .replace(BLOCKQUOTE_LINE_PATTERN, ' ')
}

function extractMentionedUnavailableOnlyTools(text: string, allowedToolNames: string[]): string[] {
  const allowedLower = new Set(allowedToolNames.map((name) => name.toLowerCase()))
  const found = new Set<string>()
  for (const pattern of ONLY_AVAILABLE_PATTERNS) {
    const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
    for (const match of text.matchAll(globalPattern)) {
      const group = match[1]
      if (!group) continue
      for (const token of splitToolList(group)) {
        if (!allowedLower.has(token.toLowerCase())) {
          found.add(token)
        }
      }
    }
  }
  return [...found]
}

function splitToolList(value: string): string[] {
  return value
    .split(TOKEN_SPLIT_PATTERN)
    .map((token) => token.trim().replace(/^`+|`+$/g, ''))
    .filter(Boolean)
}

function hasNearbyDenial(text: string, escapedToolName: string): boolean {
  const patterns = [
    new RegExp(`${escapedToolName}[\\s\\S]{0,40}(?:not available|unavailable|not provided|does not exist|do not exist|cannot use|can't use|no access|do not have access to|don't have access to|没有|不能使用|不可用|不存在)`, 'i'),
    new RegExp(`(?:not available|unavailable|not provided|does not exist|do not exist|cannot use|can't use|no access|do not have access to|don't have access to|没有|不能使用|不可用|不存在)[\\s\\S]{0,40}${escapedToolName}`, 'i'),
  ]
  return patterns.some((pattern) => pattern.test(text))
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
