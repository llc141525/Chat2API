import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TOOL_EXECUTION_PROFILES,
  getExecutionProfileSettings,
  isToolExecutionProfile,
  TOOL_EXECUTION_PROFILE_IDS,
} from '../../../src/main/proxy/toolRuntime/control/index.ts'

test('execution profiles are closed to the three v1 profiles', () => {
  assert.deepEqual(TOOL_EXECUTION_PROFILE_IDS, [
    'disabled_passthrough',
    'native_passthrough',
    'managed_buffered_structural',
  ])

  assert.equal(isToolExecutionProfile('disabled_passthrough'), true)
  assert.equal(isToolExecutionProfile('native_passthrough'), true)
  assert.equal(isToolExecutionProfile('managed_buffered_structural'), true)
  assert.equal(isToolExecutionProfile('managed_incremental_structural'), false)
  assert.equal(isToolExecutionProfile(''), false)
})

test('disabled passthrough profile derives no parse or repair behavior', () => {
  assert.deepEqual(getExecutionProfileSettings('disabled_passthrough'), {
    mode: 'disabled',
    streamGateMode: 'pass_through',
    parseMode: 'none',
    repairMode: 'disabled',
    historyFormat: 'openai_native',
  })
})

test('native passthrough profile derives native mode without managed behavior', () => {
  assert.deepEqual(getExecutionProfileSettings('native_passthrough'), {
    mode: 'native',
    streamGateMode: 'pass_through',
    parseMode: 'none',
    repairMode: 'disabled',
    historyFormat: 'openai_native',
  })
})

test('managed buffered structural profile derives full-buffer selected-protocol behavior', () => {
  assert.deepEqual(getExecutionProfileSettings('managed_buffered_structural'), {
    mode: 'managed',
    streamGateMode: 'full_buffer',
    parseMode: 'selected_protocol_only',
    repairMode: 'deterministic_structural_repair',
    historyFormat: 'managed_protocol',
  })
})

test('profile settings are returned as defensive copies', () => {
  const settings = getExecutionProfileSettings('managed_buffered_structural') as any
  settings.streamGateMode = 'pass_through'

  assert.equal(
    getExecutionProfileSettings('managed_buffered_structural').streamGateMode,
    'full_buffer',
  )
  assert.equal(TOOL_EXECUTION_PROFILES.managed_buffered_structural.streamGateMode, 'full_buffer')
})
