import type { ToolCallingConfig } from '../../../shared/toolCalling.ts'
import type { NormalizedClientToolRequest } from './clientAdapters/types.ts'
import { getProviderToolProfile } from './providerProfiles.ts'
import type { ToolCallingPlan, NormalizedToolDefinition } from './types.ts'
import type { ChatMessage } from '../types.ts'
import { hasGeneralToolPromptSignature } from '../constants/signatures.ts'

export function buildToolCallingRuntimePlan(input: {
  requestId?: string
  providerId: string
  actualModel?: string
  model?: string
  config: ToolCallingConfig
  clientRequest: NormalizedClientToolRequest
  messages?: ChatMessage[]
}): ToolCallingPlan {
  const profile = getProviderToolProfile(input.providerId)
  const tools = input.clientRequest.tools
  const toolNames = new Set(tools.map((tool) => tool.name))
  const forcedName = input.clientRequest.toolChoice.forcedName

  if (input.clientRequest.toolChoice.mode === 'forced' && forcedName && !toolNames.has(forcedName)) {
    throw new Error(`Forced tool ${forcedName} is not declared`)
  }

  const allowedToolNames = forcedName ? new Set([forcedName]) : toolNames
  const allowedTools = forcedName ? tools.filter((tool) => tool.name === forcedName) : tools
  const disabledReason = getDisabledReason(
    input.config,
    allowedTools.length,
    input.clientRequest.toolChoice.mode,
    profile.managedSupport,
    input.messages,
  )
  const mode = disabledReason ? 'disabled' : 'managed'
  const protocol = profile.preferredManagedProtocol
  const shouldInjectPrompt = mode === 'managed' && allowedTools.length > 0
  const shouldParseResponse = mode === 'managed'

  const effectiveTools = allowedTools.length > 0
    ? allowedTools
    : shouldParseResponse ? extractToolNamesFromMessages(input.messages) : []
  const effectiveToolNames = forcedName
    ? new Set([forcedName])
    : new Set(effectiveTools.map((tool) => tool.name))

  return {
    mode,
    protocol,
    clientAdapterId: input.clientRequest.clientAdapterId,
    providerId: input.providerId,
    tools: effectiveTools,
    shouldInjectPrompt,
    shouldParseResponse,
    toolChoiceMode: input.clientRequest.toolChoice.mode,
    allowedToolNames: effectiveToolNames,
    forcedToolName: forcedName,
    diagnostics: {
      requestId: input.requestId,
      clientAdapterId: input.clientRequest.clientAdapterId,
      providerId: input.providerId,
      model: input.model,
      actualModel: input.actualModel,
      toolSource: input.clientRequest.toolSource,
      mode,
      protocol,
      toolCount: effectiveTools.length,
      injected: shouldInjectPrompt,
      reason: disabledReason ?? `managed_${input.config.mode}`,
      toolChoiceMode: input.clientRequest.toolChoice.mode,
      forcedToolName: forcedName,
      allowedToolNames: [...effectiveToolNames],
    },
  }
}

function getDisabledReason(
  config: ToolCallingConfig,
  toolCount: number,
  toolChoiceMode: string,
  managedSupport: boolean,
  messages?: ChatMessage[],
): string | undefined {
  if (!config.enabled || config.mode === 'off') return 'mode_off'
  if (toolChoiceMode === 'none') return 'tool_choice_none'
  if (toolCount === 0) {
    if (!hasExistingManagedXmlContext(messages)) return 'no_tools'
  }
  if (!managedSupport && config.mode === 'auto') return 'provider_not_supported'
  return undefined
}

function hasExistingManagedXmlContext(messages?: ChatMessage[]): boolean {
  if (!messages || messages.length === 0) return false

  for (const msg of messages) {
    if (msg.role === 'system' && typeof msg.content === 'string') {
      if (hasGeneralToolPromptSignature(msg.content)) return true
    }
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      return true
    }
    if (msg.role === 'tool' && msg.tool_call_id) {
      return true
    }
  }

  return false
}

const TOOL_NAME_REGEX = /<\|CHAT2API\|invoke\s+name="([^"]+)"/g

function extractToolNamesFromMessages(messages?: ChatMessage[]): NormalizedToolDefinition[] {
  if (!messages) return []

  const names = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'system' || typeof msg.content !== 'string') continue
    let match: RegExpExecArray | null
    while ((match = TOOL_NAME_REGEX.exec(msg.content)) !== null) {
      names.add(match[1])
    }
  }

  return [...names].map((name) => ({
    name,
    description: '',
    parameters: {},
    source: 'openai' as const,
  }))
}
