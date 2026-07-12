import type { ChatCompletionRequest } from '../types.ts'
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
import type { NormalizedToolDefinition, ToolCallingPlan, ToolCallingTransformResult, ToolProtocolId } from './types.ts'
import type { ToolManifest } from './ToolManifest.ts'
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
    if (this.config.diagnosticsEnabled) {
      const rawTools = Array.isArray((request as { tools?: unknown }).tools)
        ? (request as { tools?: unknown[] }).tools ?? []
        : []
      const firstRawTool = rawTools[0]
      console.log('[ToolCallingEngine] normalizeRequest diagnostics:', JSON.stringify({
        requestId,
        providerId: provider.id,
        model: request.model,
        actualModel,
        configuredClientAdapterId: this.config.clientAdapterId,
        resolvedClientAdapterId: clientRequest.clientAdapterId,
        requestedClientAdapterId: clientRequest.diagnostics.requestedClientAdapterId,
        fallbackClientAdapterId: clientRequest.diagnostics.fallbackClientAdapterId,
        rawToolCount: rawTools.length,
        normalizedToolCount: clientRequest.tools.length,
        normalizedToolNames: clientRequest.tools.map((tool) => tool.name),
        firstRawToolKeys: firstRawTool && typeof firstRawTool === 'object'
          ? Object.keys(firstRawTool as Record<string, unknown>)
          : [],
        firstRawToolPreview: firstRawTool ?? null,
      }))
    }
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
    const profile = getProviderToolProfile(provider.id)
    console.log('[ToolCallingEngine] runtime plan trace:', JSON.stringify({
      requestId,
      providerId: provider.id,
      model: request.model,
      actualModel,
      toolSessionKeyPresent: typeof toolSessionKey === 'string' && toolSessionKey.length > 0,
      clientAdapterId: plan.clientAdapterId,
      toolSource: plan.diagnostics.toolSource,
      catalogSource: plan.catalogDiagnostics.source,
      catalogFingerprint: plan.catalogSnapshot?.fingerprint,
      mode: plan.mode,
      protocol: plan.protocol,
      toolCount: plan.tools.length,
      shouldInjectPrompt: plan.shouldInjectPrompt,
      shouldParseResponse: plan.shouldParseResponse,
      toolChoiceMode: plan.toolChoiceMode,
      forcedToolName: plan.forcedToolName,
      driftKinds: plan.catalogDiagnostics.driftKinds,
      disabledReason: plan.mode === 'disabled' ? plan.diagnostics.reason : undefined,
    }))

    if (plan.catalogSnapshot) {
      console.log('[ToolCallingEngine] catalog resolution:', JSON.stringify({
        requestId,
        providerId: provider.id,
        model: actualModel,
        managedStatus: profile.managedToolSupportStatus,
        managedTransport: profile.managedTransport,
        riskControlCaveats: profile.providerRiskControlCaveats,
        catalogSource: plan.catalogDiagnostics.source,
        catalogFingerprint: plan.catalogSnapshot.fingerprint,
        toolCount: plan.catalogSnapshot.allowedToolNames.length,
        driftKinds: plan.catalogDiagnostics.driftKinds,
      }))
      recordToolDiagnosticEvent({
        type: 'tool_catalog_resolved',
        requestId,
        providerId: provider.id,
        model: actualModel,
        catalogSource: plan.catalogDiagnostics.source,
        catalogFingerprint: plan.catalogSnapshot.fingerprint,
        toolNames: [...plan.catalogSnapshot.allowedToolNames],
        schemaHashes: { ...plan.catalogSnapshot.schemaHashes },
        driftKinds: [...plan.catalogDiagnostics.driftKinds],
        responseMode: request.stream ? 'streaming' : 'non_streaming',
      })
      if (plan.catalogDiagnostics.driftKinds.length > 0) {
        recordToolDiagnosticEvent({
          type: 'tool_catalog_drift_detected',
          requestId,
          providerId: provider.id,
          model: actualModel,
          catalogFingerprint: plan.catalogSnapshot.fingerprint,
          driftKinds: [...plan.catalogDiagnostics.driftKinds],
          responseMode: request.stream ? 'streaming' : 'non_streaming',
        })
      }
    }

    if (!shouldInjectPrompt) {
      return {
        messages: request.messages,
        tools: plan.mode === 'disabled' ? request.tools : undefined,
        plan,
      }
    }

    const toolManifest = this.createToolManifest(plan)
    return {
      messages: request.messages,
      tools: undefined,
      plan,
      toolManifest,
    }
  }

  createToolManifest(plan: ToolCallingPlan): ToolManifest {
    return createToolManifest({
      protocol: plan.protocol,
      catalogFingerprint: plan.catalogSnapshot?.fingerprint ?? '',
      allowedToolNames: [...plan.allowedToolNames],
      tools: plan.tools.map(t => ({ ...t })),
      renderedPrompt: renderPrompt(plan.protocol, plan.tools, this.config),
      contractHeaderVersion: 1,
    })
  }

  applyNonStreamResponse(result: any, plan: ToolCallingPlan): void {
    if (!plan.shouldParseResponse) return

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
      return maybeBuildAvailabilityRetry(message.content, plan, opts)
    }

    if (validation.status === 'invalid_structure') {
      plan.diagnostics.parserFormat = plan.protocol
      plan.diagnostics.parsedToolCallCount = 0
      plan.diagnostics.malformedReason = validation.failure.kind
      plan.diagnostics.validationFailureKind = validation.failure.kind
      recordToolDiagnosticEvent({
        type: 'tool_validation_failed',
        requestId: plan.diagnostics.requestId,
        providerId: plan.providerId,
        model: plan.diagnostics.actualModel ?? plan.diagnostics.model,
        catalogFingerprint: plan.catalogSnapshot?.fingerprint,
        protocol: plan.protocol,
        responseMode: 'non_streaming',
        validationFailureKind: validation.failure.kind,
      })
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

function parseSelectedProtocol(content: string, plan: ToolCallingPlan) {
  const selected = getToolProtocol(plan.protocol)
  return selected.parse(content, { tools: plan.tools, protocol: plan.protocol })
}
