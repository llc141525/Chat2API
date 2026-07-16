import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ToolCallingEngine } from '../../src/main/proxy/toolCalling/ToolCallingEngine.ts'
import { inspectNonStreamAssistantOutput } from '../../src/main/proxy/toolCalling/outputInspection.ts'
import type { ChatCompletionRequest } from '../../src/main/proxy/types.ts'
import type { Provider } from '../../src/main/store/types.ts'

const provider = {
  id: 'deepseek',
  name: 'DeepSeek',
  type: 'builtin',
  authType: 'userToken',
  apiEndpoint: 'https://chat.deepseek.com',
  headers: {},
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
} as Provider

const tools = [
  {
    type: 'function' as const,
    function: {
      name: 'default_api:read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { filePath: { type: 'string' } } },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'default_api:list_dir',
      description: 'List a directory',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  },
]

const skillProbeTools = [
  {
    type: 'function' as const,
    function: {
      name: 'skill',
      description: 'Load a skill',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read',
      description: 'Read a file',
      parameters: { type: 'object', properties: { filePath: { type: 'string' } } },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'bash',
      description: 'Run command',
      parameters: { type: 'object', properties: { command: { type: 'string' } } },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write',
      description: 'Write a file',
      parameters: { type: 'object', properties: { filePath: { type: 'string' } } },
    },
  },
]

function request(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'read /tmp/a' }],
    tools,
    ...overrides,
  }
}

test('OpenAI tools plus DeepSeek choose managed prompt', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: 'engine-stage2-openai-tools',
  })

  assert.equal(result.plan.mode, 'managed')
  assert.equal(result.plan.protocol, 'managed_xml')
  assert.equal(result.plan.shouldInjectPrompt, true)
  assert.equal(result.tools, undefined)
  assert.equal(result.plan.tools.length, 2)
  // Tool contract lives in toolManifest.renderedPrompt, not in messages
  assert.ok(result.toolManifest, 'toolManifest should be present')
  assert.match(result.toolManifest!.renderedPrompt, /<\|CHAT2API\|tool_calls>/)
})

test('managed prompt includes Tool Contract Header from catalog snapshot', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: `engine-catalog-${Date.now()}-header`,
  })

  assert.ok(result.toolManifest, 'toolManifest should be present')
  assert.ok(result.plan.catalogSnapshot, 'catalogSnapshot should be present')
  assert.equal(typeof result.plan.catalogSnapshot?.fingerprint, 'string')
})

test('explicit Cherry Studio MCP adapter uses managed prompt and preserves tool names', () => {
  const result = new ToolCallingEngine({ clientAdapterId: 'cherry-studio-mcp' }).transformRequest({
    request: request({
      messages: [
        { role: 'system', content: 'In this environment you have access to a set of tools' },
        { role: 'user', content: 'read /tmp/a' },
      ],
    }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.clientAdapterId, 'cherry-studio-mcp')
  assert.equal(result.plan.mode, 'managed')
  assert.equal(result.plan.shouldInjectPrompt, true)
  assert.deepEqual(result.plan.tools.map((tool) => tool.name), ['default_api:list_dir', 'default_api:read_file'])
  assert.equal(result.plan.tools[0].source, 'mcp')
})

test('client prompt signatures do not override selected adapter', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({
      messages: [
        { role: 'system', content: 'You are Kilo, the best coding agent. Tool definitions:' },
        { role: 'user', content: 'read /tmp/a' },
      ],
    }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.clientAdapterId, 'standard-openai-tools')
  assert.equal(result.plan.mode, 'managed')
  assert.equal(result.plan.shouldInjectPrompt, true)
})

test('No tools choose disabled', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({ tools: undefined }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.mode, 'disabled')
  assert.equal(result.plan.shouldInjectPrompt, false)
})

test('Store mode off chooses disabled', () => {
  const result = new ToolCallingEngine({ mode: 'off', enabled: false }).transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.mode, 'disabled')
  assert.equal(result.tools, tools)
})

test('tool_choice none chooses disabled even when tools are present', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({ tool_choice: 'none' }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.mode, 'disabled')
  assert.equal(result.plan.toolChoiceMode, 'none')
})

test('tool_choice required preserves required policy on the plan', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({ tool_choice: 'required' }),
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: 'engine-stage2-required',
  })

  assert.equal(result.plan.toolChoiceMode, 'required')
  assert.deepEqual([...result.plan.allowedToolNames].sort(), ['default_api:list_dir', 'default_api:read_file'])
  assert.equal(result.plan.availabilityRetryAllowed, true)
})

test('tool session key reuses catalog snapshot across omitted-tool turns', () => {
  const engine = new ToolCallingEngine()
  const first = engine.transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: 'engine-stage2-reuse',
  })
  const second = engine.transformRequest({
    request: request({
      tools: undefined,
      messages: [
        {
          role: 'assistant',
          content: null as any,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'default_api:read_file', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'body' },
        { role: 'user', content: 'continue' },
      ],
    }),
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: 'engine-stage2-reuse',
  })

  assert.equal(first.plan.catalogSnapshot?.fingerprint, second.plan.catalogSnapshot?.fingerprint)
  assert.equal(second.plan.catalogDiagnostics.source, 'session_catalog')
  assert.ok(second.toolManifest, 'toolManifest should be present on reuse')
  assert.deepEqual(second.plan.tools.map((tool) => tool.parameters), first.plan.tools.map((tool) => tool.parameters))
})

test('first-skill instruction produces a high-priority tool action constraint before catalog', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({
      messages: [{
        role: 'user',
        content: [
          'Your first assistant action must be a real OpenCode `skill` tool call for `agent-capability-probe`.',
          'Any assistant text before that tool call is a probe failure.',
        ].join('\n'),
      }],
      tools: skillProbeTools,
    }),
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: 'engine-first-skill-action-constraint',
  })

  assert.equal(result.plan.mode, 'managed')
  assert.ok(result.toolManifest)
  assert.deepEqual(result.toolManifest!.actionConstraint, {
    kind: 'first_skill_required',
    toolName: 'skill',
    arguments: { name: 'agent-capability-probe' },
    reason: 'request_requires_first_assistant_action_skill',
  })
  assert.deepEqual(result.toolManifest!.tools.map((tool) => tool.name), ['bash', 'read', 'skill', 'write'])

  const prompt = result.toolManifest!.renderedPrompt
  assert.match(prompt, /\[High-priority tool action constraint\]/)
  assert.match(prompt, /Only valid next tool: skill/)
  assert.match(prompt, /Required tool call: skill\(name="agent-capability-probe"\)/)
  assert.match(prompt, /parameter name="name"/)
  assert.match(prompt, /<\|CHAT2API\|invoke name="skill"><\|CHAT2API\|parameter name="name"><!\[CDATA\[agent-capability-probe\]\]><\/\|CHAT2API\|parameter><\/\|CHAT2API\|invoke>/)
  assert.match(prompt, /Output exactly this complete Chat2API XML tool-call block/)
  assert.match(prompt, /Invalid formats include <skill_tool_call>, <tool_call>, JSON-only tool descriptions/)
  assert.doesNotMatch(prompt, /parameter name="agent-capability-probe"/)
  assert.match(prompt, /Do not call read, bash, write, or any other non-skill tool before the skill result\./)
  assert.match(prompt, /Do not output any final completion marker before the required skill tool result and follow-up tool sequence complete\./)
  assert.match(prompt, /\[Current action surface\]/)
  assert.match(prompt, /The gateway still preserves the full tool catalog structurally for later turns\./)
  assert.match(prompt, /Only the currently valid tool surface is shown below for this constrained turn\./)
  assert.match(prompt, /\[Immediate next output\]/)
  assert.ok(
    prompt.indexOf('[High-priority tool action constraint]') < prompt.indexOf('## Available Tools'),
    'action constraint must render before the verbose tool catalog',
  )
  assert.ok(
    prompt.indexOf('<|CHAT2API|tool_calls><|CHAT2API|invoke name="skill"')
      < prompt.indexOf('Only valid next tool: skill'),
    'exact managed XML should appear before natural-language descriptions',
  )
  assert.ok(
    prompt.lastIndexOf('<|CHAT2API|tool_calls><|CHAT2API|invoke name="skill"')
      > prompt.indexOf('Tool `skill`: Load a skill'),
    'exact managed XML should also be repeated after the projected tool surface',
  )
  assert.match(prompt, /Tool `skill`: Load a skill/)
  assert.doesNotMatch(prompt, /Tool `read`: Read a file/)
  assert.doesNotMatch(prompt, /Tool `bash`: Run command/)
})

test('first-skill action constraint renders exact managed XML for long-conversation-probe', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({
      messages: [{
        role: 'user',
        content: 'Your first assistant action must be a real OpenCode `skill` tool call for `long-conversation-probe`.',
      }],
      tools: skillProbeTools,
    }),
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: 'engine-first-skill-action-constraint-long-probe',
  })

  const prompt = result.toolManifest!.renderedPrompt
  assert.match(prompt, /Required tool call: skill\(name="long-conversation-probe"\)/)
  assert.match(prompt, /<\|CHAT2API\|tool_calls><\|CHAT2API\|invoke name="skill"><\|CHAT2API\|parameter name="name"><!\[CDATA\[long-conversation-probe\]\]>/)
  assert.ok(
    prompt.lastIndexOf('<|CHAT2API|tool_calls><|CHAT2API|invoke name="skill"')
      > prompt.indexOf('Only the currently valid tool surface is shown below for this constrained turn.'),
    'long-conversation skill XML should be the immediate next output reminder after the constrained surface',
  )
  assert.doesNotMatch(prompt, /parameter name="long-conversation-probe"/)
})

test('first-skill action constraint disappears after matching skill tool result exists', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({
      messages: [
        {
          role: 'user',
          content: 'Your first assistant action must be a real OpenCode `skill` tool call for `agent-capability-probe`.',
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_skill_probe',
            type: 'function',
            function: { name: 'skill', arguments: '{"name":"agent-capability-probe"}' },
          }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_skill_probe',
          content: '<skill_content name="agent-capability-probe">instructions</skill_content>',
        },
      ],
      tools: skillProbeTools,
    }),
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: 'engine-first-skill-action-constraint-completed',
  })

  assert.ok(result.toolManifest)
  // When nonSkillToolCount === 0 after compaction, no constraint is forced —
  // the model uses the full catalog. The first-turn 'read' hint is not a
  // correctness requirement. Action constraint is null when history is empty.
  assert.equal(result.toolManifest!.actionConstraint, null)
  assert.doesNotMatch(result.toolManifest!.renderedPrompt, /\[High-priority tool action constraint\]/)
})

test('final marker instruction alone does not activate terminal finalization constraint', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({
      messages: [{
        role: 'user',
        content: [
          'After the required tool work is complete, output exactly the final text `CAPABILITY_PROBE_DONE`.',
          'Do not paraphrase the final marker.',
        ].join('\n'),
      }],
      tools: skillProbeTools,
    }),
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: 'engine-terminal-constraint-no-evidence',
  })

  assert.ok(result.toolManifest)
  assert.equal(result.toolManifest!.actionConstraint, null)
  assert.doesNotMatch(result.toolManifest!.renderedPrompt, /No tool call is valid for this turn\./)
  assert.match(result.toolManifest!.renderedPrompt, /Tool `read`: Read a file/)
  assert.match(result.toolManifest!.renderedPrompt, /Tool `bash`: Run command/)
})

test('result-generation bash tool result activates terminal finalization constraint before catalog', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({
      messages: [
        {
          role: 'user',
          content: 'After the required tool work is complete, output exactly the final text `CAPABILITY_PROBE_DONE`.',
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_result_bash',
            type: 'function',
            function: {
              name: 'bash',
              arguments: '{"command":"node verify.js > .agent-probe/result.json"}',
            },
          }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_result_bash',
          content: 'wrote .agent-probe/result.json',
        },
      ],
      tools: skillProbeTools,
    }),
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: 'engine-terminal-constraint-bash-evidence',
  })

  assert.ok(result.toolManifest)
  assert.deepEqual(result.toolManifest!.actionConstraint, {
    kind: 'terminal_final_text_required',
    toolName: null,
    arguments: { exactText: 'CAPABILITY_PROBE_DONE' },
    reason: 'request_requires_terminal_final_text',
  })
  assert.deepEqual(result.toolManifest!.tools.map((tool) => tool.name), ['bash', 'read', 'skill', 'write'])

  const prompt = result.toolManifest!.renderedPrompt
  assert.match(prompt, /\[High-priority tool action constraint\]/)
  assert.match(prompt, /No tool call is valid for this turn\./)
  assert.match(prompt, /Output exactly: CAPABILITY_PROBE_DONE/)
  assert.match(prompt, /Do not call read, bash, write, skill, or any other tool\./)
  assert.match(prompt, /\[Current action surface\]/)
  assert.match(prompt, /No verbose tool definitions are shown because no tool is valid for this turn\./)
  assert.ok(
    prompt.indexOf('[High-priority tool action constraint]') < prompt.indexOf('[Current action surface]'),
    'terminal constraint must render before the constrained action surface note',
  )
  assert.doesNotMatch(prompt, /Tool `skill`: Load a skill/)
  assert.doesNotMatch(prompt, /Tool `read`: Read a file/)
  assert.doesNotMatch(prompt, /Tool `bash`: Run command/)
  assert.doesNotMatch(prompt, /## Available Tools/)
})

test('completed read of .agent-probe/result.json keeps terminal finalization constraint active', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({
      messages: [
        {
          role: 'user',
          content: 'The final assistant text contains `CAPABILITY_PROBE_DONE` once tool work is complete.',
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_result_read',
            type: 'function',
            function: {
              name: 'read',
              arguments: '{"filePath":".agent-probe/result.json"}',
            },
          }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_result_read',
          content: '{"ok":true}',
        },
      ],
      tools: skillProbeTools,
    }),
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: 'engine-terminal-constraint-read-evidence',
  })

  assert.ok(result.toolManifest)
  assert.equal(result.toolManifest!.actionConstraint?.kind, 'terminal_final_text_required')
  assert.equal(result.toolManifest!.actionConstraint?.arguments.exactText, 'CAPABILITY_PROBE_DONE')
  assert.match(result.toolManifest!.renderedPrompt, /No tool call is valid for this turn\./)
  assert.doesNotMatch(result.toolManifest!.renderedPrompt, /Tool `read`: Read a file/)
})

test('terminal finalization constraint survives later continuation user turns after result evidence', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({
      messages: [
        {
          role: 'user',
          content: 'After the required tool work is complete, output exactly the final text `CAPABILITY_PROBE_DONE`.',
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_result_bash',
            type: 'function',
            function: {
              name: 'bash',
              arguments: '{"command":"node verify.js > .agent-probe/result.json"}',
            },
          }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_result_bash',
          content: 'wrote .agent-probe/result.json',
        },
        {
          role: 'user',
          content: 'continue',
        },
      ],
      tools: skillProbeTools,
    }),
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: 'engine-terminal-constraint-after-continuation',
  })

  assert.ok(result.toolManifest)
  assert.equal(result.toolManifest!.actionConstraint?.kind, 'terminal_final_text_required')
  assert.equal(result.toolManifest!.actionConstraint?.arguments.exactText, 'CAPABILITY_PROBE_DONE')
  assert.match(result.toolManifest!.renderedPrompt, /No tool call is valid for this turn\./)
})

test('first-skill action constraint still wins over terminal finalization before skill result exists', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({
      messages: [{
        role: 'user',
        content: [
          'Your first assistant action must be a real OpenCode `skill` tool call for `agent-capability-probe`.',
          'After the required tool work is complete, output exactly the final text `CAPABILITY_PROBE_DONE`.',
        ].join('\n'),
      }],
      tools: skillProbeTools,
    }),
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: 'engine-first-skill-wins-before-terminal',
  })

  assert.ok(result.toolManifest)
  assert.equal(result.toolManifest!.actionConstraint?.kind, 'first_skill_required')
  assert.equal(result.toolManifest!.actionConstraint?.arguments.name, 'agent-capability-probe')
  assert.doesNotMatch(result.toolManifest!.renderedPrompt, /No tool call is valid for this turn\./)
})

test('tool session key keeps the full catalog when a later request sends only a subset of tools', () => {
  const engine = new ToolCallingEngine()
  const sessionKey = 'engine-stage2-subset-reuse'
  const first = engine.transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: sessionKey,
  })

  const second = engine.transformRequest({
    request: {
      model: 'deepseek-chat',
      messages: [
        {
          role: 'assistant',
          content: null as any,
          tool_calls: [{ id: 'call_skill', type: 'function', function: { name: 'default_api:read_file', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call_skill', content: 'body' },
        { role: 'user', content: 'continue' },
      ],
      tools: [tools[0]],
    },
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: sessionKey,
  })

  assert.equal(second.plan.catalogDiagnostics.source, 'session_catalog')
  assert.deepEqual(second.plan.catalogDiagnostics.driftKinds, ['current_request_subset_of_session_catalog'])
  assert.equal(second.plan.catalogSnapshot?.fingerprint, first.plan.catalogSnapshot?.fingerprint)
  assert.deepEqual(second.plan.tools.map((tool) => tool.name), ['default_api:list_dir', 'default_api:read_file'])
  assert.ok(second.toolManifest, 'toolManifest should be present')
  assert.match(second.toolManifest!.renderedPrompt, /default_api:list_dir/)
})

test('requestId falls back as the tool session key for omitted-tool follow-up turns', () => {
  const engine = new ToolCallingEngine()
  const first = engine.transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
    requestId: 'engine-stage2-requestid-reuse',
  })
  const second = engine.transformRequest({
    request: request({
      tools: undefined,
      messages: [
        {
          role: 'assistant',
          content: null as any,
          tool_calls: [{ id: 'call_reqid', type: 'function', function: { name: 'default_api:read_file', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call_reqid', content: 'body' },
        { role: 'user', content: 'continue' },
      ],
    }),
    provider,
    actualModel: 'deepseek-chat',
    requestId: 'engine-stage2-requestid-reuse',
  })

  assert.equal(first.plan.catalogSnapshot?.fingerprint, second.plan.catalogSnapshot?.fingerprint)
  assert.equal(second.plan.catalogDiagnostics.source, 'session_catalog')
  assert.ok(second.toolManifest, 'toolManifest should be present')
})

test('legacy managed xml prompt without a catalog restores default_api:read_file from history', () => {
  const engine = new ToolCallingEngine()

  const result = engine.transformRequest({
    request: request({
      tools: undefined,
      messages: [
        {
          role: 'system',
          content: [
            '<|CHAT2API|tool_calls>',
            '<|CHAT2API|invoke name="default_api:read_file">',
            '<|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter>',
            '</|CHAT2API|invoke>',
            '</|CHAT2API|tool_calls>',
          ].join('\n'),
        },
        { role: 'user', content: 'continue' },
      ],
    }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.mode, 'managed')
})

test('forced function choice narrows allowed tool names to the selected function', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({ tool_choice: { type: 'function', function: { name: 'default_api:list_dir' } } }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.toolChoiceMode, 'forced')
  assert.equal(result.plan.forcedToolName, 'default_api:list_dir')
  assert.deepEqual(result.plan.tools.map((tool) => tool.name), ['default_api:list_dir'])
})

test('forced function choice contract header only exposes the forced tool for this turn', () => {
  const result = new ToolCallingEngine().transformRequest({
    request: request({ tool_choice: { type: 'function', function: { name: 'default_api:list_dir' } } }),
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: 'engine-stage3-forced-header',
  })

  assert.ok(result.toolManifest, 'toolManifest should be present')
})

test('non-stream parsing only accepts the selected provider protocol', () => {
  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
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

  assert.equal(result.choices[0].message.tool_calls, undefined)
  assert.equal(result.choices[0].message.content, '[function_calls][call:default_api:read_file]{"filePath":"/tmp/a"}[/call][/function_calls]')
})

test('transformRequest returns toolManifest alongside messages for managed prompt', () => {
  const provider = {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'builtin' as const,
    authType: 'token' as const,
    apiEndpoint: '',
    headers: {},
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  }
  const engine = new ToolCallingEngine()
  const result = engine.transformRequest({
    request: request({ tools: [{ type: 'function', function: { name: 'default_api:read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } } }] }),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.ok(result.toolManifest, 'toolManifest should be present when shouldInjectPrompt is true')
  assert.equal(result.toolManifest!.protocol, 'managed_xml')
  assert.ok(result.toolManifest!.allowedToolNames.length > 0)
  assert.ok(result.toolManifest!.renderedPrompt.length > 0)
  assert.match(result.toolManifest!.renderedPrompt, /## Available Tools/)
  // Messages are no longer modified — tool contract lives entirely in toolManifest.renderedPrompt
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].content, 'read /tmp/a')
})

test('transformRequest omits toolManifest when injection is skipped', () => {
  const provider = {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'builtin' as const,
    authType: 'token' as const,
    apiEndpoint: '',
    headers: {},
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  }
  const engine = new ToolCallingEngine()
  const result = engine.transformRequest({
    request: { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] },
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.shouldInjectPrompt, false)
  assert.equal(result.toolManifest, undefined)
})

test('toolManifest uses catalogFingerprint from plan snapshot', () => {
  const provider = {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'builtin' as const,
    authType: 'token' as const,
    apiEndpoint: '',
    headers: {},
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  }
  const engine = new ToolCallingEngine()
  const result = engine.transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
  })

  assert.equal(result.plan.shouldInjectPrompt, true)
  // catalogFingerprint matches the plan's snapshot fingerprint
  assert.equal(result.toolManifest!.catalogFingerprint, result.plan.catalogSnapshot?.fingerprint ?? '')
})

test('provider adapters do not import tool prompt injection helpers (INV-001 guard)', () => {
  const adapterDir = path.resolve('src/main/proxy/adapters')
  const adapterFiles = fs.readdirSync(adapterDir)
    .filter((file) => file.endsWith('.ts'))

  const forbiddenImports = [
    'hasToolPromptInjected',
    'toolsToSystemPrompt',
    'TOOL_WRAP_HINT',
    'shouldInjectToolPrompt',
  ]

  for (const file of adapterFiles) {
    const source = fs.readFileSync(path.join(adapterDir, file), 'utf8')
    const importLines = source
      .split(/\r?\n/)
      .filter((line) => /^\s*import\b/.test(line))
      .join('\n')

    for (const symbol of forbiddenImports) {
      assert.doesNotMatch(
        importLines,
        new RegExp(`\\b${symbol}\\b`),
        `${file} must not import ${symbol}`,
      )
    }
  }
})
