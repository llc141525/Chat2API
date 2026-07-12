import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import {
  anthropicRequestToOpenAI,
  classifyAnthropicForwardError,
  classifyAnthropicSelectionFailure,
  openAIResponseToAnthropic,
  transformOpenAIStreamToAnthropic,
} from '../../src/main/proxy/routes/anthropicCompat.ts'
import { splitProviderQualifiedModel } from '../../src/main/proxy/modelQualifier.ts'
import {
  collectAnthropicCatalogEvidence,
  deriveAnthropicSessionIdentity,
} from '../../src/main/proxy/routes/anthropicSession.ts'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function parseAnthropicEvents(raw: string): Array<{ event: string; data: any }> {
  return raw
    .split('\n\n')
    .map(part => part.trim())
    .filter(Boolean)
    .map((part) => {
      const lines = part.split('\n')
      const event = lines.find(line => line.startsWith('event: '))?.slice(7) || ''
      const dataLine = lines.find(line => line.startsWith('data: '))?.slice(6) || '{}'
      return { event, data: JSON.parse(dataLine) }
    })
}

test('Anthropic text request maps to OpenAI chat request', () => {
  const result = anthropicRequestToOpenAI({
    model: 'qwen/Qwen3.7-Max',
    system: 'You are helpful.',
    messages: [
      { role: 'user', content: 'Hello from Claude Code' },
    ],
    max_tokens: 1024,
    temperature: 0.2,
    stream: false,
  })

  assert.equal(result.model, 'qwen/Qwen3.7-Max')
  assert.equal(result.messages[0].role, 'system')
  assert.equal(result.messages[0].content, 'You are helpful.')
  assert.equal(result.messages[1].role, 'user')
  assert.equal(result.messages[1].content, 'Hello from Claude Code')
  assert.equal(result.max_tokens, 1024)
  assert.equal(result.temperature, 0.2)
})

test('Anthropic tools preserve input_schema and tool choice', () => {
  const result = anthropicRequestToOpenAI({
    model: 'qwen/Qwen3.7-Max',
    messages: [{ role: 'user', content: 'Read a file' }],
    tools: [{
      name: 'read',
      description: 'Read a file',
      input_schema: {
        type: 'object',
        properties: { filePath: { type: 'string' } },
        required: ['filePath'],
      },
    }],
    tool_choice: { type: 'tool', name: 'read' },
  })

  assert.deepEqual(result.tools, [{
    type: 'function',
    function: {
      name: 'read',
      description: 'Read a file',
      parameters: {
        type: 'object',
        properties: { filePath: { type: 'string' } },
        required: ['filePath'],
      },
    },
  }])
  assert.deepEqual(result.tool_choice, {
    type: 'function',
    function: { name: 'read' },
  })
})

test('Anthropic assistant tool_use and user tool_result map to structured OpenAI tool turns', () => {
  const result = anthropicRequestToOpenAI({
    model: 'qwen/Qwen3.7-Max',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will inspect the file.' },
          { type: 'tool_use', id: 'toolu_1', name: 'read', input: { filePath: 'tests/input.txt' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file body' },
          { type: 'text', text: 'Continue.' },
        ],
      },
    ],
  })

  assert.equal(result.messages[0].role, 'assistant')
  assert.equal(result.messages[0].content, 'I will inspect the file.')
  assert.deepEqual(result.messages[0].tool_calls, [{
    id: 'toolu_1',
    type: 'function',
    function: {
      name: 'read',
      arguments: '{"filePath":"tests/input.txt"}',
    },
  }])
  assert.equal(result.messages[1].role, 'tool')
  assert.equal(result.messages[1].tool_call_id, 'toolu_1')
  assert.equal(result.messages[1].content, 'file body')
  assert.equal(result.messages[2].role, 'user')
  assert.equal(result.messages[2].content, 'Continue.')
})

test('OpenAI non-stream tool_calls map to Anthropic tool_use content and tool_use stop reason', () => {
  const result = openAIResponseToAnthropic({
    id: 'chatcmpl_1',
    model: 'Qwen3.7-Max',
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: {
            name: 'read',
            arguments: '{"filePath":"tests/input.txt"}',
          },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 7,
    },
  }, 'fallback-model')

  assert.equal(result.type, 'message')
  assert.equal(result.stop_reason, 'tool_use')
  assert.deepEqual(result.content, [{
    type: 'tool_use',
    id: 'call_1',
    name: 'read',
    input: { filePath: 'tests/input.txt' },
  }])
  assert.deepEqual(result.usage, {
    input_tokens: 12,
    output_tokens: 7,
  })
})

test('OpenAI non-stream invalid tool arguments degrade to empty input object', () => {
  const result = openAIResponseToAnthropic({
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_bad',
          type: 'function',
          function: {
            name: 'bash',
            arguments: '{"unterminated"',
          },
        }],
      },
      finish_reason: 'tool_calls',
    }],
  }, 'fallback-model')

  assert.deepEqual(result.content, [{
    type: 'tool_use',
    id: 'call_bad',
    name: 'bash',
    input: {},
  }])
})

test('OpenAI stream delta.tool_calls maps to Anthropic tool_use event order', async () => {
  const sse = [
    'data: {"id":"chatcmpl_1","choices":[{"delta":{"content":"Checking file..."},"finish_reason":null}]}\n\n',
    'data: {"id":"chatcmpl_1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read","arguments":"{\\"filePath\\":\\"tests/input.txt\\"}"}}]},"finish_reason":null}]}\n\n',
    'data: {"id":"chatcmpl_1","choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ].join('')

  const transformed = transformOpenAIStreamToAnthropic(
    Readable.from([sse]),
    'Qwen3.7-Max',
  )
  const raw = await readStream(transformed)
  const events = parseAnthropicEvents(raw)

  assert.deepEqual(
    events.map(event => event.event),
    [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ],
  )

  assert.equal(events[1].data.content_block.type, 'text')
  assert.equal(events[2].data.delta.type, 'text_delta')
  assert.equal(events[4].data.content_block.type, 'tool_use')
  assert.equal(events[4].data.content_block.id, 'call_1')
  assert.equal(events[5].data.delta.type, 'input_json_delta')
  assert.equal(events[7].data.delta.stop_reason, 'tool_use')
})

test('Model selection failures return typed Anthropic errors', () => {
  assert.deepEqual(
    classifyAnthropicSelectionFailure({
      requestedModel: 'qwen/Qwen3.7-Max',
      supportedProviderCount: 0,
      configuredAccountCount: 0,
      availableAccountCount: 0,
    }),
    {
      type: 'not_found_error',
      message: 'No enabled provider supports requested model: qwen/Qwen3.7-Max',
      diagnosticClass: 'no_provider_configured',
    },
  )

  assert.deepEqual(
    classifyAnthropicSelectionFailure({
      requestedModel: 'qwen/Qwen3.7-Max',
      supportedProviderCount: 1,
      configuredAccountCount: 0,
      availableAccountCount: 0,
    }),
    {
      type: 'authentication_error',
      message: 'No configured account for model: qwen/Qwen3.7-Max',
      diagnosticClass: 'no_account_configured',
    },
  )
})

test('Provider failures normalize to typed Anthropic terminal errors', () => {
  assert.deepEqual(
    classifyAnthropicForwardError(404, 'Upstream model not found'),
    {
      type: 'not_found_error',
      message: 'Upstream model not found',
      diagnosticClass: 'provider_model_not_found',
    },
  )

  assert.deepEqual(
    classifyAnthropicForwardError(502, 'Provider returned malformed tool output'),
    {
      type: 'api_error',
      message: 'Provider returned malformed tool output',
      diagnosticClass: 'malformed_provider_response',
    },
  )

  assert.deepEqual(
    classifyAnthropicForwardError(502, 'Provider refused the authoritative tool catalog for managed tool turn claude:abc'),
    {
      type: 'api_error',
      message: 'Provider refused the authoritative tool catalog for managed tool turn claude:abc',
      diagnosticClass: 'tool_catalog_drift',
    },
  )
})

test('Anthropic compatibility also exposes model discovery routes under the anthropic prefix', () => {
  const modelsRouteSource = readFileSync(
    join(root, 'src/main/proxy/routes/models.ts'),
    'utf8',
  )
  const serverSource = readFileSync(
    join(root, 'src/main/proxy/server.ts'),
    'utf8',
  )

  assert.match(modelsRouteSource, /router\.get\('\/v1\/models', handleListModels\)/)
  assert.match(modelsRouteSource, /router\.get\('\/v1\/v1\/models', handleListModels\)/)
  assert.match(modelsRouteSource, /router\.get\('\/anthropic\/v1\/models', handleListModels\)/)
  assert.match(modelsRouteSource, /router\.get\('\/v1\/models\/:model', handleGetModel\)/)
  assert.match(modelsRouteSource, /router\.get\('\/v1\/v1\/models\/:model', handleGetModel\)/)
  assert.match(modelsRouteSource, /router\.get\('\/anthropic\/v1\/models\/:model', handleGetModel\)/)
  assert.match(serverSource, /GET \/v1\/v1\/models/)
  assert.match(serverSource, /GET \/v1\/v1\/models\/:model/)
  assert.match(serverSource, /GET \/anthropic\/v1\/models/)
  assert.match(serverSource, /GET \/anthropic\/v1\/models\/:model/)
})

test('Qualified provider/model ids resolve to the expected provider and unqualified model name', async () => {
  assert.deepEqual(
    splitProviderQualifiedModel('qwen/Qwen3.7-Max', ['glm', 'qwen', 'deepseek']),
    {
      providerId: 'qwen',
      model: 'Qwen3.7-Max',
    },
  )

  assert.deepEqual(
    splitProviderQualifiedModel('missing-provider/Qwen3.7-Max', ['glm', 'qwen', 'deepseek']),
    {
      model: 'missing-provider/Qwen3.7-Max',
    },
  )

  assert.deepEqual(
    splitProviderQualifiedModel('glm/GLM-5.2', ['qwen', 'glm']),
    {
      providerId: 'glm',
      model: 'GLM-5.2',
    },
  )
})

test('Anthropic route sources register Claude base-url /v1 aliases', () => {
  const modelsRouteSource = readFileSync(
    join(root, 'src/main/proxy/routes/models.ts'),
    'utf8',
  )
  const anthropicSource = readFileSync(
    join(root, 'src/main/proxy/routes/anthropic.ts'),
    'utf8',
  )

  assert.match(anthropicSource, /router\.post\('\/v1\/v1\/messages', handleMessages\)/)
  assert.match(modelsRouteSource, /router\.get\('\/v1\/v1\/models', handleListModels\)/)
  assert.match(modelsRouteSource, /router\.get\('\/v1\/v1\/models\/:model', handleGetModel\)/)
})

test('Anthropic session identity prefers stable session headers and hashes the raw value', () => {
  const identity = deriveAnthropicSessionIdentity({
    request: {
      model: 'qwen/Qwen3.7-Max',
      messages: [{ role: 'user', content: 'Hello' }],
    },
    headers: {
      'x-claude-code-session-id': 'claude-session-123',
    },
    clientIP: '127.0.0.1',
  })

  assert.equal(identity.source, 'header')
  assert.match(identity.claudeSessionKey, /^claude:[a-f0-9]{24}$/)
  assert.doesNotMatch(identity.claudeSessionKey, /claude-session-123/)
})

test('Anthropic catalog evidence notices compact-like turns that lost top-level tools', () => {
  const evidence = collectAnthropicCatalogEvidence({
    model: 'qwen/Qwen3.7-Max',
    system: [
      '## Available Tools',
      'Tool `Bash`: Execute shell commands.',
      'JSON schema: {"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}',
      'Tool `Read`: Read files.',
      'JSON schema: {"type":"object","properties":{"file_path":{"type":"string"}},"required":["file_path"]}',
    ].join('\n'),
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'README.md' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'body' },
        ],
      },
    ],
  })

  assert.equal(evidence.topLevelToolCount, 0)
  assert.equal(evidence.hasToolUseHistory, true)
  assert.equal(evidence.hasToolResultHistory, true)
  assert.equal(evidence.hasContractHeaderText, true)
  assert.deepEqual(evidence.contractHeaderAllowedToolNames, ['Bash', 'Read'])
  assert.equal(evidence.compactSuspected, true)
})
