import type {
  ToolControlReason,
  ToolControlState,
  ToolEvent,
  ToolOperation,
  ToolOperationFailureKind,
  ToolOperationResultKind,
  ToolTransition,
} from './types.ts'

export function createInitialToolControlState(): ToolControlState {
  return {
    phase: 'idle',
    step: null,
    repairAttempted: false,
  }
}

export function transitionToolState(
  state: ToolControlState,
  event: ToolEvent,
): ToolTransition {
  if (state.phase === 'idle' && event.type === 'start') {
    return next(state, 'invoke_model', 'started')
  }

  if (state.phase !== 'awaiting_operation_result' || state.step === null) {
    throw invalidTransition(state, event)
  }

  if (event.type === 'operation_succeeded') {
    return transitionSucceeded(state, event.resultKind)
  }

  if (event.type === 'operation_failed') {
    return transitionFailed(state, event.failureKind)
  }

  throw invalidTransition(state, event)
}

function transitionSucceeded(
  state: ToolControlState,
  resultKind: ToolOperationResultKind,
): ToolTransition {
  switch (state.step) {
    case 'invoke_model':
    case 'gate_stream':
      if (resultKind === 'model_output') return next(state, 'validate_structure', 'model_output_ready')
      break
    case 'validate_structure':
    case 'validate_repaired_structure':
      if (resultKind === 'plain_text') return next(state, 'map_response', 'plain_text_ready')
      if (resultKind === 'valid_structure') return next(state, 'assemble_tool_calls', 'valid_structure_ready')
      break
    case 'repair_structure':
      if (resultKind === 'repaired_structure_text') {
        return next(state, 'validate_repaired_structure', 'repair_completed')
      }
      break
    case 'assemble_tool_calls':
      if (resultKind === 'openai_tool_calls') return next(state, 'map_response', 'tool_calls_assembled')
      break
    case 'map_response':
      if (resultKind === 'response_mapped') {
        return {
          nextState: { ...state, phase: 'terminal_success', step: null },
          nextOperation: null,
          reason: 'response_completed',
        }
      }
      break
    case 'delegate_error':
      if (resultKind === 'error_delegated') {
        return {
          nextState: { ...state, phase: 'terminal_failure', step: null },
          nextOperation: null,
          reason: 'error_delegated',
        }
      }
      break
  }

  throw invalidTransition(state, { type: 'operation_succeeded', resultKind } as ToolEvent)
}

function transitionFailed(
  state: ToolControlState,
  failureKind: ToolOperationFailureKind,
): ToolTransition {
  if (failureKind === 'model_error') return next(state, 'delegate_error', 'model_error')
  if (failureKind === 'stream_error') return next(state, 'delegate_error', 'stream_error')
  if (failureKind === 'assembly_failed') return next(state, 'delegate_error', 'assembly_failed')
  if (failureKind === 'mapping_failed') return next(state, 'delegate_error', 'mapping_failed')

  if (state.step === 'validate_structure' || state.step === 'validate_repaired_structure') {
    if (failureKind === 'invalid_structure_repairable' && !state.repairAttempted) {
      return {
        nextState: {
          phase: 'awaiting_operation_result',
          step: 'repair_structure',
          repairAttempted: true,
        },
        nextOperation: 'repair_structure',
        reason: 'repair_allowed',
      }
    }

    if (failureKind === 'invalid_structure_repairable' && state.repairAttempted) {
      return next(state, 'map_response', 'repair_exhausted')
    }

    if (failureKind === 'invalid_structure_blocked') {
      return next(state, 'map_response', 'invalid_structure_blocked')
    }
  }

  if (state.step === 'repair_structure' && failureKind === 'structural_repair_failed') {
    return next(state, 'map_response', 'repair_failed')
  }

  throw invalidTransition(state, { type: 'operation_failed', failureKind } as ToolEvent)
}

function next(
  state: ToolControlState,
  operation: ToolOperation,
  reason: ToolControlReason,
): ToolTransition {
  return {
    nextState: {
      phase: 'awaiting_operation_result',
      step: operation,
      repairAttempted: state.repairAttempted,
    },
    nextOperation: operation,
    reason,
  }
}

function invalidTransition(state: ToolControlState, event: ToolEvent): Error {
  return new Error(
    `Invalid tool state transition from ${state.phase}:${state.step ?? 'none'} with ${event.type}`,
  )
}
