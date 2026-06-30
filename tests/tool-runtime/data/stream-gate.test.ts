import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createStreamGateState,
  finishStreamGate,
  ingestStreamChunk,
} from '../../../src/main/proxy/toolRuntime/data/index.ts'

test('pass_through releases chunks immediately and records escaped ranges', () => {
  let state = createStreamGateState('pass_through')
  const first = ingestStreamChunk(state, 'hello ')
  state = first.state
  const second = ingestStreamChunk(state, 'world')
  state = second.state
  const finished = finishStreamGate(state)

  assert.deepEqual(first.releasedChunks, ['hello '])
  assert.deepEqual(second.releasedChunks, ['world'])
  assert.equal(finished.rawOutput, 'hello world')
  assert.equal(finished.facts.hasEscapedToClient, true)
  assert.deepEqual(finished.facts.escapedRanges, [
    { start: 0, end: 6, classification: 'plain_text' },
    { start: 6, end: 11, classification: 'plain_text' },
  ])
})

test('full_buffer releases nothing until finish and reports no escaped bytes', () => {
  let state = createStreamGateState('full_buffer')
  const first = ingestStreamChunk(state, '<|CHAT2API|tool')
  state = first.state
  const second = ingestStreamChunk(state, '_calls>')
  state = second.state
  const finished = finishStreamGate(state)

  assert.deepEqual(first.releasedChunks, [])
  assert.deepEqual(second.releasedChunks, [])
  assert.equal(finished.rawOutput, '<|CHAT2API|tool_calls>')
  assert.equal(finished.facts.hasEscapedToClient, false)
  assert.deepEqual(finished.facts.escapedRanges, [])
})

test('full_buffer records marker facts even when marker is split across chunks', () => {
  let state = createStreamGateState('full_buffer')
  state = ingestStreamChunk(state, 'prefix <|CHAT2API|tool').state
  state = ingestStreamChunk(state, '_calls> suffix').state
  const finished = finishStreamGate(state)

  assert.deepEqual(finished.facts.detectedMarkers, [{
    protocol: 'managed_xml',
    marker: '<|CHAT2API|tool_calls>',
    offset: 7,
    confidence: 'full',
  }])
})

test('incremental_safe_buffer is accepted as an interface mode but does not release chunks in v1', () => {
  let state = createStreamGateState('incremental_safe_buffer')
  const update = ingestStreamChunk(state, 'hello')
  state = update.state
  const finished = finishStreamGate(state)

  assert.deepEqual(update.releasedChunks, [])
  assert.equal(finished.rawOutput, 'hello')
  assert.equal(finished.facts.mode, 'incremental_safe_buffer')
  assert.equal(finished.facts.hasEscapedToClient, false)
})
