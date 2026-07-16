import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  classifyTextPayload,
  summarizePayloadClasses,
} from '../../src/main/proxy/services/contextPayloadClassifier.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'

const fixture = JSON.parse(readFileSync(
  new URL('../fixtures/context-economy/export-shapes.json', import.meta.url),
  'utf8',
)) as { mainSession: ChatMessage[] }

test('export-shaped main session reports repeated runtime and tool-contract payloads', () => {
  const summary = summarizePayloadClasses(fixture.mainSession)

  assert.ok(summary.counts.runtime_config >= 3)
  assert.ok(summary.counts.tool_contract >= 3)
  assert.ok(summary.markerCounts['You are opencode'] >= 2)
  assert.ok(summary.markerCounts['## Available Tools'] >= 2)
})

test('ordinary user task text is not runtime configuration', () => {
  const classified = classifyTextPayload('Implement the context economy fix and keep tool calls working.')
  assert.notEqual(classified.className, 'runtime_config')
  assert.notEqual(classified.className, 'tool_contract')
})

test('managed XML tool calls classify as tool exchange', () => {
  const classified = classifyTextPayload(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="read"></|CHAT2API|invoke></|CHAT2API|tool_calls>',
  )
  assert.equal(classified.className, 'tool_exchange')
})
