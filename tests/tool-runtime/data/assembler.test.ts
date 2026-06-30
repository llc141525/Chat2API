import test from 'node:test'
import assert from 'node:assert/strict'

import { assembleOpenAIToolCalls } from '../../../src/main/proxy/toolRuntime/data/index.ts'
import type { ValidatedCallStructure } from '../../../src/main/proxy/toolRuntime/data/index.ts'
import type { NormalizedToolDefinition } from '../../../src/main/proxy/toolCalling/types.ts'

const tools: NormalizedToolDefinition[] = [{
  name: 'bash',
  description: 'Run a shell command',
  parameters: {
    type: 'object',
    properties: {
      argument: { type: 'string' },
    },
    required: ['argument'],
  },
  source: 'openai',
}]

test('assembler converts validated structure into OpenAI tool_calls', () => {
  const validated: ValidatedCallStructure[] = [{
    callIndex: 0,
    toolName: 'bash',
    parameters: [{
      name: 'argument',
      rawPayload: 'pwd',
      payloadEncoding: 'cdata',
    }],
  }]

  const calls = assembleOpenAIToolCalls({ validated, tools })

  assert.deepEqual(calls, [{
    id: 'call_0',
    index: 0,
    type: 'function',
    function: {
      name: 'bash',
      arguments: JSON.stringify({ argument: 'pwd' }),
    },
  }])
})

test('assembler preserves raw payload content without JSON repair', () => {
  const payload = '{"unterminated": true'
  const validated: ValidatedCallStructure[] = [{
    callIndex: 0,
    toolName: 'bash',
    parameters: [{
      name: 'argument',
      rawPayload: payload,
      payloadEncoding: 'cdata',
    }],
  }]

  const calls = assembleOpenAIToolCalls({ validated, tools })
  assert.equal(calls[0].function.arguments, JSON.stringify({ argument: payload }))
})

test('assembler keeps repeated parameter names as arrays without inventing names', () => {
  const validated: ValidatedCallStructure[] = [{
    callIndex: 0,
    toolName: 'bash',
    parameters: [
      { name: 'argument', rawPayload: 'one', payloadEncoding: 'text' },
      { name: 'argument', rawPayload: 'two', payloadEncoding: 'text' },
    ],
  }]

  const calls = assembleOpenAIToolCalls({ validated, tools })
  assert.equal(calls[0].function.arguments, JSON.stringify({ argument: ['one', 'two'] }))
})

test('assembler rejects validated structure for undeclared tool', () => {
  const validated: ValidatedCallStructure[] = [{
    callIndex: 0,
    toolName: 'python',
    parameters: [{
      name: 'argument',
      rawPayload: 'print(1)',
      payloadEncoding: 'text',
    }],
  }]

  assert.throws(
    () => assembleOpenAIToolCalls({ validated, tools }),
    /Cannot assemble undeclared tool python/,
  )
})

test('assembler does not add missing required parameters', () => {
  const validated: ValidatedCallStructure[] = [{
    callIndex: 0,
    toolName: 'bash',
    parameters: [],
  }]

  const calls = assembleOpenAIToolCalls({ validated, tools })
  assert.equal(calls[0].function.arguments, '{}')
})
