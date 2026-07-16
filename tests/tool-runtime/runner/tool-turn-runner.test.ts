import test from 'node:test'
import assert from 'node:assert/strict'

import { runToolTurn } from '../../../src/main/proxy/toolRuntime/runner/index.ts'
import type { ToolPlan } from '../../../src/main/proxy/toolRuntime/control/index.ts'
import type { ToolTurnRunnerDeps } from '../../../src/main/proxy/toolRuntime/runner/index.ts'
import type { NormalizedToolDefinition } from '../../../src/main/proxy/toolCalling/types.ts'

const plan: ToolPlan = {
  profile: 'managed_buffered_structural',
  protocol: 'managed_xml',
  allowedToolNames: ['bash'],
  diagnostics: {
    providerId: 'qwen',
    model: 'qwen-test',
    profile: 'managed_buffered_structural',
    mode: 'managed',
    protocol: 'managed_xml',
    reason: 'provider_managed_tools',
    toolCount: 1,
    toolChoiceMode: 'auto',
    allowedToolNames: ['bash'],
  },
}

const tools: NormalizedToolDefinition[] = [{
  name: 'bash',
  parameters: { type: 'object', properties: { argument: { type: 'string' } }, required: ['argument'] },
  source: 'openai',
}]

function deps(overrides: Partial<ToolTurnRunnerDeps> = {}): ToolTurnRunnerDeps {
  return {
    invokeModel: async () => ({ status: 'completed', rawOutput: 'hello' }),
    extractStructure: () => ({ kind: 'no_intent', protocol: 'managed_xml', content: 'hello' }),
    validateStructure: () => ({ status: 'plain_text', content: 'hello' }),
    canRepair: () => false,
    repairStructure: () => ({ status: 'not_repairable', reason: 'no' }),
    assembleToolCalls: () => [],
    mapResponse: (input) => ({ mapped: input }),
    ...overrides,
  }
}

test('runner maps plain text without repair or assembly', async () => {
  const calls: string[] = []
  const result = await runToolTurn({
    plan,
    tools,
    deps: deps({
      validateStructure: () => {
        calls.push('validate')
        return { status: 'plain_text', content: 'hello' }
      },
      mapResponse: (input) => {
        calls.push(input.kind)
        return { mapped: input }
      },
    }),
  })

  assert.deepEqual(calls, ['validate', 'plain_text'])
  assert.deepEqual(result, { status: 'success', response: { mapped: { kind: 'plain_text', content: 'hello' } } })
})

test('runner repairs once, revalidates, assembles, and maps tool calls', async () => {
  let validateCount = 0
  const result = await runToolTurn({
    plan,
    tools,
    deps: deps({
      validateStructure: () => {
        validateCount += 1
        if (validateCount === 1) {
          return {
            status: 'invalid_structure',
            failure: { kind: 'mixed_protocol_container', selectedProtocol: 'managed_xml', detail: 'mixed' },
            malformedIntent: {
              selectedProtocol: 'managed_xml',
              toolName: 'bash',
              parameters: [{ name: 'argument', rawPayload: 'pwd', payloadEncoding: 'cdata' }],
              rawContainerFingerprint: 'f',
              failureKind: 'mixed_protocol_container',
            },
          }
        }
        return {
          status: 'valid_structure',
          cleanContent: null,
          validated: [{
            callIndex: 0,
            toolName: 'bash',
            parameters: [{ name: 'argument', rawPayload: 'pwd', payloadEncoding: 'cdata' }],
          }],
        }
      },
      canRepair: () => true,
      repairStructure: () => ({ status: 'repaired', protocol: 'managed_xml', method: 'deterministic_rewrap', repairedText: '<fixed />' }),
      assembleToolCalls: () => [{ id: 'call_0', index: 0, type: 'function', function: { name: 'bash', arguments: '{"argument":"pwd"}' } }],
      mapResponse: (input) => ({ mapped: input }),
    }),
  })

  assert.equal(validateCount, 2)
  assert.deepEqual(result, {
    status: 'success',
    response: {
      mapped: {
        kind: 'valid_tool_calls',
        toolCalls: [{ id: 'call_0', index: 0, type: 'function', function: { name: 'bash', arguments: '{"argument":"pwd"}' } }],
      },
    },
  })
})

test('runner blocks invalid structure when repair is not allowed', async () => {
  const result = await runToolTurn({
    plan,
    tools,
    deps: deps({
      validateStructure: () => ({
        status: 'invalid_structure',
        failure: { kind: 'unknown_tool_name', selectedProtocol: 'managed_xml', detail: 'bad' },
      }),
      canRepair: () => false,
      mapResponse: (input) => ({ mapped: input }),
    }),
  })

  assert.deepEqual(result, {
    status: 'success',
    response: {
      mapped: {
        kind: 'blocked_malformed',
        safeMessage: 'The model attempted a tool call but produced invalid tool-call markup. Chat2API blocked it to avoid executing an unsafe or malformed tool request.',
      },
    },
  })
})
