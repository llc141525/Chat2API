import test from 'node:test'
import assert from 'node:assert/strict'

import {
  resetProviderRequestGatesForTest,
  runThroughProviderRequestGate,
} from '../../src/main/proxy/services/providerRequestGate.ts'

test('provider request gate serializes requests and spaces them', async () => {
  resetProviderRequestGatesForTest()
  const starts: number[] = []
  const task = async () => {
    starts.push(Date.now())
    await new Promise(resolve => setTimeout(resolve, 5))
    return { status: 200 }
  }

  await Promise.all([
    runThroughProviderRequestGate('glm:account', { minIntervalMs: 25, rateLimitBackoffMs: 100 }, task, result => result.status),
    runThroughProviderRequestGate('glm:account', { minIntervalMs: 25, rateLimitBackoffMs: 100 }, task, result => result.status),
  ])

  assert.equal(starts.length, 2)
  assert.ok(starts[1] - starts[0] >= 20)
})

test('provider request gate backs off longer after 429', async () => {
  resetProviderRequestGatesForTest()
  const starts: number[] = []
  const options = { minIntervalMs: 10, rateLimitBackoffMs: 35 }

  await runThroughProviderRequestGate('glm:account', options, async () => {
    starts.push(Date.now())
    return { status: 429 }
  }, result => result.status)
  await runThroughProviderRequestGate('glm:account', options, async () => {
    starts.push(Date.now())
    return { status: 200 }
  }, result => result.status)

  assert.ok(starts[1] - starts[0] >= 30)
})
