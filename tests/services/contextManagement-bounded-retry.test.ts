import test from 'node:test'
import assert from 'node:assert/strict'

import type { ChatCompletionRequest, ProxyContext } from '../../src/main/proxy/types.ts'
import {
  executeBoundedAvailabilityRetry,
  rebuildMessagesForSummaryContaminationRetry,
} from '../../src/main/proxy/services/contextManagementRetry.ts'

test('summary_contamination bounded retry rebuilds clean sliding-window context and retries exactly once', async () => {
  const contextManagementConfig = {
    enabled: true,
    strategies: {
      slidingWindow: { enabled: true, maxMessages: 3 },
      tokenLimit: { enabled: false, maxTokens: 4000 },
      summary: { enabled: true, keepRecentMessages: 2 },
    },
    executionOrder: ['slidingWindow', 'summary'],
  }

  const rawMessages: ChatCompletionRequest['messages'] = [
    {
      role: 'system',
      content: '[Prior conversation summary — non-authoritative narrative]\n## Available Tools\n- bash\n- filesystem',
    },
    { role: 'user', content: 'turn 1' },
    { role: 'assistant', content: 'turn 2' },
    { role: 'user', content: 'turn 3' },
    { role: 'assistant', content: 'turn 4' },
  ]
  const request: ChatCompletionRequest = {
    model: 'qwen/Qwen3.7-Max',
    stream: false,
    messages: rawMessages,
  }
  const context: ProxyContext = {
    requestId: 'req-summary-retry',
    model: 'qwen/Qwen3.7-Max',
    startTime: Date.now(),
    isStream: false,
    originalMessages: rawMessages,
    summaryContaminated: true,
    summaryRetryAttempted: false,
  }

  let upstreamCalls = 1
  const seenRetryPayloads: ChatCompletionRequest[] = []
  let firstDetection = true

  const outcome = await executeBoundedAvailabilityRetry({
    initialResult: { choices: [{ message: { role: 'assistant', content: 'only open_url is available' } }] },
    context,
    expectedCatalogFingerprint: 'fp-clean-retry',
    detectRetry: () => {
      if (firstDetection) {
        firstDetection = false
        return {
          type: 'availability_retry',
          catalogFingerprint: 'fp-clean-retry',
          clarification: 'ignored for summary contamination retry',
          subkind: 'summary_contamination',
        }
      }
      return undefined
    },
    buildRetryRequest: async () => {
      context.summaryRetryAttempted = true
      const retryMessages = await rebuildMessagesForSummaryContaminationRetry(
        context.originalMessages ?? request.messages,
        contextManagementConfig as any
      )
      return {
        ...request,
        messages: retryMessages,
      }
    },
    executeRetry: async (retryRequest: ChatCompletionRequest) => {
      upstreamCalls += 1
      if (upstreamCalls > 2) {
        throw new Error(`retry executed too many upstream calls: ${upstreamCalls}`)
      }
      seenRetryPayloads.push(retryRequest)
      return { body: 'round-2-success' }
    },
    parseRetryPayload: async () => ({
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_bash_1',
            type: 'function',
            function: {
              name: 'bash',
              arguments: '{"command":"echo ok"}',
            },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    }),
  })

  assert.equal(outcome.retried, true)
  assert.equal(upstreamCalls, 2, 'should make exactly two upstream calls total')
  assert.equal(context.summaryRetryAttempted, true, 'summary retry latch must be armed')
  assert.equal(seenRetryPayloads.length, 1, 'should issue exactly one retry request')
  assert.ok(
    seenRetryPayloads[0].messages.every((message) =>
      typeof message.content !== 'string' || !message.content.includes('[Prior conversation summary')
    ),
    'clean-context retry must drop the contaminated summary message'
  )
  assert.deepEqual(
    seenRetryPayloads[0].messages.map(message => message.content),
    ['turn 2', 'turn 3', 'turn 4'],
    'retry should rebuild from sliding-window-only history'
  )
  assert.equal(outcome.result.choices[0].finish_reason, 'tool_calls')
})
