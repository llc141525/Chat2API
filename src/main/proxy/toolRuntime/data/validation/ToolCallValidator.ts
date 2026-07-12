import type { NormalizedToolDefinition } from '../../../toolCalling/types.ts'
import type {
  ExtractedCallStructure,
  ToolCallValidatorInput,
  ToolStructureFailure,
  ToolValidationOutcome,
  ValidatedCallStructure,
} from '../types.ts'
import { parseParameterPayloadForSchema, schemaRequiresComplexPayload } from './schemaPayload.ts'

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

    const emptyComplex = emptyComplexParameters(call, tool)
    if (emptyComplex.length > 0) {
      return invalid({
        kind: 'malformed_argument_container',
        selectedProtocol,
        detail: `Parameter ${emptyComplex.join(', ')} has empty payload but schema requires complex type`,
        toolName,
      })
    }

    const invalidPayload = invalidSchemaPayload(call, tool)
    if (invalidPayload) {
      return invalid({
        kind: 'schema_validation_failed',
        selectedProtocol,
        detail: invalidPayload,
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

function emptyComplexParameters(
  call: ExtractedCallStructure,
  tool: NormalizedToolDefinition,
): string[] {
  const props = tool.parameters?.properties as Record<string, any> | undefined
  if (!props) return []

  return call.rawParameters
    .filter((param) => {
      const schema = props[param.rawName]
      if (!schema) return false
      return schemaRequiresComplexPayload(schema) && param.rawPayload.trim().length === 0
    })
    .map((param) => param.rawName)
}

function invalidSchemaPayload(
  call: ExtractedCallStructure,
  tool: NormalizedToolDefinition,
): string | null {
  const props = tool.parameters?.properties as Record<string, unknown> | undefined
  if (!props) return null

  for (const param of call.rawParameters) {
    const schema = props[param.rawName]
    if (!schemaRequiresComplexPayload(schema)) continue

    const result = parseParameterPayloadForSchema(param.rawPayload, schema, param.rawName)
    if (!result.ok) return result.detail
  }

  return null
}

function invalid(failure: ToolStructureFailure): ToolValidationOutcome {
  return {
    status: 'invalid_structure',
    failure,
  }
}
