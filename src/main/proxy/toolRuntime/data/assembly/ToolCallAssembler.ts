import type { ToolCall } from '../../../types.ts'
import type { NormalizedToolDefinition } from '../../../toolCalling/types.ts'
import type { ToolCallAssemblerInput, ValidatedParameterStructure } from '../types.ts'
import { parseParameterPayloadForSchema } from '../validation/schemaPayload.ts'

export function assembleOpenAIToolCalls(input: ToolCallAssemblerInput): ToolCall[] {
  return input.validated.map((call) => {
    const tool = input.tools.find((candidate) => candidate.name === call.toolName)
    if (!tool) {
      throw new Error(`Cannot assemble undeclared tool ${call.toolName}`)
    }

    return {
      id: `call_${call.callIndex}`,
      index: call.callIndex,
      type: 'function',
      function: {
        name: call.toolName,
        arguments: JSON.stringify(parametersToObject(call.parameters, tool)),
      },
    }
  })
}

function parametersToObject(
  parameters: ValidatedParameterStructure[],
  tool: NormalizedToolDefinition,
): Record<string, unknown> {
  return parameters.reduce<Record<string, unknown>>((acc, parameter) => {
    const value = unwrapParameterPayload(parameter, tool)
    const existing = acc[parameter.name]

    if (existing === undefined) {
      return { ...acc, [parameter.name]: value }
    }

    if (Array.isArray(existing)) {
      return { ...acc, [parameter.name]: [...existing, value] }
    }

    return { ...acc, [parameter.name]: [existing, value] }
  }, {})
}

function unwrapParameterPayload(
  parameter: ValidatedParameterStructure,
  tool: NormalizedToolDefinition,
): unknown {
  const props = tool.parameters?.properties as Record<string, unknown> | undefined
  const schema = props?.[parameter.name]
  const result = parseParameterPayloadForSchema(parameter.rawPayload, schema, parameter.name)
  if (!result.ok) {
    throw new Error(`Cannot assemble invalid payload for parameter ${parameter.name}: ${result.detail}`)
  }

  return result.value
}
