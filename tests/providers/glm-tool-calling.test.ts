import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'

import { buildGLMPromptMessagesForTest, GLMStreamHandler } from '../../src/main/proxy/adapters/glm.ts'
import { QwenStreamHandler } from '../../src/main/proxy/adapters/qwen.ts'
import { ToolCallingEngine } from '../../src/main/proxy/toolCalling/ToolCallingEngine.ts'
import { ToolStreamParser } from '../../src/main/proxy/toolCalling/ToolStreamParser.ts'
import { managedXmlProtocol } from '../../src/main/proxy/toolCalling/protocols/managedXml.ts'
import { managedBracketProtocol } from '../../src/main/proxy/toolCalling/protocols/managedBracket.ts'
import { getProviderToolProfile } from '../../src/main/proxy/toolCalling/providerProfiles.ts'
import { hasGeneralToolPromptSignature } from '../../src/main/proxy/constants/signatures.ts'
import type { ToolCallingPlan } from '../../src/main/proxy/toolCalling/types.ts'
import type { ChatCompletionRequest } from '../../src/main/proxy/types.ts'
import type { Provider } from '../../src/main/store/types.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))

const glmProvider: Provider = {
  id: 'glm', name: 'GLM', type: 'builtin', authType: 'userToken',
  apiEndpoint: 'https://chatglm.cn', headers: {}, enabled: true, createdAt: 0, updatedAt: 0,
}

const qwenProvider: Provider = {
  id: 'qwen', name: 'Qwen', type: 'builtin', authType: 'userToken',
  apiEndpoint: 'https://qianwen.com', headers: {}, enabled: true, createdAt: 0, updatedAt: 0,
}

const openCodeTools: ChatCompletionRequest['tools'] = [
  { type: 'function', function: { name: 'default_api:read_file', description: 'Read a file', parameters: { type: 'object', properties: { filePath: { type: 'string' } } } } },
  { type: 'function', function: { name: 'default_api:write_file', description: 'Write a file', parameters: { type: 'object', properties: { filePath: { type: 'string' }, content: { type: 'string' } } } } },
]

function managedPlan(providerId: 'glm' | 'qwen'): ToolCallingPlan {
  return {
    mode: 'managed',
    protocol: 'managed_xml',
    clientAdapterId: 'standard-openai-tools',
    providerId,
    tools: [
      { name: 'default_api:read_file', description: 'Read a file', parameters: {}, source: 'openai' },
    ],
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(['default_api:read_file']),
    diagnostics: {} as any,
  }
}

function bashManagedPlan(providerId: 'glm' | 'qwen'): ToolCallingPlan {
  return {
    mode: 'managed',
    protocol: 'managed_xml',
    clientAdapterId: 'standard-openai-tools',
    providerId,
    tools: [{ name: 'bash', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } }, source: 'openai' }],
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(['bash']),
    diagnostics: {} as any,
  }
}

function collect(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = []
    stream.on('data', (chunk) => chunks.push(String(chunk)))
    stream.once('error', reject)
    stream.once('end', () => resolve(chunks.join('')))
  })
}

function sseEvent(data: unknown, event?: string): string {
  return `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`
}

const managedXmlToolCall = '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>'

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1
}

// ============================================================
// ROOT CAUSE: GLM forwarder BYPASSES ToolCallingEngine
// ============================================================

test('GLM: ToolCallingEngine produces managed_xml plan and injects XML prompt', () => {
  const engine = new ToolCallingEngine()
  const request: ChatCompletionRequest = {
    model: 'GLM-4.7',
    messages: [
      { role: 'system', content: 'You are a coding assistant.' },
      { role: 'user', content: 'Read the file /tmp/a' },
    ],
    tools: openCodeTools as any,
    stream: true,
  }
  const result = engine.transformRequest({ request, provider: glmProvider, actualModel: 'GLM-4.7' })

  assert.equal(result.plan.mode, 'managed')
  assert.equal(result.plan.protocol, 'managed_xml')
  assert.equal(result.plan.shouldInjectPrompt, true)
  assert.equal(result.plan.shouldParseResponse, true)
  assert.equal(result.plan.tools.length, 2)
  assert.equal(result.tools, undefined)
  assert.match(result.messages[0].content as string, /<\|CHAT2API\|tool_calls>/)
})

test('GLM: tool_choice=none disables tool injection and parsing', () => {
  const engine = new ToolCallingEngine()
  const request: ChatCompletionRequest = {
    model: 'GLM-4.7', messages: [{ role: 'user', content: 'Hello' }],
    tools: openCodeTools as any, tool_choice: 'none', stream: true,
  }
  const result = engine.transformRequest({ request, provider: glmProvider, actualModel: 'GLM-4.7' })

  assert.equal(result.plan.mode, 'disabled')
  assert.equal(result.plan.shouldInjectPrompt, false)
  assert.equal(result.plan.shouldParseResponse, false)
})

test('GLM: tool_choice=required enables tool injection', () => {
  const engine = new ToolCallingEngine()
  const request: ChatCompletionRequest = {
    model: 'GLM-4.7', messages: [{ role: 'user', content: 'Read /tmp/a' }],
    tools: openCodeTools as any, tool_choice: 'required', stream: true,
  }
  const result = engine.transformRequest({ request, provider: glmProvider, actualModel: 'GLM-4.7' })

  assert.equal(result.plan.toolChoiceMode, 'required')
  assert.equal(result.plan.mode, 'managed')
  assert.equal(result.plan.shouldInjectPrompt, true)
})

test('GLM adapter moves managed XML tool prompt to the final instruction position', () => {
  const engine = new ToolCallingEngine()
  const request: ChatCompletionRequest = {
    model: 'GLM-5.2',
    messages: [
      { role: 'system', content: 'You are a coding assistant.' },
      { role: 'user', content: 'Read tests/agent-capability/input.txt' },
    ],
    tools: openCodeTools as any,
    stream: true,
  }
  const transformed = engine.transformRequest({ request, provider: glmProvider, actualModel: 'glm-5.2' })
  const promptMessages = buildGLMPromptMessagesForTest(transformed.messages as any)
  const text = promptMessages[0].content.find((item: any) => item.type === 'text')?.text

  assert.equal(promptMessages.length, 1)
  assert.equal(countOccurrences(text, '## Available Tools'), 1)
  assert.equal(countOccurrences(text, '<|CHAT2API|tool_calls>'), 1)
  assert.match(text, /^You are a coding assistant\./)
  assert.match(text, /Read tests\/agent-capability\/input\.txt/)
  // Tools must be placed at the END, after the user message, so the model
  // sees them closest to its generation point (avoids lost-in-the-middle).
  assert.match(text, /Read tests\/agent-capability\/input\.txt[\s\S]*## Available Tools/)
  assert.match(text, /## Available Tools[\s\S]*<\|CHAT2API\|tool_calls>/)
})

test('Qwen: ToolCallingEngine produces managed_xml plan', () => {
  const engine = new ToolCallingEngine()
  const request: ChatCompletionRequest = {
    model: 'Qwen3.6', messages: [{ role: 'user', content: 'Read /tmp/a' }],
    tools: openCodeTools as any, stream: true,
  }
  const result = engine.transformRequest({ request, provider: qwenProvider, actualModel: 'Qwen3.6' })

  assert.equal(result.plan.mode, 'managed')
  assert.equal(result.plan.protocol, 'managed_xml')
  assert.equal(result.plan.shouldInjectPrompt, true)
})

test('Qwen AI: ToolCallingEngine also uses managed_xml plan', () => {
  const engine = new ToolCallingEngine()
  const request: ChatCompletionRequest = {
    model: 'Qwen3.7-Max', messages: [{ role: 'user', content: 'Read /tmp/a' }],
    tools: openCodeTools as any, stream: true,
  }
  const result = engine.transformRequest({
    request,
    provider: { ...qwenProvider, id: 'qwen-ai', name: 'Qwen AI', apiEndpoint: 'https://chat.qwen.ai' },
    actualModel: 'qwen3.7-max',
  })

  assert.equal(result.plan.mode, 'managed')
  assert.equal(result.plan.protocol, 'managed_xml')
  assert.equal(result.plan.shouldInjectPrompt, true)
})

// ============================================================
// FORMAT CONSISTENCY: History, prompt, and parse must match
// ============================================================

test('BUG: GLM provider profile uses managed_xml for history (same as prompt if using ToolCallingEngine)', () => {
  const profile = getProviderToolProfile('glm')
  assert.equal(profile.preferredManagedProtocol, 'managed_xml')

  const xmlHistory = profile.formatAssistantToolCalls([
    { id: 'call_0', name: 'default_api:read_file', arguments: '{"filePath":"/tmp/a"}' },
  ])
  assert.match(xmlHistory, /<\|CHAT2API\|tool_calls>/)
  assert.match(xmlHistory, /<\|CHAT2API\|invoke name="default_api:read_file"/)

  // XML history IS parseable by managed_xml protocol (consistent!)
  const parseResult = managedXmlProtocol.parse(xmlHistory, {
    tools: [{ name: 'default_api:read_file', description: '', parameters: {}, source: 'openai' }],
    protocol: 'managed_xml',
  })
  assert.equal(parseResult.toolCalls.length, 1)
})

test('BUG: managed_xml prompt + managed_xml history + managed_xml parse = consistent format', () => {
  // When ToolCallingEngine injects the prompt and the adapter uses the profile
  // for history, and the stream parser uses the plan's protocol, everything matches
  const prompt = managedXmlProtocol.renderPrompt([
    { name: 'default_api:read_file', description: 'Read', parameters: { type: 'object' }, source: 'openai' },
  ])
  assert.match(prompt, /<\|CHAT2API\|tool_calls>/)

  const history = managedXmlProtocol.formatAssistantToolCalls([
    { id: 'call_0', name: 'default_api:read_file', arguments: '{"filePath":"/tmp/a"}' },
  ])
  assert.match(history, /<\|CHAT2API\|/)

  const parsed = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
    { tools: [{ name: 'default_api:read_file', description: '', parameters: {}, source: 'openai' }], protocol: 'managed_xml' },
  )
  assert.equal(parsed.toolCalls.length, 1)
})

test('managed_xml prompt marks runtime tool catalog as authoritative', () => {
  const prompt = managedXmlProtocol.renderPrompt([{
    name: 'skill',
    description: 'Load a skill',
    parameters: { type: 'object', properties: { name: { type: 'string' } } },
    source: 'openai',
  }])

  assert.match(prompt, /authoritative for the current turn/)
  assert.match(prompt, /Do not claim that a listed tool is unavailable/)
})

test('managed_xml parser repairs singleton array arguments from OpenCode-style tools', () => {
  const parsed = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:todowrite"><|CHAT2API|parameter name="todos"><![CDATA[{"content":"Inspect GLM","status":"in_progress"}]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
    {
      tools: [{
        name: 'default_api:todowrite',
        description: 'Write todos',
        source: 'openai',
        parameters: {
          type: 'object',
          required: ['todos'],
          properties: {
            todos: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  content: { type: 'string' },
                  status: { type: 'string' },
                },
              },
            },
          },
        },
      }],
      protocol: 'managed_xml',
    },
  )

  assert.equal(parsed.toolCalls.length, 1)
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), {
    todos: [{ content: 'Inspect GLM', status: 'in_progress' }],
  })
})

test('managed_xml parser maps description to required prompt when model omits prompt', () => {
  const parsed = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:task"><|CHAT2API|parameter name="description"><![CDATA[Inspect Qwen tool calling]]></|CHAT2API|parameter><|CHAT2API|parameter name="subagent_type"><![CDATA[general]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
    {
      tools: [{
        name: 'default_api:task',
        description: 'Run a task',
        source: 'openai',
        parameters: {
          type: 'object',
          required: ['prompt'],
          properties: {
            prompt: { type: 'string' },
            description: { type: 'string' },
            subagent_type: { type: 'string' },
          },
        },
      }],
      protocol: 'managed_xml',
    },
  )

  assert.equal(parsed.toolCalls.length, 1)
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), {
    description: 'Inspect Qwen tool calling',
    subagent_type: 'general',
    prompt: 'Inspect Qwen tool calling',
  })
})

test('BUG: managed_bracket and managed_xml are different formats - mixing them fails', () => {
  const bracket = managedBracketProtocol.formatAssistantToolCalls([
    { id: 'call_0', name: 'read_file', arguments: '{}' },
  ])
  const xml = managedXmlProtocol.formatAssistantToolCalls([
    { id: 'call_0', name: 'read_file', arguments: '{}' },
  ])
  assert.notEqual(bracket, xml)
  assert.match(bracket, /\[function_calls\]/)
  assert.match(xml, /<\|CHAT2API\|/)

  // Current bug: GLM adapter injects bracket prompt BUT formats history as XML
  // AND the forwarder creates managed_bracket plan for parsing BUT profile says managed_xml
})

// ============================================================
// DOUBLE INJECTION DETECTION: hasToolPromptInjected
// ============================================================

test('GENERAL_TOOL_SIGNATURES detects XML injected prompts', () => {
  const xmlSystemPrompt = managedXmlProtocol.renderPrompt([
    { name: 'default_api:read_file', description: '', parameters: { type: 'object' }, source: 'openai' },
  ])

  // hasGeneralToolPromptSignature checks for '## Available Tools' and
  // 'You can invoke the following developer tools' which are in both formats
  assert.equal(hasGeneralToolPromptSignature(xmlSystemPrompt), true,
    'XML prompt should be detected to prevent double injection')

  // toolsToSystemPrompt (bracket) also contains these signatures
  assert.match(xmlSystemPrompt, /## Available Tools/)
  assert.match(xmlSystemPrompt, /You can invoke the following developer tools/)
})

test('GENERAL_TOOL_SIGNATURES detects bracket injected prompts', () => {
  const bracketSystemPrompt = '[function_calls]\n## Available Tools\nTool definitions:'

  assert.equal(hasGeneralToolPromptSignature(bracketSystemPrompt), true,
    'Bracket prompt should be detected to prevent double injection')
})

test('GLM and Qwen adapters do not inject legacy bracket prompts when forwarder owns tool prompts', async () => {
  const glmSource = await readFile(join(__dirname, '..', '..', 'src/main/proxy/adapters/glm.ts'), 'utf8')
  const qwenSource = await readFile(join(__dirname, '..', '..', 'src/main/proxy/adapters/qwen.ts'), 'utf8')
  const qwenAiSource = await readFile(join(__dirname, '..', '..', 'src/main/proxy/adapters/qwen-ai.ts'), 'utf8')

  // Check for actual import statements (ADR comments list forbidden symbols but are not imports)
  assert.doesNotMatch(glmSource, /^import\s+[^'"\n]*['"][^'\n]*(?:toolsToSystemPrompt|TOOL_WRAP_HINT)/m)
  assert.doesNotMatch(qwenSource, /^import\s+[^'"\n]*['"][^'\n]*(?:toolsToSystemPrompt|TOOL_WRAP_HINT|shouldInjectToolPrompt)/m)
  assert.doesNotMatch(qwenAiSource, /## Available Tools|\[function_calls\]|\[call:TOOL_NAME\]/)
  assert.match(qwenAiSource, /getProviderToolProfile\('qwen-ai'\)/)
  assert.match(qwenAiSource, /formatAssistantToolCalls/)
  assert.match(qwenAiSource, /formatToolResult/)
})

test('managed_xml prompt explicitly tells models to include required schema parameters', () => {
  const prompt = managedXmlProtocol.renderPrompt([{
    name: 'default_api:task',
    description: 'Run task',
    source: 'openai',
    parameters: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: { type: 'string' },
        description: { type: 'string' },
      },
    },
  }])

  assert.match(prompt, /Include ALL required parameters/)
  assert.match(prompt, /Required parameters: prompt/)
  assert.match(prompt, /"prompt"/)
})

// ============================================================
// STREAM PARSER: ToolStreamParser integration tests
// ============================================================

test('ToolStreamParser managed_xml: intercepts and emits tool_calls delta', () => {
  const plan: ToolCallingPlan = {
    mode: 'managed', protocol: 'managed_xml', clientAdapterId: 'standard-openai-tools',
    providerId: 'glm',
    tools: [{ name: 'default_api:read_file', description: '', parameters: {}, source: 'openai' }],
    shouldInjectPrompt: true, shouldParseResponse: true, toolChoiceMode: 'auto',
    allowedToolNames: new Set(['default_api:read_file']), diagnostics: {} as any,
  }
  const parser = new ToolStreamParser(plan)
  const base = { id: 'test', model: 'test', object: 'chat.completion.chunk', created: 1 }

  // Feed normal text first
  const before = parser.push('Some text\n', base, true)
  assert.equal(before.length, 1)
  assert.equal(before[0].choices[0].delta.content, 'Some text\n')

  // Feed complete XML tool call block
  const result = parser.push(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
    base, false,
  )
  const hasToolCall = result.some((c: any) => c.choices?.[0]?.delta?.tool_calls)
  assert.ok(hasToolCall, 'Should emit tool_calls for managed_xml format')
})

test('ToolStreamParser managed_bracket: intercepts and emits tool_calls delta', () => {
  const plan: ToolCallingPlan = {
    mode: 'managed', protocol: 'managed_bracket', clientAdapterId: 'standard-openai-tools',
    providerId: 'glm',
    tools: [{ name: 'default_api:read_file', description: '', parameters: {}, source: 'openai' }],
    shouldInjectPrompt: true, shouldParseResponse: true, toolChoiceMode: 'auto',
    allowedToolNames: new Set(['default_api:read_file']), diagnostics: {} as any,
  }
  const parser = new ToolStreamParser(plan)
  const base = { id: 'test', model: 'test', object: 'chat.completion.chunk', created: 1 }

  parser.push('Before\n', base, true)

  const result = parser.push('[function_calls]\n[call:default_api:read_file]{"filePath":"/tmp/a"}[/call]\n[/function_calls]', base, false)
  const hasToolCall = result.some((c: any) => c.choices?.[0]?.delta?.tool_calls)
  assert.ok(hasToolCall, 'Should emit tool_calls for managed_bracket format')
})

test('GLM stream decodes gzip SSE and emits managed XML as OpenAI tool_calls', async () => {
  const handler = new GLMStreamHandler('GLM-5.2', undefined, undefined, managedPlan('glm'))
  const body = [
    sseEvent({
      conversation_id: 'glm-conv-1',
      status: 'streaming',
      parts: [{
        logic_id: 'part-1',
        status: 'streaming',
        content: [{ type: 'text', text: managedXmlToolCall }],
      }],
    }),
    sseEvent({ conversation_id: 'glm-conv-1', status: 'finish' }),
  ].join('')

  const output = await collect(await handler.handleStream(
    Readable.from([gzipSync(Buffer.from(body))]),
    { headers: { 'content-encoding': 'gzip' } } as any,
  ))

  assert.match(output, /"tool_calls"/)
  assert.match(output, /"name":"default_api:read_file"/)
  assert.match(output, /"finish_reason":"tool_calls"/)
  assert.equal((output.match(/data: \[DONE\]/g) || []).length, 1)
})

test('GLM non-stream leaves managed XML for ToolCallingEngine to convert', async () => {
  const handler = new GLMStreamHandler('GLM-5.2', undefined, undefined, managedPlan('glm'))
  const body = [
    sseEvent({
      conversation_id: 'glm-conv-ns-1',
      status: 'streaming',
      parts: [{
        logic_id: 'part-ns-1',
        status: 'streaming',
        content: [{ type: 'text', text: managedXmlToolCall }],
      }],
    }),
    sseEvent({ conversation_id: 'glm-conv-ns-1', status: 'finish' }),
  ].join('')

  const result = await handler.handleNonStream(
    Readable.from([gzipSync(Buffer.from(body))]),
    { headers: { 'content-encoding': 'gzip' } } as any,
  )

  const initialMessage = result.choices?.[0]?.message
  assert.equal(initialMessage?.tool_calls, undefined)
  assert.equal(result.choices?.[0]?.finish_reason, 'stop')
  assert.match(initialMessage?.content, /<\|CHAT2API\|tool_calls>/)

  // Apply ToolCallingEngine parsing
  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: {
      model: 'GLM-5.2',
      messages: [{ role: 'user', content: 'Read /tmp/a' }],
      tools: openCodeTools as any,
      stream: false,
    },
    provider: glmProvider,
    actualModel: 'GLM-5.2',
  })
  engine.applyNonStreamResponse(result, transformed.plan)

  assert.equal(result.choices[0].message.content, null)
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'default_api:read_file')
  assert.equal(result.choices[0].finish_reason, 'tool_calls')
})

test('Qwen stream emits managed XML as OpenAI tool_calls', async () => {
  const handler = new QwenStreamHandler('Qwen3-Max', undefined, managedPlan('qwen'))
  const output = await collect(handler.handleStream(Readable.from([
    sseEvent({
      communication: { sessionid: 'qwen-session-1', reqid: 'qwen-req-1' },
      data: {
        messages: [{
          mime_type: 'multi_load/iframe',
          content: managedXmlToolCall,
          status: 'complete',
          meta_data: {},
        }],
      },
    }),
  ])))

  assert.match(output, /"tool_calls"/)
  assert.match(output, /"name":"default_api:read_file"/)
  assert.match(output, /"finish_reason":"tool_calls"/)
  assert.doesNotMatch(output, /<\|CHAT2API\|tool_calls>/)
})

test('Qwen non-stream leaves managed XML for ToolCallingEngine to convert', async () => {
  const handler = new QwenStreamHandler('Qwen3-Max', undefined, managedPlan('qwen'))
  const result = await handler.handleNonStream(Readable.from([
    sseEvent({
      communication: { sessionid: 'qwen-session-1', reqid: 'qwen-req-1' },
      data: {
        messages: [{
          mime_type: 'multi_load/iframe',
          content: managedXmlToolCall,
          status: 'complete',
          meta_data: {},
        }],
      },
    }),
  ]))

  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: {
      model: 'Qwen3-Max',
      messages: [{ role: 'user', content: 'Read /tmp/a' }],
      tools: openCodeTools as any,
      stream: false,
    },
    provider: qwenProvider,
    actualModel: 'Qwen3-Max',
  })
  engine.applyNonStreamResponse(result, transformed.plan)

  assert.equal(result.choices[0].message.content, null)
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'default_api:read_file')
  assert.equal(result.choices[0].finish_reason, 'tool_calls')
})

// ============================================================
// FORWARDER INTEGRATION: Multi-turn tool calls
// ============================================================

test('INTEGRATION: OpenCode multi-turn tool call messages through ToolCallingEngine', () => {
  const engine = new ToolCallingEngine()
  const request: ChatCompletionRequest = {
    model: 'GLM-4.7',
    messages: [
      { role: 'system', content: 'You are a coding assistant.' },
      { role: 'user', content: 'Read /tmp/a and /tmp/b' },
      {
        role: 'assistant', content: null,
        tool_calls: [
          { id: 'call_0', type: 'function', function: { name: 'default_api:read_file', arguments: '{"filePath":"/tmp/a"}' } },
          { id: 'call_1', type: 'function', function: { name: 'default_api:read_file', arguments: '{"filePath":"/tmp/b"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_0', content: 'content of a' },
      { role: 'tool', tool_call_id: 'call_1', content: 'content of b' },
    ],
    tools: openCodeTools as any, stream: true,
  }
  const result = engine.transformRequest({ request, provider: glmProvider, actualModel: 'GLM-4.7' })

  assert.equal(result.plan.protocol, 'managed_xml')
  assert.match(result.messages[0].content as string, /<\|CHAT2API\|tool_calls>/)

  // Assistant message with tool_calls is preserved in original OpenAI format
  // The adapter is responsible for converting these to the provider's format (XML)
  assert.equal(result.messages[2].role, 'assistant')
  assert.ok(Array.isArray(result.messages[2].tool_calls))
  assert.equal((result.messages[2] as any).tool_calls.length, 2)
})

// ============================================================
// FORWARDER CODE ANALYSIS: Bug documentation
// ============================================================

test('FIX: forwardGLM now uses transformRequestForPromptToolUse', async () => {
  const src = await readFile(join(__dirname, '..', '..', 'src/main/proxy/forwarder.ts'), 'utf8')

  const mStart = src.indexOf('private async forwardGLM(')
  const mEnd = src.indexOf('private async forwardKimi(')
  assert.ok(mStart >= 0 && mEnd > mStart)

  const glmMethod = src.slice(mStart, mEnd)

  // FIXED: now uses transformRequestForPromptToolUse like DeepSeek and Kimi
  assert.match(glmMethod, /transformRequestForPromptToolUse/,
    'FIXED: forwardGLM now calls transformRequestForPromptToolUse')

  // FIXED: passes transformed messages (not raw request.messages)
  assert.match(glmMethod, /transformed\.messages|transformedRequest\.messages/,
    'FIXED: forwardGLM passes transformed messages')

  // FIXED: uses transformed.plan (managed_xml) instead of managed_bracket
  assert.match(glmMethod, /transformed\.plan/,
    'FIXED: forwardGLM uses transformed.plan (consistent managed_xml)')

  // FIXED: no more manual managed_bracket plan
  assert.doesNotMatch(glmMethod, /managed_bracket/,
    'FIXED: no manual managed_bracket plan anymore')

  // FIXED: applies tool calls to non-stream response
  assert.match(glmMethod, /applyToolCallsToResponse/,
    'FIXED: applies ToolCallingEngine tool parsing for non-stream responses')
})

test('QWEN: forwardQwen correctly uses transformRequestForPromptToolUse', async () => {
  const src = await readFile(join(__dirname, '..', '..', 'src/main/proxy/forwarder.ts'), 'utf8')

  const mStart = src.indexOf('private async forwardQwen(')
  const mEnd = src.indexOf('private async forwardQwenAi(')
  assert.ok(mStart >= 0 && mEnd > mStart)

  const qwenMethod = src.slice(mStart, mEnd)

  assert.match(qwenMethod, /transformRequestForPromptToolUse/,
    'Qwen correctly uses transformRequestForPromptToolUse')

  assert.match(qwenMethod, /applyToolCallsToResponse/,
    'Qwen applies tool calls to non-stream response')
})

test('QWEN: adapter sends raw latest user text as ori_query for intent routing', async () => {
  const src = await readFile(join(__dirname, '..', '..', 'src/main/proxy/adapters/qwen.ts'), 'utf8')

  assert.match(src, /const lastUserText = extractLastUserText\(request\.messages\)/)
  assert.match(src, /ori_query: lastUserText \|\| userContent \|\| finalContent/)
  assert.doesNotMatch(src, /ori_query: finalContent/)
})

test('FIX: forwardGLM passes Axios response to GLM stream handler for content decoding', async () => {
  const src = await readFile(join(__dirname, '..', '..', 'src/main/proxy/forwarder.ts'), 'utf8')

  const mStart = src.indexOf('private async forwardGLM(')
  const mEnd = src.indexOf('private async forwardKimi(')
  assert.ok(mStart >= 0 && mEnd > mStart)

  const glmMethod = src.slice(mStart, mEnd)

  assert.match(glmMethod, /handler\.handleStream\(response\.data,\s*response\)/,
    'GLM streaming must pass response so content-encoding can be decoded')
  assert.match(glmMethod, /handler\.handleNonStream\(response\.data,\s*response\)/,
    'GLM non-streaming must pass response so content-encoding can be decoded')
})

test('DEEPSEEK: forwardDeepSeek uses transformRequestForPromptToolUse (reference pattern)', async () => {
  const src = await readFile(join(__dirname, '..', '..', 'src/main/proxy/forwarder.ts'), 'utf8')

  const mStart = src.indexOf('private async forwardDeepSeek(')
  const mEnd = src.indexOf('private async forwardGLM(')
  assert.ok(mStart >= 0 && mEnd > mStart)

  const dsMethod = src.slice(mStart, mEnd)

  assert.match(dsMethod, /transformRequestForPromptToolUse/,
    'DeepSeek uses transformRequestForPromptToolUse (correct pattern)')

  assert.match(dsMethod, /transformed\.plan/,
    'DeepSeek passes transformed.plan to stream handler')
})

// ============================================================
// Non-stream tool call application
// ============================================================

test('applyNonStreamResponse: parses managed_xml tool calls and sets finish_reason', () => {
  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: {
      model: 'GLM-4.7', messages: [{ role: 'user', content: 'Read /tmp/a' }],
      tools: openCodeTools as any, stream: false,
    },
    provider: glmProvider, actualModel: 'GLM-4.7',
  })

  const result: any = {
    choices: [{
      message: {
        role: 'assistant',
        content: '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
      },
      finish_reason: 'stop',
    }],
  }

  engine.applyNonStreamResponse(result, transformed.plan)

  assert.equal(result.choices[0].message.content, null)
  assert.ok(Array.isArray(result.choices[0].message.tool_calls))
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'default_api:read_file')
  assert.equal(result.choices[0].finish_reason, 'tool_calls')
})

test('applyNonStreamResponse: ignores bracket tool calls when plan expects managed_xml', () => {
  // The parser is protocol-specific: managed_xml does NOT parse bracket format
  // This is why format consistency matters - if the model outputs bracket format
  // but the plan expects XML, tool calls are lost
  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: {
      model: 'GLM-4.7', messages: [{ role: 'user', content: 'Read /tmp/a' }],
      tools: openCodeTools as any, stream: false,
    },
    provider: glmProvider, actualModel: 'GLM-4.7',
  })

  const result: any = {
    choices: [{
      message: {
        role: 'assistant',
        content: '[function_calls][call:default_api:read_file]{"filePath":"/tmp/a"}[/call][/function_calls]',
      },
      finish_reason: 'stop',
    }],
  }

  engine.applyNonStreamResponse(result, transformed.plan)

  // managed_xml parser does NOT parse bracket format → tool calls are lost
  assert.equal(result.choices[0].message.tool_calls, undefined)
  assert.match(result.choices[0].message.content, /\[function_calls\]/)
  assert.equal(result.choices[0].finish_reason, 'stop')
})

// ── Standalone <|CHAT2API|invoke> (no outer <|CHAT2API|tool_calls> wrapper) ──

const standaloneInvokeXml =
  '<|CHAT2API|invoke name="bash"><|CHAT2API|parameter name="command"><![CDATA[ls -la]]></|CHAT2API|parameter></|CHAT2API|invoke>'

const standaloneInvokeWithPreamble =
  'I will run the command.\n\n<|CHAT2API|invoke name="bash"><|CHAT2API|parameter name="command"><![CDATA[ls -la]]></|CHAT2API|parameter></|CHAT2API|invoke>'

test('managedXmlProtocol.parse handles standalone <|CHAT2API|invoke> without outer wrapper', () => {
  const parsed = managedXmlProtocol.parse(standaloneInvokeXml, {
    tools: [{ name: 'bash', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } }, source: 'openai' }],
    protocol: 'managed_xml',
  })

  assert.equal(parsed.toolCalls.length, 1)
  assert.equal(parsed.toolCalls[0].function.name, 'bash')
  const args = JSON.parse(parsed.toolCalls[0].function.arguments)
  assert.equal(args.command, 'ls -la')
  assert.match(parsed.protocol, /managed_xml/)
})

test('managedXmlProtocol.parse handles standalone invoke with preamble text', () => {
  const parsed = managedXmlProtocol.parse(standaloneInvokeWithPreamble, {
    tools: [{ name: 'bash', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } }, source: 'openai' }],
    protocol: 'managed_xml',
  })

  assert.equal(parsed.toolCalls.length, 1)
  assert.equal(parsed.toolCalls[0].function.name, 'bash')
  assert.match(parsed.content, /I will run the command/)
})

test('managedXmlProtocol.parse rejects standalone invoke with unknown tool name', () => {
  const parsed = managedXmlProtocol.parse(
    '<|CHAT2API|invoke name="unknown_tool"><|CHAT2API|parameter name="x"><![CDATA[1]]></|CHAT2API|parameter></|CHAT2API|invoke>',
    {
      tools: [{ name: 'bash', description: 'Run a command', parameters: {}, source: 'openai' }],
      protocol: 'managed_xml',
    },
  )

  assert.equal(parsed.toolCalls.length, 0)
  assert.ok(parsed.invalidToolNames.includes('unknown_tool'))
})

test('detectStart matches standalone <|CHAT2API|invoke> as a marker', () => {
  const result = managedXmlProtocol.detectStart('<|CHAT2API|invoke name="bash">')
  assert.ok(result.matched)
  assert.equal(result.markerStart, 0)
})

test('detectStart matches standalone <|CHAT2API|invoke> when preceded by text', () => {
  const result = managedXmlProtocol.detectStart('Some text here.\n<|CHAT2API|invoke name="read">')
  assert.ok(result.matched)
  assert.equal(result.markerStart, 16) // after "Some text here.\n"
})

test('detectStart partial-matches <|CHAT2API|inv prefix', () => {
  const result = managedXmlProtocol.detectStart('<|CHAT2API|inv')
  assert.ok(result.partial)
})

test('GLM stream emits standalone <|CHAT2API|invoke> as OpenAI tool_calls', async () => {
  const handler = new GLMStreamHandler('GLM-5.2', undefined, undefined, bashManagedPlan('glm'))
  const body = [
    sseEvent({
      conversation_id: 'glm-standalone-1',
      status: 'streaming',
      parts: [{
        logic_id: 'part-1',
        status: 'streaming',
        content: [{ type: 'text', text: standaloneInvokeXml }],
      }],
    }),
    sseEvent({ conversation_id: 'glm-standalone-1', status: 'finish' }),
  ].join('')

  const output = await collect(await handler.handleStream(
    Readable.from([gzipSync(Buffer.from(body))]),
    { headers: { 'content-encoding': 'gzip' } } as any,
  ))

  assert.match(output, /"tool_calls"/)
  assert.match(output, /"name":"bash"/)
  assert.match(output, /"finish_reason":"tool_calls"/)
  assert.equal((output.match(/data: \[DONE\]/g) || []).length, 1)
  // Must NOT leak raw XML to client
  assert.doesNotMatch(output, /<\|CHAT2API\|invoke/)
})

test('GLM stream emits standalone invoke with preamble text correctly', async () => {
  const handler = new GLMStreamHandler('GLM-5.2', undefined, undefined, bashManagedPlan('glm'))
  const body = [
    sseEvent({
      conversation_id: 'glm-standalone-2',
      status: 'streaming',
      parts: [{
        logic_id: 'part-1',
        status: 'streaming',
        content: [{ type: 'text', text: standaloneInvokeWithPreamble }],
      }],
    }),
    sseEvent({ conversation_id: 'glm-standalone-2', status: 'finish' }),
  ].join('')

  const output = await collect(await handler.handleStream(
    Readable.from([gzipSync(Buffer.from(body))]),
    { headers: { 'content-encoding': 'gzip' } } as any,
  ))

  // Should output preamble text before tool call
  assert.match(output, /I will run the command/)
  // Should output tool call
  assert.match(output, /"tool_calls"/)
  assert.match(output, /"name":"bash"/)
  assert.doesNotMatch(output, /<\|CHAT2API\|invoke/)
})

test('standalone invoke with invalid tool name is silently dropped', async () => {
  const handler = new GLMStreamHandler('GLM-5.2', undefined, undefined, bashManagedPlan('glm'))
  const invalidXml = '<|CHAT2API|invoke name="nonexistent"><|CHAT2API|parameter name="x"><![CDATA[1]]></|CHAT2API|parameter></|CHAT2API|invoke>'
  const body = [
    sseEvent({
      conversation_id: 'glm-standalone-3',
      status: 'streaming',
      parts: [{
        logic_id: 'part-1',
        status: 'streaming',
        content: [{ type: 'text', text: invalidXml }],
      }],
    }),
    sseEvent({ conversation_id: 'glm-standalone-3', status: 'finish' }),
  ].join('')

  const output = await collect(await handler.handleStream(
    Readable.from([gzipSync(Buffer.from(body))]),
    { headers: { 'content-encoding': 'gzip' } } as any,
  ))

  // Invalid tool name → no tool_calls emitted, xml consumed silently
  assert.doesNotMatch(output, /"tool_calls"/)
  assert.doesNotMatch(output, /<\|CHAT2API\|invoke/)
  assert.match(output, /"finish_reason":"stop"/)
})
