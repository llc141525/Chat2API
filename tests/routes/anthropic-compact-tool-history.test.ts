import test from 'node:test'
import assert from 'node:assert/strict'

import { ToolCallingEngine } from '../../src/main/proxy/toolCalling/ToolCallingEngine.ts'
import { anthropicRequestToOpenAI, type AnthropicMessagesRequest } from '../../src/main/proxy/routes/anthropicCompat.ts'
import { deriveAnthropicSessionIdentity } from '../../src/main/proxy/routes/anthropicSession.ts'
import type { Provider } from '../../src/main/store/types.ts'

const provider = {
  id: 'qwen',
  name: 'Qwen',
  type: 'builtin',
  authType: 'token',
  apiEndpoint: '',
  headers: {},
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
} as Provider

test('Anthropic tool_use/tool_result history survives compact and keeps matching restored tool schemas', () => {
  const engine = new ToolCallingEngine()
  const headers = { 'x-claude-code-session-id': 'session-history-1' }

  const firstRequest: AnthropicMessagesRequest = {
    model: 'qwen/Qwen3.7-Max',
    messages: [{ role: 'user', content: 'Inspect files.' }],
    tools: [
      {
        name: 'Bash',
        description: 'Execute shell commands',
        input_schema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
      {
        name: 'Read',
        description: 'Read files',
        input_schema: {
          type: 'object',
          properties: { file_path: { type: 'string' } },
          required: ['file_path'],
        },
      },
    ],
  }

  const session = deriveAnthropicSessionIdentity({
    request: firstRequest,
    headers,
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  const first = engine.transformRequest({
    request: anthropicRequestToOpenAI(firstRequest),
    provider,
    actualModel: 'Qwen3.7-Max',
    toolSessionKey: session.claudeSessionKey,
  })

  const compactedRequest: AnthropicMessagesRequest = {
    model: 'qwen/Qwen3.7-Max',
    system: 'Compacted conversation summary.',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I read the file already.' },
          { type: 'tool_use', id: 'toolu_read_1', name: 'Read', input: { file_path: 'README.md' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_read_1', content: 'README body' },
          { type: 'text', text: 'Continue after compact.' },
        ],
      },
    ],
  }

  const transformedRequest = anthropicRequestToOpenAI(compactedRequest)
  const second = engine.transformRequest({
    request: transformedRequest,
    provider,
    actualModel: 'Qwen3.7-Max',
    toolSessionKey: session.claudeSessionKey,
  })

  assert.equal(second.plan.catalogDiagnostics.source, 'session_catalog')
  assert.equal(second.plan.catalogSnapshot?.fingerprint, first.plan.catalogSnapshot?.fingerprint)
  assert.deepEqual(second.plan.tools.map((tool) => tool.name), ['Bash', 'Read'])
  assert.equal(transformedRequest.messages[0].role, 'system')
  assert.equal(transformedRequest.messages[1].role, 'assistant')
  assert.deepEqual(transformedRequest.messages[1].tool_calls, [{
    id: 'toolu_read_1',
    type: 'function',
    function: {
      name: 'Read',
      arguments: '{"file_path":"README.md"}',
    },
  }])
  assert.equal(transformedRequest.messages[2].role, 'tool')
  assert.equal(transformedRequest.messages[2].tool_call_id, 'toolu_read_1')
})
