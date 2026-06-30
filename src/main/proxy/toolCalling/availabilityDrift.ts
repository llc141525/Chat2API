import type { ToolCallingPlan } from './types.ts'

export interface AvailabilityDriftDetection {
  detected: boolean
  deniedToolName?: string
}

const UNAVAILABLE_PATTERNS = [
  /\btool(?:s)?\b[\s\S]{0,80}\b(?:not available|unavailable|not provided|not found|does not exist|don't exist|do not exist)\b/i,
  /\b(?:not available|unavailable|not provided|not found|does not exist|don't exist|do not exist)\b[\s\S]{0,80}\btool(?:s)?\b/i,
  /不存在.{0,20}工具|工具.{0,20}不存在|没有.{0,20}工具|未提供.{0,20}工具/i,
]

export function detectAvailabilityDrift(plan: ToolCallingPlan, rawAssistantText: string): AvailabilityDriftDetection {
  const allowedToolNames = [...plan.allowedToolNames]
  if (!plan.catalogSnapshot || allowedToolNames.length === 0) {
    return { detected: false }
  }

  const matched = UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(rawAssistantText))
  if (!matched) return { detected: false }

  const lowerText = rawAssistantText.toLowerCase()
  const deniedToolName = allowedToolNames.find((name) => lowerText.includes(name.toLowerCase()))
  if (deniedToolName) {
    return { detected: true, deniedToolName }
  }

  return { detected: true }
}

export function buildAvailabilityRetryClarification(plan: ToolCallingPlan): string {
  const allowedToolNames = [...plan.allowedToolNames]
  return [
    'Tool availability clarification:',
    `catalog_fingerprint: ${plan.catalogSnapshot?.fingerprint ?? ''}`,
    `available_tools: ${allowedToolNames.join(', ')}`,
    'The runtime-provided catalog in this clarification is authoritative for this turn. Use only tools listed in that catalog when a tool call is needed.',
  ].join('\n')
}
