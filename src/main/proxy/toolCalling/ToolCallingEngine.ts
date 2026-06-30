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
import type { NormalizedToolDefinition, ToolCallingPlan, ToolCallingTransformResult, ToolProtocolId } from './types.ts'

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

    return {
      messages: injectPrompt(request.messages, renderPrompt(plan.protocol, plan.tools, this.config)),
      tools: undefined,
      plan,
    }
  }

  applyNonStreamResponse(result: any, plan: ToolCallingPlan): void {
    if (!plan.shouldParseResponse) return

    const message = result?.choices?.[0]?.message
    if (!message || typeof message.content !== 'string') return

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
      return
    }

    if (validation.status === 'invalid_structure') {
      plan.diagnostics.parserFormat = plan.protocol
      plan.diagnostics.parsedToolCallCount = 0
      plan.diagnostics.malformedReason = validation.failure.kind
      return
    }

    const toolCalls = assembleOpenAIToolCalls({
      validated: validation.validated,
      tools: plan.tools,
    })
    if (toolCalls.length === 0) return

    message.content = validation.cleanContent || null
    message.tool_calls = toolCalls

    const choice = result.choices[0]
    choice.finish_reason = 'tool_calls'
    plan.diagnostics.parserFormat = plan.protocol
    plan.diagnostics.parsedToolCallCount = toolCalls.length
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
