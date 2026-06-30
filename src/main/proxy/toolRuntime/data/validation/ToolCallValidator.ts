import type { NormalizedToolDefinition } from '../../../toolCalling/types.ts'
import type {
  ExtractedCallStructure,
  ToolCallValidatorInput,
  ToolStructureFailure,
  ToolValidationOutcome,
  ValidatedCallStructure,
} from '../types.ts'

export function validateToolCallStructure(input: ToolCallValidatorInput): ToolValidationOutcome {
  const selectedProtocol = input.plan.protocol
  if (input.protocolResult.protocol !== selectedProtocol) {
    return invalid({
      kind: 'malformed_container',
      selectedProtocol,
      detail: `Protocol result ${input.protocolResult.protocol} does not match selected protocol ${selectedProtocol}`,
    })
  }

  if (input.protocolResult.kind === 'no_intent') {
    return { status: 'plain_text', content: input.protocolResult.content }
  }

  if (input.protocolResult.kind === 'malformed_container') {
    return {
      status: 'invalid_structure',
      failure: {
        kind: input.protocolResult.malformedIntent?.failureKind ?? 'malformed_container',
        selectedProtocol,
        detail: `Malformed ${selectedProtocol ?? 'unknown'} tool container`,
        toolName: input.protocolResult.malformedIntent?.toolName,
      },
      ...(input.protocolResult.malformedIntent ? { malformedIntent: input.protocolResult.malformedIntent } : {}),
    }
  }

  const validated: ValidatedCallStructure[] = []
  for (const call of input.protocolResult.extractedCalls) {
    const toolName = call.rawToolName
    if (!input.plan.allowedToolNames.includes(toolName)) {
      return invalid({
        kind: 'unknown_tool_name',
        selectedProtocol,
        detail: `Tool ${toolName} is not allowed by the current plan`,
        toolName,
      })
    }

    const tool = input.tools.find((candidate) => candidate.name === toolName)
    if (!tool) {
      return invalid({
        kind: 'unknown_tool_name',
        selectedProtocol,
        detail: `Tool ${toolName} is not declared in tool definitions`,
        toolName,
      })
    }

    const missing = missingRequiredParameters(call, tool)
    if (missing.length > 0) {
      return invalid({
        kind: 'schema_validation_failed',
        selectedProtocol,
        detail: `Missing required parameter ${missing.join(', ')}`,
        toolName,
      })
    }

    validated.push({
      callIndex: call.callIndex,
      toolName,
      parameters: call.rawParameters.map((parameter) => ({
        name: parameter.rawName,
        rawPayload: parameter.rawPayload,
        payloadEncoding: parameter.payloadEncoding,
      })),
    })
  }

  return {
    status: 'valid_structure',
    validated,
    cleanContent: input.protocolResult.cleanContent.trim() || null,
  }
}

function missingRequiredParameters(
  call: ExtractedCallStructure,
  tool: NormalizedToolDefinition,
): string[] {
  const required = Array.isArray(tool.parameters?.required)
    ? (tool.parameters.required as string[])
    : []
  const present = new Set(call.rawParameters.map((parameter) => parameter.rawName))

  return required.filter((name) => !present.has(name))
}

function invalid(failure: ToolStructureFailure): ToolValidationOutcome {
  return {
    status: 'invalid_structure',
    failure,
  }
}
