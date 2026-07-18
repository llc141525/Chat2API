import test from 'node:test'
import assert from 'node:assert/strict'

import { QwenProviderPlugin } from '../../src/main/proxy/plugins/QwenProviderPlugin.ts'
import { GLMProviderPlugin } from '../../src/main/proxy/plugins/GLMProviderPlugin.ts'

test('Qwen does not inherit GLM account request throttling', () => {
  assert.equal(QwenProviderPlugin.capabilities.requestThrottle, undefined)
  assert.deepEqual(GLMProviderPlugin.capabilities.requestThrottle, {
    minIntervalMs: 2000,
    rateLimitBackoffMs: 30000,
  })
})
