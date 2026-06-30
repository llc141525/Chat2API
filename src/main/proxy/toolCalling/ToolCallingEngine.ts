import type { ChatCompletionRequest, ChatMessage } from '../types.ts'
import type { Provider } from '../../store/types.ts'
import {
  DEFAULT_TOOL_CALLING_CONFIG,
  normalizeToolCallingConfig,
  type ToolCallingConfig,
} from '../../../shared/toolCalling.ts'
import {
  assembleOpenAIToolCalls,
  getStructureProtocolAdapter,
  repairStructure,
  validateToolCallStructure,
  type MalformedToolIntent,
} from '../toolRuntime/data/index.ts'
import { getToolProtocol } from './protocols/index.ts'
import { getToolClientAdapter } from './clientAdapters/index.ts'
import { buildToolCallingRuntimePlan } from './runtimePlan.ts'
import { getProviderToolProfile } from './providerProfiles.ts'
import { renderManagedXmlContractHeader } from './protocols/managedXml.ts'
import { buildAvailabilityRetryClarification, detectAvailabilityDrift } from './availabilityDrift.ts'
import type { AvailabilityRetryRequest, ToolCallingPlan, ToolCallingTransformResult } from './types.ts'

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

    const profile = getProviderToolProfile(provider.id)
    return {
      messages: injectPrompt(request.messages, renderPrompt(plan, this.config, profile.contractHeaderVersion)),
      tools: undefined,
      plan,
    }
  }

  applyNonStreamResponse(result: any, plan: ToolCallingPlan): AvailabilityRetryRequest | undefined {
    if (!plan.shouldParseResponse) return undefined

    const message = result?.choices?.[0]?.message
    if (!message || typeof message.content !== 'string') return undefined

    const adapter = getStructureProtocolAdapter(plan.protocol)
    const firstStructure = adapter.extractStructure(message.content)
    const firstValidation = validateToolCallStructure({
      plan: runtimePlanFromCallingPlan(plan),
      protocolResult: firstStructure,
      tools: plan.tools,
    })

    const validation = firstValidation.status === 'invalid_structure' && firstValidation.malformedIntent
      ? validateRepaired(adapter, firstValidation.malformedIntent, plan)
      : firstValidation

    if (validation.status === 'plain_text') {
      plan.diagnostics.parserFormat = 'unknown'
      plan.diagnostics.parsedToolCallCount = 0
      return maybeBuildAvailabilityRetry(message.content, plan)
    }

    if (validation.status === 'invalid_structure') {
      plan.diagnostics.parserFormat = plan.protocol
      plan.diagnostics.parsedToolCallCount = 0
      plan.diagnostics.malformedReason = validation.failure.kind
      return undefined
    }

    const toolCalls = assembleOpenAIToolCalls({
      validated: validation.validated,
      tools: plan.tools,
    })
    if (toolCalls.length === 0) return undefined

    message.content = validation.cleanContent || null
    message.tool_calls = toolCalls

    const choice = result.choices[0]
    choice.finish_reason = 'tool_calls'
    plan.diagnostics.parserFormat = plan.protocol
    plan.diagnostics.parsedToolCallCount = toolCalls.length
    if (plan.availabilityRetryAttempted) {
      plan.diagnostics.availabilityRetryResult = 'succeeded'
    }
    return undefined
  }
}

function renderPrompt(
  plan: ToolCallingPlan,
  config: ToolCallingConfig,
  contractHeaderVersion: number,
): string {
  const prompt = getToolProtocol(plan.protocol).renderPrompt(plan.tools)
  const contractHeader = plan.catalogSnapshot
    ? renderManagedXmlContractHeader({
        catalogFingerprint: plan.catalogSnapshot.fingerprint,
        allowedToolNames: [...plan.allowedToolNames],
        protocol: plan.protocol,
        contractHeaderVersion,
      })
    : ''
  const fullPrompt = contractHeader ? `${contractHeader}\n\n${prompt}` : prompt
  const customPromptTemplate = config.diagnosticsEnabled
    ? config.advanced.customPromptTemplate
    : undefined
  if (!customPromptTemplate) return fullPrompt

  return customPromptTemplate
    .replace(/\{\{tools\}\}/g, fullPrompt)
    .replace(/\{\{tool_names\}\}/g, plan.tools.map((tool) => tool.name).join(', '))
    .replace(/\{\{format\}\}/g, plan.protocol)
}

function injectPrompt(messages: ChatMessage[], prompt: string): ChatMessage[] {
  const [first, ...rest] = messages
  if (first?.role === 'system' && typeof first.content === 'string') {
    return [{ ...first, content: `${first.content}\n\n${prompt}` }, ...rest]
  }

  return [{ role: 'system', content: prompt }, ...messages]
}

function runtimePlanFromCallingPlan(plan: ToolCallingPlan) {
  return {
    profile: 'managed_buffered_structural' as const,
    protocol: plan.protocol,
    allowedToolNames: [...plan.allowedToolNames],
    forcedToolName: plan.forcedToolName,
    diagnostics: {
      providerId: plan.providerId,
      model: plan.diagnostics.model,
      actualModel: plan.diagnostics.actualModel,
      profile: 'managed_buffered_structural' as const,
      mode: 'managed' as const,
      protocol: plan.protocol,
      reason: plan.diagnostics.reason,
      toolCount: plan.tools.length,
      toolChoiceMode: plan.toolChoiceMode,
      forcedToolName: plan.forcedToolName,
      allowedToolNames: [...plan.allowedToolNames],
    },
  }
}

function validateRepaired(
  adapter: ReturnType<typeof getStructureProtocolAdapter>,
  malformedIntent: MalformedToolIntent,
  plan: ToolCallingPlan,
) {
  const repaired = repairStructure(malformedIntent)
  if (repaired.status !== 'repaired') {
    return {
      status: 'invalid_structure' as const,
      failure: {
        kind: 'malformed_container' as const,
        selectedProtocol: plan.protocol,
        detail: repaired.reason,
      },
    }
  }

  return validateToolCallStructure({
    plan: runtimePlanFromCallingPlan(plan),
    protocolResult: adapter.extractStructure(repaired.repairedText),
    tools: plan.tools,
  })
}

function maybeBuildAvailabilityRetry(
  content: string,
  plan: ToolCallingPlan,
): AvailabilityRetryRequest | undefined {
  if (!plan.availabilityRetryAllowed || !plan.catalogSnapshot) {
    return undefined
  }

  if (plan.availabilityRetryAttempted) {
    plan.diagnostics.availabilityRetryResult = 'skipped'
    return undefined
  }

  const detection = detectAvailabilityDrift(plan, content)
  if (!detection.detected) return undefined

  plan.availabilityRetryAttempted = true
  plan.diagnostics.availabilityDriftDetected = true
  plan.diagnostics.availabilityRetryResult = 'attempted'

  return {
    type: 'availability_retry',
    catalogFingerprint: plan.catalogSnapshot.fingerprint,
    clarification: buildAvailabilityRetryClarification(plan),
  }
}
