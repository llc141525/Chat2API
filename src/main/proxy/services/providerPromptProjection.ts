import type { RequestAssembly } from '../RequestAssembly.ts'
import type { ChatMessage } from '../types.ts'
import type { PromptRefreshMode } from '../promptBudgetPolicy.ts'
import { extractTextContent } from './contextPayloadClassifier.ts'

/**
 * Applies the runtime prompt budget at the shared plugin boundary so every
 * provider receives the same bounded history semantics.
 */
export function projectRequestAssemblyForPromptMode(
  assembly: RequestAssembly,
  mode?: PromptRefreshMode,
): RequestAssembly {
  // Re-inject infrastructure (agent definition + skill steps) for every mode.
  // Compaction strips these from conversation history; the model needs them
  // regardless of prompt refresh strategy. The assembly carries the pre-built
  // infrastructure prompt captured from raw messages before filtering.
  const infrastructurePrompt = assembly.infrastructurePrompt

  if (!mode || mode === 'full' || mode === 'repair' || mode === 'tool_ready') {
    return infrastructurePrompt ? { ...assembly, infrastructurePrompt } : assembly
  }

  if (mode === 'minimal') {
    return {
      ...assembly,
      messages: selectMinimalDelta(assembly.messages),
      summaryText: null,
      workflowDigest: null,
      recoveryContextText: assembly.recoveryContextText ?? null,
      infrastructurePrompt,
    }
  }

  return {
    ...assembly,
    messages: selectBoundedDigestTail(assembly.messages),
    infrastructurePrompt,
  }
}

/**
 * Builds an infrastructure prompt from the assembly messages.
 * Extracts the agent definition (ALL non-tool-contract system messages) and
 * active skill instruction summaries. This is injected after compaction so
 * the model does not lose its role definition, subagent directives, or
 * multi-step skill workflow.
 *
 * Key invariants:
 * - ALL system messages are merged (not just the first) — subagent instructions
 *   may live in a later system message.
 * - Agent definition is not truncated — a 2000-char limit drops critical
 *   tool-use directives that live in the second half of long system prompts.
 * - Skill steps get up to 3000 chars (was 800) to capture full multi-step
 *   workflows.
 */
function buildInfrastructurePrompt(messages: ChatMessage[]): string | null {
  const sections: string[] = []

  // Agent definition: ALL system messages that aren't tool contracts or summaries
  const agentParts: string[] = []
  for (const m of messages) {
    if (m.role !== 'system') continue
    const text = extractTextContent(m.content).trim()
    if (text.length === 0) continue
    if (text.includes('## Available Tools')) continue
    if (text.includes('Tool Contract Header')) continue
    if (text.includes('[Prior conversation summary')) continue
    if (text.includes('[Local fallback summary')) continue
    agentParts.push(text)
  }
  if (agentParts.length > 0) {
    sections.push(`[Role definition — authoritative for this session]\n${agentParts.join('\n\n')}`)
  }

  // Active skill summary: last tool result with <skill_content>
  const skillResults = messages.filter(m =>
    m.role === 'tool' && m.tool_call_id
    && typeof m.content === 'string'
    && m.content.includes('<skill_content')
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

/**
 * Extracts numbered instruction steps from skill content, bounded to 800 chars.
 * Includes continuation lines (bash commands) that follow a step header.
 */
function extractSkillSteps(skillContent: string): string | null {
  const lines = skillContent.split(/\r?\n/)
  const steps: string[] = []
  let inSteps = false
  let collectingCommand = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\d+\.\s+Use\s+the\s+`/.test(line)) {
      inSteps = true
      collectingCommand = /\brun:?\s*$/.test(line.trimEnd())
      steps.push(line.trim())
    } else if (inSteps && /^\d+\./.test(line) && !collectingCommand) {
      collectingCommand = /\brun:?\s*$/.test(line.trimEnd())
      steps.push(line.trim())
    } else if (collectingCommand && line.trim() && !/^\d+\.\s+Use\s+the\s+`/.test(line)) {
      // Capture the backtick-quoted command from continuation lines
      const cmdMatch = line.match(/`([^`]+)`/)
      if (cmdMatch) {
        steps.push(`  ${cmdMatch[1]}`)
        collectingCommand = false
      }
    } else if (inSteps && line.trim() === '' && steps.length >= 2 && !collectingCommand) {
      break
    }
    if (steps.join('\\n').length > 3000) break
  }
  return steps.length > 0 ? steps.join('\n') : null
}

function selectMinimalDelta(messages: ChatMessage[]): ChatMessage[] {
  const nonSystem = messages.filter(message => message.role !== 'system')
  // Keep the last 4 non-system messages so the model sees recent tool exchanges.
  // A single user message is too aggressive for managed XML protocols — the
  // model needs at least one tool-call + result pair to know what it was doing.
  const tail = nonSystem.slice(-4)
  // If the tail starts with a tool result, widen to include its trigger call
  if (tail[0]?.role === 'tool' && tail[0]?.tool_call_id) {
    const toolCallId = tail[0].tool_call_id
    for (let index = nonSystem.length - 5; index >= Math.max(0, nonSystem.length - 6); index -= 1) {
      if (nonSystem[index]?.tool_calls?.some(call => call.id === toolCallId)) {
        return nonSystem.slice(index)
      }
    }
  }
  return tail
}

function selectBoundedDigestTail(messages: ChatMessage[]): ChatMessage[] {
  const nonSystem = messages.filter(message => message.role !== 'system')
  const maxMessages = 6
  let start = Math.max(0, nonSystem.length - maxMessages)

  if (nonSystem[start]?.role === 'tool' && nonSystem[start].tool_call_id) {
    const toolCallId = nonSystem[start].tool_call_id
    for (let index = start - 1; index >= Math.max(0, start - 2); index -= 1) {
      if (nonSystem[index].tool_calls?.some(call => call.id === toolCallId)) {
        start = index
        break
      }
    }
  }

  return nonSystem.slice(start)
}

function findLastAssistantToolCall(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'assistant' && (messages[index].tool_calls?.length ?? 0) > 0) {
      return index
    }
  }
  return -1
}
