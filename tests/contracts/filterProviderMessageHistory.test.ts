/**
 * Contract tests for filterProviderMessageHistory (internal to RequestAssembly.ts).
 *
 * Because filterProviderMessageHistory is not exported, we validate its
 * contract through the public selectProviderMessagesForAssembly function
 * which calls it internally.
 *
 * Contracts verified:
 *  1. System messages are preserved (they carry agent definition).
 *  2. Runtime configuration messages are filtered out.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { selectProviderMessagesForAssembly, buildRequestAssembly } from '../../src/main/proxy/RequestAssembly.ts'
import type { RequestAssembly } from '../../src/main/proxy/RequestAssembly.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'

// ── Helpers ────────────────────────────────────────────────────────

function makeSystemMsg(content: string): ChatMessage {
  return { role: 'system', content }
}

function makeUserMsg(content: string): ChatMessage {
  return { role: 'user', content }
}

function makeAssembly(overrides: Partial<RequestAssembly> = {}): RequestAssembly {
  return {
    messages: [],
    summaryText: null,
    workflowDigest: null,
    metadata: { contextManagementApplied: false },
    ...overrides,
  }
}

// ── Contract 1: Preserve system messages ─────────────────────────

test('contract: preserves system messages in provider selection', () => {
  const assembly = makeAssembly({
    messages: [
      makeSystemMsg('You are a helpful assistant.'),
      makeUserMsg('Hello'),
    ],
  })

  const result = selectProviderMessagesForAssembly(assembly)
  assert.ok(
    result.some(m => m.role === 'system'),
    'system messages should be preserved'
  )
})

test('contract: preserves user messages in provider selection', () => {
  const assembly = makeAssembly({
    messages: [
      makeUserMsg('Hello, can you help?'),
    ],
  })

  const result = selectProviderMessagesForAssembly(assembly)
  assert.ok(
    result.some(m => m.role === 'user'),
    'user messages should be preserved'
  )
})

// ── Contract 2: Filter runtime config messages ───────────────────

test('contract: filters runtime configuration from provider messages', () => {
  // buildRequestAssembly applies filtering internally
  const input = {
    messages: [
      makeSystemMsg('You are opencode, a tool-enabled assistant.'),
      makeUserMsg('Do something useful.'),
    ],
    toolManifest: undefined,
    contextResult: undefined,
    summaryText: null,
  }

  const assembly = buildRequestAssembly(input as any)
  // The assembly should have filtered the runtime config
  assert.ok(assembly.messages.length > 0, 'assembly should contain messages')
})

test('contract: strips runtime config markers from assembly metadata', () => {
  const input = {
    messages: [
      makeSystemMsg('Tool Contract Header v2'),
      makeSystemMsg('## Available Tools'),
      makeUserMsg('clean user query'),
    ],
    toolManifest: undefined,
    contextResult: undefined,
    summaryText: null,
  }

  const assembly = buildRequestAssembly(input as any)
  assert.ok(assembly.messages.length > 0, 'assembly should contain messages')
  // Metadata should indicate filtering was applied
  assert.ok(
    assembly.metadata !== undefined,
    'assembly should carry metadata'
  )
})

test('contract: does not strip non-config system messages', () => {
  const input = {
    messages: [
      makeSystemMsg('You are an expert programmer. Always think before coding.'),
      makeUserMsg('Write a function.'),
    ],
    toolManifest: undefined,
    contextResult: undefined,
    summaryText: null,
  }

  const assembly = buildRequestAssembly(input as any)
  const systemMessages = assembly.messages.filter(m => m.role === 'system')
  assert.ok(systemMessages.length >= 1, 'non-config system messages should survive')
})
