import type { ToolCallingConfig } from '../../../shared/toolCalling.ts'
import type { NormalizedClientToolRequest } from './clientAdapters/types.ts'
import { resolveToolCatalog } from './catalog.ts'
import { getProviderToolProfile } from './providerProfiles.ts'
import type { ToolCallingPlan } from './types.ts'
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
  toolSessionKey?: string | null
}): ToolCallingPlan {
  const profile = getProviderToolProfile(input.providerId)
  const requestTools = input.clientRequest.tools
  const forcedName = input.clientRequest.toolChoice.forcedName

  const catalogResolution = resolveToolCatalog({
    sessionId: input.toolSessionKey ?? null,
    requestTools,
    hasManagedToolHistory: hasExistingManagedXmlContext(input.messages),
    historyToolNames: extractManagedHistoryToolNames(input.messages),
  })
  const catalogTools = catalogResolution.snapshot?.tools ?? []
  const catalogToolNames = new Set(catalogTools.map((tool) => tool.name))

  if (catalogResolution.blocked) {
    throw new Error(catalogResolution.diagnostics.reason ?? 'tool_catalog_blocked')
  }

  if (input.clientRequest.toolChoice.mode === 'forced' && forcedName && !catalogToolNames.has(forcedName)) {
    throw new Error(`Forced tool ${forcedName} is not declared`)
  }

  const allowedToolNames = forcedName ? new Set([forcedName]) : catalogToolNames
  const allowedTools = forcedName ? catalogTools.filter((tool) => tool.name === forcedName) : [...catalogTools]
  const baseDisabledReason = getDisabledReason(
    input.config,
    allowedTools.length,
    input.clientRequest.toolChoice.mode,
    profile.managedSupport,
    input.messages,
  )
  const disabledReason = baseDisabledReason
  const mode = disabledReason ? 'disabled' : 'managed'
  const protocol = profile.preferredManagedProtocol
  const shouldInjectPrompt = mode === 'managed' && allowedTools.length > 0
  const shouldParseResponse = mode === 'managed'
  const availabilityRetryAllowed = mode === 'managed' && profile.availabilityDriftRetry === 'enabled'

  return {
    mode,
    protocol,
    clientAdapterId: input.clientRequest.clientAdapterId,
    providerId: input.providerId,
    tools: allowedTools,
    shouldInjectPrompt,
    shouldParseResponse,
    toolChoiceMode: input.clientRequest.toolChoice.mode,
    allowedToolNames,
    forcedToolName: forcedName,
    catalogSnapshot: catalogResolution.snapshot,
    catalogDiagnostics: catalogResolution.diagnostics,
    availabilityRetryAllowed,
    diagnostics: {
      requestId: input.requestId,
      clientAdapterId: input.clientRequest.clientAdapterId,
      providerId: input.providerId,
      model: input.model,
      actualModel: input.actualModel,
      toolSource: input.clientRequest.toolSource,
      mode,
      protocol,
      toolCount: allowedTools.length,
      injected: shouldInjectPrompt,
      reason: disabledReason ?? `managed_${input.config.mode}`,
      toolChoiceMode: input.clientRequest.toolChoice.mode,
      forcedToolName: forcedName,
      allowedToolNames: [...allowedToolNames],
      catalogSource: catalogResolution.diagnostics.source,
      catalogFingerprint: catalogResolution.snapshot?.fingerprint,
      catalogDriftKinds: catalogResolution.diagnostics.driftKinds,
      catalogBlocked: catalogResolution.diagnostics.blocked,
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
    if (msg.role === 'assistant' && typeof msg.content === 'string') {
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

function extractManagedHistoryToolNames(messages?: ChatMessage[]): string[] {
  if (!messages) return []

  const names = new Set<string>()
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      for (const toolCall of msg.tool_calls) {
        const name = toolCall.function?.name
        if (name) names.add(name)
      }
    }

    if ((msg.role !== 'system' && msg.role !== 'assistant') || typeof msg.content !== 'string') continue

    TOOL_NAME_REGEX.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = TOOL_NAME_REGEX.exec(msg.content)) !== null) {
      names.add(match[1])
    }
  }

  return [...names].sort()
}
