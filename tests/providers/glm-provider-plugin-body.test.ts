import test from 'node:test'
import assert from 'node:assert/strict'

import { buildRequestAssembly } from '../../src/main/proxy/RequestAssembly.ts'
import { buildGLMProviderBodyForTest } from '../../src/main/proxy/plugins/GLMProviderPlugin.ts'
import { projectRequestAssemblyForPromptMode } from '../../src/main/proxy/services/providerPromptProjection.ts'

function sourceAssembly() {
  return buildRequestAssembly({
    messages: [
      { role: 'user', content: 'Old task turn.' },
      { role: 'assistant', content: 'Old response.' },
      { role: 'user', content: 'Current task turn.' },
    ],
    summaryText: '[Workflow state digest] Continue current task.',
    toolManifest: {
      renderedPrompt: 'Tool Contract Header\n## Available Tools\nTool `read`: read files',
    } as any,
  })
}

function promptText(body: ReturnType<typeof buildGLMProviderBodyForTest>): string {
  return String(body.messages?.[0]?.content?.find((part: any) => part.type === 'text')?.text ?? '')
}

test('GLM body uses an empty conversation id for a fresh digest boundary', () => {
  const body = buildGLMProviderBodyForTest({
    assembly: projectRequestAssemblyForPromptMode(sourceAssembly(), 'digest'),
    model: 'glm-5',
    sessionId: undefined,
    enableThinking: false,
    enableWebSearch: false,
  })

  assert.equal(body.conversation_id, '')
  assert.match(promptText(body), /Workflow state digest/)
  assert.match(promptText(body), /Tool Contract Header/)
})

test('GLM body reuses a session only with minimal current-delta content', () => {
  const body = buildGLMProviderBodyForTest({
    assembly: projectRequestAssemblyForPromptMode(sourceAssembly(), 'minimal'),
    model: 'glm-5',
    sessionId: 'existing-conversation',
    enableThinking: false,
    enableWebSearch: false,
  })
  const prompt = promptText(body)

  assert.equal(body.conversation_id, 'existing-conversation')
  assert.match(prompt, /Current task turn/)
  assert.doesNotMatch(prompt, /Old task turn|Old response|Workflow state digest|Tool Contract Header/)
})
