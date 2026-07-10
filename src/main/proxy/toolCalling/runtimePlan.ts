import type { ToolCallingConfig } from '../../../shared/toolCalling.ts'
import type { NormalizedClientToolRequest } from './clientAdapters/types.ts'
import { resolveToolCatalog } from './catalog.ts'
import { getProviderToolProfile } from './providerProfiles.ts'
import type {
  ToolCallingPlan,
  ToolCatalogSource,
  ToolContractSourceStep,
  ToolTurnContract,
} from './types.ts'
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

  const isPromptEmbedded = input.clientRequest.toolSource === 'prompt_embedded'
  const catalogResolution = resolveToolCatalog({
    sessionId: input.toolSessionKey ?? null,
    requestTools: isPromptEmbedded ? [] : requestTools,
    promptEmbeddedTools: isPromptEmbedded ? requestTools : undefined,
    hasManagedToolHistory: hasExistingManagedXmlContext(input.messages),
    historyToolNames: extractManagedHistoryToolNames(input.messages),
  })
  const catalogTools = catalogResolution.snapshot?.tools ?? []
  const catalogToolNames = new Set(catalogTools.map((tool) => tool.name))

  if (catalogResolution.blocked) {
    console.warn(`[runtimePlan] Catalog blocked (${catalogResolution.diagnostics.reason ?? 'tool_catalog_blocked'}) — continuing with degraded tools`)
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
  const toolSourceChain = buildToolSourceChain(catalogResolution.diagnostics.source)
  const contract = freezeContract({
    turnId: input.requestId ?? `${input.providerId}:${input.actualModel ?? input.model ?? 'unknown'}`,
    sessionId: input.toolSessionKey ?? null,
    providerId: input.providerId,
    model: input.model ?? input.actualModel ?? '',
    protocol,
    snapshotFingerprint: catalogResolution.snapshot?.fingerprint ?? null,
    tools: allowedTools,
    allowedToolNames,
    toolChoiceMode: input.clientRequest.toolChoice.mode,
    forcedToolName: forcedName,
    shouldInjectPrompt,
    shouldParseResponse,
    historyMode: mode === 'managed' ? 'managed_protocol' : 'openai_native',
    emptyOutputPolicy: profile.supportsIntentionalEmptyOutput
      ? 'pass_through_without_tool_semantics'
      : 'diagnose_and_fail',
    toolSourceChain,
  })

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
    contract,
    diagnostics: {
      requestId: input.requestId,
      turnId: contract.turnId,
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
      toolSourceChain,
      emptyOutputPolicy: contract.emptyOutputPolicy,
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
    return 'no_tools_with_managed_history'
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

    const matches = msg.content.matchAll(/<\|CHAT2API\|invoke\s+name="([^"]+)"/g)
    for (const match of matches) {
      names.add(match[1])
    }
  }

  return [...names].sort()
}

function buildToolSourceChain(source: ToolCatalogSource): ToolContractSourceStep[] {
  if (source === 'current_request') return ['current_request']
  if (source === 'session_catalog') return ['current_request', 'session_catalog']
  if (source === 'prompt_embedded') return ['current_request', 'prompt_embedded']
  if (source === 'restored_from_history') return ['current_request', 'session_catalog', 'message_history']
  return ['current_request', 'session_catalog', 'message_history', 'safe_empty']
}

function freezeContract(contract: ToolTurnContract): ToolTurnContract {
  return Object.freeze({
    ...contract,
    tools: Object.freeze(contract.tools.map((tool) => Object.freeze({
      ...tool,
      parameters: deepFreeze(cloneValue(tool.parameters)),
    }))),
    allowedToolNames: createReadonlySet(contract.allowedToolNames),
    toolSourceChain: Object.freeze([...contract.toolSourceChain]),
  })
}

function createReadonlySet<T>(values: Iterable<T>): ReadonlySet<T> {
  const set = new Set(values)
  return new Proxy(set, {
    get(target, prop, receiver) {
      if (prop === 'add' || prop === 'delete' || prop === 'clear') {
        return () => {
          throw new TypeError('Cannot mutate readonly set')
        }
      }

      const value = Reflect.get(target, prop, target)
      if (typeof value === 'function') {
        return value.bind(target)
      }
      return value
    },
  }) as ReadonlySet<T>
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as T
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, cloneValue(nested)]),
    ) as T
  }
  return value
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object') return value

  Object.freeze(value)

  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item)
    }
    return value
  }

  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested)
  }
  return value
}
