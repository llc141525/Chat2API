import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { DeepSeekStreamHandler } from '../../../src/main/proxy/adapters/deepseek-stream.ts'
import { ToolCallingEngine } from '../../../src/main/proxy/toolCalling/ToolCallingEngine.ts'
import type { ChatCompletionRequest } from '../../../src/main/proxy/types.ts'
import type { Provider } from '../../../src/main/store/types.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))

const provider: Provider = {
  id: 'deepseek',
  name: 'DeepSeek',
  type: 'builtin',
  authType: 'userToken',
  apiEndpoint: 'https://chat.deepseek.com',
  headers: {},
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
}

const tool = {
  type: 'function' as const,
  function: {
    name: 'bash',
    description: 'Execute a shell command',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
      },
      required: ['command'],
    },
  },
}

function makeEngine(): ToolCallingEngine {
  return new ToolCallingEngine({
    enabled: true,
    mode: 'force',
    clientAdapterId: 'standard-openai-tools',
    diagnosticsEnabled: false,
    advanced: { promptPreviewEnabled: false },
  })
}

function sseEvent(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function sse(...payloads: Record<string, unknown>[]): Readable {
  return Readable.from([
    ...payloads.map((payload) => sseEvent(payload)),
    'data: [DONE]\n\n',
  ])
}

const TOOL_XML =
  '<|CHAT2API|tool_calls><|CHAT2API|invoke name="bash">' +
  '<|CHAT2API|parameter name="command"><![CDATA[echo Paris]]></|CHAT2API|parameter>' +
  '</|CHAT2API|invoke></|CHAT2API|tool_calls>'

test('DeepSeek multi-turn integration preserves session catalog and assistant reply after tool result', async () => {
  const engine = makeEngine()
  const toolSessionKey = 'deepseek-multi-turn'

  const firstTurnRequest: ChatCompletionRequest = {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'Check Paris weather with bash.' }],
    tools: [tool],
    stream: false,
  }

  const firstTurn = engine.transformRequest({
    request: firstTurnRequest,
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey,
  })

  const firstHandler = new DeepSeekStreamHandler(
    'deepseek-chat',
    'session-turn-1',
    undefined,
    false,
    undefined,
    firstTurn.plan,
  )

  const firstResponse = await firstHandler.handleNonStream(sse({
    response_message_id: 'msg-turn-1',
    v: {
      response: {
        thinking_enabled: false,
        fragments: [{ type: 'RESPONSE', content: TOOL_XML }],
      },
    },
  }))

  const retry = engine.applyNonStreamResponse(firstResponse, firstTurn.plan)
  assert.equal(retry, undefined)

  const toolCallMessage = firstResponse.choices[0].message
  assert.equal(firstResponse.choices[0].finish_reason, 'tool_calls')
  assert.ok(toolCallMessage.content == null)
  assert.equal(toolCallMessage.tool_calls?.[0]?.function?.name, 'bash')

  const secondTurnRequest: ChatCompletionRequest = {
    model: 'deepseek-chat',
    stream: false,
    messages: [
      { role: 'user', content: 'Check Paris weather with bash.' },
      toolCallMessage,
      { role: 'tool', tool_call_id: toolCallMessage.tool_calls[0].id, content: 'Paris: sunny, 25C' },
      { role: 'user', content: 'And in London?' },
    ],
  }

  const secondTurn = engine.transformRequest({
    request: secondTurnRequest,
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey,
  })

  assert.equal(secondTurn.plan.catalogDiagnostics.source, 'session_catalog')
  assert.equal(
    secondTurn.plan.catalogSnapshot?.fingerprint,
    firstTurn.plan.catalogSnapshot?.fingerprint,
  )

  const deepseekSource = await readFile(
    join(__dirname, '..', '..', '..', 'src/main/proxy/adapters/deepseek.ts'),
    'utf8',
  )

  assert.match(deepseekSource, /if \(isMultiTurn\)/)
  assert.match(deepseekSource, /if \(lastAssistantToolIdx !== -1\)/)
  assert.match(deepseekSource, /parts\.push\(processedMessages\[i\]\.text\)/)
  assert.match(deepseekSource, /return `<｜User｜>\$\{parts\.join\('\\n\\n'\)\}`/)
  assert.match(deepseekSource, /text \+= `\\n\\n\$\{processedMessages\[i\]\.text\}`/)

  const secondHandler = new DeepSeekStreamHandler(
    'deepseek-chat',
    'session-turn-2',
    undefined,
    false,
    undefined,
    secondTurn.plan,
  )

  const secondResponse = await secondHandler.handleNonStream(sse({
    response_message_id: 'msg-turn-2',
    v: {
      response: {
        thinking_enabled: false,
        fragments: [{ type: 'RESPONSE', content: 'London is cloudy, 19C.' }],
      },
    },
  }))

  const secondRetry = engine.applyNonStreamResponse(secondResponse, secondTurn.plan)
  assert.equal(secondRetry, undefined)
  assert.equal(secondResponse.choices[0].finish_reason, 'stop')
  assert.equal(secondResponse.choices[0].message.tool_calls, undefined)
  assert.equal(secondResponse.choices[0].message.content, 'London is cloudy, 19C.')
})
