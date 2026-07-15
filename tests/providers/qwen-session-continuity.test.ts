import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'

import { buildQwenAssemblyRequestBodyForTest, buildQwenChatRequestBodyForTest, QwenStreamHandler } from '../../src/main/proxy/adapters/qwen.ts'
import { createContextManagementService } from '../../src/main/proxy/services/contextManagementService.ts'
import { deriveOpenAISessionIdentity } from '../../src/main/proxy/routes/openaiSession.ts'
import {
  buildPromptBudgetPolicyInput,
  inspectRecentPromptBudgetToolSignals,
  promptBudgetSnapshotCache,
  recordPromptBudgetSnapshot,
} from '../../src/main/proxy/promptBudgetPolicy.ts'
import {
  buildChildSessionHandoff,
  buildProviderConversationStateWritePlan,
  decideProviderConversationStateWriteTargets,
  forkProviderConversationContext,
  renderChildSessionHandoffStateMessage,
} from '../../src/main/proxy/sessionBoundary.ts'
import type { ProxyContext } from '../../src/main/proxy/types.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'
import type { ToolCallingTransformResult } from '../../src/main/proxy/toolCalling/types.ts'
import { decidePromptBudgetPolicy } from '../../src/main/proxy/promptBudgetPolicy.ts'

function sseEvent(data: Record<string, unknown>, event = 'message'): string {
  return `event:${event}\ndata:${JSON.stringify(data)}\n\n`
}

async function collect(stream: Readable): Promise<string> {
  let output = ''
  for await (const chunk of stream) output += chunk.toString()
  return output
}

function createProxyContext(): ProxyContext {
  return {
    requestId: 'req-1',
    providerId: 'qwen',
    accountId: 'acc-1',
    model: 'Qwen3-Max',
    actualModel: 'Qwen3-Max',
    startTime: 1,
    isStream: false,
    toolCatalogSessionKey: 'openai-chat:base-tool-key',
    providerConversationSessionKey: 'openai-chat:base-provider-key',
    providerSessionEpoch: 'main',
    sessionBoundaryReason: 'normal',
  }
}

function makeToolCall(id: string, name: string, args: string) {
  return {
    id,
    type: 'function' as const,
    function: {
      name,
      arguments: args,
    },
  }
}

function makeTransformResult(overrides: Partial<ToolCallingTransformResult> = {}): ToolCallingTransformResult {
  return {
    messages: [],
    tools: undefined,
    plan: {
      mode: 'disabled',
      protocol: 'managed_xml',
      clientAdapterId: 'standard-openai-tools',
      providerId: 'qwen',
      tools: [],
      shouldInjectPrompt: false,
      shouldParseResponse: false,
      toolChoiceMode: 'auto',
      allowedToolNames: new Set(),
      catalogSnapshot: undefined,
      catalogDiagnostics: {
        source: 'none',
        driftKinds: [],
        blocked: false,
      },
      availabilityRetryAllowed: false,
      contract: {
        turnId: 'turn-1',
        sessionId: null,
        providerId: 'qwen',
        model: 'Qwen3-Max',
        protocol: 'managed_xml',
        snapshotFingerprint: null,
        tools: [],
        allowedToolNames: new Set(),
        toolChoiceMode: 'auto',
        shouldInjectPrompt: false,
        shouldParseResponse: false,
        historyMode: 'openai_native',
        emptyOutputPolicy: 'diagnose_and_fail',
        toolSourceChain: ['current_request', 'session_catalog', 'message_history', 'safe_empty'],
      },
      diagnostics: {
        clientAdapterId: 'standard-openai-tools',
        providerId: 'qwen',
        toolSource: 'openai',
        mode: 'disabled',
        protocol: 'managed_xml',
        toolCount: 0,
        injected: false,
        reason: 'test',
      },
    },
    ...overrides,
  }
}

function makeProvider() {
  return {
    id: 'qwen',
    name: 'Qwen',
    type: 'builtin' as const,
    authType: 'token' as const,
    apiEndpoint: '',
    headers: {},
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  }
}

function makeAccount() {
  return {
    id: 'acc-1',
    providerId: 'qwen',
    name: 'Qwen Account',
    credentials: { token: 'test-token' },
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  }
}

test('Qwen request body uses chat scene when continuing an existing session', () => {
  const body = buildQwenChatRequestBodyForTest({
    request: {
      model: 'Qwen3-Max',
      messages: [{ role: 'user', content: 'continue the thread' }],
      stream: true,
    },
    actualModel: 'Qwen3-Max',
    sessionId: 'existing-session',
    reqId: 'new-req',
    parentReqId: 'prev-req',
    timestamp: 1,
    enableThinking: false,
    enableWebSearch: false,
  })

  assert.equal(body.session_id, 'existing-session')
  assert.equal(body.parent_req_id, 'prev-req')
  assert.equal(body.scene_param, 'chat')
})

test('Qwen request body keeps first_turn semantics for new sessions', () => {
  const body = buildQwenChatRequestBodyForTest({
    request: {
      model: 'Qwen3-Max',
      messages: [{ role: 'user', content: 'start a thread' }],
      stream: true,
    },
    actualModel: 'Qwen3-Max',
    sessionId: 'new-session',
    reqId: 'new-req',
    timestamp: 1,
    enableThinking: false,
    enableWebSearch: false,
  })

  assert.equal(body.parent_req_id, '0')
  assert.equal(body.scene_param, 'first_turn')
})

test('provider conversation state helpers live outside forwarder and are used by qwen path', () => {
  const forwarderSource = readFileSync('src/main/proxy/forwarder.ts', 'utf8')
  const sessionBoundarySource = readFileSync('src/main/proxy/sessionBoundary.ts', 'utf8')
  const providerStateSource = readFileSync('src/main/proxy/services/providerConversationState.ts', 'utf8')
  const providerRuntimeSource = readFileSync('src/main/proxy/services/ProviderRuntime.ts', 'utf8')

  assert.match(sessionBoundarySource, /export function decideProviderConversationStateWriteTargets\(/)
  assert.match(sessionBoundarySource, /export function buildChildSessionHandoff\(/)
  assert.match(sessionBoundarySource, /export function buildProviderConversationStateWritePlan</)
  assert.doesNotMatch(providerRuntimeSource, /forwarder\.ts/)
  assert.match(providerStateSource, /export interface ConversationState/)
  assert.match(providerStateSource, /export function shouldUseProviderConversationFallback\(context: ProxyContext\)/)
  assert.match(providerStateSource, /export function getProviderConversationState\(/)
  assert.match(providerStateSource, /export function setProviderConversationState\(/)
  assert.match(providerStateSource, /const targets = decideProviderConversationStateWriteTargets\(input\)/)
  assert.match(providerStateSource, /const writes = buildProviderConversationStateWritePlan<ConversationState>\(\{/)
  assert.match(
    forwarderSource,
    /from\s+'\.\/services\/providerConversationState\.ts'/,
  )
  assert.match(forwarderSource, /import\s+\{\s*inspectNonStreamAssistantOutput\s*\}\s+from\s+'\.\/toolCalling\/outputInspection\.ts'/)
  assert.match(
    forwarderSource,
    /import\s+\{[\s\S]*buildChildSessionHandoff[\s\S]*forkProviderConversationContext[\s\S]*\}\s+from\s+'\.\/sessionBoundary\.ts'/,
  )
  assert.match(forwarderSource, /inspectNonStreamAssistantOutput\(\{/)
  assert.match(forwarderSource, /allowFallback: allowProviderStateFallback/)
  assert.match(forwarderSource, /mirrorToFallback: allowProviderStateFallback/)
  assert.match(forwarderSource, /context,/)
  assert.match(forwarderSource, /const convState = getProviderConversationState\(/)
  assert.match(forwarderSource, /renderChildSessionHandoffStateMessage\(convState\.childSessionHandoff\)/)
  assert.match(forwarderSource, /childSessionHandoff: undefined/)
  assert.match(forwarderSource, /sessionId: convState\?\.qwenSessionId/)
  assert.match(forwarderSource, /parentReqId: convState\?\.qwenParentReqId/)
  assert.match(forwarderSource, /const parentHandoff = buildChildSessionHandoff\(\{/)
  assert.match(forwarderSource, /const finalAssistantResponse = handler\.getFinalAssistantResponseForHandoff\(\)/)
  assert.match(forwarderSource, /writeSessionState\(\{[\s\S]*qwenSessionId: sid,[\s\S]*qwenParentReqId: parentReqId \|\| '0'/)
  assert.match(forwarderSource, /childProviderSessionId:\s*finalSessionId/)
  assert.match(forwarderSource, /cleanupChildProviderSession\(\{/)
  assert.doesNotMatch(forwarderSource, /setConversationState\(parentConversationKey,\s*\{\s*childQwenSessionId:\s*sid\s*\}\)/)
  assert.match(forwarderSource, /if \(!deleteSessionCallback\) \{\s*saveConversationState\(finalSessionId, finalResponseId, parentHandoff\)\s*\}/)
  assert.doesNotMatch(forwarderSource, /saveConversationState\(finalSessionId, finalResponseId, parentHandoff\)\s*[\r\n]+\s*if \(deleteSessionCallback && finalSessionId\)/)
  assert.match(forwarderSource, /const parentHandoff = finalAssistantResponse\s*\?\s*buildChildSessionHandoff\(\{/)
})

test('normal provider-state writes can mirror to the fallback tool session key', () => {
  const targets = decideProviderConversationStateWriteTargets({
    context: createProxyContext(),
    primaryKey: 'provider:main',
    fallbackToolSessionKey: 'tool:main',
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
    ],
    mirrorToFallback: true,
  })

  assert.deepEqual(targets, {
    primaryKey: 'provider:main',
    mirrorKey: 'tool:main',
    parentHandoffKey: undefined,
  })
})

test('tool child provider-state writes stay on the child key and expose the parent handoff key separately', () => {
  const targets = decideProviderConversationStateWriteTargets({
    context: {
      ...createProxyContext(),
      providerConversationSessionKey: 'provider:tool-child',
      parentProviderConversationSessionKey: 'provider:main',
      sessionBoundaryReason: 'tool_child',
    },
    primaryKey: 'provider:tool-child',
    fallbackToolSessionKey: 'tool:main',
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'child result' },
    ],
    mirrorToFallback: true,
  })

  assert.deepEqual(targets, {
    primaryKey: 'provider:tool-child',
    parentHandoffKey: 'provider:main',
  })
})

test('typed child handoff is bounded and excludes raw child transcript content', () => {
  const rawToolTranscript = 'RAW_CHILD_TRANSCRIPT '.repeat(80)
  const handoff = buildChildSessionHandoff({
    context: {
      ...createProxyContext(),
      providerConversationSessionKey: 'provider:tool-child',
      parentProviderConversationSessionKey: 'provider:main',
      sessionBoundaryReason: 'tool_child',
    },
    requestMessages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_read_1', type: 'function', function: { name: 'read', arguments: '{"filePath":"tests/agent-capability/input.txt"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_read_1', content: rawToolTranscript },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_write_1', type: 'function', function: { name: 'write', arguments: '{"filePath":".agent-probe/long-summary.txt","content":"done"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_write_1', content: 'created .agent-probe/long-summary.txt' },
    ],
    responseBody: {
      choices: [{
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: 'Child workflow completed. Next action: update the parent plan with the new artifact.',
        },
      }],
    },
  })

  assert.ok(handoff, 'expected settled child result to produce a typed handoff')
  assert.equal(handoff?.kind, 'tool_child')
  assert.equal(handoff?.status, 'ok')
  assert.match(handoff?.summary ?? '', /Child workflow completed/i)
  assert.equal(handoff?.summary.includes(rawToolTranscript.trim()), false)
  assert.ok((handoff?.summary.length ?? 0) <= 280, 'handoff summary must stay bounded')
  assert.ok((handoff?.evidence.length ?? 0) > 0, 'handoff should include bounded evidence')
  assert.ok(handoff?.artifacts?.some((artifact) => artifact.path === '.agent-probe/long-summary.txt'))
  assert.match(handoff?.nextAction ?? '', /update the parent plan/i)
})

test('rendered parent handoff state message includes only typed bounded fields', () => {
  const rawToolTranscript = 'RAW_CHILD_TRANSCRIPT '.repeat(40)
  const handoff = buildChildSessionHandoff({
    context: {
      ...createProxyContext(),
      providerConversationSessionKey: 'provider:tool-child',
      parentProviderConversationSessionKey: 'provider:main',
      sessionBoundaryReason: 'tool_child',
    },
    requestMessages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_read_1', type: 'function', function: { name: 'read', arguments: '{"filePath":"tests/agent-capability/input.txt"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_read_1', content: rawToolTranscript },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_write_1', type: 'function', function: { name: 'write', arguments: '{"filePath":".agent-probe/long-summary.txt","content":"done"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_write_1', content: 'created .agent-probe/long-summary.txt' },
    ],
    responseBody: {
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'Child workflow completed. Next action: continue from the saved artifact.' },
      }],
    },
  })!

  const rendered = renderChildSessionHandoffStateMessage(handoff)
  assert.match(rendered, /\[Child session handoff state\]/)
  assert.match(rendered, /kind: tool_child/)
  assert.match(rendered, /status: ok/)
  assert.match(rendered, /summary:/)
  assert.match(rendered, /evidence:/)
  assert.match(rendered, /artifacts:/)
  assert.match(rendered, /nextAction:/)
  assert.equal(rendered.includes(rawToolTranscript.trim()), false)
  assert.equal(rendered.includes('"tool_calls"'), false)
})

test('tool child handoff writes plan updates only the parent handoff field and keeps raw child provider state on the child key', () => {
  const parentHandoff = buildChildSessionHandoff({
    context: {
      ...createProxyContext(),
      providerConversationSessionKey: 'provider:tool-child',
      parentProviderConversationSessionKey: 'provider:main',
      sessionBoundaryReason: 'tool_child',
    },
    requestMessages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_read_1', type: 'function', function: { name: 'read', arguments: '{"filePath":"tests/agent-capability/input.txt"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_read_1', content: 'raw child tool output' },
    ],
    responseBody: {
      choices: [{
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: 'Done. Next step: ask the parent to continue from the saved artifact.',
        },
      }],
    },
  })

  const targets = decideProviderConversationStateWriteTargets({
    context: {
      ...createProxyContext(),
      providerConversationSessionKey: 'provider:tool-child',
      parentProviderConversationSessionKey: 'provider:main',
      sessionBoundaryReason: 'tool_child',
    },
    primaryKey: 'provider:tool-child',
    fallbackToolSessionKey: 'tool:main',
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_read_1', type: 'function', function: { name: 'read', arguments: '{"filePath":"tests/agent-capability/input.txt"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_read_1', content: 'raw child tool output' },
    ],
    mirrorToFallback: true,
  })
  const writes = buildProviderConversationStateWritePlan<{
    qwenSessionId?: string
    qwenParentReqId?: string
    childSessionHandoff?: NonNullable<typeof parentHandoff>
  }>({
    targets,
    parentHandoff,
    primaryUpdate: {
      qwenSessionId: 'child-session',
      qwenParentReqId: 'child-req',
    },
  })

  assert.deepEqual(writes, [
    {
      key: 'provider:tool-child',
      update: {
        qwenSessionId: 'child-session',
        qwenParentReqId: 'child-req',
      },
    },
    {
      key: 'provider:main',
      update: {
        childSessionHandoff: parentHandoff,
      },
    },
  ])
  assert.equal(
    JSON.stringify(writes).includes('raw child tool output'),
    false,
    'write plan must not copy raw child transcript into parent handoff writes',
  )
})

test('parent normal qwen request consumes stored child handoff as a bounded system state message', () => {
  const handoff = buildChildSessionHandoff({
    context: {
      ...createProxyContext(),
      providerConversationSessionKey: 'provider:tool-child',
      parentProviderConversationSessionKey: 'provider:main',
      sessionBoundaryReason: 'tool_child',
    },
    requestMessages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_read_1', type: 'function', function: { name: 'read', arguments: '{"filePath":"tests/agent-capability/input.txt"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_read_1', content: 'raw child tool output' },
    ],
    responseBody: {
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'Done. Next action: continue from .agent-probe/long-summary.txt' },
      }],
    },
  })!
  const injectedMessages = [
    {
      role: 'system' as const,
      content: renderChildSessionHandoffStateMessage(handoff),
    },
    { role: 'user' as const, content: 'Continue the parent workflow.' },
  ]

  assert.equal(injectedMessages[0].role, 'system')
  assert.match(String(injectedMessages[0].content), /\[Child session handoff state\]/)
  assert.match(String(injectedMessages[0].content), /nextAction: Continue from \.agent-probe\/long-summary\.txt/i)
  assert.equal(String(injectedMessages[0].content).includes('raw child tool output'), false)
})

test('child session requests do not consume parent handoff state', () => {
  const context: ProxyContext = {
    ...createProxyContext(),
    providerConversationSessionKey: 'provider:tool-child',
    parentProviderConversationSessionKey: 'provider:main',
    sessionBoundaryReason: 'tool_child',
  }

  assert.equal(context.sessionBoundaryReason, 'tool_child')
  assert.equal(['tool_child', 'subagent_child'].includes(context.sessionBoundaryReason ?? 'normal'), true)
})

test('consumed parent handoff is cleared on the next parent save', () => {
  const handoff = buildChildSessionHandoff({
    context: {
      ...createProxyContext(),
      providerConversationSessionKey: 'provider:tool-child',
      parentProviderConversationSessionKey: 'provider:main',
      sessionBoundaryReason: 'tool_child',
    },
    requestMessages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_read_1', type: 'function', function: { name: 'read', arguments: '{"filePath":"tests/agent-capability/input.txt"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_read_1', content: 'raw child tool output' },
    ],
    responseBody: {
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'Done. Next action: continue from .agent-probe/long-summary.txt' },
      }],
    },
  })!
  const targets = decideProviderConversationStateWriteTargets({
    context: createProxyContext(),
    primaryKey: 'provider:main',
    fallbackToolSessionKey: 'tool:main',
    messages: [{ role: 'user', content: 'Continue the parent workflow.' }],
    mirrorToFallback: false,
  })
  const writes = buildProviderConversationStateWritePlan<{
    qwenSessionId?: string
    qwenParentReqId?: string
    childSessionHandoff?: typeof handoff | undefined
  }>({
    targets: { ...targets, mirrorKey: undefined },
    primaryUpdate: {
      qwenSessionId: 'parent-session-2',
      qwenParentReqId: 'parent-req-2',
      childSessionHandoff: undefined,
    },
  })

  assert.deepEqual(writes, [
    {
      key: 'provider:main',
      update: {
        qwenSessionId: 'parent-session-2',
        qwenParentReqId: 'parent-req-2',
        childSessionHandoff: undefined,
      },
    },
  ])
})

test('active child tool call result does not emit a settled handoff before the workflow finishes', () => {
  const handoff = buildChildSessionHandoff({
    context: {
      ...createProxyContext(),
      providerConversationSessionKey: 'provider:tool-child',
      parentProviderConversationSessionKey: 'provider:main',
      sessionBoundaryReason: 'tool_child',
    },
    requestMessages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_read_1', type: 'function', function: { name: 'read', arguments: '{"filePath":"tests/agent-capability/input.txt"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_read_1', content: 'raw child tool output' },
    ],
    responseBody: {
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_write_1', type: 'function', function: { name: 'write', arguments: '{}' } }],
        },
      }],
    },
  })

  assert.equal(handoff, undefined)
})

test('qwen stream settled child response produces a bounded parent handoff without raw tool result content', async () => {
  const rawToolOutput = 'RAW_STREAM_TOOL_OUTPUT '.repeat(80)
  const handler = new QwenStreamHandler('Qwen3-Max')
  await collect(handler.handleStream(Readable.from([
    sseEvent({
      communication: { sessionid: 'qwen-stream-session', reqid: 'qwen-stream-req' },
      data: {
        messages: [{
          mime_type: 'multi_load/iframe',
          content: 'Child workflow complete. Next action: continue from .agent-probe/long-summary.txt',
          status: 'complete',
          meta_data: {},
        }],
      },
    }),
  ])))

  const finalAssistantResponse = handler.getFinalAssistantResponseForHandoff()
  const handoff = buildChildSessionHandoff({
    context: {
      ...createProxyContext(),
      providerConversationSessionKey: 'provider:tool-child',
      parentProviderConversationSessionKey: 'provider:main',
      sessionBoundaryReason: 'tool_child',
    },
    requestMessages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_read_1', type: 'function', function: { name: 'read', arguments: '{"filePath":"tests/agent-capability/input.txt"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_read_1', content: rawToolOutput },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_write_1', type: 'function', function: { name: 'write', arguments: '{"filePath":".agent-probe/long-summary.txt","content":"done"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_write_1', content: 'created .agent-probe/long-summary.txt' },
    ],
    responseBody: {
      choices: [finalAssistantResponse],
    },
  })
  const targets = decideProviderConversationStateWriteTargets({
    context: {
      ...createProxyContext(),
      providerConversationSessionKey: 'provider:tool-child',
      parentProviderConversationSessionKey: 'provider:main',
      sessionBoundaryReason: 'tool_child',
    },
    primaryKey: 'provider:tool-child',
    fallbackToolSessionKey: 'tool:main',
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_read_1', type: 'function', function: { name: 'read', arguments: '{"filePath":"tests/agent-capability/input.txt"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_read_1', content: rawToolOutput },
    ],
    mirrorToFallback: true,
  })
  const writes = buildProviderConversationStateWritePlan({
    targets,
    primaryUpdate: {
      qwenSessionId: 'qwen-stream-session',
      qwenParentReqId: 'qwen-stream-req',
    },
    parentHandoff: handoff,
  })

  assert.equal(finalAssistantResponse?.finish_reason, 'stop')
  assert.match(String(finalAssistantResponse?.message.content), /Child workflow complete/i)
  assert.ok(handoff, 'expected stream-settled child handoff to be built')
  assert.equal(JSON.stringify(writes).includes(rawToolOutput.trim()), false)
  assert.equal(writes.some(write => write.key === 'provider:main' && 'childSessionHandoff' in write.update), true)
})

test('qwen stream tool_calls child response does not produce a settled parent handoff', async () => {
  const handler = new QwenStreamHandler('Qwen3-Max', undefined, makeTransformResult({
    plan: {
      ...makeTransformResult().plan,
      mode: 'managed',
      shouldParseResponse: true,
      tools: [{ name: 'read', parameters: { type: 'object' }, source: 'openai' }],
      allowedToolNames: new Set(['read']),
    },
  }).plan)
  await collect(handler.handleStream(Readable.from([
    sseEvent({
      communication: { sessionid: 'qwen-stream-session', reqid: 'qwen-stream-req' },
      data: {
        messages: [{
          mime_type: 'multi_load/iframe',
          content: '<|CHAT2API|tool_calls><|CHAT2API|invoke name="read"><|CHAT2API|parameter name="filePath"><![CDATA[tests/agent-capability/input.txt]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
          status: 'complete',
          meta_data: {},
        }],
      },
    }),
  ])))

  const finalAssistantResponse = handler.getFinalAssistantResponseForHandoff()
  const handoff = buildChildSessionHandoff({
    context: {
      ...createProxyContext(),
      providerConversationSessionKey: 'provider:tool-child',
      parentProviderConversationSessionKey: 'provider:main',
      sessionBoundaryReason: 'tool_child',
    },
    requestMessages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_read_1', type: 'function', function: { name: 'read', arguments: '{"filePath":"tests/agent-capability/input.txt"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_read_1', content: 'raw child tool output' },
    ],
    responseBody: {
      choices: [finalAssistantResponse],
    },
  })

  assert.equal(finalAssistantResponse?.finish_reason, 'tool_calls')
  assert.ok(Array.isArray(finalAssistantResponse?.message.tool_calls))
  assert.equal(handoff, undefined)
})

test('qwen managed stream suppresses malformed tool-output diagnostics as assistant content', async () => {
  const handler = new QwenStreamHandler('Qwen3-Max', undefined, makeTransformResult({
    plan: {
      ...makeTransformResult().plan,
      mode: 'managed',
      shouldParseResponse: true,
      tools: [{ name: 'read', parameters: { type: 'object' }, source: 'openai' }],
      allowedToolNames: new Set(['read']),
      contract: {
        ...makeTransformResult().plan.contract,
        shouldParseResponse: true,
        emptyOutputPolicy: 'diagnose_and_fail',
      },
      diagnostics: {
        ...makeTransformResult().plan.diagnostics,
        requestId: 'req-malformed-stream',
      },
    },
  }).plan)

  const output = await collect(handler.handleStream(Readable.from([
    sseEvent({
      communication: { sessionid: 'qwen-stream-session', reqid: 'qwen-stream-req' },
      data: {
        messages: [{
          mime_type: 'multi_load/iframe',
          content: '<|CHAT2API|tool_calls><|CHAT2API|invoke name="read"><|CHAT2API|parameter name="filePath"><![CDATA[tests/agent-capability/input.txt]]>',
          status: 'complete',
          meta_data: {},
        }],
      },
    }),
  ])))
  const finalAssistantResponse = handler.getFinalAssistantResponseForHandoff()

  assert.equal(output.includes('Provider returned malformed tool output'), false)
  assert.equal(output.includes('Error: Provider returned malformed'), false)
  assert.equal(output.includes('<|CHAT2API|tool_calls>'), false)
  assert.match(output, /"finish_reason":"stop"/)
  assert.equal(finalAssistantResponse?.finish_reason, 'stop')
  assert.equal(finalAssistantResponse?.message.content, null)
})

test('subagent child provider-state writes do not update the main provider key', () => {
  const targets = decideProviderConversationStateWriteTargets({
    context: {
      ...createProxyContext(),
      providerConversationSessionKey: 'provider:subagent-child',
      parentProviderConversationSessionKey: 'provider:main',
      sessionBoundaryReason: 'subagent_child',
    },
    primaryKey: 'provider:subagent-child',
    fallbackToolSessionKey: 'tool:main',
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'subagent result' },
    ],
    mirrorToFallback: true,
  })

  assert.deepEqual(targets, {
    primaryKey: 'provider:subagent-child',
    parentHandoffKey: 'provider:main',
  })
})

test('server summary from a tool child writes to the summary child key instead of the parent key', () => {
  const summaryContext = forkProviderConversationContext(
    {
      ...createProxyContext(),
      providerConversationSessionKey: 'provider:tool-child',
      parentProviderConversationSessionKey: 'provider:main',
      sessionBoundaryReason: 'tool_child',
    },
    {
      reason: 'server_summary',
      epochSource: {
        originalMessageCount: 18,
        finalMessageCount: 5,
        summary: '[Prior conversation summary] child workflow was compacted',
      },
    },
  )

  const targets = decideProviderConversationStateWriteTargets({
    context: summaryContext,
    primaryKey: 'provider:tool-child:server-summary',
    fallbackToolSessionKey: 'tool:main',
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'summary child result' },
    ],
    mirrorToFallback: false,
  })

  assert.deepEqual(targets, {
    primaryKey: 'provider:tool-child:server-summary',
    parentHandoffKey: 'provider:tool-child',
  })
})

test('server summary forked from an active tool child does not mirror raw child state to the fallback tool key', () => {
  const summaryContext = forkProviderConversationContext(
    {
      ...createProxyContext(),
      providerConversationSessionKey: 'provider:tool-child',
      parentProviderConversationSessionKey: 'provider:main',
      sessionBoundaryReason: 'tool_child',
    },
    {
      reason: 'server_summary',
      epochSource: {
        originalMessageCount: 20,
        finalMessageCount: 6,
        summary: '[Prior conversation summary] active child workflow compacted',
      },
    },
  )

  const targets = decideProviderConversationStateWriteTargets({
    context: summaryContext,
    primaryKey: 'provider:tool-child:server-summary',
    fallbackToolSessionKey: 'tool:main',
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'child summary result' },
    ],
    mirrorToFallback: true,
  })

  assert.deepEqual(targets, {
    primaryKey: 'provider:tool-child:server-summary',
    parentHandoffKey: 'provider:tool-child',
  })
})

test('chat route sets provider conversation keys from openai session identity helper', () => {
  const chatRouteSource = readFileSync('src/main/proxy/routes/chat.ts', 'utf8')
  const helperSource = readFileSync('src/main/proxy/routes/openaiSession.ts', 'utf8')

  assert.match(chatRouteSource, /import\s+\{\s*applyOpenAISessionIdentity\s*\}\s+from\s+'\.\/openaiSession\.ts'/)
  assert.match(chatRouteSource, /const context = applyOpenAISessionIdentity\(/)
  assert.match(helperSource, /toolCatalogSessionKey: sessionIdentity\.toolCatalogSessionKey/)
  assert.match(helperSource, /providerConversationSessionKey: sessionIdentity\.providerConversationSessionKey/)
})

test('forkProviderConversationContext creates child provider key without changing tool catalog key', () => {
  const context = createProxyContext()
  const forkedA = forkProviderConversationContext(context, {
    reason: 'server_summary',
    epochSource: {
      originalMessageCount: 12,
      finalMessageCount: 4,
      summary: '[Prior conversation summary] compacted',
    },
  })
  const forkedB = forkProviderConversationContext(context, {
    reason: 'server_summary',
    epochSource: {
      originalMessageCount: 12,
      finalMessageCount: 4,
      summary: '[Prior conversation summary] compacted',
    },
  })

  assert.equal(forkedA.toolCatalogSessionKey, context.toolCatalogSessionKey)
  assert.equal(forkedA.parentProviderConversationSessionKey, context.providerConversationSessionKey)
  assert.equal(forkedA.sessionBoundaryReason, 'server_summary')
  assert.notEqual(forkedA.providerConversationSessionKey, context.providerConversationSessionKey)
  assert.equal(forkedA.providerConversationSessionKey, forkedB.providerConversationSessionKey)
  assert.match(forkedA.providerSessionEpoch ?? '', /^server_summary:[a-f0-9]{24}$/)
})

test('server-summary fork from a tool-child provider context keeps the tool catalog key and preserves the parent chain', () => {
  const toolChildContext: ProxyContext = {
    ...createProxyContext(),
    providerConversationSessionKey: 'openai-chat:base-provider-key:tool:child-epoch',
    providerSessionEpoch: 'tool:child-epoch',
    parentProviderConversationSessionKey: 'openai-chat:base-provider-key',
    sessionBoundaryReason: 'tool_child',
  }

  const summaryFork = forkProviderConversationContext(toolChildContext, {
    reason: 'server_summary',
    epochSource: {
      originalMessageCount: 18,
      finalMessageCount: 5,
      summary: '[Prior conversation summary] child workflow was compacted',
    },
  })

  assert.equal(summaryFork.toolCatalogSessionKey, toolChildContext.toolCatalogSessionKey)
  assert.equal(summaryFork.parentProviderConversationSessionKey, toolChildContext.providerConversationSessionKey)
  assert.equal(summaryFork.sessionBoundaryReason, 'server_summary')
  assert.notEqual(summaryFork.providerConversationSessionKey, toolChildContext.providerConversationSessionKey)
  assert.equal(summaryFork.providerSessionEpoch?.startsWith('server_summary:'), true)
  assert.match(
    summaryFork.providerConversationSessionKey ?? '',
    /^openai-chat:base-provider-key:tool:child-epoch:server_summary:[a-f0-9]{24}$/,
  )
})

test('forwarder source isolates summary generator and server summary provider sessions', () => {
  const forwarderSource = readFileSync('src/main/proxy/forwarder.ts', 'utf8')

  assert.match(forwarderSource, /reason: 'summary_generator'/)
  assert.match(forwarderSource, /reason: 'server_summary'/)
  assert.match(forwarderSource, /summaryContext/)
  assert.match(forwarderSource, /let forwardContext = context/)
  assert.match(
    forwarderSource,
    /this\.doForward\(modifiedRequest, account, provider, actualModel, forwardContext,\s*contextProcessResult\)/,
  )
})

test('forwarder source imports and uses preserveContextManagedMessageMetadata for trimmed context', () => {
  const forwarderSource = readFileSync('src/main/proxy/forwarder.ts', 'utf8')

  assert.match(
    forwarderSource,
    /import\s+\{\s*preserveContextManagedMessageMetadata\s*\}\s+from\s+'\.\/contextMessageMetadata\.ts'/,
  )
  assert.match(
    forwarderSource,
    /messages:\s*preserveContextManagedMessageMetadata\(\s*modifiedRequest\.messages,\s*this\.toRequestMessages\(processResult\.messages\)\s*\)/,
  )
})

test('prompt budget diagnostics are full on first qwen turn and minimal on stable second turn', () => {
  promptBudgetSnapshotCache.clear()

  const context = createProxyContext()
  const provider = makeProvider()
  const account = makeAccount()
  const transformed = makeTransformResult({
    plan: {
      ...makeTransformResult().plan,
      catalogSnapshot: {
        sessionId: 'openai-chat:base-tool-key',
        fingerprint: 'catalog-fp-1',
        tools: [],
        allowedToolNames: [],
        schemaHashes: {},
        source: 'current_request',
        createdTurnIndex: 1,
        updatedTurnIndex: 1,
      },
      catalogDiagnostics: {
        source: 'current_request',
        fingerprint: 'catalog-fp-1',
        driftKinds: [],
        blocked: false,
      },
      diagnostics: {
        ...makeTransformResult().plan.diagnostics,
        catalogFingerprint: 'catalog-fp-1',
      },
    },
  })
  const request = {
    model: 'Qwen3-Max',
    messages: [{ role: 'user' as const, content: 'hello' }],
    stream: false,
  }
  const providerConversationStateKey = 'qwen:acc-1:Qwen3-Max:openai-chat:base-provider-key'

  const first = {
    decision: decidePromptBudgetPolicy(buildPromptBudgetPolicyInput({
      requestMessages: request.messages,
      sessionBoundaryReason: context.sessionBoundaryReason,
      providerId: provider.id,
      accountId: account.id,
      actualModel: 'Qwen3-Max',
      toolSessionKey: context.toolCatalogSessionKey!,
      providerConversationSessionKey: providerConversationStateKey,
      toolCatalogFingerprint: transformed.plan.catalogSnapshot?.fingerprint,
      hasActiveTools: transformed.plan.tools.length > 0,
      hasManagedToolCapableTurn: transformed.plan.mode === 'managed' || transformed.plan.shouldParseResponse,
    })),
  }
  assert.equal(first.decision.promptRefreshMode, 'full')
  assert.ok(first.decision.reasons.includes('fresh_provider_session'))
  recordPromptBudgetSnapshot(providerConversationStateKey, {
    providerId: provider.id,
    modelId: 'Qwen3-Max',
    accountId: account.id,
    toolCatalogFingerprint: transformed.plan.catalogSnapshot?.fingerprint,
  })

  const second = {
    decision: decidePromptBudgetPolicy(buildPromptBudgetPolicyInput({
      requestMessages: request.messages,
      sessionBoundaryReason: context.sessionBoundaryReason,
      providerId: provider.id,
      accountId: account.id,
      actualModel: 'Qwen3-Max',
      toolSessionKey: context.toolCatalogSessionKey!,
      providerConversationSessionKey: providerConversationStateKey,
      toolCatalogFingerprint: transformed.plan.catalogSnapshot?.fingerprint,
      hasActiveTools: transformed.plan.tools.length > 0,
      hasManagedToolCapableTurn: transformed.plan.mode === 'managed' || transformed.plan.shouldParseResponse,
      previousSnapshot: promptBudgetSnapshotCache.get(providerConversationStateKey),
    })),
  }
  assert.equal(second.decision.promptRefreshMode, 'minimal')
  assert.deepEqual(second.decision.reasons, ['stable_normal_continuation'])
})

test('prompt budget diagnostics report tool_ready for active qwen tool follow-up and full on boundary', () => {
  promptBudgetSnapshotCache.clear()

  const context = createProxyContext()
  const provider = makeProvider()
  const account = makeAccount()
  const providerConversationStateKey = 'qwen:acc-1:Qwen3-Max:openai-chat:base-provider-key'

  recordPromptBudgetSnapshot(providerConversationStateKey, {
    providerId: provider.id,
    modelId: 'Qwen3-Max',
    accountId: account.id,
    toolCatalogFingerprint: 'catalog-fp-1',
  })

  const transformed = makeTransformResult({
    plan: {
      ...makeTransformResult().plan,
      mode: 'managed',
      shouldParseResponse: true,
      tools: [{
        name: 'bash',
        parameters: { type: 'object' },
        source: 'openai',
      }],
      catalogSnapshot: {
        sessionId: 'openai-chat:base-tool-key',
        fingerprint: 'catalog-fp-1',
        tools: [],
        allowedToolNames: [],
        schemaHashes: {},
        source: 'current_request',
        createdTurnIndex: 1,
        updatedTurnIndex: 1,
      },
      contract: {
        ...makeTransformResult().plan.contract,
        shouldParseResponse: true,
      },
      diagnostics: {
        ...makeTransformResult().plan.diagnostics,
        mode: 'managed',
      },
    },
  })

  const toolReady = {
    decision: decidePromptBudgetPolicy(buildPromptBudgetPolicyInput({
      requestMessages: [
        { role: 'assistant' as const, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
        { role: 'tool' as const, tool_call_id: 'call_1' },
      ],
      sessionBoundaryReason: context.sessionBoundaryReason,
      providerId: provider.id,
      accountId: account.id,
      actualModel: 'Qwen3-Max',
      toolSessionKey: context.toolCatalogSessionKey!,
      providerConversationSessionKey: providerConversationStateKey,
      toolCatalogFingerprint: transformed.plan.catalogSnapshot?.fingerprint,
      hasActiveTools: transformed.plan.tools.length > 0,
      hasManagedToolCapableTurn: transformed.plan.mode === 'managed' || transformed.plan.shouldParseResponse,
      previousSnapshot: promptBudgetSnapshotCache.get(providerConversationStateKey),
    })),
  }
  assert.equal(toolReady.decision.promptRefreshMode, 'tool_ready')
  assert.ok(toolReady.decision.reasons.includes('current_tool_result_present'))

  const boundaryInput = buildPromptBudgetPolicyInput({
    requestMessages: [{ role: 'user' as const }],
    sessionBoundaryReason: 'client_compact',
    providerId: provider.id,
    accountId: account.id,
    actualModel: 'Qwen3-Max',
    toolSessionKey: context.toolCatalogSessionKey!,
    providerConversationSessionKey: providerConversationStateKey,
    toolCatalogFingerprint: undefined,
    hasActiveTools: false,
    hasManagedToolCapableTurn: false,
    previousSnapshot: {
      providerId: provider.id,
      modelId: 'Qwen3-Max',
      accountId: account.id,
      toolCatalogFingerprint: 'catalog-fp-1',
    },
  })
  assert.equal(boundaryInput.sessionBoundaryReason, 'client_compact')
  assert.equal(boundaryInput.providerConversationSessionKey, providerConversationStateKey)

  const boundary = {
    decision: decidePromptBudgetPolicy(buildPromptBudgetPolicyInput({
      requestMessages: [{ role: 'user' as const }],
      sessionBoundaryReason: 'client_compact',
      providerId: provider.id,
      accountId: account.id,
      actualModel: 'Qwen3-Max',
      toolSessionKey: context.toolCatalogSessionKey!,
      providerConversationSessionKey: `${providerConversationStateKey}:compact`,
      toolCatalogFingerprint: undefined,
      hasActiveTools: false,
      hasManagedToolCapableTurn: false,
    })),
  }
  assert.equal(boundary.decision.promptRefreshMode, 'full')
  assert.ok(boundary.decision.reasons.includes('session_boundary_client_compact'))
})

test('prompt budget policy input and decision use the forked tool-child provider key and boundary reason', () => {
  promptBudgetSnapshotCache.clear()

  const provider = makeProvider()
  const account = makeAccount()
  const toolChildContext: ProxyContext = {
    ...createProxyContext(),
    providerConversationSessionKey: 'openai-chat:base-provider-key:tool:child-epoch',
    providerSessionEpoch: 'tool:child-epoch',
    parentProviderConversationSessionKey: 'openai-chat:base-provider-key',
    sessionBoundaryReason: 'tool_child',
  }
  const transformed = makeTransformResult({
    plan: {
      ...makeTransformResult().plan,
      catalogSnapshot: {
        sessionId: 'openai-chat:base-tool-key',
        fingerprint: 'catalog-fp-1',
        tools: [],
        allowedToolNames: [],
        schemaHashes: {},
        source: 'current_request',
        createdTurnIndex: 1,
        updatedTurnIndex: 1,
      },
      diagnostics: {
        ...makeTransformResult().plan.diagnostics,
        catalogFingerprint: 'catalog-fp-1',
      },
    },
  })
  const request = {
    model: 'Qwen3-Max',
    messages: [
      {
        role: 'assistant' as const,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
      },
      { role: 'tool' as const, tool_call_id: 'call_1' },
    ],
    stream: false,
  }
  const providerConversationStateKey = 'qwen:acc-1:Qwen3-Max:openai-chat:base-provider-key:tool:child-epoch'
  const forwarderSource = readFileSync('src/main/proxy/forwarder.ts', 'utf8')

  assert.match(
    forwarderSource,
    /sessionBoundaryReason:\s*input\.context\.sessionBoundaryReason/,
  )
  assert.match(
    forwarderSource,
    /providerConversationSessionKey:\s*input\.providerConversationStateKey/,
  )

  const policyInput = buildPromptBudgetPolicyInput({
    requestMessages: request.messages,
    sessionBoundaryReason: toolChildContext.sessionBoundaryReason,
    providerId: provider.id,
    accountId: account.id,
    actualModel: 'Qwen3-Max',
    toolSessionKey: toolChildContext.toolCatalogSessionKey!,
    providerConversationSessionKey: providerConversationStateKey,
    toolCatalogFingerprint: transformed.plan.catalogSnapshot?.fingerprint,
    hasActiveTools: transformed.plan.tools.length > 0,
    hasManagedToolCapableTurn: transformed.plan.mode === 'managed' || transformed.plan.shouldParseResponse,
  })

  assert.equal(policyInput.sessionBoundaryReason, 'tool_child')
  assert.equal(policyInput.providerConversationSessionKey, providerConversationStateKey)
  assert.equal(policyInput.toolCatalogSessionKey, toolChildContext.toolCatalogSessionKey)

  const decision = decidePromptBudgetPolicy(policyInput)
  assert.equal(decision.promptRefreshMode, 'full')
  assert.ok(decision.reasons.includes('fresh_provider_session'))
  assert.ok(decision.reasons.includes('session_boundary_tool_child'))
})

test('prompt budget uses the grouped tool-child provider key across a contiguous workflow', () => {
  promptBudgetSnapshotCache.clear()

  const provider = makeProvider()
  const account = makeAccount()
  const firstStepIdentity = deriveOpenAISessionIdentity({
    request: {
      model: 'Qwen3-Max',
      messages: [
        { role: 'user', content: 'Use tools to inspect the repo.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_read_1', type: 'function', function: { name: 'read', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call_read_1', content: 'first result' },
      ],
      metadata: { session_id: 'tool-session-1' },
    } as any,
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })
  const laterStepIdentity = deriveOpenAISessionIdentity({
    request: {
      model: 'Qwen3-Max',
      messages: [
        { role: 'user', content: 'Use tools to inspect the repo.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_read_1', type: 'function', function: { name: 'read', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call_read_1', content: 'first result' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_grep_2', type: 'function', function: { name: 'grep', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call_grep_2', content: 'second result' },
      ],
      metadata: { session_id: 'tool-session-1' },
    } as any,
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  assert.equal(firstStepIdentity.providerConversationSessionKey, laterStepIdentity.providerConversationSessionKey)

  const policyInput = buildPromptBudgetPolicyInput({
    requestMessages: [
      {
        role: 'assistant',
        tool_calls: [{ id: 'call_grep_2', type: 'function', function: { name: 'grep', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_grep_2' },
    ],
    sessionBoundaryReason: laterStepIdentity.sessionBoundaryReason,
    providerId: provider.id,
    accountId: account.id,
    actualModel: 'Qwen3-Max',
    toolSessionKey: laterStepIdentity.toolCatalogSessionKey,
    providerConversationSessionKey: `qwen:${account.id}:Qwen3-Max:${laterStepIdentity.providerConversationSessionKey}`,
    toolCatalogFingerprint: 'catalog-fp-1',
    hasActiveTools: true,
    hasManagedToolCapableTurn: true,
  })

  assert.equal(policyInput.sessionBoundaryReason, 'tool_child')
  assert.equal(
    policyInput.providerConversationSessionKey,
    `qwen:${account.id}:Qwen3-Max:${laterStepIdentity.providerConversationSessionKey}`,
  )
})

test('server-summary child forks preserve tool-child ancestry in the provider key for downstream diagnostics', () => {
  const toolChildContext: ProxyContext = {
    ...createProxyContext(),
    providerConversationSessionKey: 'openai-chat:base-provider-key:tool:child-epoch',
    providerSessionEpoch: 'tool:child-epoch',
    parentProviderConversationSessionKey: 'openai-chat:base-provider-key',
    sessionBoundaryReason: 'tool_child',
  }

  const summaryFork = forkProviderConversationContext(toolChildContext, {
    reason: 'server_summary',
    epochSource: {
      originalMessageCount: 18,
      finalMessageCount: 5,
      summary: '[Prior conversation summary] child workflow compacted',
    },
  })

  const policyInput = buildPromptBudgetPolicyInput({
    requestMessages: [
      {
        role: 'assistant',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1' },
    ],
    sessionBoundaryReason: summaryFork.sessionBoundaryReason,
    providerId: 'qwen',
    accountId: 'acc-1',
    actualModel: 'Qwen3-Max',
    toolSessionKey: summaryFork.toolCatalogSessionKey!,
    providerConversationSessionKey: `qwen:acc-1:Qwen3-Max:${summaryFork.providerConversationSessionKey}`,
    toolCatalogFingerprint: 'catalog-fp-1',
    hasActiveTools: true,
    hasManagedToolCapableTurn: true,
  })

  assert.equal(policyInput.sessionBoundaryReason, 'server_summary')
  assert.match(
    policyInput.providerConversationSessionKey,
    /openai-chat:base-provider-key:tool:child-epoch:server_summary:/,
  )
})

test('server-summary active qwen tool continuation stays tool_ready when identity and fingerprints are stable', () => {
  promptBudgetSnapshotCache.clear()

  const summaryFork = forkProviderConversationContext({
    ...createProxyContext(),
    providerConversationSessionKey: 'openai-chat:base-provider-key:tool:child-epoch',
    providerSessionEpoch: 'tool:child-epoch',
    parentProviderConversationSessionKey: 'openai-chat:base-provider-key',
    sessionBoundaryReason: 'tool_child',
  }, {
    reason: 'server_summary',
    epochSource: {
      originalMessageCount: 18,
      finalMessageCount: 5,
      summary: '[Prior conversation summary] child workflow compacted',
    },
  })

  const providerConversationStateKey = `qwen:acc-1:Qwen3-Max:${summaryFork.providerConversationSessionKey}`
  recordPromptBudgetSnapshot(providerConversationStateKey, {
    providerId: 'qwen',
    modelId: 'Qwen3-Max',
    accountId: 'acc-1',
    toolCatalogFingerprint: 'catalog-fp-1',
  })

  const decision = decidePromptBudgetPolicy(buildPromptBudgetPolicyInput({
    requestMessages: [
      {
        role: 'assistant' as const,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }],
      },
      { role: 'tool' as const, tool_call_id: 'call_1', content: 'read done' },
    ],
    sessionBoundaryReason: summaryFork.sessionBoundaryReason,
    providerId: 'qwen',
    accountId: 'acc-1',
    actualModel: 'Qwen3-Max',
    toolSessionKey: summaryFork.toolCatalogSessionKey!,
    providerConversationSessionKey: providerConversationStateKey,
    toolCatalogFingerprint: 'catalog-fp-1',
    hasActiveTools: true,
    hasManagedToolCapableTurn: true,
    previousSnapshot: promptBudgetSnapshotCache.get(providerConversationStateKey),
  }))

  assert.equal(decision.promptRefreshMode, 'tool_ready')
  assert.deepEqual(decision.reasons, [
    'server_summary_active_tool_continuation',
    'current_tool_result_present',
    'previous_assistant_tool_calls_present',
    'managed_tool_turn_present',
  ])
})

test('server-summary active qwen tool continuation stays tool_ready on a fresh summary fork without a cached snapshot', () => {
  promptBudgetSnapshotCache.clear()

  const summaryFork = forkProviderConversationContext({
    ...createProxyContext(),
    providerConversationSessionKey: 'openai-chat:base-provider-key:tool:child-epoch',
    providerSessionEpoch: 'tool:child-epoch',
    parentProviderConversationSessionKey: 'openai-chat:base-provider-key',
    sessionBoundaryReason: 'tool_child',
  }, {
    reason: 'server_summary',
    epochSource: {
      originalMessageCount: 22,
      finalMessageCount: 6,
      summary: '[Prior conversation summary] active child workflow compacted again',
    },
  })

  const decision = decidePromptBudgetPolicy(buildPromptBudgetPolicyInput({
    requestMessages: [
      {
        role: 'assistant' as const,
        tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'bash', arguments: '{}' } }],
      },
      { role: 'tool' as const, tool_call_id: 'call_2', content: 'bash done' },
    ],
    sessionBoundaryReason: summaryFork.sessionBoundaryReason,
    providerId: 'qwen',
    accountId: 'acc-1',
    actualModel: 'Qwen3-Max',
    toolSessionKey: summaryFork.toolCatalogSessionKey!,
    providerConversationSessionKey: `qwen:acc-1:Qwen3-Max:${summaryFork.providerConversationSessionKey}`,
    toolCatalogFingerprint: 'catalog-fp-1',
    hasActiveTools: true,
    hasManagedToolCapableTurn: true,
  }))

  assert.equal(decision.promptRefreshMode, 'tool_ready')
  assert.equal(decision.reasons.includes('fresh_provider_session'), false)
  assert.equal(decision.reasons.includes('identity_uncertain'), false)
  assert.equal(decision.reasons.includes('fingerprint_uncertain'), false)
  assert.deepEqual(decision.reasons, [
    'server_summary_active_tool_continuation',
    'current_tool_result_present',
    'previous_assistant_tool_calls_present',
    'managed_tool_turn_present',
  ])
})

test('server-summary active qwen tool continuation still upgrades to full when skill fingerprint drifts', () => {
  const decision = decidePromptBudgetPolicy(buildPromptBudgetPolicyInput({
    requestMessages: [
      {
        role: 'assistant' as const,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }],
      },
      { role: 'tool' as const, tool_call_id: 'call_1', content: 'read done' },
    ],
    sessionBoundaryReason: 'server_summary',
    providerId: 'qwen',
    accountId: 'acc-1',
    actualModel: 'Qwen3-Max',
    toolSessionKey: 'openai-chat:base-tool-key',
    providerConversationSessionKey: 'qwen:acc-1:Qwen3-Max:server-summary-child',
    toolCatalogFingerprint: 'catalog-fp-1',
    hasActiveTools: true,
    hasManagedToolCapableTurn: true,
    previousSnapshot: {
      providerId: 'qwen',
      modelId: 'Qwen3-Max',
      accountId: 'acc-1',
      toolCatalogFingerprint: 'catalog-fp-1',
      skillFingerprint: 'skill-fp-old',
    },
    skillFingerprint: 'skill-fp-new',
  }))

  assert.equal(decision.promptRefreshMode, 'full')
  assert.deepEqual(decision.reasons, ['skill_fingerprint_changed'])
})

test('server-summary fresh qwen turn without an active tool tail still stays full', () => {
  const decision = decidePromptBudgetPolicy(buildPromptBudgetPolicyInput({
    requestMessages: [{ role: 'user' as const, content: 'continue' }],
    sessionBoundaryReason: 'server_summary',
    providerId: 'qwen',
    accountId: 'acc-1',
    actualModel: 'Qwen3-Max',
    toolSessionKey: 'openai-chat:base-tool-key',
    providerConversationSessionKey: 'qwen:acc-1:Qwen3-Max:server-summary-child',
    toolCatalogFingerprint: 'catalog-fp-1',
    hasActiveTools: false,
    hasManagedToolCapableTurn: false,
  }))

  assert.equal(decision.promptRefreshMode, 'full')
  assert.ok(decision.reasons.includes('fresh_provider_session'))
  assert.ok(decision.reasons.includes('session_boundary_server_summary'))
})

test('server-summary fresh qwen turn with tools available but no assistant tool tail still stays full', () => {
  const decision = decidePromptBudgetPolicy(buildPromptBudgetPolicyInput({
    requestMessages: [{ role: 'user' as const, content: 'continue with available tools' }],
    sessionBoundaryReason: 'server_summary',
    providerId: 'qwen',
    accountId: 'acc-1',
    actualModel: 'Qwen3-Max',
    toolSessionKey: 'openai-chat:base-tool-key',
    providerConversationSessionKey: 'qwen:acc-1:Qwen3-Max:server-summary-child',
    toolCatalogFingerprint: 'catalog-fp-1',
    hasActiveTools: true,
    hasManagedToolCapableTurn: true,
  }))

  assert.equal(decision.promptRefreshMode, 'full')
  assert.ok(decision.reasons.includes('fresh_provider_session'))
  assert.ok(decision.reasons.includes('session_boundary_server_summary'))
  assert.equal(decision.reasons.includes('server_summary_active_tool_continuation'), false)
})

test('historical tool cycle followed by assistant answer and user follow-up is not treated as active tool_ready tail', () => {
  const signals = inspectRecentPromptBudgetToolSignals([
    { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1' },
    { role: 'assistant' },
    { role: 'user' },
  ])

  assert.deepEqual(signals, {
    hasCurrentToolResult: false,
    hasPreviousAssistantToolCalls: false,
  })

  promptBudgetSnapshotCache.clear()
  recordPromptBudgetSnapshot('stable-tail', {
    providerId: 'qwen',
    modelId: 'Qwen3-Max',
    accountId: 'acc-1',
    toolCatalogFingerprint: 'catalog-fp-1',
    skillFingerprint: 'skill-fp-1',
  })

  const decision = decidePromptBudgetPolicy(buildPromptBudgetPolicyInput({
    requestMessages: [
      { role: 'assistant' as const, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'tool' as const, tool_call_id: 'call_1' },
      { role: 'assistant' as const },
      { role: 'user' as const },
    ],
    sessionBoundaryReason: 'normal',
    providerId: 'qwen',
    accountId: 'acc-1',
    actualModel: 'Qwen3-Max',
    toolSessionKey: 'openai-chat:base-tool-key',
    providerConversationSessionKey: 'stable-tail',
    toolCatalogFingerprint: 'catalog-fp-1',
    hasActiveTools: false,
    hasManagedToolCapableTurn: false,
    previousSnapshot: promptBudgetSnapshotCache.get('stable-tail'),
    skillFingerprint: 'skill-fp-1',
  }))

  assert.equal(decision.promptRefreshMode, 'digest')
  assert.deepEqual(decision.reasons, ['skill_fingerprint_present'])
})

test('tool_ready qwen assembly preserves completed read evidence and the next exact bash step after server summary', () => {
  const body = buildQwenAssemblyRequestBodyForTest({
    assembly: {
      messages: [
        { role: 'system', content: 'system directive' },
        {
          role: 'system',
          content: [
            '[Active skill workflow state checkpoint]',
            'Latest pinned skill instructions remain authoritative.',
            '1 completed tool exchange(s) already finished after the latest pinned skill instruction exchange.',
            '1. read completed | artifact: tests/agent-capability/input.txt | evidence: input body',
            'Next required skill step: 2. Use the `bash` tool to run:',
            '   `New-Item -ItemType Directory -Force -Path .agent-probe | Out-Null; node -e "const fs=require(\'fs\');const text=fs.readFileSync(\'tests/agent-capability/input.txt\',\'utf8\');fs.writeFileSync(\'.agent-probe/long-step-1.txt\', \'STEP1=\' + text.length + \'\\n\', \'utf8\');"`',
            'Listed read/bash/write steps above are already complete. Do not repeat completed reads or bash writes; continue with the first not-yet-completed skill instruction.',
          ].join('\n'),
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_skill', type: 'function', function: { name: 'skill', arguments: '{"name":"long-conversation-probe"}' } }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_skill',
          content: [
            '<skill_content name="long-conversation-probe">',
            '1. Use the read tool to read tests/agent-capability/input.txt.',
            '2. Use the `bash` tool to run:',
            '   `New-Item -ItemType Directory -Force -Path .agent-probe | Out-Null; node -e "const fs=require(\'fs\');const text=fs.readFileSync(\'tests/agent-capability/input.txt\',\'utf8\');fs.writeFileSync(\'.agent-probe/long-step-1.txt\', \'STEP1=\' + text.length + \'\\n\', \'utf8\');"`',
            '</skill_content>',
          ].join('\n'),
        },
      ],
      summaryText: '[Prior conversation summary] active workflow compacted',
      toolManifest: {
        renderedPrompt: 'tool schema',
      } as any,
    },
    request: {
      model: 'Qwen3-Max',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_read_input', type: 'function', function: { name: 'read', arguments: '{"filePath":"tests/agent-capability/input.txt"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_read_input', content: 'input body' },
      ],
      promptRefreshMode: 'tool_ready',
      sessionId: 'server-summary-fork',
    },
    actualModel: 'Qwen3-Max',
    sessionId: 'provider-session',
    reqId: 'req-2',
    parentReqId: 'req-1',
    timestamp: 1,
    enableThinking: false,
    enableWebSearch: false,
  })

  const content = String(body.messages[0]?.content ?? '')
  assert.match(content, /\[Active skill workflow state checkpoint\]/)
  assert.match(content, /1\. read completed \| artifact: tests\/agent-capability\/input\.txt/i)
  assert.match(content, /Next required skill step: 2\. Use the `bash` tool to run:/i)
  assert.match(content, /New-Item -ItemType Directory -Force -Path \.agent-probe/i)
  assert.match(content, /writeFileSync\('\.agent-probe\/long-step-1\.txt'/i)
  assert.match(content, /Do not repeat completed reads or bash writes/i)
  assert.equal(content.includes('input body input body'), false)
})

test('tool_ready qwen assembly trace reports managed tool contract without logging prompt content', () => {
  const logs: string[] = []
  const originalLog = console.log
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '))
  }

  try {
    buildQwenAssemblyRequestBodyForTest({
      assembly: {
        messages: [
          { role: 'system', content: 'system directive' },
          { role: 'system', content: '[Prior conversation summary] compacted tool workflow' },
          { role: 'assistant', content: null, tool_calls: [makeToolCall('call_read_input', 'read', '{"filePath":"tests/agent-capability/input.txt"}')] },
          { role: 'tool', tool_call_id: 'call_read_input', content: 'input body' },
        ],
        summaryText: '[Prior conversation summary] compacted tool workflow',
        toolManifest: {
          renderedPrompt: [
            'catalog_fingerprint: catalog-fp-1',
            '<|CHAT2API|tool_calls><|CHAT2API|invoke name="read"></|CHAT2API|invoke></|CHAT2API|tool_calls>',
          ].join('\n'),
        } as any,
      },
      request: {
        model: 'Qwen3-Max',
        messages: [
          { role: 'assistant', content: null, tool_calls: [makeToolCall('call_read_input', 'read', '{"filePath":"tests/agent-capability/input.txt"}')] },
          { role: 'tool', tool_call_id: 'call_read_input', content: 'input body' },
        ],
        promptRefreshMode: 'tool_ready',
        sessionId: 'server-summary-fork',
      },
      actualModel: 'Qwen3-Max',
      sessionId: 'provider-session',
      reqId: 'req-trace',
      parentReqId: 'req-previous',
      timestamp: 1,
      enableThinking: false,
      enableWebSearch: false,
    })
  } finally {
    console.log = originalLog
  }

  const traceLine = logs.find(line => line.startsWith('[Qwen] Request assembly trace: '))
  assert.ok(traceLine, 'expected qwen assembly path to emit a request assembly trace')
  const traceJson = traceLine.replace('[Qwen] Request assembly trace: ', '')
  const trace = JSON.parse(traceJson)

  assert.equal(trace.messageCount, 4)
  assert.equal(trace.systemMessageCount, 1)
  assert.equal(trace.conversationPartCount, 2)
  assert.equal(trace.hasManagedToolContract, true)
  assert.equal(trace.hasSummaryIsolationHeader, true)
  assert.equal(trace.promptRefreshMode, 'tool_ready')
  assert.equal(typeof trace.finalContentLength, 'number')
  assert.ok(trace.finalContentLength > 0)
  assert.equal(traceLine.includes('<|CHAT2API|tool_calls>'), false)
  assert.equal(traceLine.includes('catalog_fingerprint:'), false)
  assert.equal(traceLine.includes('tests/agent-capability/input.txt'), false)
})

test('tool_ready qwen assembly preserves step 8 bash command checkpoint after server summary', async () => {
  const step2Command = 'New-Item -ItemType Directory -Force -Path .agent-probe | Out-Null; node -e "const fs=require(\'fs\');const text=fs.readFileSync(\'tests/agent-capability/input.txt\',\'utf8\');fs.writeFileSync(\'.agent-probe/long-step-1.txt\', \'STEP1=\' + text.length + \'\\n\', \'utf8\');"'
  const step4Command = 'node -e "const fs=require(\'fs\');const step1=fs.readFileSync(\'.agent-probe/long-step-1.txt\',\'utf8\').trim();const payload=fs.readFileSync(\'tests/agent-capability/long-conversation-payload.txt\',\'utf8\').split(/\\r?\\n/)[0];fs.writeFileSync(\'.agent-probe/long-step-2.txt\', step1 + \'|STEP2=\' + payload + \'\\n\', \'utf8\');"'
  const step5Command = 'node -e "const {spawnSync}=require(\'child_process\');const fs=require(\'fs\');const run=spawnSync(process.execPath,[\'tests/agent-capability/compute-result.mjs\',\'tests/agent-capability/input.txt\'],{encoding:\'utf8\'});if(run.status!==0){process.stderr.write(run.stderr||\'\');process.exit(run.status||1);}fs.writeFileSync(\'.agent-probe/long-result.json\', run.stdout, \'utf8\');"'
  const step6Command = 'node -e "const fs=require(\'fs\');const result=JSON.parse(fs.readFileSync(\'.agent-probe/long-result.json\',\'utf8\'));fs.writeFileSync(\'.agent-probe/long-check-1.txt\',\'CHECK1=\' + result.lineCount + \'\\n\',\'utf8\');"'
  const step7Command = 'node -e "const fs=require(\'fs\');const result=JSON.parse(fs.readFileSync(\'.agent-probe/long-result.json\',\'utf8\'));fs.writeFileSync(\'.agent-probe/long-check-2.txt\',\'CHECK2=\' + result.byteLength + \'\\n\',\'utf8\');"'
  const step8Command = 'node -e "const fs=require(\'fs\');const step2=fs.readFileSync(\'.agent-probe/long-step-2.txt\',\'utf8\').trim();fs.writeFileSync(\'.agent-probe/long-summary.txt\', step2 + \'|LONG_CONVERSATION_PROBE_DONE\\n\',\'utf8\');"'
  const skillInstructions = [
    '<skill_content name="long-conversation-probe">',
    '1. Use the `read` tool to read `tests/agent-capability/input.txt`.',
    '2. Use the `bash` tool to run:',
    `   \`${step2Command}\``,
    '3. Use the `read` tool to read `tests/agent-capability/long-conversation-payload.txt`.',
    '4. Use the `bash` tool to run:',
    `   \`${step4Command}\``,
    '5. Use the `bash` tool to run:',
    `   \`${step5Command}\``,
    '6. Use the `bash` tool to run:',
    `   \`${step6Command}\``,
    '7. Use the `bash` tool to run:',
    `   \`${step7Command}\``,
    '8. Use the `bash` tool to run:',
    `   \`${step8Command}\``,
    '</skill_content>',
  ].join('\n')
  const messages: ChatMessage[] = [
    { role: 'system', content: 'system directive' },
    { role: 'assistant', content: '## Available Tools\n- skill\n- read\n- bash' },
    { role: 'user', content: 'Run the long conversation probe.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_skill_live', 'skill', '{"name":"long-conversation-probe"}')],
    },
    { role: 'tool', tool_call_id: 'call_skill_live', content: skillInstructions },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_read_input', 'read', '{"filePath":"tests/agent-capability/input.txt"}')],
    },
    { role: 'tool', tool_call_id: 'call_read_input', content: 'input body' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_bash_step_1', 'bash', JSON.stringify({ command: step2Command }))],
    },
    { role: 'tool', tool_call_id: 'call_bash_step_1', content: 'created .agent-probe/long-step-1.txt' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_read_payload', 'read', '{"filePath":"tests/agent-capability/long-conversation-payload.txt"}')],
    },
    { role: 'tool', tool_call_id: 'call_read_payload', content: 'payload body' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_bash_step_2', 'bash', JSON.stringify({ command: step4Command }))],
    },
    { role: 'tool', tool_call_id: 'call_bash_step_2', content: 'created .agent-probe/long-step-2.txt' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_bash_result', 'bash', JSON.stringify({ command: step5Command }))],
    },
    { role: 'tool', tool_call_id: 'call_bash_result', content: 'created .agent-probe/long-result.json' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_bash_check_1', 'bash', JSON.stringify({ command: step6Command }))],
    },
    { role: 'tool', tool_call_id: 'call_bash_check_1', content: 'created .agent-probe/long-check-1.txt' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [makeToolCall('call_bash_check_2', 'bash', JSON.stringify({ command: step7Command }))],
    },
    { role: 'tool', tool_call_id: 'call_bash_check_2', content: 'created .agent-probe/long-check-2.txt' },
  ]
  const service = createContextManagementService({
    enabled: true,
    strategies: {
      slidingWindow: { enabled: true, maxMessages: 8 },
      tokenLimit: { enabled: false, maxTokens: 4000 },
      summary: { enabled: true, keepRecentMessages: 4, summaryPrompt: 'Summarize progress only.' },
    },
    executionOrder: ['summary', 'slidingWindow'],
  }, async () => 'Probe progress summary without tool catalog restatement.')
  const processed = await service.process(messages)

  const body = buildQwenAssemblyRequestBodyForTest({
    assembly: {
      messages: processed.messages,
      summaryText: '[Prior conversation summary] active workflow compacted',
      toolManifest: {
        renderedPrompt: 'tool schema',
      } as any,
    },
    request: {
      model: 'Qwen3-Max',
      messages: processed.messages,
      promptRefreshMode: 'tool_ready',
      sessionId: 'server-summary-fork',
    },
    actualModel: 'Qwen3-Max',
    sessionId: 'provider-session',
    reqId: 'req-step8',
    parentReqId: 'req-previous',
    timestamp: 1,
    enableThinking: false,
    enableWebSearch: false,
  })

  const content = String(body.messages[0]?.content ?? '')
  assert.match(content, /\[Active skill workflow state checkpoint\]/)
  assert.match(content, /Required next action: call the bash tool/i)
  assert.match(content, /Required next tool arguments: command=/i)
  assert.match(content, /writeFileSync\('\.agent-probe\/long-summary\.txt'/i)
  assert.match(content, /Do not call bash with any other command\./i)
  assert.match(content, /Only the bash tool is valid/i)
  assert.doesNotMatch(content, /Required next tool arguments: filePath=tests\/agent-capability\/input\.txt/i)

  const lastCheckpointIndex = content.lastIndexOf('[Active skill workflow state checkpoint]')
  const lastInitialReadInstructionIndex = content.lastIndexOf('1. Use the `read` tool to read `tests/agent-capability/input.txt`.')
  assert.ok(
    lastCheckpointIndex > lastInitialReadInstructionIndex,
    'active checkpoint must be closer to the model than the pinned skill step 1 text',
  )
})
