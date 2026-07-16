import {
  createInitialToolControlState,
  transitionToolState,
} from '../control/ToolStateMachine.ts'
import type {
  ToolEvent,
  ToolOperation,
} from '../control/types.ts'
import type {
  ToolRuntimeMappingInput,
  ToolValidationOutcome,
} from '../data/types.ts'
import type { ToolTurnRunnerInput, ToolTurnRunnerResult } from './types.ts'

export const BLOCKED_MALFORMED_TOOL_MESSAGE =
  'The model attempted a tool call but produced invalid tool-call markup. Chat2API blocked it to avoid executing an unsafe or malformed tool request.'

export async function runToolTurn(input: ToolTurnRunnerInput): Promise<ToolTurnRunnerResult> {
  let state = createInitialToolControlState()
  let event: ToolEvent = { type: 'start' }
  let rawOutput = ''
  let validation: ToolValidationOutcome | undefined
  let mappingInput: ToolRuntimeMappingInput | undefined

  for (let guard = 0; guard < 20; guard += 1) {
    const transition = transitionToolState(state, event)
    state = transition.nextState

    if (transition.nextOperation === null) {
      return {
        status: 'success',
        response: input.deps.mapResponse(
          mappingInput ?? { kind: 'blocked_malformed', safeMessage: BLOCKED_MALFORMED_TOOL_MESSAGE },
        ),
      }
    }

    const opResult = await executeOperation(transition.nextOperation, input, {
      rawOutput,
      validation,
      mappingInput,
    })

    rawOutput = opResult.rawOutput ?? rawOutput
    validation = opResult.validation ?? validation
    mappingInput = opResult.mappingInput ?? mappingInput
    event = opResult.event
  }

  return { status: 'failed', error: 'Tool turn exceeded transition guard' }
}

async function executeOperation(
  operation: ToolOperation,
  input: ToolTurnRunnerInput,
  context: {
    rawOutput: string
    validation?: ToolValidationOutcome
    mappingInput?: ToolRuntimeMappingInput
  },
): Promise<{
  event: ToolEvent
  rawOutput?: string
  validation?: ToolValidationOutcome
  mappingInput?: ToolRuntimeMappingInput
}> {
  switch (operation) {
    case 'invoke_model': {
      const result = await input.deps.invokeModel()
      return {
        rawOutput: result.rawOutput,
        event: { type: 'operation_succeeded', resultKind: 'model_output' },
      }
    }
    case 'validate_structure':
    case 'validate_repaired_structure': {
      const protocolResult = input.deps.extractStructure(context.rawOutput)
      const nextValidation = input.deps.validateStructure(protocolResult)
      return classifyValidation(input, nextValidation)
    }
    case 'repair_structure': {
      if (!context.validation || context.validation.status !== 'invalid_structure' || !context.validation.malformedIntent) {
        return { event: { type: 'operation_failed', failureKind: 'structural_repair_failed' } }
      }

      const repair = input.deps.repairStructure(context.validation.malformedIntent)
      if (repair.status !== 'repaired') {
        return { event: { type: 'operation_failed', failureKind: 'structural_repair_failed' } }
      }

      return {
        rawOutput: repair.repairedText,
        event: { type: 'operation_succeeded', resultKind: 'repaired_structure_text' },
      }
    }
    case 'assemble_tool_calls': {
      if (!context.validation || context.validation.status !== 'valid_structure') {
        return { event: { type: 'operation_failed', failureKind: 'assembly_failed' } }
      }

      const toolCalls = input.deps.assembleToolCalls(context.validation.validated, input.tools)
      return {
        mappingInput: { kind: 'valid_tool_calls', toolCalls },
        event: { type: 'operation_succeeded', resultKind: 'openai_tool_calls' },
      }
    }
    case 'map_response':
      return {
        mappingInput: context.mappingInput ?? { kind: 'blocked_malformed', safeMessage: BLOCKED_MALFORMED_TOOL_MESSAGE },
        event: { type: 'operation_succeeded', resultKind: 'response_mapped' },
      }
    case 'delegate_error':
      return { event: { type: 'operation_succeeded', resultKind: 'error_delegated' } }
    case 'gate_stream':
      return { event: { type: 'operation_failed', failureKind: 'stream_error' } }
  }
}

function classifyValidation(
  input: ToolTurnRunnerInput,
  validation: ToolValidationOutcome,
): {
  event: ToolEvent
  validation: ToolValidationOutcome
  mappingInput?: ToolRuntimeMappingInput
} {
  if (validation.status === 'plain_text') {
    return {
      validation,
      mappingInput: { kind: 'plain_text', content: validation.content },
      event: { type: 'operation_succeeded', resultKind: 'plain_text' },
    }
  }

  if (validation.status === 'valid_structure') {
    return {
      validation,
      event: { type: 'operation_succeeded', resultKind: 'valid_structure' },
    }
  }

  const repairable = input.deps.canRepair(validation.malformedIntent, validation)
  return {
    validation,
    event: {
      type: 'operation_failed',
      failureKind: repairable ? 'invalid_structure_repairable' : 'invalid_structure_blocked',
    },
  }
}
