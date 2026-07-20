import test from 'node:test'
import assert from 'node:assert/strict'

import { primeProviderStreamEvents } from '../../src/main/proxy/services/providerStreamGuard.ts'

test('stream guard preserves the first event and all later events', async () => {
  async function* source() {
    yield 'first'
    yield 'second'
  }

  const guarded = await primeProviderStreamEvents(source(), 100)
  assert.ok('events' in guarded)
  assert.deepEqual(await Array.fromAsync(guarded.events), ['first', 'second'])
})

test('stream guard closes a no-first-event stream before downstream timeout', async () => {
  let timedOut = false
  async function* stalled() {
    await new Promise(resolve => setTimeout(resolve, 100))
    yield 'late'
  }

  const guarded = await primeProviderStreamEvents(stalled(), 15, () => { timedOut = true })
  assert.ok('error' in guarded)
  assert.equal(timedOut, true)
  assert.match(guarded.error.message, /no deliverable event within 15ms/)
})

test('stream guard keeps session metadata but waits for a deliverable event', async () => {
  async function* source() {
    yield { type: 'session_update', id: 'session-1' }
    yield { type: 'text_delta', text: 'ready' }
  }

  const guarded = await primeProviderStreamEvents(
    source(),
    100,
    undefined,
    event => event.type !== 'session_update',
  )
  assert.ok('events' in guarded)
  assert.deepEqual(await Array.fromAsync(guarded.events), [
    { type: 'session_update', id: 'session-1' },
    { type: 'text_delta', text: 'ready' },
  ])
})

test('stream guard rejects a stream that closes before any deliverable event', async () => {
  async function* empty() {
    return
  }

  const guarded = await primeProviderStreamEvents(
    empty(),
    100,
    undefined,
    event => event.type !== 'session_update',
  )

  assert.ok('error' in guarded)
  assert.match(guarded.error.message, /closed without a deliverable event/)
})
