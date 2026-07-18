import test from 'node:test'
import assert from 'node:assert/strict'

import { buildRequestAssembly } from '../../src/main/proxy/RequestAssembly.ts'
import { buildQwenAssemblyRequestBodyForTest } from '../../src/main/proxy/adapters/qwen.ts'

test('Qwen compact assembly retains a bounded workspace anchor while dropping runtime configuration', () => {
  const assembly = buildRequestAssembly({
    messages: [
      {
        role: 'system',
        content: [
          'You are opencode. Runtime configuration follows.',
          'Working directory: E:\\Chat2API',
          'Workspace root: E:\\Chat2API',
          'superpowers:systematic-debugging',
          'Tool Contract Header',
          'catalog_fingerprint: historical-contract',
          '<|CHAT2API|tool_calls>',
          'UNBOUNDED_RUNTIME_CONFIGURATION_SHOULD_NOT_REACH_QWEN',
        ].join('\n'),
      },
      { role: 'user', content: 'Inspect the project and use the correct working directory.' },
    ] as any,
    toolManifest: {
      renderedPrompt: '## Available Tools\ncatalog_fingerprint: fp\n<|CHAT2API|tool_calls>',
    } as any,
  })

  const body = buildQwenAssemblyRequestBodyForTest({
    assembly,
    request: {
      model: 'Qwen3.7-Max',
      originalModel: 'Qwen3.7-Max',
      stream: true,
      messages: assembly.messages as any,
      promptRefreshMode: 'tool_ready',
    },
    actualModel: 'Qwen3.7-Max',
    sessionId: 'session',
    reqId: 'req',
    timestamp: 1,
    enableThinking: false,
    enableWebSearch: false,
  })

  const content = String(body.messages[0]?.content ?? '')
  assert.match(content, /Working directory:\s*E:\\Chat2API/)
  assert.match(content, /Workspace root:\s*E:\\Chat2API/)
  assert.doesNotMatch(content, /UNBOUNDED_RUNTIME_CONFIGURATION_SHOULD_NOT_REACH_QWEN/)
  assert.doesNotMatch(content, /superpowers:systematic-debugging/)
  assert.match(content, /## Available Tools/)
})
