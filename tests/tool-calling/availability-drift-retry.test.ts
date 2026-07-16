import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildAvailabilityRetryClarification,
  detectAvailabilityDrift,
} from '../../src/main/proxy/toolCalling/availabilityDrift.ts'
import { buildToolCallingRuntimePlan } from '../../src/main/proxy/toolCalling/runtimePlan.ts'
import { __resetCatalogStoreForTest } from '../../src/main/proxy/toolCalling/catalog.ts'
import type { ToolCallingPlan } from '../../src/main/proxy/toolCalling/types.ts'

function makePlan(overrides: Partial<ToolCallingPlan> = {}): ToolCallingPlan {
  return {
    mode: 'managed',
    protocol: 'managed_xml',
    clientAdapterId: 'standard-openai-tools',
    providerId: 'qwen',
    tools: [],
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(['bash', 'read', 'write']),
    catalogSnapshot: {
      sessionId: 's1',
      fingerprint: 'fp_test_123',
      tools: [],
      allowedToolNames: ['bash', 'read', 'write'],
      schemaHashes: {},
      source: 'current_request',
      createdTurnIndex: 1,
      updatedTurnIndex: 1,
    },
    catalogDiagnostics: {
      source: 'current_request',
      fingerprint: 'fp_test_123',
      driftKinds: [],
      blocked: false,
    },
    availabilityRetryAllowed: true,
    contract: {
      turnId: 'turn-1',
      sessionId: 's1',
      providerId: 'qwen',
      model: 'qwen-test',
      protocol: 'managed_xml',
      snapshotFingerprint: 'fp_test_123',
      tools: [],
      allowedToolNames: new Set(['bash', 'read', 'write']),
      toolChoiceMode: 'auto',
      shouldInjectPrompt: true,
      shouldParseResponse: true,
      historyMode: 'managed_protocol',
      emptyOutputPolicy: 'diagnose_and_fail',
      toolSourceChain: ['current_request', 'session_catalog', 'message_history', 'safe_empty'],
    },
    diagnostics: {
      clientAdapterId: 'standard-openai-tools',
      providerId: 'qwen',
      toolSource: 'openai',
      mode: 'managed',
      protocol: 'managed_xml',
      toolCount: 3,
      injected: true,
      reason: 'managed_auto',
      allowedToolNames: ['bash', 'read', 'write'],
    },
    ...overrides,
  }
}

test('detectAvailabilityDrift catches only-open-url denial against authoritative catalog', () => {
  const detection = detectAvailabilityDrift(
    makePlan(),
    'I only have open_url available in this environment.',
  )

  assert.equal(detection.detected, true)
  assert.deepEqual(detection.deniedToolNames, [])
  assert.deepEqual(detection.mentionedUnavailableOnlyTools, ['open_url'])
})

test('detectAvailabilityDrift catches denied allowed tool names in English', () => {
  const detection = detectAvailabilityDrift(
    makePlan(),
    'I do not have access to read or bash right now.',
  )

  assert.equal(detection.detected, true)
  assert.deepEqual(detection.deniedToolNames.sort(), ['bash', 'read'])
})

test('detectAvailabilityDrift catches Chinese availability denial', () => {
  const detection = detectAvailabilityDrift(
    makePlan(),
    '当前没有 read 和 bash 工具，只能使用 open_url。',
  )

  assert.equal(detection.detected, true)
  assert.deepEqual(detection.deniedToolNames.sort(), ['bash', 'read'])
  assert.deepEqual(detection.mentionedUnavailableOnlyTools, ['open_url'])
})

test('detectAvailabilityDrift catches only-available-tool phrasing with backticks', () => {
  const chineseDetection = detectAvailabilityDrift(
    makePlan(),
    '环境中唯一可用的工具是 `open_url`，但任务要求调用 skill、read 和 bash。',
  )
  const englishDetection = detectAvailabilityDrift(
    makePlan(),
    'The only available tool is `open_url`, but I need read and bash.',
  )

  assert.equal(chineseDetection.detected, true)
  assert.deepEqual(chineseDetection.mentionedUnavailableOnlyTools, ['open_url'])
  assert.equal(englishDetection.detected, true)
  assert.deepEqual(englishDetection.mentionedUnavailableOnlyTools, ['open_url'])
})

test('detectAvailabilityDrift ignores fenced examples', () => {
  const detection = detectAvailabilityDrift(
    makePlan(),
    '```text\nI only have open_url available.\n```',
  )

  assert.equal(detection.detected, false)
})

test('clarification includes fingerprint, protocol, and authoritative tool list', () => {
  const result = buildAvailabilityRetryClarification(makePlan())

  assert.ok(result.includes('catalog_fingerprint: fp_test_123'))
  assert.ok(result.includes('protocol: managed_xml'))
  assert.ok(result.includes('available_tools: bash, read, write'))
  assert.ok(result.includes('Do not say that an allowed tool is unavailable.'))
})

test('clarification only exposes the forced tool when allowed set is narrowed', () => {
  const result = buildAvailabilityRetryClarification(makePlan({
    allowedToolNames: new Set(['read']),
  }))

  assert.ok(result.includes('available_tools: read'))
  assert.ok(!result.includes('bash'))
  assert.ok(!result.includes('write'))
})

// --- Prompt-embedded catalog integration ---

const OPENCODE_SYSTEM_PROMPT = `You are a coding assistant.

## Available Tools
You can invoke the following developer tools. Tool names are case-sensitive.
The tool list in this section is authoritative for the current turn.

Tool \`read\`: Read a file from disk. Required parameters: file_path
  JSON schema: {"type":"object","properties":{"file_path":{"type":"string"}},"required":["file_path"]}
Tool \`bash\`: Execute a shell command. Required parameters: command
  JSON schema: {"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}

When calling tools, respond with only this Chat2API XML block:

<|CHAT2API|tool_calls><|CHAT2API|invoke name="exact_tool_name"><|CHAT2API|parameter name="argument"><![CDATA[value]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>

Tool results will be provided as Chat2API XML result blocks:

<|CHAT2API|tool_result tool_call_id="call_id"><![CDATA[result]]></|CHAT2API|tool_result>`

const MANAGED_CONFIG = {
  enabled: true,
  mode: 'auto' as const,
  clientAdapterId: 'standard-openai-tools' as const,
  diagnosticsEnabled: false,
  advanced: { promptPreviewEnabled: false },
}

test('OpenCode-style system prompt produces a populated catalogSnapshot via prompt_embedded path', () => {
  __resetCatalogStoreForTest()

  const plan = buildToolCallingRuntimePlan({
    requestId: 'pe-test-1',
    providerId: 'glm',
    actualModel: 'GLM-5.2',
    config: MANAGED_CONFIG,
    clientRequest: {
      clientAdapterId: 'standard-openai-tools',
      toolSource: 'prompt_embedded',
      tools: [
        { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }, source: 'prompt_embedded' },
        { name: 'bash', description: 'Execute a shell command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }, source: 'prompt_embedded' },
      ],
      toolChoice: { mode: 'auto' },
      diagnostics: {
        rawToolCount: 0,
        normalizedToolNames: ['read', 'bash'],
        promptEmbeddedMarkers: { availableToolsHeader: true, managedProtocolHeader: true, mcpServerBlock: false },
      },
    },
    messages: [{ role: 'system', content: OPENCODE_SYSTEM_PROMPT }],
    toolSessionKey: 'pe-session-1',
  })

  assert.ok(plan.catalogSnapshot !== undefined, 'catalogSnapshot must be defined for prompt-embedded path')
  assert.equal(plan.catalogDiagnostics.source, 'prompt_embedded')
  assert.ok(plan.catalogSnapshot.fingerprint.length > 0, 'fingerprint must be non-empty')
  assert.deepEqual([...plan.allowedToolNames].sort(), ['bash', 'read'])
  assert.equal(plan.mode, 'managed')
  assert.equal(plan.shouldInjectPrompt, true)
  assert.ok(plan.catalogDiagnostics.driftKinds.includes('prompt_embedded_only_catalog'))
})

test('drift detection fires against prompt-embedded catalog when model denies available tools', () => {
  __resetCatalogStoreForTest()

  const plan = buildToolCallingRuntimePlan({
    requestId: 'pe-test-2',
    providerId: 'glm',
    actualModel: 'GLM-5.2',
    config: MANAGED_CONFIG,
    clientRequest: {
      clientAdapterId: 'standard-openai-tools',
      toolSource: 'prompt_embedded',
      tools: [
        { name: 'read', description: 'Read a file', parameters: { type: 'object', additionalProperties: true }, source: 'prompt_embedded' },
        { name: 'bash', description: 'Execute a shell command', parameters: { type: 'object', additionalProperties: true }, source: 'prompt_embedded' },
      ],
      toolChoice: { mode: 'auto' },
      diagnostics: { rawToolCount: 0, normalizedToolNames: ['read', 'bash'] },
    },
    messages: [{ role: 'system', content: OPENCODE_SYSTEM_PROMPT }],
    toolSessionKey: 'pe-session-2',
  })

  assert.ok(plan.catalogSnapshot !== undefined, 'catalogSnapshot must be defined')

  // Simulate GLM's response denying the tools
  const glmDenialText = '环境中唯一可用的工具是 open_url，不能使用 read 或 bash。'
  const detection = detectAvailabilityDrift(plan, glmDenialText)

  assert.equal(detection.detected, true, 'drift must be detected against prompt-embedded catalog')
  assert.ok(
    detection.deniedToolNames.includes('read') || detection.deniedToolNames.includes('bash') || detection.mentionedUnavailableOnlyTools.includes('open_url'),
    `Expected denial to mention read/bash or open_url, got: denied=${detection.deniedToolNames}, mentioned=${detection.mentionedUnavailableOnlyTools}`,
  )
})

test('drift detection fires for English open_url-only denial against prompt-embedded catalog', () => {
  __resetCatalogStoreForTest()

  const plan = buildToolCallingRuntimePlan({
    requestId: 'pe-test-3',
    providerId: 'glm',
    actualModel: 'GLM-5.2',
    config: MANAGED_CONFIG,
    clientRequest: {
      clientAdapterId: 'standard-openai-tools',
      toolSource: 'prompt_embedded',
      tools: [
        { name: 'read', description: 'Read a file', parameters: { type: 'object', additionalProperties: true }, source: 'prompt_embedded' },
        { name: 'bash', description: 'Execute a shell command', parameters: { type: 'object', additionalProperties: true }, source: 'prompt_embedded' },
      ],
      toolChoice: { mode: 'auto' },
      diagnostics: { rawToolCount: 0, normalizedToolNames: ['read', 'bash'] },
    },
    messages: [{ role: 'system', content: OPENCODE_SYSTEM_PROMPT }],
    toolSessionKey: 'pe-session-3',
  })

  assert.ok(plan.catalogSnapshot !== undefined)

  const detection = detectAvailabilityDrift(plan, 'I only have open_url available in this environment.')
  assert.equal(detection.detected, true)
  assert.deepEqual(detection.mentionedUnavailableOnlyTools, ['open_url'])
})
