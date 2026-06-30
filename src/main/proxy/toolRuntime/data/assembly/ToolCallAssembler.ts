import type { ToolCall } from '../../../types.ts'
import type { ToolCallAssemblerInput, ValidatedParameterStructure } from '../types.ts'

export function assembleOpenAIToolCalls(input: ToolCallAssemblerInput): ToolCall[] {
  return input.validated.map((call) => {
    if (!input.tools.some((tool) => tool.name === call.toolName)) {
      throw new Error(`Cannot assemble undeclared tool ${call.toolName}`)
    }

    return {
      id: `call_${call.callIndex}`,
      index: call.callIndex,
      type: 'function',
      function: {
        name: call.toolName,
        arguments: JSON.stringify(parametersToObject(call.parameters)),
      },
    }
  })
}

function parametersToObject(parameters: ValidatedParameterStructure[]): Record<string, unknown> {
  return parameters.reduce<Record<string, unknown>>((acc, parameter) => {
    const value = unwrapParameterPayload(parameter)
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

function unwrapParameterPayload(parameter: ValidatedParameterStructure): string {
  return parameter.rawPayload
}
