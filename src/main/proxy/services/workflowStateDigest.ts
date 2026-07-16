import type { ChatMessage } from '../types.ts'
import {
  classifyTextPayload,
  extractTextContent,
  isLikelyConfigurationPayload,
} from './contextPayloadClassifier.ts'

export interface WorkflowStateDigest {
  kind: 'workflow_state_digest'
  version: 1
  source: 'external_summary' | 'local_fallback' | 'tool_handoff' | 'client_compact'
  userGoal?: string
  confirmedFacts: string[]
  inspectedFiles: string[]
  modifiedFiles: string[]
  pendingObligations: string[]
  nextAction?: string
  activeToolCallIds: string[]
  completedSkillNames: string[]
  omitted: {
    runtimeConfig: number
    toolContract: number
    toolPayloadBytes: number
    skillDocumentBytes: number
  }
}

const MIN_FACT_CHARS = 20
const WARMUP_NOISE_PATTERNS = [
  /\breply\s+exactly\b/i,
  /\bWARMUP_ACK\b/i,
  /\bdo\s+not\s+use\s+tools\b/i,
  /\bcompaction\s+warmup\b/i,
  /\bthis\s+is\s+a\s+(controlled\s+)?(test|warmup)\b/i,
]

function isWarmupNoiseUserGoal(text: string): boolean {
  return WARMUP_NOISE_PATTERNS.some(p => p.test(text))
}

function isOneWordEcho(text: string): boolean {
  const words = text.replace(/[_.-]+/g, ' ').trim().split(/\s+/)
  return words.length <= 2 && text.length < MIN_FACT_CHARS
}

function extractEchoTarget(instruction: string | undefined): string | undefined {
  if (!instruction) return undefined
  const match = instruction.match(/\breply\s+exactly\s+(.+?)(?:\s+and|\s*$)/i)
  return match?.[1]?.replace(/[_.-]/g, ' ').trim().toLowerCase()
}

function isEchoReply(targetText: string | undefined, assistantText: string): boolean {
  if (!targetText) {
    return false
  }
  const normalized = assistantText.replace(/[_.-]/g, ' ').trim().toLowerCase()
  return normalized === targetText
}

const MAX_FIELD_CHARS = 600
const MAX_ITEMS = 8
const MAX_RENDERED_CHARS = 4000
const RUNTIME_CONFIG_MARKERS = ['You are opencode', 'superpowers', 'SUBAGENT-STOP']
const TOOL_CONTRACT_MARKERS = ['## Available Tools', 'Tool Contract Header', '<tools>']
const SKILL_MARKERS = ['superpowers', 'SUBAGENT-STOP', 'SKILL.md', 'Available skills']
const FILE_PATH = /(?:[A-Za-z]:[\\/])?(?:[\w.@-]+[\\/])+[\w.@-]+\.[A-Za-z0-9]+/g

export function buildLocalWorkflowDigest(
  messages: ChatMessage[],
  source: WorkflowStateDigest['source'],
): WorkflowStateDigest {
  const confirmedFacts: string[] = []
  const pendingObligations: string[] = []
  const inspectedFiles = new Set<string>()
  const modifiedFiles = new Set<string>()
  const activeToolCallIds = new Set<string>()
  const completedSkillNames = new Set<string>()
  // Track skill calls by id to match with corresponding tool results
  const pendingSkillCalls = new Map<string, string>()
  let userGoal: string | undefined
  let pendingEchoTarget: string | undefined
  let runtimeConfig = 0
  let toolContract = 0
  let toolPayloadBytes = 0
  let skillDocumentBytes = 0

  for (const message of messages) {
    const text = extractTextContent(message.content)
    if (RUNTIME_CONFIG_MARKERS.some(marker => text.includes(marker))) runtimeConfig += text.length
    if (TOOL_CONTRACT_MARKERS.some(marker => text.includes(marker))) toolContract += text.length
    if (SKILL_MARKERS.some(marker => text.includes(marker))) skillDocumentBytes += text.length

    if (message.role === 'tool') {
      toolPayloadBytes += text.length
      if (message.tool_call_id) {
        activeToolCallIds.add(message.tool_call_id)
        const callId = message.tool_call_id
        if (pendingSkillCalls.has(callId)) {
          completedSkillNames.add(pendingSkillCalls.get(callId)!)
          pendingSkillCalls.delete(callId)
        }
      }
      continue
    }

    if (message.role === 'assistant' && message.tool_calls?.length) {
      for (const call of message.tool_calls) {
        activeToolCallIds.add(call.id)
        toolPayloadBytes += call.function.arguments.length
        const paths = extractPaths(call.function.arguments)
        const target = /(?:write|edit|patch|apply)/i.test(call.function.name) ? modifiedFiles : inspectedFiles
        paths.forEach(path => target.add(path))
        if (call.function?.name === 'skill' && call.id) {
          const skillName = parseSkillArgumentName(call.function.arguments)
          if (skillName) pendingSkillCalls.set(call.id, skillName)
        }
      }
      continue
    }

    const className = classifyTextPayload(text).className
    if (className === 'runtime_config' || className === 'tool_contract' || className === 'tool_exchange') {
      if (message.role === 'user' && !userGoal) {
        const goalSource = isLikelyConfigurationPayload(text) ? sanitizeDigestText(text) : text.trim()
        const mixedUserGoal = selectGoalText(goalSource)
        if (mixedUserGoal && !isWarmupNoiseUserGoal(mixedUserGoal)) userGoal = mixedUserGoal
      }
      continue
    }

    const cleanText = sanitizeDigestText(text)
    if (!cleanText) continue
    extractPaths(cleanText).forEach(path => inspectedFiles.add(path))

    if (message.role === 'user') {
      if (!userGoal) {
        const candidate = selectGoalText(cleanText)
        if (!isWarmupNoiseUserGoal(candidate)) userGoal = candidate
      }
      const echoTarget = extractEchoTarget(cleanText)
      if (echoTarget) pendingEchoTarget = echoTarget
    }
    if (message.role === 'assistant' || className === 'workflow_fact') {
      const isEcho = pendingEchoTarget && isEchoReply(pendingEchoTarget, cleanText)
      if (!isEcho && cleanText.length >= MIN_FACT_CHARS && !isOneWordEcho(cleanText)) {
        pushUnique(confirmedFacts, truncate(cleanText, MAX_FIELD_CHARS))
      }
      pendingEchoTarget = undefined
    }

    for (const line of cleanText.split(/\r?\n/)) {
      if (/\b(?:next|todo|pending|remaining|must)\b|下一步|待办|尚需/i.test(line)) {
        pushUnique(pendingObligations, truncate(line.trim(), MAX_FIELD_CHARS))
      }
    }
  }

  return {
    kind: 'workflow_state_digest',
    version: 1,
    source,
    ...(userGoal ? { userGoal } : {}),
    confirmedFacts: confirmedFacts.slice(-MAX_ITEMS),
    inspectedFiles: [...inspectedFiles].slice(-MAX_ITEMS),
    modifiedFiles: [...modifiedFiles].slice(-MAX_ITEMS),
    pendingObligations: pendingObligations.slice(-MAX_ITEMS),
    ...(pendingObligations[0] ? { nextAction: pendingObligations[0] } : {}),
    activeToolCallIds: [...activeToolCallIds].slice(-MAX_ITEMS),
    completedSkillNames: [...completedSkillNames],
    omitted: { runtimeConfig, toolContract, toolPayloadBytes, skillDocumentBytes },
  }
}

export function renderWorkflowDigestForProvider(digest: WorkflowStateDigest): string {
  const lines = [
    '[Workflow state digest v1 — runtime configuration, tool contracts, skill documents, and raw tool payloads omitted.]',
    `Source: ${digest.source}`,
  ]
  if (digest.userGoal) lines.push(`User goal: ${sanitizeDigestText(digest.userGoal)}`)
  appendList(lines, 'Confirmed facts', digest.confirmedFacts)
  appendList(lines, 'Inspected files', digest.inspectedFiles)
  appendList(lines, 'Modified files', digest.modifiedFiles)
  appendList(lines, 'Pending obligations', digest.pendingObligations)
  if (digest.nextAction) lines.push(`Next action: ${sanitizeDigestText(digest.nextAction)}`)
  appendList(lines, 'Active tool call ids', digest.activeToolCallIds)
  appendList(lines, 'Completed skill calls', digest.completedSkillNames)
  lines.push(`Omitted bytes: runtime_config=${digest.omitted.runtimeConfig}, tool_contract=${digest.omitted.toolContract}, tool_payload=${digest.omitted.toolPayloadBytes}, skill_document=${digest.omitted.skillDocumentBytes}`)
  return lines.join('\n').slice(0, MAX_RENDERED_CHARS)
}

function extractPaths(value: string): string[] {
  return [...value.matchAll(FILE_PATH)].map(match => match[0].replace(/\\/g, '/'))
}

function sanitizeDigestText(value: string): string {
  return value
    .replace(/<\|CHAT2API\|tool_calls>[\s\S]*?<\/\|CHAT2API\|tool_calls>/gi, '[tool exchange omitted]')
    .split(/\r?\n/)
    .filter(line => (
      ![...RUNTIME_CONFIG_MARKERS, ...TOOL_CONTRACT_MARKERS, ...SKILL_MARKERS].some(marker => line.includes(marker))
      && !/^\s*Tool `[^`]+`\s*:/i.test(line)
      && !/^\s*JSON schema\s*:/i.test(line)
    ))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
}

function appendList(lines: string[], label: string, values: string[]): void {
  if (values.length > 0) lines.push(`${label}: ${values.map(sanitizeDigestText).filter(Boolean).join(' | ')}`)
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1).trimEnd()}…`
}

function selectGoalText(value: string): string {
  if (value.length <= MAX_FIELD_CHARS) return value
  return `…${value.slice(-(MAX_FIELD_CHARS - 1)).trimStart()}`
}

function pushUnique(values: string[], value: string): void {
  if (value && !values.includes(value)) values.push(value)
}

function parseSkillArgumentName(args: string): string | undefined {
  try {
    const parsed = JSON.parse(args)
    if (typeof parsed === 'string') return parsed.trim() || undefined
    if (parsed && typeof parsed === 'object' && typeof parsed.name === 'string') return parsed.name.trim() || undefined
  } catch {
    // Not JSON — try to extract a bare skill name
    const trimmed = args.trim()
    if (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(trimmed)) return trimmed
    return undefined
  }
}
