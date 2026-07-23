import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyOpenAISessionIdentity,
  deriveOpenAISessionIdentity,
} from '../../src/main/proxy/routes/openaiSession.ts'
import { prepareAndForwardChatCompletion } from '../../src/main/proxy/routes/chat.ts'
import { forkProviderConversationContext } from '../../src/main/proxy/sessionBoundary.ts'
import type { ChatCompletionRequest, ProxyContext } from '../../src/main/proxy/types.ts'
import type { Context } from 'koa'

function createRequest(messages: ChatCompletionRequest['messages'], extras: Record<string, unknown> = {}): ChatCompletionRequest {
  return {
    model: 'Qwen3.7-Max',
    messages,
    ...(extras as Partial<ChatCompletionRequest>),
  }
}

function createContext(overrides: Partial<ProxyContext> = {}): ProxyContext {
  return {
    requestId: 'req-1',
    providerId: 'qwen',
    accountId: 'acc-1',
    model: 'Qwen3.7-Max',
    actualModel: 'Qwen3.7-Max',
    startTime: 1,
    isStream: false,
    clientIP: '127.0.0.1',
    ...overrides,
  }
}

function createRouteContext(
  request: ChatCompletionRequest,
  headers: Record<string, string | string[] | undefined> = {},
): Context {
  return {
    headers,
    request: {
      body: request,
    },
    ip: '127.0.0.1',
    set() {
      // No-op for route helper tests.
    },
  } as unknown as Context
}

test('same stable history without user derives the same tool and provider key for a normal turn', () => {
  const requestA = createRequest([
    { role: 'user', content: 'Remember project Chat2API and nonce alpha.' },
  ])
  const requestB = createRequest([
    { role: 'user', content: 'Remember project Chat2API and nonce alpha.' },
    { role: 'assistant', content: 'Stored.' },
    { role: 'user', content: 'What did I ask you to remember?' },
  ])

  const identityA = deriveOpenAISessionIdentity({
    request: requestA,
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })
  const identityB = deriveOpenAISessionIdentity({
    request: requestB,
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  assert.equal(identityA.source, 'derived_hash')
  assert.equal(identityB.source, 'derived_hash')
  assert.equal(identityA.sessionBoundaryReason, 'normal')
  assert.equal(identityB.sessionBoundaryReason, 'normal')
  assert.equal(identityA.toolCatalogSessionKey, identityB.toolCatalogSessionKey)
  assert.equal(identityA.providerConversationSessionKey, identityA.toolCatalogSessionKey)
  assert.equal(identityB.providerConversationSessionKey, identityB.toolCatalogSessionKey)
})

test('different first prefix derives different base session key', () => {
  const identityA = deriveOpenAISessionIdentity({
    request: createRequest([
      { role: 'user', content: 'prefix one' },
      { role: 'assistant', content: 'stored one' },
    ]),
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })
  const identityB = deriveOpenAISessionIdentity({
    request: createRequest([
      { role: 'user', content: 'prefix two' },
      { role: 'assistant', content: 'stored one' },
    ]),
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  assert.equal(identityA.source, 'derived_hash')
  assert.equal(identityB.source, 'derived_hash')
  assert.notEqual(identityA.toolCatalogSessionKey, identityB.toolCatalogSessionKey)
})

test('explicit header wins over derived hash for a normal turn', () => {
  const identity = deriveOpenAISessionIdentity({
    request: createRequest([
      { role: 'user', content: 'prefix one' },
      { role: 'assistant', content: 'stored one' },
    ]),
    headers: {
      'x-session-id': 'client-session-123',
    },
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  assert.equal(identity.source, 'header')
  assert.equal(identity.sessionBoundaryReason, 'normal')
  assert.match(identity.toolCatalogSessionKey, /^openai-chat:[a-f0-9]{24}$/)
  assert.equal(identity.providerConversationSessionKey, identity.toolCatalogSessionKey)
  assert.doesNotMatch(identity.toolCatalogSessionKey, /client-session-123/)
})

test('compact summary with stable header keeps tool key but forks provider key to deterministic compact epoch', () => {
  const normalIdentity = deriveOpenAISessionIdentity({
    request: createRequest([
      { role: 'user', content: 'Remember nonce beta.' },
      { role: 'assistant', content: 'Stored.' },
      { role: 'user', content: 'Recall it.' },
    ]),
    headers: {
      'x-session-id': 'stable-client-session',
    },
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  const compactRequest = createRequest([
    { role: 'system', content: '[Prior conversation summary] Remember nonce beta and continue carefully.' },
    { role: 'user', content: 'Recall it after compact.' },
  ])

  const compactIdentityA = deriveOpenAISessionIdentity({
    request: compactRequest,
    headers: {
      'x-session-id': 'stable-client-session',
    },
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })
  const compactIdentityB = deriveOpenAISessionIdentity({
    request: compactRequest,
    headers: {
      'x-session-id': 'stable-client-session',
    },
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  assert.equal(compactIdentityA.sessionBoundaryReason, 'client_compact')
  assert.equal(compactIdentityA.toolCatalogSessionKey, normalIdentity.toolCatalogSessionKey)
  assert.notEqual(compactIdentityA.providerConversationSessionKey, normalIdentity.providerConversationSessionKey)
  assert.equal(compactIdentityA.providerConversationSessionKey, compactIdentityB.providerConversationSessionKey)
  assert.match(compactIdentityA.providerConversationSessionKey, /^openai-chat:[a-f0-9]{24}:compact:[a-f0-9]{24}$/)
  assert.equal(compactIdentityA.parentProviderConversationSessionKey, normalIdentity.toolCatalogSessionKey)
})

test('compact summary can also be detected from metadata session id and summary marker text', () => {
  const normalIdentity = deriveOpenAISessionIdentity({
    request: createRequest([
      { role: 'user', content: 'Track repo task delta.' },
    ], {
      metadata: {
        session_id: 'metadata-session-1',
      },
    }),
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  const compactIdentity = deriveOpenAISessionIdentity({
    request: createRequest([
      { role: 'user', content: '/compact conversation summary: track repo task delta.' },
      { role: 'assistant', content: 'Continue from the summary only.' },
    ], {
      metadata: {
        session_id: 'metadata-session-1',
      },
    }),
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  assert.equal(compactIdentity.source, 'metadata')
  assert.equal(compactIdentity.toolCatalogSessionKey, normalIdentity.toolCatalogSessionKey)
  assert.notEqual(compactIdentity.providerConversationSessionKey, normalIdentity.providerConversationSessionKey)
  assert.equal(compactIdentity.sessionBoundaryReason, 'client_compact')
})

test('tool workflow start forks provider key but keeps the logical tool catalog key', () => {
  const normalIdentity = deriveOpenAISessionIdentity({
    request: createRequest([
      { role: 'user', content: 'Use tools to inspect the repo.' },
    ], {
      metadata: {
        session_id: 'tool-session-1',
      },
    }),
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  const toolChildA = deriveOpenAISessionIdentity({
    request: createRequest([
      { role: 'user', content: 'Use tools to inspect the repo.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_read_1',
            type: 'function',
            function: { name: 'read', arguments: '{"filePath":"src/main.ts"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_read_1', content: 'file contents preview' },
    ], {
      metadata: {
        session_id: 'tool-session-1',
      },
    }),
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })
  const toolChildB = deriveOpenAISessionIdentity({
    request: createRequest([
      { role: 'user', content: 'Use tools to inspect the repo.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_read_1',
            type: 'function',
            function: { name: 'read', arguments: '{"filePath":"src/main.ts"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_read_1', content: 'file contents preview' },
    ], {
      metadata: {
        session_id: 'tool-session-1',
      },
    }),
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  assert.equal(toolChildA.sessionBoundaryReason, 'tool_child')
  assert.equal(toolChildA.toolCatalogSessionKey, normalIdentity.toolCatalogSessionKey)
  assert.equal(toolChildA.parentProviderConversationSessionKey, normalIdentity.providerConversationSessionKey)
  assert.notEqual(toolChildA.providerConversationSessionKey, normalIdentity.providerConversationSessionKey)
  assert.equal(toolChildA.providerConversationSessionKey, toolChildB.providerConversationSessionKey)
  assert.match(toolChildA.providerConversationSessionKey, /^openai-chat:[a-f0-9]{24}:tool:[a-f0-9]{24}$/)
})

test('contiguous tool workflow turns reuse the same tool-child provider key across multiple tool results', () => {
  const firstStep = deriveOpenAISessionIdentity({
    request: createRequest([
      { role: 'user', content: 'Use tools to inspect the repo.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_read_1',
            type: 'function',
            function: { name: 'read', arguments: '{"filePath":"src/main.ts"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_read_1', content: 'file contents preview' },
    ], {
      metadata: {
        session_id: 'tool-session-1',
      },
    }),
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  const laterStep = deriveOpenAISessionIdentity({
    request: createRequest([
      { role: 'user', content: 'Use tools to inspect the repo.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_read_1',
            type: 'function',
            function: { name: 'read', arguments: '{"filePath":"src/main.ts"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_read_1', content: 'file contents preview' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_grep_2',
            type: 'function',
            function: { name: 'grep', arguments: '{"pattern":"TODO","path":"src"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_grep_2', content: 'TODO found in src/main.ts' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_bash_3',
            type: 'function',
            function: { name: 'bash', arguments: '{"command":"npm test"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_bash_3', content: 'tests passed' },
    ], {
      metadata: {
        session_id: 'tool-session-1',
      },
    }),
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  assert.equal(firstStep.sessionBoundaryReason, 'tool_child')
  assert.equal(laterStep.sessionBoundaryReason, 'tool_child')
  assert.equal(laterStep.parentProviderConversationSessionKey, firstStep.parentProviderConversationSessionKey)
  assert.equal(laterStep.providerConversationSessionKey, firstStep.providerConversationSessionKey)
})

test('OpenCode-style skill tool result marker keeps the workflow in grouped tool-child even when the latest non-system role is not native tool', () => {
  const firstStep = deriveOpenAISessionIdentity({
    request: createRequest([
      { role: 'user', content: 'Run the long conversation probe.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_skill_live',
            type: 'function',
            function: { name: 'skill', arguments: '{"name":"long-conversation-probe"}' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          '<skill_content name="long-conversation-probe">',
          '1. Read tests/agent-capability/input.txt exactly once.',
          '2. Use bash to write .agent-probe/long-step-1.txt.',
          '</skill_content>',
        ].join('\n'),
      },
    ], {
      metadata: {
        session_id: 'tool-session-opencode-1',
      },
    }),
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  const laterStep = deriveOpenAISessionIdentity({
    request: createRequest([
      { role: 'user', content: 'Run the long conversation probe.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_skill_live',
            type: 'function',
            function: { name: 'skill', arguments: '{"name":"long-conversation-probe"}' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          '<skill_content name="long-conversation-probe">',
          '1. Read tests/agent-capability/input.txt exactly once.',
          '2. Use bash to write .agent-probe/long-step-1.txt.',
          '</skill_content>',
        ].join('\n'),
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_read_input',
            type: 'function',
            function: { name: 'read', arguments: '{"filePath":"tests/agent-capability/input.txt"}' },
          },
        ],
      },
      {
        role: 'user',
        content: '{"type":"tool","tool":"read","state":{"status":"completed"},"title":"Read input"}',
      },
    ], {
      metadata: {
        session_id: 'tool-session-opencode-1',
      },
    }),
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  assert.equal(firstStep.sessionBoundaryReason, 'tool_child')
  assert.equal(laterStep.sessionBoundaryReason, 'tool_child')
  assert.equal(laterStep.parentProviderConversationSessionKey, firstStep.parentProviderConversationSessionKey)
  assert.equal(laterStep.providerConversationSessionKey, firstStep.providerConversationSessionKey)
})

test('active grouped tool workflow wins over compact-style summary markers until the workflow is genuinely settled', () => {
  const identity = deriveOpenAISessionIdentity({
    request: createRequest([
      { role: 'system', content: '[Prior conversation summary] Continue the probe carefully.' },
      { role: 'user', content: 'Run the long conversation probe.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_read_1',
            type: 'function',
            function: { name: 'read', arguments: '{"filePath":"tests/agent-capability/input.txt"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_read_1', content: 'input contents' },
    ], {
      metadata: {
        session_id: 'tool-session-priority-1',
      },
    }),
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  assert.equal(identity.sessionBoundaryReason, 'tool_child')
  assert.match(identity.providerConversationSessionKey, /^openai-chat:[a-f0-9]{24}:tool:[a-f0-9]{24}$/)
})

test('server-summary fork from a tool-child context keeps the parent chain inspectable and rotates the provider key again', () => {
  const toolChildIdentity = deriveOpenAISessionIdentity({
    request: createRequest([
      { role: 'user', content: 'Use tools to inspect the repo.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_read_1',
            type: 'function',
            function: { name: 'read', arguments: '{"filePath":"src/main.ts"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_read_1', content: 'file contents preview' },
    ], {
      metadata: {
        session_id: 'tool-session-1',
      },
    }),
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  const toolChildContext = applyOpenAISessionIdentity(createContext(), createRequest([
    { role: 'user', content: 'Use tools to inspect the repo.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_read_1',
          type: 'function',
          function: { name: 'read', arguments: '{"filePath":"src/main.ts"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call_read_1', content: 'file contents preview' },
  ], {
    metadata: {
      session_id: 'tool-session-1',
    },
  }))

  const summaryFork = forkProviderConversationContext(toolChildContext, {
    reason: 'server_summary',
    epochSource: {
      originalMessageCount: 8,
      finalMessageCount: 3,
      summary: '[Prior conversation summary] repo inspection is already complete',
    },
  })

  assert.equal(toolChildContext.providerConversationSessionKey, toolChildIdentity.providerConversationSessionKey)
  assert.equal(summaryFork.toolCatalogSessionKey, toolChildIdentity.toolCatalogSessionKey)
  assert.equal(summaryFork.parentProviderConversationSessionKey, toolChildIdentity.providerConversationSessionKey)
  assert.equal(summaryFork.sessionBoundaryReason, 'server_summary')
  assert.notEqual(summaryFork.providerConversationSessionKey, toolChildIdentity.providerConversationSessionKey)
  assert.match(
    summaryFork.providerConversationSessionKey ?? '',
    /^openai-chat:[a-f0-9]{24}:tool:[a-f0-9]{24}:server_summary:[a-f0-9]{24}$/,
  )
})

test('historical tool results do not fork provider key when the latest turn is a new user message', () => {
  const identity = deriveOpenAISessionIdentity({
    request: createRequest([
      { role: 'user', content: 'Use tools to inspect the repo.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_read_1',
            type: 'function',
            function: { name: 'read', arguments: '{"filePath":"src/main.ts"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_read_1', content: 'file contents preview' },
      { role: 'assistant', content: 'The file was inspected.' },
      { role: 'user', content: 'Now continue with a normal follow-up.' },
    ], {
      metadata: {
        session_id: 'tool-session-1',
      },
    }),
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  assert.equal(identity.sessionBoundaryReason, 'normal')
  assert.equal(identity.providerConversationSessionKey, identity.toolCatalogSessionKey)
})

test('a settled assistant answer ends the tool workflow and returns to normal provider state', () => {
  const identity = deriveOpenAISessionIdentity({
    request: createRequest([
      { role: 'user', content: 'Use tools to inspect the repo.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_read_1',
            type: 'function',
            function: { name: 'read', arguments: '{"filePath":"src/main.ts"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_read_1', content: 'file contents preview' },
      { role: 'assistant', content: 'Inspection complete. The repo looks healthy.' },
    ], {
      metadata: {
        session_id: 'tool-session-1',
      },
    }),
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  assert.equal(identity.sessionBoundaryReason, 'normal')
  assert.equal(identity.providerConversationSessionKey, identity.toolCatalogSessionKey)
})

test('different independent tool workflows do not collide', () => {
  const workflowA = deriveOpenAISessionIdentity({
    request: createRequest([
      { role: 'user', content: 'Inspect src/main.ts.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_read_1',
            type: 'function',
            function: { name: 'read', arguments: '{"filePath":"src/main.ts"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_read_1', content: 'main file contents' },
    ], {
      metadata: {
        session_id: 'tool-session-1',
      },
    }),
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  const workflowB = deriveOpenAISessionIdentity({
    request: createRequest([
      { role: 'user', content: 'Inspect src/worker.ts instead.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_read_9',
            type: 'function',
            function: { name: 'read', arguments: '{"filePath":"src/worker.ts"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_read_9', content: 'worker file contents' },
    ], {
      metadata: {
        session_id: 'tool-session-1',
      },
    }),
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  assert.equal(workflowA.sessionBoundaryReason, 'tool_child')
  assert.equal(workflowB.sessionBoundaryReason, 'tool_child')
  assert.notEqual(workflowA.providerConversationSessionKey, workflowB.providerConversationSessionKey)
})

test('subagent metadata forks provider key while preserving the logical tool catalog key', () => {
  const mainIdentity = deriveOpenAISessionIdentity({
    request: createRequest([
      { role: 'user', content: 'Main task for the repo.' },
    ], {
      metadata: {
        session_id: 'main-session-1',
      },
    }),
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  const subagentA = deriveOpenAISessionIdentity({
    request: createRequest([
      { role: 'user', content: 'Worker task for one slice.' },
    ], {
      metadata: {
        session_id: 'main-session-1',
        agent_run_id: 'worker-run-1',
      },
    }),
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })
  const subagentB = deriveOpenAISessionIdentity({
    request: createRequest([
      { role: 'user', content: 'Worker task for one slice.' },
    ], {
      metadata: {
        session_id: 'main-session-1',
        agent_run_id: 'worker-run-2',
      },
    }),
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  assert.equal(subagentA.sessionBoundaryReason, 'subagent_child')
  assert.equal(subagentA.toolCatalogSessionKey, mainIdentity.toolCatalogSessionKey)
  assert.notEqual(subagentA.providerConversationSessionKey, mainIdentity.providerConversationSessionKey)
  assert.notEqual(subagentA.providerConversationSessionKey, subagentB.providerConversationSessionKey)
  assert.match(subagentA.providerConversationSessionKey, /^openai-chat:[a-f0-9]{24}:subagent:[a-f0-9]{24}$/)
  assert.equal(subagentA.parentProviderConversationSessionKey, mainIdentity.providerConversationSessionKey)
})

test('tool result inside a subagent forks from the subagent provider key, not the main provider key', () => {
  const subagentIdentity = deriveOpenAISessionIdentity({
    request: createRequest([
      { role: 'user', content: 'Worker task for one slice.' },
    ], {
      metadata: {
        session_id: 'main-session-1',
        agent_run_id: 'worker-run-1',
      },
    }),
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  const subagentToolChild = deriveOpenAISessionIdentity({
    request: createRequest([
      { role: 'user', content: 'Worker task for one slice.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_worker_read',
            type: 'function',
            function: { name: 'read', arguments: '{"filePath":"worker.txt"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_worker_read', content: 'worker file contents' },
    ], {
      metadata: {
        session_id: 'main-session-1',
        agent_run_id: 'worker-run-1',
      },
    }),
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  assert.equal(subagentToolChild.sessionBoundaryReason, 'tool_child')
  assert.equal(subagentToolChild.toolCatalogSessionKey, subagentIdentity.toolCatalogSessionKey)
  assert.notEqual(subagentToolChild.providerConversationSessionKey, subagentIdentity.providerConversationSessionKey)
  assert.equal(subagentToolChild.parentProviderConversationSessionKey, subagentIdentity.providerConversationSessionKey)
  assert.match(
    subagentToolChild.providerConversationSessionKey,
    /^openai-chat:[a-f0-9]{24}:subagent:[a-f0-9]{24}:tool:[a-f0-9]{24}$/,
  )
})

test('subagent child and subagent tool child provider keys do not collide', () => {
  const subagentIdentity = deriveOpenAISessionIdentity({
    request: createRequest([
      { role: 'user', content: 'Worker task for one slice.' },
    ], {
      metadata: {
        session_id: 'main-session-1',
        agent_run_id: 'worker-run-1',
      },
    }),
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  const subagentToolChild = deriveOpenAISessionIdentity({
    request: createRequest([
      { role: 'user', content: 'Worker task for one slice.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_worker_read',
            type: 'function',
            function: { name: 'read', arguments: '{"filePath":"worker.txt"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_worker_read', content: 'worker file contents' },
    ], {
      metadata: {
        session_id: 'main-session-1',
        agent_run_id: 'worker-run-1',
      },
    }),
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  assert.equal(subagentIdentity.sessionBoundaryReason, 'subagent_child')
  assert.equal(subagentToolChild.sessionBoundaryReason, 'tool_child')
  assert.notEqual(subagentIdentity.providerConversationSessionKey, subagentToolChild.providerConversationSessionKey)
  assert.equal(subagentToolChild.parentProviderConversationSessionKey, subagentIdentity.providerConversationSessionKey)
})

test('chat route context assigns split session keys and compact diagnostics', () => {
  const request = createRequest([
    { role: 'system', content: '[Prior conversation summary] Repo state loaded.' },
    { role: 'user', content: 'conversation summary says continue the same task.' },
  ])

  const expected = deriveOpenAISessionIdentity({
    request,
    headers: {
      'x-session-id': 'compact-session-1',
    },
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  const context = applyOpenAISessionIdentity(createContext(), request, {
    'x-session-id': 'compact-session-1',
  })

  assert.equal(context.toolCatalogSessionKey, expected.toolCatalogSessionKey)
  assert.equal(context.providerConversationSessionKey, expected.providerConversationSessionKey)
  assert.equal(context.providerSessionEpoch, expected.providerSessionEpoch)
  assert.equal(context.parentProviderConversationSessionKey, expected.parentProviderConversationSessionKey)
  assert.equal(context.sessionBoundaryReason, 'client_compact')
  assert.notEqual(context.toolCatalogSessionKey, context.providerConversationSessionKey)
})

test('explicit header identity is still assigned to both session dimensions for ordinary continuation', () => {
  const request = createRequest([
    { role: 'user', content: 'Remember nonce gamma.' },
  ])

  const context = applyOpenAISessionIdentity(createContext(), request, {
    'x-session-id': 'stable-client-session',
  })

  assert.equal(context.sessionBoundaryReason, 'normal')
  assert.equal(context.providerSessionEpoch, 'main')
  assert.equal(context.toolCatalogSessionKey, context.providerConversationSessionKey)
  assert.match(context.toolCatalogSessionKey ?? '', /^openai-chat:[a-f0-9]{24}$/)
  assert.equal(context.recoverySessionId, context.toolCatalogSessionKey)
})

test('recovery session bridge is explicit and only enabled for stable client identity', () => {
  const stable = applyOpenAISessionIdentity(createContext(), createRequest([
    { role: 'user', content: 'Continue stable task.' },
  ]), {
    'x-session-id': 'stable-client-session',
  })
  assert.equal(stable.recoverySessionId, stable.toolCatalogSessionKey)
  assert.equal(stable.parentRecoverySessionId, undefined)

  const fallback = applyOpenAISessionIdentity(createContext(), createRequest([
    { role: 'user', content: 'No explicit stable session.' },
  ]))
  assert.equal(fallback.recoverySessionId, undefined)

  const child = applyOpenAISessionIdentity(createContext(), createRequest([
    { role: 'user', content: 'Use tool.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_read',
        type: 'function',
        function: { name: 'read', arguments: '{"filePath":"a.ts"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_read', content: 'result' },
  ]), {
    'x-session-id': 'stable-client-session',
  })
  assert.equal(child.sessionBoundaryReason, 'tool_child')
  assert.notEqual(child.recoverySessionId, child.providerConversationSessionKey)
  assert.equal(child.parentRecoverySessionId, stable.recoverySessionId)
  assert.equal(child.recoveryToolCallId, 'call_read')
})

test('recovery session bridge keeps recovery identity isolated from provider epochs', () => {
  const main = applyOpenAISessionIdentity(createContext(), createRequest([
    { role: 'user', content: 'Stable main task.' },
  ]), {
    'x-session-id': 'stable-client-session',
  })
  const compactedMain = applyOpenAISessionIdentity(createContext(), createRequest([
    { role: 'user', content: '/compact Stable main task summary.' },
  ]), {
    'x-session-id': 'stable-client-session',
  })

  assert.notEqual(compactedMain.providerConversationSessionKey, main.providerConversationSessionKey)
  assert.equal(compactedMain.recoverySessionId, main.recoverySessionId)

  const childA = applyOpenAISessionIdentity(createContext(), createRequest([
    { role: 'user', content: 'Use tool.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_read',
        type: 'function',
        function: { name: 'read', arguments: '{"filePath":"a.ts"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_read', content: 'result' },
  ]), {
    'x-session-id': 'stable-client-session',
  })
  const childARetryDifferentProviderEpoch = applyOpenAISessionIdentity(createContext(), createRequest([
    { role: 'system', content: 'different provider-only prompt prefix' },
    { role: 'user', content: 'Use tool.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_read',
        type: 'function',
        function: { name: 'read', arguments: '{"filePath":"changed-provider-payload.ts"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_read', content: 'result' },
  ]), {
    'x-session-id': 'stable-client-session',
  })
  const childB = applyOpenAISessionIdentity(createContext(), createRequest([
    { role: 'user', content: 'Use another tool.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_write',
        type: 'function',
        function: { name: 'write', arguments: '{"filePath":"a.ts"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_write', content: 'ok' },
  ]), {
    'x-session-id': 'stable-client-session',
  })

  assert.notEqual(childA.providerConversationSessionKey, childARetryDifferentProviderEpoch.providerConversationSessionKey)
  assert.equal(childA.recoverySessionId, childARetryDifferentProviderEpoch.recoverySessionId)
  assert.notEqual(childA.recoverySessionId, childA.providerConversationSessionKey)
  assert.notEqual(childA.recoverySessionId, childB.recoverySessionId)
  assert.equal(childA.parentRecoverySessionId, main.recoverySessionId)
  assert.equal(childARetryDifferentProviderEpoch.parentRecoverySessionId, main.recoverySessionId)

  const subagentA = applyOpenAISessionIdentity(createContext(), createRequest([
    { role: 'user', content: 'Run subagent.' },
  ], { metadata: { subagent_id: 'worker-a' } }), {
    'x-session-id': 'stable-client-session',
  })
  const subagentARetry = applyOpenAISessionIdentity(createContext({ requestId: 'different-request-id' }), createRequest([
    { role: 'user', content: 'Run subagent retry.' },
  ], { metadata: { subagent_id: 'worker-a' } }), {
    'x-session-id': 'stable-client-session',
  })

  assert.equal(subagentA.sessionBoundaryReason, 'subagent_child')
  assert.notEqual(subagentA.recoverySessionId, subagentA.providerConversationSessionKey)
  assert.equal(subagentA.recoverySessionId, subagentARetry.recoverySessionId)
  assert.equal(subagentA.parentRecoverySessionId, main.recoverySessionId)
})

test('applyOpenAISessionIdentity preserves runtime-set server_summary boundary', () => {
  const context = applyOpenAISessionIdentity(
    createContext({ sessionBoundaryReason: 'server_summary' }),
    createRequest([
      { role: 'user', content: 'Continue after compaction.' },
      { role: 'assistant', content: 'Task state preserved.' },
    ]),
  )
  assert.equal(context.sessionBoundaryReason, 'server_summary',
    'must preserve runtime-set server_summary instead of overwriting to normal')
})

test('applyOpenAISessionIdentity preserves runtime-set summary_generator boundary', () => {
  const context = applyOpenAISessionIdentity(
    createContext({ sessionBoundaryReason: 'summary_generator' }),
    createRequest([
      { role: 'user', content: 'Summarize the conversation.' },
    ]),
  )
  assert.equal(context.sessionBoundaryReason, 'summary_generator',
    'must preserve runtime-set summary_generator instead of overwriting to normal')
})

test('chat route helper forwards grouped tool workflow as tool_child while keeping the parent tool catalog key stable', async () => {
  const request = createRequest([
    { role: 'user', content: 'Use tools to inspect the repo.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_read_1',
          type: 'function',
          function: { name: 'read', arguments: '{"filePath":"src/main.ts"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call_read_1', content: 'file contents preview' },
  ], {
    metadata: {
      session_id: 'tool-session-route-1',
    },
  })

  let capturedContext: ProxyContext | undefined

  const prepared = await prepareAndForwardChatCompletion(
    createRouteContext(request),
    {
      getConfig: () => ({ loadBalanceStrategy: 'round_robin' }),
      getPreferredProvider: () => undefined,
      getPreferredAccount: () => undefined,
      selectAccount: () => ({
        account: {
          id: 'acc-1',
          name: 'Account 1',
          requestCount: 0,
          todayUsed: 0,
        },
        provider: {
          id: 'qwen',
          name: 'Qwen',
        },
        actualModel: 'Qwen3.7-Max',
      } as any),
      recordRequestStart: () => undefined,
      forwardChatCompletion: async (_request, _account, _provider, _actualModel, context) => {
        capturedContext = context
        return { success: true, body: { ok: true } }
      },
    },
  )

  assert.ok(prepared)
  assert.ok(capturedContext)

  const expected = deriveOpenAISessionIdentity({
    request,
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  assert.equal(capturedContext.sessionBoundaryReason, 'tool_child')
  assert.equal(capturedContext.toolCatalogSessionKey, expected.toolCatalogSessionKey)
  assert.equal(capturedContext.parentProviderConversationSessionKey, expected.parentProviderConversationSessionKey)
  assert.equal(capturedContext.providerConversationSessionKey, expected.providerConversationSessionKey)
  assert.equal(capturedContext.toolCatalogSessionKey, capturedContext.parentProviderConversationSessionKey)
  assert.notEqual(capturedContext.toolCatalogSessionKey, capturedContext.providerConversationSessionKey)
})

test('chat route helper forwards subagent metadata as subagent_child without forking the tool catalog key', async () => {
  const request = createRequest([
    { role: 'user', content: 'Worker task for one slice.' },
  ], {
    metadata: {
      session_id: 'main-session-route-1',
      agent_run_id: 'worker-route-1',
    },
  })

  let capturedContext: ProxyContext | undefined

  const prepared = await prepareAndForwardChatCompletion(
    createRouteContext(request),
    {
      getConfig: () => ({ loadBalanceStrategy: 'round_robin' }),
      getPreferredProvider: () => undefined,
      getPreferredAccount: () => undefined,
      selectAccount: () => ({
        account: {
          id: 'acc-1',
          name: 'Account 1',
          requestCount: 0,
          todayUsed: 0,
        },
        provider: {
          id: 'qwen',
          name: 'Qwen',
        },
        actualModel: 'Qwen3.7-Max',
      } as any),
      recordRequestStart: () => undefined,
      forwardChatCompletion: async (_request, _account, _provider, _actualModel, context) => {
        capturedContext = context
        return { success: true, body: { ok: true } }
      },
    },
  )

  assert.ok(prepared)
  assert.ok(capturedContext)

  const expected = deriveOpenAISessionIdentity({
    request,
    clientIP: '127.0.0.1',
    providerId: 'qwen',
  })

  assert.equal(capturedContext.sessionBoundaryReason, 'subagent_child')
  assert.equal(capturedContext.toolCatalogSessionKey, expected.toolCatalogSessionKey)
  assert.equal(capturedContext.parentProviderConversationSessionKey, expected.parentProviderConversationSessionKey)
  assert.equal(capturedContext.providerConversationSessionKey, expected.providerConversationSessionKey)
  assert.equal(capturedContext.toolCatalogSessionKey, capturedContext.parentProviderConversationSessionKey)
  assert.notEqual(capturedContext.toolCatalogSessionKey, capturedContext.providerConversationSessionKey)
})
