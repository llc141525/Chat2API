import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCleanedRequest } from '../../src/main/proxy/core/requestCleaner.ts'
import { buildRequestAssembly } from '../../src/main/proxy/RequestAssembly.ts'
import type { RequestAssembly } from '../../src/main/proxy/RequestAssembly.ts'

test('cleaned infrastructure keeps one bounded role definition across repeated runtime messages', () => {
  const assembly: RequestAssembly = {
    messages: [
      { role: 'system', content: 'You are the OpenCode probe runner. Follow the active workflow.' },
      { role: 'system', content: 'You are the OpenCode probe runner. Follow the active workflow.' },
      { role: 'system', content: 'You are the OpenCode probe runner. Follow the active workflow.' },
      { role: 'user', content: 'Continue the probe.' },
    ],
    summaryText: null,
    workflowDigest: null,
    metadata: { contextManagementApplied: false },
    infrastructurePrompt: '[Role definition — authoritative for this session]\nCanonical bounded prompt.',
  }

  const cleaned = buildCleanedRequest(assembly, {
    promptRefreshMode: 'tool_ready',
    hasProviderSession: false,
  })

  const prompt = cleaned.infrastructurePrompt ?? ''
  assert.equal(prompt, '[Role definition — authoritative for this session]\nCanonical bounded prompt.')
})

test('cleaned infrastructure preserves skill steps after blank phase separators', () => {
  const assembly: RequestAssembly = {
    messages: [
      { role: 'tool', tool_call_id: 'skill-1', content: [
        '<skill_content>',
        '1. Use the `read` tool to read the first file.',
        '',
        '2. Use the `read` tool to read the second file.',
        '',
        '3. Use the `write` tool to write the final artifact.',
        '</skill_content>',
      ].join('\n') },
    ],
    summaryText: null,
    workflowDigest: null,
    metadata: { contextManagementApplied: false },
  }

  const cleaned = buildCleanedRequest(assembly, {
    promptRefreshMode: 'tool_ready',
    hasProviderSession: false,
  })

  const prompt = cleaned.infrastructurePrompt ?? ''
  assert.match(prompt, /2\. Use the `read` tool to read the second file/)
  assert.match(prompt, /3\. Use the `write` tool to write the final artifact/)
})

test('request assembly keeps later skill phases beyond the legacy 800 character cap', () => {
  const messages = [{
    role: 'tool' as const,
    tool_call_id: 'skill-call',
    content: [
      '<skill_content>',
      `1. Use the \`read\` tool to inspect ${'a'.repeat(700)}.`,
      '',
      `2. Use the \`glob\` tool to inspect ${'b'.repeat(700)}.`,
      '',
      `3. Use the \`read\` tool to inspect ${'c'.repeat(700)}.`,
      '',
      '4. Use the `write` tool to save the final notes.',
      '</skill_content>',
    ].join('\n'),
  }]
  const assembly = buildRequestAssembly({ messages, toolManifest: null })
  assert.match(assembly.infrastructurePrompt ?? '', /4\. Use the `write` tool/)
})

test('request assembly preserves skill workflows that use direct action verbs', () => {
  const messages = [{
    role: 'tool' as const,
    tool_call_id: 'skill-call',
    content: [
      '<skill_content>',
      '1. Read `E:\\Chat2API\\tailwind.config.js` — extract color tokens only.',
      '2. Read `E:\\Chat2API\\src\\renderer\\src\\index.css` — extract CSS variables only.',
      '3. Glob `E:\\Chat2API\\src\\renderer\\src\\**\\*.tsx` to find component files.',
      '4. Read EXACTLY 2 component files from the glob results.',
      '5. Write findings to `.agent-probe\\white-ui-notes.txt`.',
      '</skill_content>',
    ].join('\n'),
  }]

  const assembly = buildRequestAssembly({ messages, toolManifest: null })
  const prompt = assembly.infrastructurePrompt ?? ''

  assert.match(prompt, /1\. Read `E:\\Chat2API\\tailwind\.config\.js`/)
  assert.match(prompt, /3\. Glob `E:\\Chat2API\\src\\renderer\\src\\\*\*\\\*\.tsx`/)
  assert.match(prompt, /5\. Write findings to/)
})

test('cleaned requests remove raw skill documents after projecting their workflow steps', () => {
  const rawSkill = [
    '<skill_content>',
    '1. Use the `read` tool to inspect the source.',
    '2. Use the `write` tool to save the notes.',
    'superpowers: internal skill documentation that must not be replayed',
    '</skill_content>',
  ].join('\n')
  const assembly: RequestAssembly = {
    messages: [{ role: 'tool', tool_call_id: 'skill-call', content: rawSkill }],
    summaryText: null,
    workflowDigest: null,
    infrastructurePrompt: '[Active skill workflow — follow these steps in order]\n1. Use the `read` tool.\n2. Use the `write` tool.',
    metadata: { contextManagementApplied: false },
  }

  const cleaned = buildCleanedRequest(assembly, {
    promptRefreshMode: 'full',
    hasProviderSession: false,
  })

  assert.doesNotMatch(
    cleaned.messages.map(message => typeof message.content === 'string' ? message.content : '').join('\n'),
    /<skill_content|superpowers: internal skill documentation/,
  )
  assert.match(cleaned.infrastructurePrompt ?? '', /Active skill workflow/)
})
