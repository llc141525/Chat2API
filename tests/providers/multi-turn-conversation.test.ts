/**
 * Stub tests for multi-turn conversation fix.
 * Verifies isMultiTurn delta behavior, conversation state cache,
 * and adapter parameter passing for DeepSeek & GLM.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { GLMAdapter, GLMStreamHandler } from '../../src/main/proxy/adapters/glm.ts'
import type { ToolCallingPlan } from '../../src/main/proxy/toolCalling/types.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---- helpers ----

const bashTool = {
  name: 'bash',
  description: 'Run a command',
  parameters: { type: 'object' as const, properties: { command: { type: 'string' } } },
  source: 'openai' as const,
}

function managedPlan(providerId: string): ToolCallingPlan {
  return {
    mode: 'managed',
    protocol: 'managed_xml',
    clientAdapterId: 'standard-openai-tools',
    providerId,
    tools: [bashTool],
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(['bash']),
    forcedToolName: undefined,
    catalogSnapshot: undefined,
    catalogDiagnostics: { source: 'current_request', driftKinds: [], blocked: false },
    availabilityRetryAllowed: false,
    diagnostics: {
      requestId: 'test',
      clientAdapterId: 'standard-openai-tools',
      providerId,
      model: 'test',
      toolSource: 'openai',
      mode: 'managed',
      protocol: 'managed_xml',
      toolCount: 1,
      injected: true,
      reason: 'managed_auto',
      toolChoiceMode: 'auto',
      allowedToolNames: ['bash'],
      catalogSource: 'current_request',
      catalogDriftKinds: [],
      catalogBlocked: false,
    },
  }
}

function sseEvent(data: Record<string, unknown>): string {
  return `event:delta\ndata:${JSON.stringify(data)}\n\n`
}

async function collect(stream: Readable): Promise<string> {
  let output = ''
  for await (const chunk of stream) { output += chunk.toString() }
  return output
}

function mockProvider(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-provider',
    name: 'Test Provider',
    type: 'custom' as const,
    authType: 'token' as const,
    apiEndpoint: '',
    headers: {},
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function mockAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-account',
    providerId: 'test-provider',
    name: 'Test Account',
    credentials: { token: 'test-token' },
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

// Multi-turn message fixtures
const deepseekMultiTurnMessages = [
  { role: 'system' as const, content: 'You are a helpful assistant.' },
  { role: 'user' as const, content: 'What is the weather in Paris?' },
  {
    role: 'assistant' as const,
    content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"curl wttr.in/Paris"}' } }],
  },
  { role: 'tool' as const, tool_call_id: 'call_1', content: 'Sunny, 25C' },
  { role: 'user' as const, content: 'And in London?' },
]

const glmMultiTurnMessages = [
  { role: 'system' as const, content: 'You are a helpful assistant.' },
  { role: 'user' as const, content: 'What is the weather in Paris?' },
  {
    role: 'assistant' as const,
    content: 'Let me check.',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"curl wttr.in/Paris"}' } }],
  },
  { role: 'tool' as const, tool_call_id: 'call_1', content: 'Sunny, 25C' },
  { role: 'user' as const, content: 'And in London?' },
]

const glmProvider = mockProvider({ id: 'glm' })
const account = mockAccount()

// ---- DeepSeek messagesToPrompt ----

test('DeepSeek messagesToPrompt isMultiTurn: source keeps delta path from last assistant tool_call onward', async () => {
    const source = await readFile(join(__dirname, '..', '..', 'src/main/proxy/adapters/deepseek.ts'), 'utf8')

    assert.match(source, /let lastAssistantToolIdx = -1/)
    assert.match(source, /for \(let i = messages\.length - 1; i >= 0; i--\)/)
    assert.match(source, /if \(lastAssistantToolIdx !== -1\)/)
    assert.match(source, /for \(let i = lastAssistantToolIdx; i < processedMessages\.length; i\+\+\)/)
    assert.match(source, /let lastUserIdx = -1/)
    assert.match(source, /if \(lastUserIdx !== -1\)/)
})

test('DeepSeek messagesToPrompt isMultiTurn: source preserves DeepSeek markers for managed history', async () => {
    const source = await readFile(join(__dirname, '..', '..', 'src/main/proxy/adapters/deepseek.ts'), 'utf8')

    assert.match(source, /<｜User｜>/)
    assert.match(source, /formatAssistantToolCalls/)
    assert.match(source, /formatToolResult/)
})

test('DeepSeek messagesToPrompt separates consecutive turns with a blank line', async () => {
    const source = await readFile(join(__dirname, '..', '..', 'src/main/proxy/adapters/deepseek.ts'), 'utf8')

    assert.match(
      source,
      /\.join\('\\n\\n'\)/,
    )
})

// ---- GLM messagesToPrompt isMultiTurn ----

test('GLM messagesToPrompt isMultiTurn: sends delta from last assistant tool_call onward', () => {
    const adapter = new GLMAdapter(glmProvider as any, account as any)
    const result = (adapter as any).messagesToPrompt(glmMultiTurnMessages, [], undefined, true)

    const text = result[0].content.find((c: any) => c.type === 'text')?.text || ''

    assert.match(text, /curl wttr\.in\/Paris/)
    assert.match(text, /Sunny, 25C/)
    assert.match(text, /And in London\?/)

    // Should NOT include first user message
    assert.doesNotMatch(text, /What is the weather in Paris\?/)
})

test('GLM messagesToPrompt isMultiTurn: includes tool prompt when provided', () => {
    const adapter = new GLMAdapter(glmProvider as any, account as any)
    const result = (adapter as any).messagesToPrompt(
      glmMultiTurnMessages, [], '## Available Tools\nTool `bash`', true,
    )

    const text = result[0].content.find((c: any) => c.type === 'text')?.text || ''
    assert.match(text, /## Available Tools/)
    assert.match(text, /Tool `bash`/)
})

test('GLM messagesToPrompt isMultiTurn: sends full history when disabled', () => {
    const adapter = new GLMAdapter(glmProvider as any, account as any)
    const result = (adapter as any).messagesToPrompt(glmMultiTurnMessages, [], undefined, false)

    const text = result[0].content.find((c: any) => c.type === 'text')?.text || ''

    assert.match(text, /What is the weather in Paris\?/)
    assert.match(text, /curl wttr\.in\/Paris/)
    assert.match(text, /Sunny, 25C/)
    assert.match(text, /And in London\?/)
})

test('GLM messagesToPrompt isMultiTurn: without assistant tool_call falls through to full prompt', () => {
    const noToolCallMessages = [
      { role: 'system' as const, content: 'System prompt' },
      { role: 'user' as const, content: 'First question' },
      { role: 'assistant' as const, content: 'First answer' },
      { role: 'user' as const, content: 'Second question' },
    ]

    const adapter = new GLMAdapter(glmProvider as any, account as any)
    const result = (adapter as any).messagesToPrompt(noToolCallMessages, [], undefined, true)

    const text = result[0].content.find((c: any) => c.type === 'text')?.text || ''

    // Falls through to full prompt, so both user messages appear
    assert.match(text, /First question/)
    assert.match(text, /Second question/)
    assert.match(text, /First answer/)
})

test('GLM messagesToPrompt isMultiTurn: excludes system prompt sent before last assistant tool_call', () => {
    // System msg is at index 0, last assistant tool_call at index 2.
    // Delta starts from index 2 — system already in server context, correctly excluded.
    const messagesWithSystem = [
      { role: 'system' as const, content: 'Important context' },
      { role: 'user' as const, content: 'Do something' },
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
      },
    ]

    const adapter = new GLMAdapter(glmProvider as any, account as any)
    const result = (adapter as any).messagesToPrompt(messagesWithSystem, [], undefined, true)

    const text = result[0].content.find((c: any) => c.type === 'text')?.text || ''

    // System before delta range is excluded (server already has it)
    assert.doesNotMatch(text, /Important context/)
    // But the tool call IS included
    assert.match(text, /<\|CHAT2API\|tool_calls>/)
    assert.match(text, /name="bash"/)
})

// ---- GLM conversationId in non-stream response ----

test('GLM non-stream with conversationId: response includes converted native tool_calls when conversationId is set', async () => {
    const nativeToolCall = {
      id: 'call_mt_1',
      type: 'function',
      function: { name: 'bash', arguments: '{"command":"ls"}' },
    }
    const body = [
      sseEvent({
        conversation_id: 'conv-mt-123',
        status: 'streaming',
        parts: [{
          logic_id: 'p1', status: 'streaming',
          content: [
            { type: 'text', text: 'Running command.' },
            { type: 'tool_calls', tool_calls: [nativeToolCall] },
          ],
        }],
      }),
      sseEvent({ conversation_id: 'conv-mt-123', status: 'finish' }),
    ].join('')

    const handler = new GLMStreamHandler('GLM-5.2', undefined, 'conv-mt-123', managedPlan('glm'))
    const result = await handler.handleNonStream(
      Readable.from([gzipSync(Buffer.from(body))]),
      { headers: { 'content-encoding': 'gzip' } } as any,
    )

    assert.match(result.choices[0].message.content, /Running command/)
    assert.match(result.choices[0].message.content, /<\|CHAT2API\|tool_calls>/)
    assert.equal(result.id, 'conv-mt-123')
})

// ---- GLM stream handler preserves conversation_id ----

test('GLM stream handler conversation_id: captures conversation_id and exposes it via getConversationId', async () => {
    const handler = new GLMStreamHandler('GLM-5.2', undefined, undefined, managedPlan('glm'))
    const body = [
      sseEvent({
        conversation_id: 'conv-stream-test',
        status: 'streaming',
        parts: [{ logic_id: 'p1', status: 'finish', content: [{ type: 'text', text: 'Hello' }] }],
      }),
      sseEvent({ conversation_id: 'conv-stream-test', status: 'finish' }),
    ].join('')

    await collect(
      await handler.handleStream(
        Readable.from([gzipSync(Buffer.from(body))]),
        { headers: { 'content-encoding': 'gzip' } } as any,
      ),
    )

    assert.equal(handler.getConversationId(), 'conv-stream-test')
})

test('RequestForwarder conversation state key: source isolates provider conversation state by request session dimension', async () => {
  const source = await readFile(join(__dirname, '..', '..', 'src/main/proxy/forwarder.ts'), 'utf8')

  assert.match(source, /buildProviderConversationStateKey/)
  assert.match(source, /request\.user\.trim\(\)\.length > 0/)
  assert.match(source, /: context\.requestId/)
  assert.match(source, /getProviderConversationState\(/)
  assert.match(source, /setProviderConversationState\(/)
  assert.match(source, /const sessionDimension = typeof context\.providerConversationSessionKey === 'string'/)
  assert.match(source, /return `\$\{provider\.id\}:\$\{account\.id\}:\$\{actualModel\}:\$\{sessionDimension\}`/)
})

test('RequestForwarder source restores provider conversation state from tool session key only for managed tool follow-up turns', async () => {
  const source = await readFile(join(__dirname, '..', '..', 'src/main/proxy/forwarder.ts'), 'utf8')

  assert.match(source, /function hasManagedToolHistory/)
  assert.match(source, /export function getProviderConversationState/)
  assert.match(source, /if \(!input\.fallbackToolSessionKey \|\| !hasManagedToolHistory\(input\.messages\)\)/)
  assert.match(source, /return getConversationState\(input\.fallbackToolSessionKey\)/)
  assert.match(source, /fallbackToolSessionKey: toolSessionKey/)
})

test('RequestForwarder source saves GLM provider conversation state to both primary and tool session keys for tool follow-up turns', async () => {
  const source = await readFile(join(__dirname, '..', '..', 'src/main/proxy/forwarder.ts'), 'utf8')

  assert.match(source, /export function setProviderConversationState/)
  assert.match(source, /setConversationState\(input\.primaryKey, input\.update\)/)
  assert.match(source, /setConversationState\(input\.fallbackToolSessionKey, input\.update\)/)
  assert.match(source, /update: \{ conversationId: convId \}/)
  assert.match(source, /update: \{ parentMessageId: lastMessageId \}/)
})
