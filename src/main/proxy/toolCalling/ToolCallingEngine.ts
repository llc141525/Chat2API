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
import { logger } from '../shared/logger.ts'

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
    logger.info('[ToolCallingEngine] action decision:', JSON.stringify({
      requestId,
      toolNames: plan.tools.map(tool => tool.name),
      allowedToolNames: [...plan.allowedToolNames],
      actionConstraint: toolManifest.actionConstraint,
      messageToolNames: request.messages.flatMap(message =>
        (message.tool_calls ?? []).map(call => call.function?.name).filter(Boolean),
      ),
      skillResultCount: request.messages.filter(message => getMessageContent(message).includes('<skill_content')).length,
      checkpointCount: request.messages.filter(message => getMessageContent(message).includes('[Active skill workflow state checkpoint]')).length,
    }))
    // Enforce the action constraint at the parser level so the model cannot
    // bypass a constrained turn by calling the wrong tool. The constraint was
    // previously only a prompt hint — the parser would accept any valid managed
    // XML regardless of what the projected catalog showed.
    if (toolManifest.actionConstraint) {
      const c = toolManifest.actionConstraint
      plan.actionConstraint = c
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
        renderRequiredSkillXml(actionConstraint.arguments.name ?? ''),
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

  if (plan.tools.some(tool => workflowToolKey(tool.name) === 'skill')) {
    const checkpointInspection = inspectCheckpointWorkflowNext(messages)
    logger.info('[ToolCallingEngine] checkpoint parse:', JSON.stringify({
      checkpointCount: checkpointInspection.checkpointCount,
      checkpointChars: checkpointInspection.checkpointChars,
      status: checkpointInspection.status,
      reason: checkpointInspection.reason,
      toolName: checkpointInspection.nextStep?.toolName ?? null,
      argumentKeys: checkpointInspection.nextStep ? Object.keys(checkpointInspection.nextStep.args) : [],
    }))
    const checkpointNext = checkpointInspection.nextStep
    if (checkpointNext) {
      const toolName = resolveWorkflowToolName(checkpointNext.toolName, plan.tools)
      return {
        kind: 'next_required_tool',
        toolName,
        arguments: checkpointNext.args,
        reason: 'skill_workflow_next_step_required',
      }
    }

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
        // Do not force a hardcoded 'read' constraint. If the surviving skill
        // document or checkpoint states the next action, use that evidence;
        // otherwise leave the catalog unconstrained.
        const nextStep = extractWorkflowNextStep(messages)
        if (nextStep) {
          const toolName = resolveWorkflowToolName(nextStep.toolName, plan.tools)
          console.log('[ToolCallingEngine] Workflow next step:', JSON.stringify(nextStep))
          return {
            kind: 'next_required_tool',
            toolName,
            arguments: nextStep.args,
            reason: 'skill_workflow_next_step_required',
          }
        }
        return null
      }
      const nextStep = extractWorkflowNextStep(messages)
      if (nextStep) {
        const toolName = resolveWorkflowToolName(nextStep.toolName, plan.tools)
        console.log('[ToolCallingEngine] Workflow next step:', JSON.stringify(nextStep))
        return {
          kind: 'next_required_tool',
          toolName,
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
      if (workflowToolKey(call.function?.name ?? '') !== 'skill') count++
    }
  }
  return count
}

const RE_SKILL_STEP = /^\d+\.\s+Use\s+the\s+`(\w+)`\s+tool\s+to\s+(?:read\s+`([^`]+)`|run:?\s*$|run:\s+`([^`]+)`)/im
const RE_DIRECT_SKILL_STEP = /^\d+\.\s+(Read|Re-read|Write|Glob|Bash|Run)\s+`([^`]+)`/i

const RE_CHECKPOINT_NEXT_TOOL = /Required next action:\s+call the\s+`?(\w+)`?\s+tool/i

interface CheckpointInspection {
  checkpointCount: number
  checkpointChars: number
  status: 'absent' | 'parsed' | 'no_required_action' | 'missing_arguments'
  reason: string
  nextStep: WorkflowNextStep | null
}

function normalizeWorkflowStepToolName(rawToolName: string): string {
  const normalizedStepName = rawToolName.toLowerCase()
  return normalizedStepName === 'run'
    ? 'bash'
    : normalizedStepName === 're-read'
      ? 'read'
      : normalizedStepName
}

function extractCheckpointNextSkillStepBlock(text: string): string | null {
  const match = text.match(
    /Next required skill step:\s*([\s\S]+?)(?:\n(?:Only the|Do not repeat|Latest pinned|Listed read\/bash\/write)\b|$)/i,
  )
  return match?.[1]?.trim() || null
}

function extractWorkflowNextStepFromInstructionBlock(block: string): WorkflowNextStep | null {
  const numberedStepMatch = block.match(/^\d+\.\s+([\s\S]+)$/)
  const instruction = (numberedStepMatch?.[1] ?? block).trim()
  const directMatch = instruction.match(/^(Read|Re-read|Write|Glob|Bash|Run)\s+`([^`]+)`/i)
    ?? instruction.match(/^(Read|Re-read|Write|Glob|Bash|Run)\b[\s\S]*?`([^`]+)`/i)
  if (directMatch) {
    const toolName = normalizeWorkflowStepToolName(directMatch[1])
    return {
      toolName,
      args: toolName === 'bash'
        ? { command: directMatch[2] }
        : { filePath: directMatch[2] },
    }
  }

  const actionMatch = instruction.match(/\b(?:use|call|emit|run)\s+(?:the|a|an)?\s*`?(skill|read|bash|write|edit|grep|glob)`?\s+tool\b/i)
  const fallbackToolMatch = instruction.match(/\b(skill|read|bash|write|edit|grep|glob)\b/i)
  const toolName = normalizeWorkflowStepToolName(actionMatch?.[1] ?? fallbackToolMatch?.[1] ?? '')
  if (!toolName) return null

  const commandMatch = instruction.match(/`([^`]*(?:New-Item|node\b|writeFileSync)[^`]*)`/i)
  if (toolName === 'bash') {
    return {
      toolName,
      args: commandMatch?.[1]?.trim()
        ? { command: commandMatch[1].trim() }
        : {},
    }
  }

  const pathMatch = instruction.match(/`(\.?[A-Za-z0-9_./\\-]*\.[A-Za-z0-9_-]+)`/)
    ?? instruction.match(/(\.?[A-Za-z0-9_./\\-]*\.[A-Za-z0-9_-]+)/)
  return {
    toolName,
    args: pathMatch?.[1]?.trim() ? { filePath: pathMatch[1].trim() } : {},
  }
}

/**
 * Scan messages for workflow checkpoint markers placed by context management
 * during compaction. These explicit markers survive compaction because they
 * are user-role messages, unlike assistant tool_calls which get truncated.
 *
 * Format: "Required next action: call the X tool for this exact skill step now."
 */
function inspectCheckpointWorkflowNext(messages: ChatMessage[]): CheckpointInspection {
  let checkpointCount = 0
  let checkpointChars = 0
  for (const message of messages) {
    // Context management may preserve the checkpoint inside the latest tool
    // result during a child-session handoff. It is still authoritative state,
    // so do not discard it based on the message role.
    const text = getMessageContent(message)
    if (!text.includes('[Active skill workflow state checkpoint]')) continue
    checkpointCount += 1
    checkpointChars += text.length
    const skillStepBlock = extractCheckpointNextSkillStepBlock(text)
    const skillStep = skillStepBlock
      ? extractWorkflowNextStepFromInstructionBlock(skillStepBlock)
      : null
    if (skillStep) {
      const hasConcreteArguments = Object.keys(skillStep.args).length > 0
      return {
        checkpointCount,
        checkpointChars,
        status: hasConcreteArguments ? 'parsed' : 'missing_arguments',
        reason: hasConcreteArguments
          ? 'next_required_skill_step'
          : 'next_required_skill_step_without_concrete_arguments',
        nextStep: skillStep,
      }
    }
    const toolMatch = text.match(RE_CHECKPOINT_NEXT_TOOL)
    if (!toolMatch) continue
    const argumentMatch = text.match(/Required next tool arguments:\s*(filePath|command)=([\s\S]+?)(?:\s+(?:Do not call|Next required skill step:|Only the|Latest pinned|Do not repeat|Latest pinned skill|Listed read\/bash\/write)|$)/i)
    if (!argumentMatch) {
      return {
        checkpointCount,
        checkpointChars,
        status: 'missing_arguments',
        reason: skillStepBlock
          ? 'next_required_skill_step_unparseable'
          : 'required_action_without_arguments',
        nextStep: { toolName: toolMatch[1].toLowerCase(), args: {} },
      }
    }

    const argumentValue = argumentMatch[2]
      .trim()
      .replace(/^['"]|['"]$/g, '')
      .split(/\s+(?:Do not call|Next required|Only the|Latest pinned)\b/i)[0]
      .trim()
    return {
      checkpointCount,
      checkpointChars,
      status: 'parsed',
      reason: 'required_next_tool_arguments',
      nextStep: {
        toolName: toolMatch[1].toLowerCase(),
        args: argumentMatch[1].toLowerCase() === 'filepath'
          ? { filePath: argumentValue }
          : { command: argumentValue },
      },
    }
  }
  return {
    checkpointCount,
    checkpointChars,
    status: checkpointCount > 0 ? 'no_required_action' : 'absent',
    reason: checkpointCount > 0 ? 'checkpoint_without_required_action' : 'no_checkpoint_marker',
    nextStep: null,
  }
}

function extractCheckpointWorkflowNext(messages: ChatMessage[]): WorkflowNextStep | null {
  return inspectCheckpointWorkflowNext(messages).nextStep
}

function workflowToolKey(name: string): string {
  const baseName = name.toLowerCase().split(':').at(-1) ?? name.toLowerCase()
  return baseName.replace(/_file$/, '')
}

function resolveWorkflowToolName(
  semanticName: string,
  tools: NormalizedToolDefinition[],
): string {
  const exact = tools.find(tool => tool.name.toLowerCase() === semanticName.toLowerCase())
  if (exact) return exact.name

  const semanticKey = workflowToolKey(semanticName)
  const matchingTool = tools.find(tool => workflowToolKey(tool.name) === semanticKey)
  return matchingTool?.name ?? semanticName
}

function extractWorkflowNextStep(messages: ChatMessage[]): WorkflowNextStep | null {
  const checkpointNext = extractCheckpointWorkflowNext(messages)
  if (checkpointNext) return checkpointNext

  // Collect skill instruction steps from skill result messages
  const steps: Array<{ toolName: string; filePath?: string; command?: string }> = []
  const skillResultText = messages
    .map(getMessageContent)
    .filter(content => content.includes('<skill_content'))
    .join('\n')
  if (!skillResultText.includes('<skill_content')) return null

  const lines = skillResultText.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const match = line.match(RE_SKILL_STEP)
    const directMatch = line.match(RE_DIRECT_SKILL_STEP)
    if (!match && !directMatch) continue
    const rawToolName = (match?.[1] ?? directMatch?.[1] ?? '').toLowerCase()
    const toolName = normalizeWorkflowStepToolName(rawToolName)
    let filePath = match?.[2] ?? (directMatch && toolName !== 'bash' ? directMatch[2] : undefined)
    let command = match?.[3] ?? (directMatch && toolName === 'bash' ? directMatch[2] : undefined)

    // If the line ends with 'run:' or 'run:\' and no command was captured on this line,
    // collect the backtick-quoted command from subsequent lines.
    if (!command && /\brun:?\s*$/.test(line.trimEnd())) {
      const collected: string[] = []
      for (let j = i + 1; j < lines.length; j++) {
        const cont = lines[j]
        if (/^\d+\.\s+(?:Use\s+the\s+`|(?:Read|Write|Glob|Bash|Run)\s+`)/i.test(cont)) break
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

  const completedTools = collectCompletedWorkflowTools(messages)

  // Match sequentially: count completed calls per tool and step through instructions
  const remaining = new Map<string, number>()
  for (const tool of completedTools) {
    remaining.set(tool, (remaining.get(tool) ?? 0) + 1)
  }
  for (const step of steps) {
      const key = workflowToolKey(step.toolName)
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

function collectCompletedWorkflowTools(messages: ChatMessage[]): string[] {
  const completedTools: string[] = []
  for (const m of messages) {
    if (m.role === 'assistant') {
      for (const call of m.tool_calls ?? []) {
        const name = call.function?.name?.toLowerCase()
        if (name && workflowToolKey(name) !== 'skill') {
          completedTools.push(workflowToolKey(name))
        }
      }
      continue
    }

    const openCodeToolName = extractOpenCodeCompletedToolName(getMessageContent(m))
    if (openCodeToolName && workflowToolKey(openCodeToolName) !== 'skill') {
      completedTools.push(workflowToolKey(openCodeToolName))
    }
  }
  return completedTools
}

function extractOpenCodeCompletedToolName(content: string): string | null {
  const trimmed = content.trim()
  if (!trimmed.includes('"type"') || !trimmed.includes('"tool"') || !trimmed.includes('completed')) {
    return null
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    const tool = typeof parsed.tool === 'string' ? parsed.tool : null
    const state = parsed.state && typeof parsed.state === 'object'
      ? parsed.state as Record<string, unknown>
      : null
    return tool && state?.status === 'completed' ? tool : null
  } catch {
    const toolMatch = trimmed.match(/"tool"\s*:\s*"([^"]+)"/)
    const completed = /"status"\s*:\s*"completed"/.test(trimmed)
    return toolMatch?.[1] && completed ? toolMatch[1] : null
  }
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
      if (workflowToolKey(call.function?.name ?? '') !== 'skill' || !call.id) {
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
    const requiredXml = renderRequiredWorkflowToolXml(toolName, args)
    return [
      '[High-priority tool action constraint]',
      'The skill workflow requires an exact next tool call before any other assistant text or final marker.',
      requiredXml
        ? `Output this exact Chat2API XML tool-call shape next, filling any remaining schema fields from the tool definition:\n${requiredXml}`
        : '',
      `Only valid next tool: ${toolName}`,
      hint ? `Required arguments: ${hint}` : '',
      'Do not call any other tool before this required step.',
      'Do not output any final completion marker before the required tool sequence is complete.',
      'The gateway still preserves the full tool catalog; this prompt shows only the current action surface.',
    ].filter(Boolean).join('\n')
  }

  const requiredXml = renderRequiredSkillXml(constraint.arguments.name ?? '')

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

function renderRequiredWorkflowToolXml(
  toolName: string,
  args: { filePath?: string; command?: string },
): string | null {
  const parameter = args.filePath
    ? `<|CHAT2API|parameter name="filePath"><![CDATA[${args.filePath}]]></|CHAT2API|parameter>`
    : args.command
      ? `<|CHAT2API|parameter name="command"><![CDATA[${args.command}]]></|CHAT2API|parameter>`
      : ''
  if (!parameter) return null
  return `<|CHAT2API|tool_calls><|CHAT2API|invoke name="${toolName}">${parameter}</|CHAT2API|invoke></|CHAT2API|tool_calls>`
}
