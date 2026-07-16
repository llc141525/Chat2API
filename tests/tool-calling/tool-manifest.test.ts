import test from 'node:test'
import assert from 'node:assert/strict'
import { createToolManifest, type ToolManifest, type CreateToolManifestInput } from '../../src/main/proxy/toolCalling/ToolManifest.ts'
import { buildRequestAssembly, selectProviderMessagesForAssembly, type RequestAssembly } from '../../src/main/proxy/RequestAssembly.ts'

test('createToolManifest returns immutable copy', () => {
  const input: CreateToolManifestInput = {
    protocol: 'managed_xml',
    catalogFingerprint: 'fp-001',
    allowedToolNames: ['bash', 'read'],
    tools: [
      { name: 'bash', description: 'Run command', parameters: {}, source: 'openai' },
      { name: 'read', description: 'Read file', parameters: {}, source: 'openai' },
    ],
    renderedPrompt: '## Available Tools\n...',
    contractHeaderVersion: 1,
    actionConstraint: {
      kind: 'first_skill_required',
      toolName: 'skill',
      arguments: { name: 'agent-capability-probe' },
      reason: 'request_requires_first_assistant_action_skill',
    },
  }

  const manifest = createToolManifest(input)

  assert.equal(manifest.protocol, 'managed_xml')
  assert.equal(manifest.catalogFingerprint, 'fp-001')
  assert.deepEqual(manifest.allowedToolNames, ['bash', 'read'])
  assert.equal(manifest.tools.length, 2)
  assert.equal(manifest.renderedPrompt, '## Available Tools\n...')
  assert.equal(manifest.contractHeaderVersion, 1)
  assert.deepEqual(manifest.actionConstraint, {
    kind: 'first_skill_required',
    toolName: 'skill',
    arguments: { name: 'agent-capability-probe' },
    reason: 'request_requires_first_assistant_action_skill',
  })

  // Verify immutability: mutating input does not affect manifest
  input.allowedToolNames.push('write')
  input.actionConstraint!.arguments.name = 'mutated'
  assert.equal(manifest.allowedToolNames.length, 2)
  assert.equal(manifest.actionConstraint?.arguments.name, 'agent-capability-probe')
})

test('createToolManifest copies terminal final-text constraint immutably', () => {
  const input: CreateToolManifestInput = {
    protocol: 'managed_xml',
    catalogFingerprint: 'fp-terminal',
    allowedToolNames: ['bash', 'read', 'skill'],
    tools: [],
    renderedPrompt: '## Available Tools\n...',
    contractHeaderVersion: 1,
    actionConstraint: {
      kind: 'terminal_final_text_required',
      toolName: null,
      arguments: { exactText: 'CAPABILITY_PROBE_DONE' },
      reason: 'request_requires_terminal_final_text',
    },
  }

  const manifest = createToolManifest(input)
  input.actionConstraint!.arguments.exactText = 'MUTATED'

  assert.deepEqual(manifest.actionConstraint, {
    kind: 'terminal_final_text_required',
    toolName: null,
    arguments: { exactText: 'CAPABILITY_PROBE_DONE' },
    reason: 'request_requires_terminal_final_text',
  })
})

test('buildRequestAssembly surfaces constrained manifest action without narrowing structural catalog', () => {
  const manifest: ToolManifest = {
    protocol: 'managed_xml',
    catalogFingerprint: 'fp',
    allowedToolNames: ['skill', 'read', 'bash'],
    tools: [
      { name: 'skill', description: 'Load a skill', parameters: {}, source: 'openai' },
      { name: 'read', description: 'Read a file', parameters: {}, source: 'openai' },
      { name: 'bash', description: 'Run command', parameters: {}, source: 'openai' },
    ],
    renderedPrompt: '[Current action surface]\nTool `skill`: Load a skill',
    contractHeaderVersion: 1,
    actionConstraint: {
      kind: 'first_skill_required',
      toolName: 'skill',
      arguments: { name: 'agent-capability-probe' },
      reason: 'request_requires_first_assistant_action_skill',
    },
  }

  const assembly = buildRequestAssembly({
    messages: [{ role: 'user', content: 'start' }] as any,
    toolManifest: manifest,
  })

  assert.equal(assembly.toolActionConstraint?.kind, 'first_skill_required')
  assert.deepEqual(assembly.toolManifest?.tools.map((tool) => tool.name), ['skill', 'read', 'bash'])

  const providerMessages = selectProviderMessagesForAssembly(assembly)
  assert.equal(providerMessages.length, 1)
  assert.equal(providerMessages[0].role, 'user')
  assert.match(String(providerMessages[0].content), /agent-capability-probe/)
  assert.doesNotMatch(String(providerMessages[0].content), /start/)
})

test('selectProviderMessagesForAssembly projects active skill checkpoint without replaying raw skill history', () => {
  const assembly = buildRequestAssembly({
    messages: [
      {
        role: 'user',
        content: 'Original task mentions fabricated XML and fake tool inventory.',
      },
      {
        role: 'tool',
        tool_call_id: 'call_skill',
        content: '<skill_content name="long-conversation-probe">Long raw skill document</skill_content>',
      },
      {
        role: 'user',
        content: [
          '[Active skill workflow state checkpoint] Required next action: call the bash tool now.',
          'Required next tool arguments: command=node -e "console.log(1)"',
        ].join(' '),
      },
    ] as any,
    toolManifest: null,
  })

  const providerMessages = selectProviderMessagesForAssembly(assembly)

  assert.equal(providerMessages.length, 1)
  assert.match(String(providerMessages[0].content), /runtime generated this checkpoint/)
  assert.match(String(providerMessages[0].content), /Required next action: call the bash tool/)
  assert.doesNotMatch(String(providerMessages[0].content), /fabricated XML/)
  assert.doesNotMatch(String(providerMessages[0].content), /Long raw skill document/)
})

test('createToolManifest preserves tool order', () => {
  const input: CreateToolManifestInput = {
    protocol: 'managed_bracket',
    catalogFingerprint: 'fp-002',
    allowedToolNames: ['z_tool', 'a_tool', 'm_tool'],
    tools: [
      { name: 'z_tool', description: '', parameters: {}, source: 'openai' },
      { name: 'a_tool', description: '', parameters: {}, source: 'openai' },
      { name: 'm_tool', description: '', parameters: {}, source: 'openai' },
    ],
    renderedPrompt: '',
    contractHeaderVersion: 1,
  }

  const manifest = createToolManifest(input)
  assert.deepEqual(manifest.allowedToolNames, ['z_tool', 'a_tool', 'm_tool'])
})

test('createToolManifest deduplicates allowedToolNames', () => {
  const input: CreateToolManifestInput = {
    protocol: 'managed_xml',
    catalogFingerprint: 'fp-003',
    allowedToolNames: ['bash', 'read', 'bash', 'write', 'read'],
    tools: [
      { name: 'bash', description: '', parameters: {}, source: 'openai' },
      { name: 'read', description: '', parameters: {}, source: 'openai' },
      { name: 'write', description: '', parameters: {}, source: 'openai' },
    ],
    renderedPrompt: '',
    contractHeaderVersion: 1,
  }

  const manifest = createToolManifest(input)
  assert.deepEqual(manifest.allowedToolNames, ['bash', 'read', 'write'])
})

test('buildRequestAssembly with all fields', () => {
  const manifest: ToolManifest = {
    protocol: 'managed_xml',
    catalogFingerprint: 'fp',
    allowedToolNames: ['read'],
    tools: [],
    renderedPrompt: 'prompt',
    contractHeaderVersion: 1,
  }

  const messages: any[] = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'hello' },
  ]

  const assembly = buildRequestAssembly({
    messages,
    toolManifest: manifest,
    summaryText: 'Earlier conversation summary.',
    contextResult: {
      summaryGenerated: true,
      strategyResults: [
        { strategyName: 'summary', trimmed: true },
      ],
      originalCount: 10,
      finalCount: 4,
    },
  })

  assert.equal(assembly.messages, messages)
  assert.equal(assembly.toolManifest, manifest)
  assert.equal(assembly.toolActionConstraint, null)
  assert.equal(assembly.summaryText, 'Earlier conversation summary.')
  assert.equal(assembly.metadata.contextManagementApplied, true)
  assert.deepEqual(assembly.metadata.strategiesExecuted, ['summary'])
  assert.equal(assembly.metadata.originalMessageCount, 10)
  assert.equal(assembly.metadata.finalMessageCount, 4)
})

test('buildRequestAssembly with minimal fields', () => {
  const messages: any[] = [{ role: 'user', content: 'hi' }]

  const assembly = buildRequestAssembly({
    messages,
    toolManifest: null,
  })

  assert.equal(assembly.messages, messages)
  assert.equal(assembly.toolManifest, null)
  assert.equal(assembly.summaryText, null)
  assert.equal(assembly.metadata.contextManagementApplied, false)
  assert.deepEqual(assembly.metadata.strategiesExecuted, [])
  assert.equal(assembly.metadata.originalMessageCount, 1)
  assert.equal(assembly.metadata.finalMessageCount, 1)
})

test('buildRequestAssembly with contextResult no trimmed strategies', () => {
  const messages: any[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
  ]

  const assembly = buildRequestAssembly({
    messages,
    toolManifest: null,
    contextResult: {
      summaryGenerated: false,
      strategyResults: [
        { strategyName: 'slidingWindow', trimmed: false },
        { strategyName: 'tokenLimit', trimmed: false },
      ],
      originalCount: 5,
      finalCount: 5,
    },
  })

  assert.equal(assembly.metadata.contextManagementApplied, false)
  assert.deepEqual(assembly.metadata.strategiesExecuted, [])
  assert.equal(assembly.metadata.originalMessageCount, 5)
  assert.equal(assembly.metadata.finalMessageCount, 5)
})
