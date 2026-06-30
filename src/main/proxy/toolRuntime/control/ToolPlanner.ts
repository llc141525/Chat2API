import { hasGeneralToolPromptSignature } from '../../constants/signatures.ts'
import { getExecutionProfileSettings } from './executionProfiles.ts'
import type { ToolExecutionProfile, ToolPlan, ToolPlannerInput } from './types.ts'

export function planToolExecution(input: ToolPlannerInput): ToolPlan {
  const forcedName = input.clientToolRequest.toolChoice.forcedName
  const allTools = input.clientToolRequest.tools
  const allToolNames = new Set(allTools.map((tool) => tool.name))

  if (
    input.clientToolRequest.toolChoice.mode === 'forced'
    && forcedName
    && !allToolNames.has(forcedName)
  ) {
    throw new Error(`Forced tool ${forcedName} is not declared`)
  }

  const allowedToolNames = forcedName ? [forcedName] : allTools.map((tool) => tool.name)
  const hasTools = allowedToolNames.length > 0
  const managedContext = hasExistingManagedToolContext(input.request.messages)

  if (!input.config.enabled || input.config.mode === 'off') {
    return createPlan(input, 'disabled_passthrough', null, [], undefined, 'tool_calling_disabled')
  }

  if (input.clientToolRequest.toolChoice.mode === 'none') {
    return createPlan(input, 'disabled_passthrough', null, [], undefined, 'tool_choice_none')
  }

  if (hasTools && input.providerProfile.supportsNativeTools) {
    return createPlan(
      input,
      'native_passthrough',
      null,
      allowedToolNames,
      forcedName,
      'provider_native_tools',
    )
  }

  if (hasTools && input.providerProfile.managedSupport) {
    return createPlan(
      input,
      'managed_buffered_structural',
      input.providerProfile.preferredManagedProtocol,
      allowedToolNames,
      forcedName,
      'provider_managed_tools',
    )
  }

  if (!hasTools && managedContext && input.providerProfile.managedSupport) {
    return createPlan(
      input,
      'managed_buffered_structural',
      input.providerProfile.preferredManagedProtocol,
      [],
      undefined,
      'existing_managed_tool_context',
    )
  }

  return createPlan(input, 'disabled_passthrough', null, [], undefined, 'no_tools_or_managed_context')
}

function createPlan(
  input: ToolPlannerInput,
  profile: ToolExecutionProfile,
  protocol: ToolPlan['protocol'],
  allowedToolNames: string[],
  forcedToolName: string | undefined,
  reason: string,
): ToolPlan {
  const settings = getExecutionProfileSettings(profile)

  return {
    profile,
    protocol,
    allowedToolNames,
    ...(forcedToolName ? { forcedToolName } : {}),
    diagnostics: {
      requestId: input.requestId,
      providerId: input.providerProfile.providerId,
      model: input.request.model,
      actualModel: input.actualModel,
      profile,
      mode: settings.mode,
      protocol,
      reason,
      toolCount: allowedToolNames.length,
      toolChoiceMode: input.clientToolRequest.toolChoice.mode,
      ...(forcedToolName ? { forcedToolName } : {}),
      allowedToolNames,
    },
  }
}

function hasExistingManagedToolContext(messages: ToolPlannerInput['request']['messages']): boolean {
  for (const message of messages) {
    if (message.role === 'system' && typeof message.content === 'string') {
      if (hasGeneralToolPromptSignature(message.content)) return true
    }

    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      return true
    }

    if (message.role === 'tool' && message.tool_call_id) {
      return true
    }
  }

  return false
}
