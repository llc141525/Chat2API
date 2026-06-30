import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createInitialToolControlState,
  transitionToolState,
} from '../../../src/main/proxy/toolRuntime/control/index.ts'

test('start transitions to invoke_model', () => {
  const transition = transitionToolState(createInitialToolControlState(), { type: 'start' })

  assert.deepEqual(transition.nextState, {
    phase: 'awaiting_operation_result',
    step: 'invoke_model',
    repairAttempted: false,
  })
  assert.equal(transition.nextOperation, 'invoke_model')
  assert.equal(transition.reason, 'started')
})

test('model output transitions to validate_structure', () => {
  const state = {
    phase: 'awaiting_operation_result' as const,
    step: 'invoke_model' as const,
    repairAttempted: false,
  }

  const transition = transitionToolState(state, {
    type: 'operation_succeeded',
    resultKind: 'model_output',
  })

  assert.deepEqual(transition.nextState, {
    phase: 'awaiting_operation_result',
    step: 'validate_structure',
    repairAttempted: false,
  })
  assert.equal(transition.nextOperation, 'validate_structure')
  assert.equal(transition.reason, 'model_output_ready')
})

test('plain text validation maps response', () => {
  const state = {
    phase: 'awaiting_operation_result' as const,
    step: 'validate_structure' as const,
    repairAttempted: false,
  }

  const transition = transitionToolState(state, {
    type: 'operation_succeeded',
    resultKind: 'plain_text',
  })

  assert.equal(transition.nextState.step, 'map_response')
  assert.equal(transition.nextOperation, 'map_response')
  assert.equal(transition.reason, 'plain_text_ready')
})

test('valid structure transitions to assemble_tool_calls', () => {
  const state = {
    phase: 'awaiting_operation_result' as const,
    step: 'validate_structure' as const,
    repairAttempted: false,
  }

  const transition = transitionToolState(state, {
    type: 'operation_succeeded',
    resultKind: 'valid_structure',
  })

  assert.equal(transition.nextState.step, 'assemble_tool_calls')
  assert.equal(transition.nextOperation, 'assemble_tool_calls')
  assert.equal(transition.reason, 'valid_structure_ready')
})

test('repairable invalid structure transitions to one structural repair', () => {
  const state = {
    phase: 'awaiting_operation_result' as const,
    step: 'validate_structure' as const,
    repairAttempted: false,
  }

  const transition = transitionToolState(state, {
    type: 'operation_failed',
    failureKind: 'invalid_structure_repairable',
  })

  assert.deepEqual(transition.nextState, {
    phase: 'awaiting_operation_result',
    step: 'repair_structure',
    repairAttempted: true,
  })
  assert.equal(transition.nextOperation, 'repair_structure')
  assert.equal(transition.reason, 'repair_allowed')
})

test('repairable invalid structure after repair maps blocked response', () => {
  const state = {
    phase: 'awaiting_operation_result' as const,
    step: 'validate_repaired_structure' as const,
    repairAttempted: true,
  }

  const transition = transitionToolState(state, {
    type: 'operation_failed',
    failureKind: 'invalid_structure_repairable',
  })

  assert.deepEqual(transition.nextState, {
    phase: 'awaiting_operation_result',
    step: 'map_response',
    repairAttempted: true,
  })
  assert.equal(transition.nextOperation, 'map_response')
  assert.equal(transition.reason, 'repair_exhausted')
})

test('blocked invalid structure maps response without repair', () => {
  const state = {
    phase: 'awaiting_operation_result' as const,
    step: 'validate_structure' as const,
    repairAttempted: false,
  }

  const transition = transitionToolState(state, {
    type: 'operation_failed',
    failureKind: 'invalid_structure_blocked',
  })

  assert.equal(transition.nextState.step, 'map_response')
  assert.equal(transition.nextOperation, 'map_response')
  assert.equal(transition.reason, 'invalid_structure_blocked')
})

test('structural repair success transitions to validate_repaired_structure', () => {
  const state = {
    phase: 'awaiting_operation_result' as const,
    step: 'repair_structure' as const,
    repairAttempted: true,
  }

  const transition = transitionToolState(state, {
    type: 'operation_succeeded',
    resultKind: 'repaired_structure_text',
  })

  assert.equal(transition.nextState.step, 'validate_repaired_structure')
  assert.equal(transition.nextOperation, 'validate_repaired_structure')
  assert.equal(transition.reason, 'repair_completed')
})

test('assembled tool calls transition to map_response', () => {
  const state = {
    phase: 'awaiting_operation_result' as const,
    step: 'assemble_tool_calls' as const,
    repairAttempted: false,
  }

  const transition = transitionToolState(state, {
    type: 'operation_succeeded',
    resultKind: 'openai_tool_calls',
  })

  assert.equal(transition.nextState.step, 'map_response')
  assert.equal(transition.nextOperation, 'map_response')
  assert.equal(transition.reason, 'tool_calls_assembled')
})

test('mapped response reaches terminal success', () => {
  const state = {
    phase: 'awaiting_operation_result' as const,
    step: 'map_response' as const,
    repairAttempted: false,
  }

  const transition = transitionToolState(state, {
    type: 'operation_succeeded',
    resultKind: 'response_mapped',
  })

  assert.deepEqual(transition.nextState, {
    phase: 'terminal_success',
    step: null,
    repairAttempted: false,
  })
  assert.equal(transition.nextOperation, null)
  assert.equal(transition.reason, 'response_completed')
})

test('model error reaches terminal failure through delegate_error', () => {
  const state = {
    phase: 'awaiting_operation_result' as const,
    step: 'invoke_model' as const,
    repairAttempted: false,
  }

  const transition = transitionToolState(state, {
    type: 'operation_failed',
    failureKind: 'model_error',
  })

  assert.equal(transition.nextState.step, 'delegate_error')
  assert.equal(transition.nextOperation, 'delegate_error')
  assert.equal(transition.reason, 'model_error')

  const terminal = transitionToolState(transition.nextState, {
    type: 'operation_succeeded',
    resultKind: 'error_delegated',
  })

  assert.equal(terminal.nextState.phase, 'terminal_failure')
  assert.equal(terminal.nextOperation, null)
  assert.equal(terminal.reason, 'error_delegated')
})

test('invalid transition throws', () => {
  assert.throws(() => transitionToolState(createInitialToolControlState(), {
    type: 'operation_succeeded',
    resultKind: 'model_output',
  }), /Invalid tool state transition/)
})
