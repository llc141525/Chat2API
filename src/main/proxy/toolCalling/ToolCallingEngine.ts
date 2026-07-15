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
    const skillName = extractFirstSkillConstraintName(instructionText)
    if (skillName && !hasCompletedSkillResult(messages, skillName)) {
      return {
        kind: 'first_skill_required',
        toolName: 'skill',
        arguments: { name: skillName },
        reason: 'request_requires_first_assistant_action_skill',
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
    if (message.role !== 'tool') {
      return false
    }
    if (message.tool_call_id && skillToolCallIds.has(message.tool_call_id)) {
      return true
    }

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
