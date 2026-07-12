import test from 'node:test'
import assert from 'node:assert/strict'

import { ToolCallingEngine } from '../../src/main/proxy/toolCalling/ToolCallingEngine.ts'
import { inspectNonStreamAssistantOutput } from '../../src/main/proxy/toolCalling/outputInspection.ts'
import { anthropicRequestToOpenAI } from '../../src/main/proxy/routes/anthropicCompat.ts'
import type { Provider } from '../../src/main/store/types.ts'

const provider = {
  id: 'qwen',
  name: 'Qwen',
  type: 'builtin',
  authType: 'token',
  apiEndpoint: '',
  headers: {},
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
} as Provider

test('Anthropic managed turn denial after compact triggers authoritative catalog drift failure', () => {
  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: anthropicRequestToOpenAI({
      model: 'qwen/Qwen3.7-Max',
      messages: [{ role: 'user', content: 'Keep using Bash after compact.' }],
      tools: [
        {
          name: 'Bash',
          description: 'Execute shell commands',
          input_schema: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
        },
        {
          name: 'Read',
          description: 'Read files',
          input_schema: {
            type: 'object',
            properties: { file_path: { type: 'string' } },
            required: ['file_path'],
          },
        },
      ],
    }),
    provider,
    actualModel: 'Qwen3.7-Max',
    toolSessionKey: 'claude:compact-drift-test',
  })

  const result: any = {
    choices: [{
      message: {
        role: 'assistant',
        content: 'After compact I only have current_time available, so Bash and Read are unavailable.',
      },
      finish_reason: 'stop',
    }],
  }

  const first = engine.applyNonStreamResponse(result, transformed.plan)
  const second = engine.applyNonStreamResponse(result, transformed.plan)
  const inspection = inspectNonStreamAssistantOutput({ result, plan: transformed.plan })

  assert.equal(first?.type, 'availability_retry')
  assert.equal(second, undefined)
  assert.equal(inspection.ok, false)
  assert.equal(inspection.outcome, 'tool_availability_drift')
  assert.equal(transformed.plan.diagnostics.availabilityRetryResult, 'failed')
  assert.match(inspection.error, /authoritative tool catalog/i)
})
