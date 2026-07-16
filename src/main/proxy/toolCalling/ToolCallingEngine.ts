import type { ChatCompletionRequest, ChatMessage } from '../types.ts'
import type { Provider } from '../../store/types.ts'
import {
  DEFAULT_TOOL_CALLING_CONFIG,
  normalizeToolCallingConfig,
  type ToolCallingConfig,
} from '../../../shared/toolCalling.ts'
import { getToolProtocol } from './protocols/index.ts'
import { renderManagedXmlContractHeader } from './protocols/managedXml.ts'
import { getToolClientAdapter } from './clientAdapters/index.ts'
import { buildToolCallingRuntimePlan } from './runtimePlan.ts'
import type { NormalizedToolDefinition, ToolCallingPlan, ToolCallingTransformResult, ToolProtocolId } from './types.ts'
import type { ToolActionConstraint, ToolManifest } from './ToolManifest.ts'
import { createToolManifest } from './ToolManifest.ts'

export class ToolCallingEngine {
  private readonly config: ToolCallingConfig

  constructor(config: Partial<ToolCallingConfig> = {}) {
    this.config = normalizeToolCallingConfig({
      ...DEFAULT_TOOL_CALLING_CONFIG,
      ...config,
      advanced: {
        ...DEFAULT_TOOL_CALLING_CONFIG.advanced,
        ...config.advanced,
      },
    })
  }

  transformRequest(input: {
    request: ChatCompletionRequest
    provider: Provider
    actualModel: string
    requestId?: string
    toolSessionKey?: string | null
  }): ToolCallingTransformResult {
    const { request, provider, actualModel, requestId, toolSessionKey } = input
    const adapter = getToolClientAdapter(this.config.clientAdapterId)
    const clientRequest = adapter.normalizeRequest(request)
    const plan = buildToolCallingRuntimePlan({
      requestId,
      providerId: provider.id,
      actualModel,
      model: request.model,
      config: this.config,
      clientRequest,
      messages: request.messages,
      toolSessionKey: toolSessionKey ?? requestId ?? null,
    })
    const shouldInjectPrompt = plan.shouldInjectPrompt

    if (!shouldInjectPrompt) {
      return {
        messages: request.messages,
        tools: plan.mode === 'disabled' ? request.tools : undefined,
        plan,
      }
    }

    const toolManifest = this.createToolManifest(plan, request.messages)
    // Enforce the action constraint at the parser level so the model cannot
    // bypass a constrained turn by calling the wrong tool. The constraint was
    // previously only a prompt hint — the parser would accept any valid managed
    // XML regardless of what the projected catalog showed.
    if (toolManifest.actionConstraint) {
      const c = toolManifest.actionConstraint
      if (c.kind === 'terminal_final_text_required') {
        plan.allowedToolNames = new Set()
      } else if (c.toolName) {
        plan.allowedToolNames = new Set([c.toolName])
      }
    }
    return {
      messages: request.messages,
      tools: undefined,
      plan,
      toolManifest,
    }
  }

  createToolManifest(plan: ToolCallingPlan, messages: ChatMessage[] = []): ToolManifest {
    const actionConstraint = detectToolActionConstraint(plan, messages)
    const renderedPrompt = renderProjectedPrompt(plan.protocol, plan.tools, this.config, actionConstraint)
    const constrainedPrompt = actionConstraint
      ? `${renderToolActionConstraint(actionConstraint)}\n\n${renderedPrompt}`
      : renderedPrompt
    const contractHeader = plan.catalogSnapshot
      ? renderManagedXmlContractHeader({
          catalogFingerprint: plan.catalogSnapshot.fingerprint,
          allowedToolNames: [...plan.allowedToolNames],
          protocol: plan.protocol,
          contractHeaderVersion: 1,
        })
      : ''
    const fullPrompt = contractHeader ? `${contractHeader}\n\n${constrainedPrompt}` : constrainedPrompt
    return createToolManifest({
      protocol: plan.protocol,
      catalogFingerprint: plan.catalogSnapshot?.fingerprint ?? '',
      allowedToolNames: [...plan.allowedToolNames],
      tools: plan.tools.map(t => ({ ...t })),
      renderedPrompt: fullPrompt,
      contractHeaderVersion: 1,
      actionConstraint,
    })
  }

  applyNonStreamResponse(result: any, plan: ToolCallingPlan): void {
    if (!plan.shouldParseResponse) return

    const message = result?.choices?.[0]?.message
    if (!message || typeof message.content !== 'string') return

    const parseResult = parseSelectedProtocol(message.content, plan)
    plan.diagnostics.parserFormat = parseResult.protocol
    plan.diagnostics.parsedToolCallCount = parseResult.toolCalls.length
    plan.diagnostics.invalidToolNames = parseResult.invalidToolNames
    plan.diagnostics.malformedReason = parseResult.malformedReason

    if (parseResult.toolCalls.length === 0) return

    message.content = parseResult.content || null
    message.tool_calls = parseResult.toolCalls

    const choice = result.choices[0]
    choice.finish_reason = 'tool_calls'
  }
}

function renderPrompt(
  protocol: ToolProtocolId,
  tools: NormalizedToolDefinition[],
  config: ToolCallingConfig,
): string {
  const prompt = getToolProtocol(protocol).renderPrompt(tools)
  const customPromptTemplate = config.diagnosticsEnabled
    ? config.advanced.customPromptTemplate
    : undefined
  if (!customPromptTemplate) return prompt

  return customPromptTemplate
    .replace(/\{\{tools\}\}/g, prompt)
    .replace(/\{\{tool_names\}\}/g, tools.map((tool) => tool.name).join(', '))
    .replace(/\{\{format\}\}/g, protocol)
}

function renderProjectedPrompt(
  protocol: ToolProtocolId,
  tools: NormalizedToolDefinition[],
  config: ToolCallingConfig,
  actionConstraint: ToolActionConstraint | null,
): string {
  if (!actionConstraint) {
    return renderPrompt(protocol, tools, config)
  }

  if (actionConstraint.kind === 'terminal_final_text_required') {
    return [
      '[Current action surface]',
      'The gateway still preserves the full tool catalog structurally for later turns.',
      'No verbose tool definitions are shown because no tool is valid for this turn.',
    ].join('\n')
  }

  const projectedTools = tools.filter((tool) => tool.name === actionConstraint.toolName)
  const projectedPrompt = renderPrompt(protocol, projectedTools, config)
  const isSkillOrNext = actionConstraint.kind === 'first_skill_required'
    || actionConstraint.kind === 'next_required_tool'
  const immediateNextOutput = actionConstraint.kind === 'first_skill_required'
    ? [
        '',
        '[Immediate next output]',
        'Output exactly this Chat2API XML tool call now and nothing else.',
        'Do not output any final completion marker before the required skill tool result and follow-up tool sequence complete.',
        renderRequiredSkillXml(actionConstraint.arguments.name),
      ]
    : []
  return [
    '[Current action surface]',
    'The gateway still preserves the full tool catalog structurally for later turns.',
    'Only the currently valid tool surface is shown below for this constrained turn.',
    '',
    projectedPrompt,
    ...immediateNextOutput,
  ].join('\n')
}

function parseSelectedProtocol(content: string, plan: ToolCallingPlan) {
  const selected = getToolProtocol(plan.protocol)
  return selected.parse(content, { tools: plan.tools, protocol: plan.protocol })
}

function detectToolActionConstraint(
  plan: ToolCallingPlan,
  messages: ChatMessage[]
): ToolActionConstraint | null {
  const instructionText = messages
    .filter(message =>
      (message.role === 'system' || message.role === 'user')
      && !message.tool_call_id
      && (message.tool_calls?.length ?? 0) === 0
    )
    .map(getMessageContent)
    .filter(content => content.trim().length > 0)
    .join('\n\n')

  if (plan.tools.some(tool => tool.name === 'skill')) {
    // If a skill is already loaded, use that skill's name regardless of what
    // the instruction text says. extractFirstSkillConstraintName may match a
    // different skill name from the agent definition (e.g. capability-probe agent
    // matches agent-capability-probe while the prompt asks for long-conversation-probe).
    const skillName = extractLoadedSkillName(messages)
      ?? extractFirstSkillConstraintName(instructionText)
    if (skillName && !hasCompletedSkillResult(messages, skillName)) {
      return {
        kind: 'first_skill_required',
        toolName: 'skill',
        arguments: { name: skillName },
        reason: 'request_requires_first_assistant_action_skill',
      }
    }
    // Skill is loaded — check if there are pending numbered workflow steps.
    // If no non-skill tool has been called yet, constrain to the first workflow tool.
    if (skillName && hasCompletedSkillResult(messages, skillName)) {
      const nonSkillToolCount = countNonSkillToolCalls(messages)
      console.log('[ToolCallingEngine] nonSkillToolCount=%d skillResult=%s',
        nonSkillToolCount, hasCompletedSkillResult(messages, skillName))
      if (nonSkillToolCount === 0) {
        // After compaction, assistant tool_call history may be truncated to zero.
        // Don't force a hardcoded 'read' constraint — the prompt still contains
        // workflow checkpoint markers with the required next action. The first-turn
        // optimization (read) was a hint, not a correctness requirement.
        return null
      }
      const nextStep = extractWorkflowNextStep(messages)
      if (nextStep) {
        console.log('[ToolCallingEngine] Workflow next step:', JSON.stringify(nextStep))
        return {
          kind: 'next_required_tool',
          toolName: nextStep.toolName,
          arguments: nextStep.args,
          reason: 'skill_workflow_next_step_required',
        }
      }
    }
  }

  const finalMarker = extractTerminalFinalTextMarker(instructionText)
  if (!finalMarker) {
    return null
  }

  if (!hasCompletedTerminalWorkflowEvidence(messages)) {
    return null
  }

  return {
    kind: 'terminal_final_text_required',
    toolName: null,
    arguments: { exactText: finalMarker },
    reason: 'request_requires_terminal_final_text',
  }
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

function extractFirstSkillConstraintName(text: string): string | undefined {
  if (!/\bfirst\s+(?:assistant\s+)?action\b/i.test(text)) {
    return undefined
  }
  if (!/\b(?:real\s+)?(?:OpenCode\s+)?`?skill`?\s+tool\s+call\b/i.test(text)) {
    return undefined
  }

  const directMatch = text.match(
    /\b(?:real\s+)?(?:OpenCode\s+)?`?skill`?\s+tool\s+call\s+for\s+[`"']?([A-Za-z0-9][A-Za-z0-9_.-]*[A-Za-z0-9])(?:[`"']|\b)/i
  )
  if (directMatch?.[1]) {
    return directMatch[1]
  }

  const requestedByNameMatch = text.match(
    /\b(?:skill|probe)\s+(?:is\s+)?(?:requested\s+)?(?:by\s+name\s+)?[`"']([A-Za-z0-9][A-Za-z0-9_.-]*[A-Za-z0-9])[`"']/i
  )
  return requestedByNameMatch?.[1]
}

interface WorkflowNextStep {
  toolName: string
  args: { filePath?: string; command?: string }
}

function extractLoadedSkillName(messages: ChatMessage[]): string | undefined {
  for (const m of messages) {
    const content = getMessageContent(m)
    const match = content.match(/<skill_content\s+name="([^"]+)"/)
    if (match?.[1]) return match[1]
  }
  return undefined
}

function countNonSkillToolCalls(messages: ChatMessage[]): number {
  let count = 0
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    for (const call of m.tool_calls ?? []) {
      if (call.function?.name?.toLowerCase() !== 'skill') count++
    }
  }
  return count
}

const RE_SKILL_STEP = /^\d+\.\s+Use\s+the\s+`(\w+)`\s+tool\s+to\s+(?:read\s+`([^`]+)`|run:?\s*$|run:\s+`([^`]+)`)/im

const RE_CHECKPOINT_NEXT_TOOL = /Required next action:\s+call the\s+`?(\w+)`?\s+tool/i

/**
 * Scan messages for workflow checkpoint markers placed by context management
 * during compaction. These explicit markers survive compaction because they
 * are user-role messages, unlike assistant tool_calls which get truncated.
 *
 * Format: "Required next action: call the X tool for this exact skill step now."
 */
function extractCheckpointWorkflowNext(messages: ChatMessage[]): WorkflowNextStep | null {
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'system') continue
    const text = getMessageContent(message)
    const toolMatch = text.match(RE_CHECKPOINT_NEXT_TOOL)
    if (!toolMatch) continue
    return { toolName: toolMatch[1].toLowerCase(), args: {} }
  }
  return null
}

function extractWorkflowNextStep(messages: ChatMessage[]): WorkflowNextStep | null {
  // Collect skill instruction steps from skill result messages
  const steps: Array<{ toolName: string; filePath?: string; command?: string }> = []
  const skillResultText = messages
    .filter(m => m.role === 'tool' && m.tool_call_id)
    .map(getMessageContent)
    .join('\n')
  if (!skillResultText.includes('<skill_content')) return null

  const lines = skillResultText.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const match = line.match(RE_SKILL_STEP)
    if (!match) continue
    const toolName = (match[1] ?? '').toLowerCase()
    let filePath = match[2]
    let command = match[3]

    // If the line ends with 'run:' or 'run:\' and no command was captured on this line,
    // collect the backtick-quoted command from subsequent lines.
    if (!command && /\brun:?\s*$/.test(line.trimEnd())) {
      const collected: string[] = []
      for (let j = i + 1; j < lines.length; j++) {
        const cont = lines[j]
        if (/^\d+\.\s+Use\s+the\s+`/.test(cont)) break
        const btMatch = cont.match(/`([^`]+)`/)
        if (btMatch) {
          collected.push(btMatch[1])
        } else if (collected.length > 0 && cont.trim() === '') {
          break
        } else if (collected.length > 0 && !cont.trimEnd().endsWith('\\')) {
          break
        }
      }
      if (collected.length > 0) command = collected.join(' ; ')
    }

    steps.push({ toolName, filePath, command })
  }
  if (steps.length === 0) return null

  // Before sequential matching (which is unreliable after compaction):
  // scan for explicit workflow checkpoint markers from context management.
  // These survive compaction because they're user-role messages.
  const checkpointNext = extractCheckpointWorkflowNext(messages)
  if (checkpointNext) return checkpointNext

  // Collect completed tool calls from assistant messages
  const completedTools: string[] = []
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    for (const call of m.tool_calls ?? []) {
      const name = call.function?.name?.toLowerCase()
      if (name && name !== 'skill') completedTools.push(name)
    }
  }

  // Match sequentially: count completed calls per tool and step through instructions
  const remaining = new Map<string, number>()
  for (const tool of completedTools) {
    remaining.set(tool, (remaining.get(tool) ?? 0) + 1)
  }
  for (const step of steps) {
    const key = step.toolName
    if ((remaining.get(key) ?? 0) > 0) {
      remaining.set(key, remaining.get(key)! - 1)
    } else {
      return {
        toolName: step.toolName,
        args: {
          ...(step.filePath ? { filePath: step.filePath } : {}),
          ...(step.command ? { command: step.command } : {}),
        },
      }
    }
  }
  return null
}

function extractTerminalFinalTextMarker(text: string): string | undefined {
  const directMatch = text.match(
    /\bfinal\s+assistant\s+text\s+contain(?:s)?\s+[`"']([A-Z0-9][A-Z0-9_.-]*[A-Z0-9])[`"']/i
  )
  if (directMatch?.[1]) {
    return directMatch[1]
  }

  const exactMatch = text.match(
    /\boutput\s+exactly\s+(?:the\s+required\s+final\s+text|the\s+final\s+text|final\s+text)\s+[`"']([A-Z0-9][A-Z0-9_.-]*[A-Z0-9])[`"']/i
  )
  if (exactMatch?.[1]) {
    return exactMatch[1]
  }

  const simpleMarkerMatch = text.match(/\bCAPABILITY_PROBE_DONE\b/)
  return simpleMarkerMatch?.[0]
}

function hasCompletedSkillResult(messages: ChatMessage[], skillName: string): boolean {
  const skillToolCallIds = new Set<string>()

  for (const message of messages) {
    if (message.role !== 'assistant') {
      continue
    }

    for (const call of message.tool_calls ?? []) {
      if (call.function?.name !== 'skill' || !call.id) {
        continue
      }
      if (toolCallArgumentsSkillName(call.function.arguments) === skillName) {
        skillToolCallIds.add(call.id)
      }
    }
  }

  return messages.some((message) => {
    if (message.tool_call_id && skillToolCallIds.has(message.tool_call_id)) {
      return true
    }
    // Check all messages for skill content evidence, not only tool-role messages.
    // The tool result may be the only surviving evidence after sliding-window trimming
    // dropped the initiating assistant tool-call message.
    const content = getMessageContent(message)
    return content.includes('<skill_content') && content.includes(skillName)
  })
}

function hasCompletedTerminalWorkflowEvidence(messages: ChatMessage[]): boolean {
  const resultReadCallIds = new Set<string>()

  for (const message of messages) {
    if (message.role !== 'assistant') {
      continue
    }

    for (const call of message.tool_calls ?? []) {
      if (!call.id) {
        continue
      }

      if (call.function?.name === 'bash' && bashArgumentsGenerateProbeResult(call.function.arguments)) {
        resultReadCallIds.add(call.id)
        continue
      }

      if (call.function?.name === 'read' && readArgumentsTargetProbeResult(call.function.arguments)) {
        resultReadCallIds.add(call.id)
      }
    }
  }

  return messages.some((message) => {
    if (message.role !== 'tool') {
      return false
    }
    return Boolean(message.tool_call_id && resultReadCallIds.has(message.tool_call_id))
  })
}

function hasLaterUserInstructionAfterTerminalEvidence(messages: ChatMessage[], finalMarker: string): boolean {
  const terminalEvidenceIndex = findLastTerminalEvidenceIndex(messages)
  if (terminalEvidenceIndex === -1) {
    return false
  }

  return messages.slice(terminalEvidenceIndex + 1).some((message) => {
    if (message.role !== 'user') {
      return false
    }
    const content = getMessageContent(message).trim()
    if (!content) {
      return false
    }
    return !content.includes(finalMarker)
  })
}

function findLastTerminalEvidenceIndex(messages: ChatMessage[]): number {
  const terminalToolCallIds = new Set<string>()

  for (const message of messages) {
    if (message.role !== 'assistant') {
      continue
    }

    for (const call of message.tool_calls ?? []) {
      if (!call.id) {
        continue
      }
      if (
        (call.function?.name === 'bash' && bashArgumentsGenerateProbeResult(call.function.arguments))
        || (call.function?.name === 'read' && readArgumentsTargetProbeResult(call.function.arguments))
      ) {
        terminalToolCallIds.add(call.id)
      }
    }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'tool' && message.tool_call_id && terminalToolCallIds.has(message.tool_call_id)) {
      return index
    }
  }

  return -1
}

function toolCallArgumentsSkillName(args: string): string | undefined {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>
    return typeof parsed.name === 'string' ? parsed.name : undefined
  } catch {
    return undefined
  }
}

function bashArgumentsGenerateProbeResult(args: string): boolean {
  const command = readStringToolArgument(args, 'command')
  if (!command) {
    return false
  }
  return command.includes('.agent-probe/result.json')
}

function readArgumentsTargetProbeResult(args: string): boolean {
  const filePath = readStringToolArgument(args, 'filePath')
  if (!filePath) {
    return false
  }
  return filePath.includes('.agent-probe/result.json')
}

function readStringToolArgument(args: string, key: string): string | undefined {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>
    return typeof parsed[key] === 'string' ? parsed[key] as string : undefined
  } catch {
    return undefined
  }
}

function renderRequiredSkillXml(skillName: string): string {
  return `<|CHAT2API|tool_calls><|CHAT2API|invoke name="skill"><|CHAT2API|parameter name="name"><![CDATA[${skillName}]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>`
}

function renderToolActionConstraint(constraint: ToolActionConstraint): string {
  if (constraint.kind === 'terminal_final_text_required') {
    return [
      '[High-priority tool action constraint]',
      'No tool call is valid for this turn.',
      `Output exactly: ${constraint.arguments.exactText}`,
      'Do not call read, bash, write, skill, or any other tool.',
      'The gateway still preserves the full tool catalog; this prompt shows only the current action surface.',
    ].join('\n')
  }

  if (constraint.kind === 'next_required_tool') {
    const toolName = constraint.toolName ?? 'read'
    const args = constraint.arguments
    const hint = args.filePath ? `filePath="${args.filePath}"`
      : args.command ? `command="${args.command}"`
      : null
    return [
      '[High-priority tool action constraint]',
      'The skill workflow requires an exact next tool call before any other assistant text or final marker.',
      `Only valid next tool: ${toolName}`,
      hint ? `Required arguments: ${hint}` : '',
      'Do not call any other tool before this required step.',
      'Do not output any final completion marker before the required tool sequence is complete.',
      'The gateway still preserves the full tool catalog; this prompt shows only the current action surface.',
    ].filter(Boolean).join('\n')
  }

  const requiredXml = renderRequiredSkillXml(constraint.arguments.name)

  return [
    '[High-priority tool action constraint]',
    'Output exactly this complete Chat2API XML tool-call block as the next assistant message, with no markdown, JSON, prose, or explanation before or after it:',
    requiredXml,
    `Only valid next tool: ${constraint.toolName}`,
    `Required tool call: skill(name="${constraint.arguments.name}")`,
    'The next assistant action must be exactly one Chat2API XML tool call that uses parameter name="name".',
    'Invalid formats include <skill_tool_call>, <tool_call>, JSON-only tool descriptions, fenced code blocks, or text saying you will invoke the skill.',
    'Do not use the skill name itself as a parameter name.',
    'Do not call read, bash, write, or any other non-skill tool before the skill result.',
    'Do not output any final completion marker before the required skill tool result and follow-up tool sequence complete.',
    'The gateway still preserves the full tool catalog; this prompt shows only the current action surface.',
  ].join('\n')
}
