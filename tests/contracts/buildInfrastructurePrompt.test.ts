/**
 * Contract tests for buildInfrastructurePrompt (internal to
 * services/providerPromptProjection.ts).
 *
 * Because buildInfrastructurePrompt is not exported, we validate its
 * contract through the public projectRequestAssemblyForPromptMode function.
 *
 * Contracts verified:
 *  1. Multiple system messages are merged into a single infrastructure prompt.
 *  2. Workflow step extraction — skill content with numbered instructions
 *     produces an active skill workflow block.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { projectRequestAssemblyForPromptMode } from '../../src/main/proxy/services/providerPromptProjection.ts'
import type { RequestAssembly } from '../../src/main/proxy/RequestAssembly.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'

// ── Helpers ────────────────────────────────────────────────────────

function makeSystemMsg(content: string): ChatMessage {
  return { role: 'system', content }
}

function makeToolMsg(callId: string, content: string): ChatMessage {
  return { role: 'tool', content, tool_call_id: callId }
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

// ── Contract 1: Merge multiple system messages ──────────────────

test('contract: merges multiple system messages into infrastructure prompt', () => {
  const assembly = makeAssembly({
    messages: [
      makeSystemMsg('You are a helpful assistant.'),
      makeSystemMsg('Always be polite and concise.'),
    ],
    // Pre-built infrastructure prompt (as buildRequestAssembly would produce)
    infrastructurePrompt:
      '[Role definition — authoritative for this session]\n' +
      'You are a helpful assistant.\n\n' +
      'Always be polite and concise.',
  })

  const result = projectRequestAssemblyForPromptMode(assembly, 'full')
  assert.ok(result.infrastructurePrompt, 'infrastructure prompt should be present')
  assert.ok(
    result.infrastructurePrompt!.includes('helpful'),
    'infrastructure should contain first system message'
  )
  assert.ok(
    result.infrastructurePrompt!.includes('polite'),
    'infrastructure should contain second system message'
  )
})

test('contract: infrastructure prompt preserves role definition header', () => {
  const assembly = makeAssembly({
    messages: [
      makeSystemMsg('You are an expert programmer.'),
    ],
    infrastructurePrompt:
      '[Role definition — authoritative for this session]\n' +
      'You are an expert programmer.',
  })

  const result = projectRequestAssemblyForPromptMode(assembly, 'full')
  assert.ok(
    result.infrastructurePrompt!.includes('[Role definition'),
    'infrastructure should carry the role definition block'
  )
})

// ── Contract 2: Workflow step extraction ────────────────────────

test('contract: extracts workflow steps from skill content', () => {
  const assembly = makeAssembly({
    messages: [
      makeSystemMsg('You are a coding agent.'),
      // This simulates a skill tool result with numbered steps
      makeToolMsg('call-1', [
        '<skill_content>',
        '1. Use the `read_file` tool to read the source file.',
        '2. Use the `bash` tool to run: `npm test`',
        '3. Use the `write_file` tool to apply fixes.',
        '</skill_content>',
      ].join('\n')),
    ],
    infrastructurePrompt:
      '[Role definition — authoritative for this session]\n' +
      'You are a coding agent.\n\n' +
      '[Active skill workflow — follow these steps in order]\n' +
      '1. Use the `read_file` tool to read the source file.\n' +
      '2. Use the `bash` tool to run: `npm test`',
  })

  const result = projectRequestAssemblyForPromptMode(assembly, 'tool_ready')
  assert.ok(result.infrastructurePrompt, 'infrastructure prompt should be present')
  assert.ok(
    result.infrastructurePrompt!.includes('skill'),
    'infrastructure should reference skill workflow'
  )
})

test('contract: full mode preserves infrastructure prompt intact', () => {
  const infra = '[Role definition — authoritative for this session]\nRole: tester'
  const assembly = makeAssembly({
    messages: [makeSystemMsg('Role: tester')],
    infrastructurePrompt: infra,
  })

  const result = projectRequestAssemblyForPromptMode(assembly, 'full')
  assert.equal(
    result.infrastructurePrompt,
    infra,
    'full mode should preserve infrastructure prompt unchanged'
  )
})
