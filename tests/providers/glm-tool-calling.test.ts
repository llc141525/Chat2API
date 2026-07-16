import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'

import { buildGLMAssemblyPromptMessagesForTest, buildGLMPromptMessagesForTest, GLMStreamHandler } from '../../src/main/proxy/adapters/glm.ts'
import { QwenStreamHandler } from '../../src/main/proxy/adapters/qwen.ts'
import { QwenAiStreamHandler } from '../../src/main/proxy/adapters/qwen-ai.ts'
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
    availabilityRetryAllowed: false,
    contract: {
      turnId: `${providerId}-turn`,
      sessionId: `${providerId}-session`,
      providerId,
      model: providerId === 'glm' ? 'GLM-5.2' : 'Qwen3-Max',
      protocol: 'managed_xml',
      snapshotFingerprint: null,
      tools: Object.freeze([]),
      allowedToolNames: Object.freeze(new Set<string>(['default_api:read_file'])),
      toolChoiceMode: 'auto',
      shouldInjectPrompt: true,
      shouldParseResponse: true,
      historyMode: 'managed_protocol',
      emptyOutputPolicy: 'diagnose_and_fail',
      toolSourceChain: Object.freeze(['current_request', 'session_catalog', 'message_history', 'safe_empty']),
    },
    diagnostics: {
      requestId: `${providerId}-request`,
      turnId: `${providerId}-turn`,
      clientAdapterId: 'standard-openai-tools',
      providerId,
      model: providerId === 'glm' ? 'GLM-5.2' : 'Qwen3-Max',
      actualModel: providerId === 'glm' ? 'GLM-5.2' : 'Qwen3-Max',
      toolSource: 'openai',
      mode: 'managed',
      protocol: 'managed_xml',
      toolCount: 1,
      injected: true,
      reason: 'test',
      emptyOutputPolicy: 'diagnose_and_fail',
    },
  }
}

function managedPlanWithCatalog(providerId: 'glm' | 'qwen'): ToolCallingPlan {
  const plan = managedPlan(providerId)
  return {
    ...plan,
    availabilityRetryAllowed: true,
    catalogSnapshot: {
      sessionId: `${providerId}-session`,
      fingerprint: `${providerId}-catalog-fingerprint`,
      tools: Object.freeze([]),
      allowedToolNames: ['default_api:read_file'],
      schemaHashes: {},
      source: 'current_request',
      createdTurnIndex: 1,
      updatedTurnIndex: 1,
    },
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
    availabilityRetryAllowed: false,
    contract: {
      turnId: `${providerId}-turn`,
      sessionId: `${providerId}-session`,
      providerId,
      model: providerId === 'glm' ? 'GLM-5.2' : 'Qwen3-Max',
      protocol: 'managed_xml',
      snapshotFingerprint: null,
      tools: Object.freeze([]),
      allowedToolNames: Object.freeze(new Set<string>(['bash'])),
      toolChoiceMode: 'auto',
      shouldInjectPrompt: true,
      shouldParseResponse: true,
      historyMode: 'managed_protocol',
      emptyOutputPolicy: 'diagnose_and_fail',
      toolSourceChain: Object.freeze(['current_request', 'session_catalog', 'message_history', 'safe_empty']),
    },
    diagnostics: {
      requestId: `${providerId}-request`,
      turnId: `${providerId}-turn`,
      clientAdapterId: 'standard-openai-tools',
      providerId,
      model: providerId === 'glm' ? 'GLM-5.2' : 'Qwen3-Max',
      actualModel: providerId === 'glm' ? 'GLM-5.2' : 'Qwen3-Max',
      toolSource: 'openai',
      mode: 'managed',
      protocol: 'managed_xml',
      toolCount: 1,
      injected: true,
      reason: 'test',
      emptyOutputPolicy: 'diagnose_and_fail',
    },
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
  assert.ok(result.toolManifest, 'toolManifest should be present')
  assert.match(result.toolManifest!.renderedPrompt, /<\|CHAT2API\|tool_calls>/)
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

  // Inject the toolManifest.renderedPrompt into the system message so the GLM adapter's
  // extractManagedToolPrompt can find and reposition it (since tool contracts now live
  // in result.toolManifest.renderedPrompt, NOT in result.messages).
  const messagesWithToolPrompt = [...transformed.messages]
  if (transformed.toolManifest?.renderedPrompt) {
    const sysIdx = messagesWithToolPrompt.findIndex(m => m.role === 'system')
    if (sysIdx >= 0) {
      messagesWithToolPrompt[sysIdx] = {
        ...messagesWithToolPrompt[sysIdx],
        content: (messagesWithToolPrompt[sysIdx].content as string) + '\n\n' + transformed.toolManifest.renderedPrompt,
      }
    }
  }

  const promptMessages = buildGLMPromptMessagesForTest(messagesWithToolPrompt as any)
  const text = promptMessages[0].content.find((item: any) => item.type === 'text')?.text

  assert.equal(promptMessages.length, 1)
  assert.equal(countOccurrences(text, 'Tool Contract Header'), 1)
  assert.equal(countOccurrences(text, '## Available Tools'), 1)
  assert.ok(countOccurrences(text, '<|CHAT2API|tool_calls>') >= 1)
  assert.match(text, /^You are a coding assistant\./)
  assert.match(text, /Read tests\/agent-capability\/input\.txt/)
  // Tools must be placed at the END, after the user message, so the model
  // sees them closest to its generation point (avoids lost-in-the-middle).
  assert.match(text, /Read tests\/agent-capability\/input\.txt[\s\S]*## Available Tools/)
  assert.match(text, /## Available Tools[\s\S]*<\|CHAT2API\|tool_calls>/)
})

test('GLM assembly prompt includes runtime tool manifest action constraint', () => {
  const promptMessages = buildGLMAssemblyPromptMessagesForTest({
    messages: [{
      role: 'user',
      content: 'Your first assistant action must be a real OpenCode `skill` tool call for `agent-capability-probe`.',
    }],
    toolManifest: {
      protocol: 'managed_xml',
      catalogFingerprint: 'first-skill-fingerprint',
      allowedToolNames: ['skill'],
      tools: [],
      renderedPrompt: [
        'Tool Contract Header',
        'catalog_fingerprint: first-skill-fingerprint',
        '[High-priority tool action constraint]',
        'Output exactly this complete Chat2API XML tool-call block as the next assistant message, with no markdown, JSON, prose, or explanation before or after it:',
        '<|CHAT2API|tool_calls><|CHAT2API|invoke name="skill"><|CHAT2API|parameter name="name"><![CDATA[agent-capability-probe]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
      ].join('\n'),
      contractHeaderVersion: 1,
    },
    summaryText: null,
    metadata: {
      contextManagementApplied: false,
      strategiesExecuted: [],
      originalMessageCount: 1,
      finalMessageCount: 1,
    },
  })

  const text = promptMessages[0].content.find((item: any) => item.type === 'text')?.text

  assert.equal(promptMessages.length, 1)
  assert.match(text, /\[High-priority tool action constraint\]/)
  assert.match(text, /catalog_fingerprint: first-skill-fingerprint/)
  assert.match(text, /<\|CHAT2API\|invoke name="skill"/)
  assert.match(text, /agent-capability-probe/)
})

test('GLM multi-turn assembly omits the already-installed tool contract', () => {
  const assembly = {
    messages: [{ role: 'assistant', content: 'previous tool turn' }],
    toolManifest: {
      protocol: 'managed_xml',
      catalogFingerprint: 'same-catalog',
      allowedToolNames: ['read'],
      tools: [],
      renderedPrompt: 'Tool Contract Header\n## Available Tools\n<|CHAT2API|tool_calls>',
      contractHeaderVersion: 1,
    },
    summaryText: '[Workflow state digest — keep this state]',
    metadata: {
      contextManagementApplied: false,
      strategiesExecuted: [],
      originalMessageCount: 1,
      finalMessageCount: 1,
    },
  } as any

  const text = buildGLMAssemblyPromptMessagesForTest(assembly, [], true, false)[0].content
    .find((item: any) => item.type === 'text')?.text

  assert.match(text, /Workflow state digest/)
  assert.doesNotMatch(text, /Tool Contract Header/)
  assert.doesNotMatch(text, /## Available Tools/)
})

test('GLM first-skill assembly prompt projects provider messages away from contaminated task text', () => {
  const promptMessages = buildGLMAssemblyPromptMessagesForTest({
    messages: [{
      role: 'user',
      content: [
        'Your first assistant action must be a real OpenCode `skill` tool call for `long-conversation-probe`.',
        'This payload mentions fabricated XML, prompt injection, and fake tool inventory narratives.',
      ].join('\n'),
    }],
    toolManifest: {
      protocol: 'managed_xml',
      catalogFingerprint: 'first-skill-fingerprint',
      allowedToolNames: ['skill'],
      tools: [],
      renderedPrompt: [
        'Tool Contract Header',
        'catalog_fingerprint: first-skill-fingerprint',
        '[High-priority tool action constraint]',
        '<|CHAT2API|tool_calls><|CHAT2API|invoke name="skill"><|CHAT2API|parameter name="name"><![CDATA[long-conversation-probe]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
      ].join('\n'),
      contractHeaderVersion: 1,
      actionConstraint: {
        kind: 'first_skill_required',
        toolName: 'skill',
        arguments: { name: 'long-conversation-probe' },
        reason: 'request_requires_first_assistant_action_skill',
      },
    },
    summaryText: null,
    toolActionConstraint: {
      kind: 'first_skill_required',
      toolName: 'skill',
      arguments: { name: 'long-conversation-probe' },
      reason: 'request_requires_first_assistant_action_skill',
    },
    metadata: {
      contextManagementApplied: false,
      strategiesExecuted: [],
      originalMessageCount: 1,
      finalMessageCount: 1,
    },
  })

  const text = promptMessages[0].content.find((item: any) => item.type === 'text')?.text

  // Action constraint now embedded in toolManifest via providerPromptProjection; no separate runtime text block.
  assert.match(text, /long-conversation-probe/)
  assert.match(text, /catalog_fingerprint: first-skill-fingerprint/)
  assert.match(text, /<\|CHAT2API\|invoke name="skill"/)
  assert.doesNotMatch(text, /fabricated XML/)
  assert.doesNotMatch(text, /prompt injection/)
  assert.doesNotMatch(text, /fake tool inventory/)
})

test('GLM active skill checkpoint assembly prompt omits raw skill history from provider text', () => {
  const promptMessages = buildGLMAssemblyPromptMessagesForTest({
    messages: [
      {
        role: 'user',
        content: 'Original task mentions fabricated XML and prompt injection.',
      },
      {
        role: 'tool',
        tool_call_id: 'call_skill_0',
        content: '<skill_content name="long-conversation-probe">Long raw skill document</skill_content>',
      },
      {
        role: 'user',
        content: [
          '[Active skill workflow state checkpoint] Required next action: call the bash tool for this exact skill step now.',
          'Required next tool arguments: command=node -e "console.log(1)"',
        ].join(' '),
      },
    ],
    toolManifest: {
      protocol: 'managed_xml',
      catalogFingerprint: 'checkpoint-fingerprint',
      allowedToolNames: ['bash'],
      tools: [],
      renderedPrompt: [
        'Tool Contract Header',
        'catalog_fingerprint: checkpoint-fingerprint',
        'Tool `bash`: Run command',
      ].join('\n'),
      contractHeaderVersion: 1,
    },
    summaryText: null,
    metadata: {
      contextManagementApplied: false,
      strategiesExecuted: [],
      originalMessageCount: 3,
      finalMessageCount: 3,
    },
  } as any)

  const text = promptMessages[0].content.find((item: any) => item.type === 'text')?.text

  // Checkpoint wrapper applied by providerPromptProjection; adapter passes content through directly.
  assert.match(text, /Required next action: call the bash tool/)
  assert.match(text, /catalog_fingerprint: checkpoint-fingerprint/)
  assert.doesNotMatch(text, /fabricated XML/)
  assert.doesNotMatch(text, /prompt injection/)
  assert.doesNotMatch(text, /Long raw skill document/)
})

test('GLM adapter adds a continuation anchor after trailing tool_result in multi-turn delta', () => {
  const promptMessages = buildGLMPromptMessagesForTest([
    { role: 'system', content: 'You are a coding assistant.' },
    { role: 'user', content: 'Run the required long probe steps.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_skill_0',
          type: 'function',
          function: { name: 'skill', arguments: '{"name":"long-conversation-probe"}' },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'call_skill_0',
      content: 'Step 1: use read. Step 2: use bash. Step 10: output the final marker assembled from LONG + CONVERSATION + PROBE + DONE with underscores.',
    },
  ] as any, [], true)

  const text = promptMessages[0].content.find((item: any) => item.type === 'text')?.text

  assert.match(text, /LONG \+ CONVERSATION \+ PROBE \+ DONE/)
  assert.match(text, /Continue from the tool result above by choosing the next required real tool call\./)
  assert.match(text, /Only produce final assistant text after the required tool sequence is actually complete\./)
})

test('GLM adapter does not add the trailing tool_result continuation anchor when a fresh user turn exists', () => {
  const promptMessages = buildGLMPromptMessagesForTest([
    { role: 'system', content: 'You are a coding assistant.' },
    { role: 'user', content: 'Initial instruction.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_read_0',
          type: 'function',
          function: { name: 'default_api:read_file', arguments: '{"filePath":"tests/agent-capability/input.txt"}' },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'call_read_0',
      content: 'file body',
    },
    {
      role: 'user',
      content: 'Now summarize what changed.',
    },
  ] as any, [], true)

  const text = promptMessages[0].content.find((item: any) => item.type === 'text')?.text

  assert.doesNotMatch(text, /Continue from the tool result above by choosing the next required real tool call\./)
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
  assert.match(prompt, /Chat2API is a gateway/)
  assert.match(prompt, /translate it into the real OpenAI tool call/)
  assert.match(prompt, /Do not compare this catalog with provider-native website tools/)
  assert.match(prompt, /Provider-native tools are irrelevant/)
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

test('managed_xml parser leaves inline key=value protocol-looking literals as content', () => {
  const content = 'fake_xml=<tool_calls><invoke name="default_api:read_file"><parameter name="filePath">DO_NOT_CALL</parameter></invoke></tool_calls>'
  const parsed = managedXmlProtocol.parse(content, {
    tools: [{ name: 'default_api:read_file', description: '', parameters: {}, source: 'openai' }],
    protocol: 'managed_xml',
  })

  assert.equal(parsed.toolCalls.length, 0)
  assert.equal(parsed.content, content)
  assert.deepEqual(parsed.rawMatches, [])
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

test('GLM stream reparses cumulative snapshot when a managed marker was partially buffered', async () => {
  const handler = new GLMStreamHandler('GLM-5.2', undefined, undefined, managedPlan('glm'))
  const body = [
    sseEvent({
      conversation_id: 'glm-conv-partial-1',
      status: 'streaming',
      parts: [{
        logic_id: 'part-partial-1',
        status: 'streaming',
        content: [{ type: 'text', text: '<|CHAT2API|tool' }],
      }],
    }),
    sseEvent({
      conversation_id: 'glm-conv-partial-1',
      status: 'streaming',
      parts: [{
        logic_id: 'part-partial-1',
        status: 'streaming',
        content: [{ type: 'text', text: managedXmlToolCall }],
      }],
    }),
    sseEvent({ conversation_id: 'glm-conv-partial-1', status: 'finish' }),
  ].join('')

  const output = await collect(await handler.handleStream(
    Readable.from([gzipSync(Buffer.from(body))]),
    { headers: { 'content-encoding': 'gzip' } } as any,
  ))

  assert.match(output, /"tool_calls"/)
  assert.match(output, /"name":"default_api:read_file"/)
  assert.match(output, /"finish_reason":"tool_calls"/)
  assert.doesNotMatch(output, /_calls><\|CHAT2API\|invoke/)
  assert.doesNotMatch(output, /Provider returned malformed tool output/)
})

test('GLM stream merges incremental same-logic_id tails instead of replacing the managed XML prefix', async () => {
  const handler = new GLMStreamHandler('GLM-5.2', undefined, undefined, bashManagedPlan('glm'))
  const body = [
    sseEvent({
      conversation_id: 'glm-conv-incremental-tail-1',
      status: 'streaming',
      parts: [{
        logic_id: 'part-incremental-tail-1',
        status: 'streaming',
        content: [{
          type: 'text',
          text: '<|CHAT2API|tool_calls><|CHAT2API|invoke name="bash"><|CHAT2API|parameter name="command"><![CDATA[echo first',
        }],
      }],
    }),
    sseEvent({
      conversation_id: 'glm-conv-incremental-tail-1',
      status: 'streaming',
      parts: [{
        logic_id: 'part-incremental-tail-1',
        status: 'streaming',
        content: [{
          type: 'text',
          text: ' && echo second]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
        }],
      }],
    }),
    sseEvent({ conversation_id: 'glm-conv-incremental-tail-1', status: 'finish' }),
  ].join('')

  const output = await collect(await handler.handleStream(
    Readable.from([gzipSync(Buffer.from(body))]),
    { headers: { 'content-encoding': 'gzip' } } as any,
  ))

  assert.match(output, /"tool_calls"/)
  assert.match(output, /"name":"bash"/)
  assert.match(output, /"finish_reason":"tool_calls"/)
  assert.doesNotMatch(output, /Provider returned malformed tool output/)
  assert.doesNotMatch(output, /_calls><\|CHAT2API\|invoke/)
})

test('GLM stream reparses a rewritten managed XML snapshot instead of leaking a mid-marker suffix', async () => {
  const handler = new GLMStreamHandler('GLM-5.2', undefined, undefined, bashManagedPlan('glm'))
  const rewrittenSnapshot = `${standaloneInvokeXml.replace('</|CHAT2API|invoke>', '')}residue-residue`
  const completedSnapshot = standaloneInvokeXml
  const body = [
    sseEvent({
      conversation_id: 'glm-conv-rewrite-1',
      status: 'streaming',
      parts: [{
        logic_id: 'part-rewrite-1',
        status: 'streaming',
        content: [{ type: 'text', text: rewrittenSnapshot }],
      }],
    }),
    sseEvent({
      conversation_id: 'glm-conv-rewrite-1',
      status: 'streaming',
      parts: [{
        logic_id: 'part-rewrite-1',
        status: 'streaming',
        content: [{ type: 'text', text: completedSnapshot }],
      }],
    }),
    sseEvent({ conversation_id: 'glm-conv-rewrite-1', status: 'finish' }),
  ].join('')

  const output = await collect(await handler.handleStream(
    Readable.from([gzipSync(Buffer.from(body))]),
    { headers: { 'content-encoding': 'gzip' } } as any,
  ))

  assert.match(output, /"tool_calls"/)
  assert.match(output, /"name":"bash"/)
  assert.match(output, /"finish_reason":"tool_calls"/)
  assert.doesNotMatch(output, /residue-residue/)
  assert.doesNotMatch(output, /Provider returned malformed tool output/)
  assert.doesNotMatch(output, /_calls><\|CHAT2API\|invoke/)
})

test('GLM stream reparses a rewritten shorter managed XML snapshot instead of leaking stale suffix state', async () => {
  const handler = new GLMStreamHandler('GLM-5.2', undefined, undefined, bashManagedPlan('glm'))
  const staleLongerSnapshot = `${standaloneInvokeXml} trailing-garbage`
  const body = [
    sseEvent({
      conversation_id: 'glm-conv-rewrite-2',
      status: 'streaming',
      parts: [{
        logic_id: 'part-rewrite-2',
        status: 'streaming',
        content: [{ type: 'text', text: staleLongerSnapshot }],
      }],
    }),
    sseEvent({
      conversation_id: 'glm-conv-rewrite-2',
      status: 'streaming',
      parts: [{
        logic_id: 'part-rewrite-2',
        status: 'streaming',
        content: [{ type: 'text', text: standaloneInvokeXml }],
      }],
    }),
    sseEvent({ conversation_id: 'glm-conv-rewrite-2', status: 'finish' }),
  ].join('')

  const output = await collect(await handler.handleStream(
    Readable.from([gzipSync(Buffer.from(body))]),
    { headers: { 'content-encoding': 'gzip' } } as any,
  ))

  assert.match(output, /"tool_calls"/)
  assert.match(output, /"name":"bash"/)
  assert.match(output, /"finish_reason":"tool_calls"/)
  assert.doesNotMatch(output, /trailing-garbage/)
  assert.doesNotMatch(output, /Provider returned malformed tool output/)
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

test('Qwen stream recovers when a cumulative snapshot rewrites an in-flight managed XML tool call', async () => {
  const handler = new QwenStreamHandler('Qwen3-Max', undefined, managedPlan('qwen'))
  const rewrittenSnapshot = `${managedXmlToolCall.replace('</|CHAT2API|tool_calls>', '')}residue-residue`
  const output = await collect(handler.handleStream(Readable.from([
    sseEvent({
      communication: { sessionid: 'qwen-session-1', reqid: 'qwen-req-1' },
      data: {
        messages: [{
          mime_type: 'multi_load/iframe',
          content: rewrittenSnapshot,
          status: 'streaming',
          meta_data: {},
        }],
      },
    }),
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
  assert.doesNotMatch(output, /residue-residue/)
  assert.doesNotMatch(output, /\|tool_calls>/)
})

test('Qwen stream reparses a rewritten shorter managed XML snapshot instead of leaking stale suffix state', async () => {
  const handler = new QwenStreamHandler('Qwen3-Max', undefined, managedPlan('qwen'))
  const staleLongerSnapshot = `${managedXmlToolCall} trailing-garbage`
  const output = await collect(handler.handleStream(Readable.from([
    sseEvent({
      communication: { sessionid: 'qwen-session-1', reqid: 'qwen-req-1' },
      data: {
        messages: [{
          mime_type: 'multi_load/iframe',
          content: staleLongerSnapshot,
          status: 'streaming',
          meta_data: {},
        }],
      },
    }),
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
  assert.doesNotMatch(output, /trailing-garbage/)
  assert.doesNotMatch(output, /\|tool_calls>/)
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

test('Qwen stream emits a client-safe error instead of silent empty success', async () => {
  const handler = new QwenStreamHandler('Qwen3-Max', undefined, managedPlan('qwen'))
  const output = await collect(handler.handleStream(Readable.from([
    sseEvent({
      communication: { sessionid: 'qwen-session-empty', reqid: 'qwen-req-empty' },
      data: {
        messages: [{
          mime_type: 'multi_load/iframe',
          content: '   ',
          status: 'complete',
          meta_data: {},
        }],
      },
    }),
  ])))

  assert.match(output, /Error: Provider returned empty assistant output/)
  assert.match(output, /"finish_reason":"stop"/)
  assert.doesNotMatch(output, /"finish_reason":"tool_calls"/)
})

test('Qwen stream turns open_url-only availability denial into an explicit managed-tool error', async () => {
  const handler = new QwenStreamHandler('Qwen3-Max', undefined, managedPlanWithCatalog('qwen'))
  const output = await collect(handler.handleStream(Readable.from([
    sseEvent({
      communication: { sessionid: 'qwen-session-drift', reqid: 'qwen-req-drift' },
      data: {
        messages: [{
          mime_type: 'multi_load/iframe',
          content: 'I only have open_url available.',
          status: 'complete',
          meta_data: {},
        }],
      },
    }),
  ])))

  assert.match(output, /I only have open_url available\./)
  assert.match(output, /Error: Provider refused the authoritative tool catalog/)
  assert.match(output, /"finish_reason":"stop"/)
})

test('Qwen AI stream emits managed XML as OpenAI tool_calls', async () => {
  const handler = new QwenAiStreamHandler('qwen3.7-max', undefined, managedPlan('qwen'))
  handler.setChatId('qwen-ai-chat-1')
  const output = await collect(await handler.handleStream(Readable.from([
    sseEvent({
      'response.created': { response_id: 'qwen-ai-response-1' },
      choices: [{
        delta: {
          phase: 'answer',
          status: 'finished',
          content: managedXmlToolCall,
        },
      }],
    }),
  ])))

  assert.match(output, /"tool_calls"/)
  assert.match(output, /"name":"default_api:read_file"/)
  assert.match(output, /"finish_reason":"tool_calls"/)
})

test('Qwen AI stream emits a client-safe error instead of silent empty success', async () => {
  const handler = new QwenAiStreamHandler('qwen3.7-max', undefined, managedPlan('qwen'))
  handler.setChatId('qwen-ai-chat-empty')
  const output = await collect(await handler.handleStream(Readable.from([
    sseEvent({
      'response.created': { response_id: 'qwen-ai-response-empty' },
      choices: [{
        delta: {
          phase: 'answer',
          status: 'finished',
          content: '   ',
        },
      }],
    }),
  ])))

  assert.match(output, /Error: Provider returned empty assistant output/)
  assert.match(output, /"finish_reason":"stop"/)
  assert.doesNotMatch(output, /"finish_reason":"tool_calls"/)
})

test('GLM stream emits a client-safe error instead of silent empty success', async () => {
  const handler = new GLMStreamHandler('GLM-5.2', undefined, undefined, managedPlan('glm'))
  const body = [
    sseEvent({
      conversation_id: 'glm-empty-1',
      status: 'streaming',
      parts: [{
        logic_id: 'part-empty-1',
        status: 'streaming',
        content: [{ type: 'text', text: '   ' }],
      }],
    }),
    sseEvent({ conversation_id: 'glm-empty-1', status: 'finish' }),
  ].join('')

  const output = await collect(await handler.handleStream(
    Readable.from([gzipSync(Buffer.from(body))]),
    { headers: { 'content-encoding': 'gzip' } } as any,
  ))

  assert.match(output, /Error: Provider returned empty assistant output/)
  assert.match(output, /"finish_reason":"stop"/)
  assert.doesNotMatch(output, /"finish_reason":"tool_calls"/)
})

test('GLM stream turns open_url-only availability denial into an explicit managed-tool error', async () => {
  const handler = new GLMStreamHandler('GLM-5.2', undefined, undefined, managedPlanWithCatalog('glm'))
  const body = [
    sseEvent({
      conversation_id: 'glm-drift-1',
      status: 'streaming',
      parts: [{
        logic_id: 'part-drift-1',
        status: 'streaming',
        content: [{ type: 'text', text: 'I only have open_url available.' }],
      }],
    }),
    sseEvent({ conversation_id: 'glm-drift-1', status: 'finish' }),
  ].join('')

  const output = await collect(await handler.handleStream(
    Readable.from([gzipSync(Buffer.from(body))]),
    { headers: { 'content-encoding': 'gzip' } } as any,
  ))

  assert.match(output, /I only have open_url available\./)
  assert.match(output, /Error: Provider refused the authoritative tool catalog/)
  assert.match(output, /"finish_reason":"stop"/)
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
  assert.ok(result.toolManifest, 'toolManifest should be present')
  assert.match(result.toolManifest!.renderedPrompt, /<\|CHAT2API\|tool_calls>/)

  // Assistant message with tool_calls is preserved in original OpenAI format
  // The adapter is responsible for converting these to the provider's format (XML)
  assert.equal(result.messages[2].role, 'assistant')
  assert.ok(Array.isArray(result.messages[2].tool_calls))
  assert.equal((result.messages[2] as any).tool_calls.length, 2)
})

// ============================================================
// FORWARDER CODE ANALYSIS: Bug documentation
// ============================================================


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

// ============================================================
// P1 v2: prompt-embedded catalog — GLM denial must not be silent
// ============================================================

function promptEmbeddedManagedPlan(): ToolCallingPlan {
  const embeddedTools = [
    { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }, source: 'prompt_embedded' as const },
    { name: 'bash', description: 'Execute a shell command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }, source: 'prompt_embedded' as const },
  ]
  return {
    mode: 'managed',
    protocol: 'managed_xml',
    clientAdapterId: 'standard-openai-tools',
    providerId: 'glm',
    tools: embeddedTools,
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(['read', 'bash']),
    availabilityRetryAllowed: true,
    catalogSnapshot: {
      sessionId: 'glm-pe-session',
      fingerprint: 'glm-pe-fingerprint',
      tools: Object.freeze(embeddedTools),
      allowedToolNames: ['read', 'bash'],
      schemaHashes: {},
      source: 'prompt_embedded',
      createdTurnIndex: 1,
      updatedTurnIndex: 1,
    },
    catalogDiagnostics: {
      source: 'prompt_embedded',
      fingerprint: 'glm-pe-fingerprint',
      driftKinds: ['prompt_embedded_only_catalog'],
      blocked: false,
    },
    contract: {
      turnId: 'glm-pe-turn',
      sessionId: 'glm-pe-session',
      providerId: 'glm',
      model: 'GLM-5.2',
      protocol: 'managed_xml',
      snapshotFingerprint: 'glm-pe-fingerprint',
      tools: Object.freeze(embeddedTools),
      allowedToolNames: Object.freeze(new Set<string>(['read', 'bash'])),
      toolChoiceMode: 'auto',
      shouldInjectPrompt: true,
      shouldParseResponse: true,
      historyMode: 'managed_protocol',
      emptyOutputPolicy: 'diagnose_and_fail',
      toolSourceChain: Object.freeze(['current_request', 'prompt_embedded']),
    },
    diagnostics: {
      requestId: 'glm-pe-request',
      turnId: 'glm-pe-turn',
      clientAdapterId: 'standard-openai-tools',
      providerId: 'glm',
      model: 'GLM-5.2',
      actualModel: 'GLM-5.2',
      toolSource: 'prompt_embedded',
      mode: 'managed',
      protocol: 'managed_xml',
      toolCount: 2,
      injected: true,
      reason: 'test_prompt_embedded',
      emptyOutputPolicy: 'diagnose_and_fail',
      allowedToolNames: ['read', 'bash'],
      catalogSource: 'prompt_embedded',
      catalogFingerprint: 'glm-pe-fingerprint',
    },
  }
}

test('GLM: prompt-embedded catalog + denial text is NOT parsed as tool_calls by applyNonStreamResponse', () => {
  const plan = promptEmbeddedManagedPlan()
  const engine = new ToolCallingEngine()

  // Simulate GLM non-stream response claiming only open_url is available
  const fakeResult = {
    id: 'glm-conv-id',
    model: 'GLM-5.2',
    object: 'chat.completion',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: '环境中唯一可用的工具是 open_url，不能使用 read 或 bash。',
      },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    created: Math.floor(Date.now() / 1000),
  }

  // applyNonStreamResponse now only parses tool_calls and returns void.
  // Denial text should NOT be parsed as tool calls; the retry logic
  // moved to executeBoundedAvailabilityRetry in the forwarder.
  engine.applyNonStreamResponse(fakeResult, plan)

  assert.equal(fakeResult.choices[0].message.tool_calls, undefined)
  assert.equal(fakeResult.choices[0].message.content, '环境中唯一可用的工具是 open_url，不能使用 read 或 bash。')
  assert.equal(fakeResult.choices[0].finish_reason, 'stop')
})
