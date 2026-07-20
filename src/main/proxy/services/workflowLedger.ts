import type { ChatMessage } from '../types.ts'

const MAX_COMPLETED_TOOL_HANDOFF_EXCHANGES = 3
const MAX_COMPLETED_TOOL_HANDOFF_CHARS = 1600
const MAX_NEXT_SKILL_STEP_CHARS = 700

export type WorkflowLedgerKind = 'active_skill' | 'completed_tool_handoff'

export interface WorkflowLedgerCompletedStep {
  toolName: string
  toolCallId?: string
  artifactPath?: string
  evidence?: string
}

export interface WorkflowLedger {
  kind: WorkflowLedgerKind
  pinnedSkillInstructions: string[]
  completedSteps: WorkflowLedgerCompletedStep[]
  nextInstruction?: string
  nextToolName?: string
  nextArgumentHint?: string
  omittedCompletedExchangeCount: number
  renderedProgressLines: string[]
}

export interface BuildWorkflowLedgerInput {
  groups: ChatMessage[][]
  latestSkillInstructionPinned?: boolean
  retainedGroups?: ChatMessage[][]
}

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

function truncateForToolHandoff(content: string, maxChars: number): string {
  const normalized = content.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) {
    return normalized
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`
}

function parseToolCallArguments(toolCallArguments: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(toolCallArguments) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function extractStructuredPath(parsed: Record<string, unknown> | undefined): string | undefined {
  const pathCandidate = parsed?.filePath ?? parsed?.path ?? parsed?.outputPath
  return typeof pathCandidate === 'string' && pathCandidate.trim().length > 0
    ? pathCandidate.trim()
    : undefined
}

function extractWriteFileSyncPath(command: string): string | undefined {
  const writeFileMatch = command.match(/writeFileSync\(\s*['"`]([^'"`]+)['"`]/)
  return writeFileMatch?.[1]
}

function extractCommandPath(command: string): string | undefined {
  const pathMatch = command.match(/(\.?[A-Za-z0-9_./-]*\.[A-Za-z0-9_-]+)/)
  return pathMatch?.[1]
}

export function extractToolArtifactPath(toolName: string, toolCallArguments: string): string | undefined {
  const parsed = parseToolCallArguments(toolCallArguments)
  const commandCandidate = typeof parsed?.command === 'string' ? parsed.command : undefined
  const normalizedToolName = toolName.toLowerCase()

  if (normalizedToolName === 'bash') {
    if (commandCandidate) {
      const writeFilePath = extractWriteFileSyncPath(commandCandidate)
      if (writeFilePath) {
        return writeFilePath
      }
    }

    return extractStructuredPath(parsed) ?? (commandCandidate ? extractCommandPath(commandCandidate) : undefined)
  }

  if (normalizedToolName === 'read') {
    return extractStructuredPath(parsed)
  }

  if (normalizedToolName === 'write' || normalizedToolName === 'edit') {
    return extractStructuredPath(parsed)
      ?? (commandCandidate ? extractWriteFileSyncPath(commandCandidate) ?? extractCommandPath(commandCandidate) : undefined)
  }

  return extractStructuredPath(parsed)
    ?? (commandCandidate ? extractWriteFileSyncPath(commandCandidate) ?? extractCommandPath(commandCandidate) : undefined)
}

function summarizeCompletedExchange(group: ChatMessage[], index: number): string {
  const assistant = group.find(
    message => message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0
  )
  const toolCalls = assistant?.tool_calls ?? []
  const toolNames = toolCalls.map(call => call.function.name).join(', ')
  const toolResults = group
    .filter(message => message.role === 'tool')
    .map((message) => truncateForToolHandoff(getMessageContent(message), 120))
    .filter(result => result.length > 0)

  const resultSnippet = toolResults.length > 0
    ? ` -> ${toolResults.join(' | ')}`
    : ''

  return `${index + 1}. ${toolNames || 'tool exchange'}${resultSnippet}`
}

function extractCompletedSteps(group: ChatMessage[]): WorkflowLedgerCompletedStep[] {
  const assistant = group.find(
    message => message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0
  )
  const toolCalls = assistant?.tool_calls ?? []
  if (toolCalls.length === 0) {
    return []
  }

  return toolCalls.flatMap((toolCall) => {
    const toolName = toolCall.function?.name || 'tool'
    const artifactPath = toolCall.function?.arguments
      ? extractToolArtifactPath(toolName, toolCall.function.arguments)
      : undefined
    const toolResult = group.find(
      message => message.role === 'tool' && message.tool_call_id === toolCall.id,
    )
    const evidence = toolResult
      ? truncateForToolHandoff(getMessageContent(toolResult), 80)
      : undefined

    if (!toolResult) {
      return []
    }

    return [{
      toolName,
      toolCallId: toolCall.id,
      artifactPath,
      evidence: evidence && evidence.length > 0 ? evidence : undefined,
    }]
  })
}

function renderActiveSkillProgressLine(step: WorkflowLedgerCompletedStep, index: number): string {
  const details = [
    `${index + 1}. ${step.toolName} completed`,
    step.artifactPath ? `artifact: ${step.artifactPath}` : '',
    step.evidence ? `evidence: ${step.evidence}` : '',
  ].filter(Boolean)

  return details.join(' | ')
}

function sanitizeInstructionBlock(block: string): string {
  return block
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .join('\n')
    .trim()
}

export function extractPinnedSkillInstructionBlocks(groups: ChatMessage[][]): string[] {
  const skillResult = groups
    .flat()
    .find((message) =>
      message.role === 'tool'
      && typeof message.tool_call_id === 'string'
      && getMessageContent(message).includes('<skill_content')
    )

  if (!skillResult) {
    return []
  }

  const lines = getMessageContent(skillResult).split(/\r?\n/)
  const instructionBlocks: string[] = []
  let currentBlock: string[] = []

  for (const rawLine of lines) {
    const trimmedLine = rawLine.trim()
    if (/^\d+\.\s+/.test(trimmedLine)) {
      if (currentBlock.length > 0) {
        instructionBlocks.push(sanitizeInstructionBlock(currentBlock.join('\n')))
      }
      currentBlock = [trimmedLine]
      continue
    }

    if (currentBlock.length === 0) {
      continue
    }

    if (/^<\/skill_content>/i.test(trimmedLine)) {
      break
    }

    if (
      trimmedLine.length === 0
      || /^\s+/.test(rawLine)
      || /^```/.test(trimmedLine)
      || /^`.*`$/.test(trimmedLine)
      || /^(New-Item|node\b|const\b|fs\.|spawnSync\b|Out-Null\b)/.test(trimmedLine)
      || trimmedLine.includes('.agent-probe/')
      || trimmedLine.includes('writeFileSync')
    ) {
      currentBlock.push(rawLine.replace(/\s+$/, ''))
    }
  }

  if (currentBlock.length > 0) {
    instructionBlocks.push(sanitizeInstructionBlock(currentBlock.join('\n')))
  }

  return instructionBlocks.filter(block => block.length > 0)
}

function normalizeArtifactPathForInstructionMatch(pathValue: string): string {
  return pathValue
    .replace(/\\/g, '/')
    .replace(/^[a-z]:/i, '')
    .replace(/^\/+/, '')
    .toLowerCase()
}

function instructionMentionsArtifactPath(
  instructionLine: string,
  artifactPath: string
): boolean {
  const normalizedInstruction = normalizeArtifactPathForInstructionMatch(instructionLine)
  const normalizedArtifactPath = normalizeArtifactPathForInstructionMatch(artifactPath)

  return normalizedInstruction.includes(normalizedArtifactPath)
    || normalizedArtifactPath.includes(normalizedInstruction.match(/[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)+/i)?.[0] ?? '\u0000')
    || normalizedInstruction.includes(normalizedArtifactPath.split('/').at(-1) ?? '\u0000')
}

function extractInstructionOutputPath(instructionLine: string): string | undefined {
  const writeFileMatch = instructionLine.match(/writeFileSync\(\s*['"`]([^'"`]+)['"`]/)
  if (writeFileMatch?.[1]) {
    return writeFileMatch[1]
  }

  const writeToolMatch = instructionLine.match(/\b(?:write|create|save)\b[^\r\n]*?(\.?[A-Za-z0-9_./-]*\.[A-Za-z0-9_-]+)/i)
  return writeToolMatch?.[1]
}

export function extractInstructionToolName(instructionLine: string): string | undefined {
  const [instructionHeader] = instructionLine.split(/\r?\n/, 1)
  const actionMatch = instructionHeader.match(
    /\b(?:use|call|emit|run)\s+(?:the|a|an)?\s*`?(skill|read|bash|write|edit|grep|glob)`?\s+tool\b/i,
  )
  if (actionMatch?.[1]) {
    return actionMatch[1].toLowerCase()
  }

  const match = instructionHeader.match(/\b(skill|read|bash|write|edit|grep|glob)\b/i)
  return match?.[1]?.toLowerCase()
}

function extractInstructionPathCandidate(instructionLine: string): string | undefined {
  const backtickPathMatch = instructionLine.match(/`(\.?[A-Za-z0-9_./\\-]*\.[A-Za-z0-9_-]+)`/)
  if (backtickPathMatch?.[1]) {
    return backtickPathMatch[1]
  }

  const pathMatch = instructionLine.match(/(\.?[A-Za-z0-9_./\\-]*\.[A-Za-z0-9_-]+)/)
  return pathMatch?.[1]
}

function extractInstructionCommandCandidate(instructionLine: string): string | undefined {
  const codeLines = instructionLine
    .split(/\r?\n/)
    .slice(1)
    .map(line => line.trim())
    .filter(line => line.length > 0)

  for (const line of codeLines) {
    const backtickCommandMatch = line.match(/^`([\s\S]*)`$/)
    if (backtickCommandMatch?.[1]?.trim()) {
      return backtickCommandMatch[1].trim()
    }
  }

  const inlineBacktickCommandMatch = instructionLine.match(/`([^`]*(?:New-Item|node\b|writeFileSync)[^`]*)`/i)
  if (inlineBacktickCommandMatch?.[1]?.trim()) {
    return inlineBacktickCommandMatch[1].trim()
  }

  const commandLine = codeLines.find(line => /(?:New-Item|node\b|writeFileSync)/i.test(line))
  return commandLine?.replace(/^`|`$/g, '').trim()
}

export function extractNextToolArgumentHint(
  instructionLine: string,
  toolName?: string
): string | undefined {
  if (toolName === 'read') {
    const pathCandidate = extractInstructionPathCandidate(instructionLine)
    return pathCandidate ? `filePath=${pathCandidate}` : undefined
  }

  if (toolName === 'bash') {
    const commandCandidate = extractInstructionCommandCandidate(instructionLine)
    return commandCandidate ? `command=${commandCandidate}` : undefined
  }

  return undefined
}

function inferNextArgumentHintFromPinnedInstructions(
  instructionBlocks: string[],
  nextInstruction: string | undefined,
  nextToolName: string | undefined,
): string | undefined {
  if (!nextInstruction || nextToolName !== 'bash') {
    return undefined
  }

  const nextIndex = instructionBlocks.findIndex(block => block === nextInstruction)
  const followingBlocks = nextIndex === -1 ? [] : instructionBlocks.slice(nextIndex + 1)
  const commandBlock = followingBlocks.find(block => extractInstructionToolName(block) === 'bash')
  return commandBlock
    ? extractNextToolArgumentHint(commandBlock, 'bash')
    : undefined
}

function isInstructionSatisfiedByCompletedStep(
  instructionLine: string,
  completedStep: WorkflowLedgerCompletedStep
): boolean {
  const [instructionHeader] = instructionLine.split(/\r?\n/, 1)
  const normalizedInstructionHeader = instructionHeader.toLowerCase()
  const normalizedToolName = completedStep.toolName.toLowerCase()
  const artifactPath = completedStep.artifactPath

  if (!normalizedInstructionHeader.includes(normalizedToolName)) {
    return false
  }

  if (!artifactPath) {
    return true
  }

  if (normalizedToolName === 'bash' || normalizedToolName === 'write') {
    const instructionOutputPath = extractInstructionOutputPath(instructionLine)
    return instructionOutputPath
      ? instructionMentionsArtifactPath(instructionOutputPath, artifactPath)
      : instructionMentionsArtifactPath(instructionLine, artifactPath)
  }

  return instructionMentionsArtifactPath(instructionLine, artifactPath)
}

function findNextIncompleteInstruction(
  instructionBlocks: string[],
  completedSteps: WorkflowLedgerCompletedStep[]
): string | undefined {
  if (instructionBlocks.length === 0) {
    return undefined
  }

  if (completedSteps.length === 0) {
    return truncateForToolHandoff(instructionBlocks[0], MAX_NEXT_SKILL_STEP_CHARS)
  }

  const nextInstruction = instructionBlocks.find(
    line => !completedSteps.some(step => isInstructionSatisfiedByCompletedStep(line, step))
  )

  return nextInstruction
    ? truncateForToolHandoff(nextInstruction, MAX_NEXT_SKILL_STEP_CHARS)
    : undefined
}

export function buildWorkflowLedger(input: BuildWorkflowLedgerInput): WorkflowLedger {
  const latestSkillInstructionPinned = input.latestSkillInstructionPinned === true
  const kind: WorkflowLedgerKind = latestSkillInstructionPinned
    ? 'active_skill'
    : 'completed_tool_handoff'
  const completedSteps = input.groups.flatMap(extractCompletedSteps)
  const pinnedSkillInstructions = latestSkillInstructionPinned
    ? extractPinnedSkillInstructionBlocks(input.retainedGroups ?? [])
    : []
  const nextInstruction = latestSkillInstructionPinned
    ? findNextIncompleteInstruction(pinnedSkillInstructions, completedSteps)
    : undefined
  const nextToolName = nextInstruction
    ? extractInstructionToolName(nextInstruction)
    : undefined
  const nextArgumentHint = nextInstruction
    ? extractNextToolArgumentHint(nextInstruction, nextToolName)
      ?? inferNextArgumentHintFromPinnedInstructions(pinnedSkillInstructions, nextInstruction, nextToolName)
    : undefined
  const renderedSteps = completedSteps.slice(-MAX_COMPLETED_TOOL_HANDOFF_EXCHANGES)
  const renderedProgressLines = latestSkillInstructionPinned
    ? renderedSteps.map(renderActiveSkillProgressLine)
    : input.groups
      .slice(-MAX_COMPLETED_TOOL_HANDOFF_EXCHANGES)
      .map(summarizeCompletedExchange)

  return {
    kind,
    pinnedSkillInstructions,
    completedSteps,
    nextInstruction,
    nextToolName,
    nextArgumentHint,
    omittedCompletedExchangeCount: Math.max(0, input.groups.length - renderedProgressLines.length),
    renderedProgressLines,
  }
}

export function renderWorkflowLedgerHandoffContent(ledger: WorkflowLedger): string {
  const latestSkillInstructionPinned = ledger.kind === 'active_skill'
  const body = [
    latestSkillInstructionPinned
      ? '[Active skill workflow state checkpoint]'
      : '[Completed tool exchange handoff]',
    ledger.nextInstruction
      ? `Required next action: call the ${ledger.nextToolName ?? 'next'} tool for this exact skill step now.`
      : '',
    ledger.nextArgumentHint
      ? `Required next tool arguments: ${ledger.nextArgumentHint}`
      : '',
    ledger.nextToolName === 'read' && ledger.nextArgumentHint
      ? 'Do not call read with any other filePath.'
      : '',
    ledger.nextToolName === 'bash' && ledger.nextArgumentHint
      ? 'Do not call bash with any other command.'
      : '',
    ledger.nextInstruction
      ? `Next required skill step: ${ledger.nextInstruction}`
      : '',
    latestSkillInstructionPinned && ledger.nextToolName
      ? `Only the ${ledger.nextToolName} tool is valid for the next assistant tool call.`
      : '',
    latestSkillInstructionPinned
      ? 'Do not repeat any completed read/bash/write call listed in this checkpoint.'
      : '',
    latestSkillInstructionPinned
      ? 'Latest pinned skill instructions remain authoritative.'
      : `${ledger.completedSteps.length} completed tool exchange(s) already finished before the current active tool boundary.`,
    latestSkillInstructionPinned
      ? `${ledger.completedSteps.length} completed tool exchange(s) already finished after the latest pinned skill instruction exchange.`
      : '',
    ...ledger.renderedProgressLines,
    ledger.omittedCompletedExchangeCount > 0
      ? `... plus ${ledger.omittedCompletedExchangeCount} earlier completed exchange(s).`
      : '',
    latestSkillInstructionPinned
      ? 'Listed read/bash/write steps above are already complete. Do not repeat completed reads or bash writes; continue with the first not-yet-completed skill instruction.'
      : '',
  ]
    .filter(line => line.length > 0)
    .join('\n')

  return truncateForToolHandoff(body, MAX_COMPLETED_TOOL_HANDOFF_CHARS)
}

export function buildWorkflowLedgerHandoffMessage(input: BuildWorkflowLedgerInput): ChatMessage {
  const ledger = buildWorkflowLedger(input)

  return {
    role: ledger.kind === 'active_skill' ? 'system' : 'assistant',
    content: renderWorkflowLedgerHandoffContent(ledger),
  }
}
