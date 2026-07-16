/**
 * Node K1 — Fixture Replay Tests (Plugin Phase 4)
 *
 * Verify that fixture replay harness can drive provider plugins
 * without live web calls.
 *
 * Run: node --test tests/providers/fixture-replay.test.ts
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'

import { replayStreamFixture, replayNonStreamFixture } from '../../src/main/proxy/services/fixtureReplay.ts'
import { QwenProviderPlugin } from '../../src/main/proxy/plugins/QwenProviderPlugin.ts'
import type { ProviderRuntimeRequest } from '../../src/main/proxy/plugins/types.ts'

function makeReplayRuntimeRequest(): ProviderRuntimeRequest {
  const messages = [{ role: 'user', content: 'Replay request' }]
  return {
    provider: {
      id: 'qwen',
      name: 'Qwen',
      type: 'builtin',
      authType: 'token',
      apiEndpoint: '',
      headers: {},
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    },
    account: {
      id: 'fixture-account',
      providerId: 'qwen',
      name: 'Fixture Account',
      credentials: { ticket: 'fixture-ticket' },
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    },
    model: 'Qwen3-Max',
    messages,
    assembly: {
      messages: messages as any,
      toolManifest: {
        protocol: 'managed_xml',
        catalogFingerprint: 'fixture-fingerprint',
        allowedToolNames: ['read'],
        tools: [],
        renderedPrompt: 'Tool Contract Header\ncatalog_fingerprint: fixture-fingerprint\n<|CHAT2API|tool_calls>',
        contractHeaderVersion: 1,
      },
      summaryText: '[Prior conversation summary]\nFixture replay summary.',
      metadata: {
        contextManagementApplied: true,
        strategiesExecuted: ['summary'],
        originalMessageCount: 4,
        finalMessageCount: 1,
      },
    },
    promptRefreshMode: 'tool_ready',
    sessionBoundaryReason: 'server_summary',
  }
}

// ── Stream fixtures ─────────────────────────────────────────────────

test('stream fixture replay: basic text response', async () => {
  const request = await QwenProviderPlugin.buildRequest(makeReplayRuntimeRequest())
  const content = String((request.body as any)?.messages?.[0]?.content ?? '')
  assert.match(content, /fixture-fingerprint/)
  assert.match(content, /Fixture replay summary/)

  const events = await replayStreamFixture(QwenProviderPlugin, {
    pluginId: 'qwen',
    description: 'Basic Qwen stream response',
    responseData: fs.readFileSync('tests/fixtures/qwen/stream-basic.ssedata', 'utf-8'),
    expected: {
      eventTypes: ['session_update', 'text_delta', 'text_delta', 'done'],
      containsText: ['Hello from fixture'],
    },
  })

  const types = events.map(e => e.type)
  assert.deepEqual(types, ['session_update', 'text_delta', 'text_delta', 'done'])

  const textDeltas = events.filter(e => e.type === 'text_delta') as Array<{ type: 'text_delta'; text: string }>
  assert.equal(textDeltas.length, 2)
  assert.ok(textDeltas[0].text.includes('Hello'), `expected "Hello" in delta, got "${textDeltas[0].text}"`)
})

test('stream fixture replay: session id extraction', async () => {
  const events = await replayStreamFixture(QwenProviderPlugin, {
    pluginId: 'qwen',
    description: 'Verify session id is extracted',
    responseData: fs.readFileSync('tests/fixtures/qwen/stream-basic.ssedata', 'utf-8'),
    expected: {
      sessionId: 'sess-fixture-basic-001',
    },
  })

  const sessionUpdate = events.find(e => e.type === 'session_update')
  assert.ok(sessionUpdate !== undefined, 'must emit session_update')
  if (sessionUpdate?.type === 'session_update') {
    assert.equal(sessionUpdate.sessionId, 'sess-fixture-basic-001')
  }
})

test('stream fixture replay: error handling', async () => {
  const events = await replayStreamFixture(QwenProviderPlugin, {
    pluginId: 'qwen',
    description: 'Qwen error code response',
    responseData: fs.readFileSync('tests/fixtures/qwen/stream-error.ssedata', 'utf-8'),
    expected: {
      eventTypes: ['error'],
    },
  })

  assert.equal(events.length, 1, 'error fixture should yield exactly 1 event')
  assert.equal(events[0].type, 'error')
})

// ── Non-stream fixtures ─────────────────────────────────────────────

test('non-stream fixture replay: session id extraction', async () => {
  const fixtureData = JSON.parse(fs.readFileSync('tests/fixtures/qwen/nonstream-basic.json', 'utf-8'))
  const result = await replayNonStreamFixture(QwenProviderPlugin, {
    pluginId: 'qwen',
    description: 'Basic non-stream response',
    responseData: fixtureData,
    expected: {
      sessionId: 'sess-nonstream-fixture-001',
      status: 200,
    },
  })

  assert.equal(result.sessionId, 'sess-nonstream-fixture-001')
  assert.equal(result.response.status, 200)
})

test('non-stream fixture replay: status passthrough', async () => {
  const fixtureData = JSON.parse(fs.readFileSync('tests/fixtures/qwen/nonstream-basic.json', 'utf-8'))
  const result = await replayNonStreamFixture(QwenProviderPlugin, {
    pluginId: 'qwen',
    description: 'Non-stream response with custom status',
    responseData: fixtureData,
    expected: { status: 502 },
  })

  assert.equal(result.response.status, 502)
})

// ── Fixture structure validation ────────────────────────────────────

test('fixture files contain no real credentials', () => {
  for (const file of ['tests/fixtures/qwen/stream-basic.ssedata', 'tests/fixtures/qwen/stream-error.ssedata']) {
    const content = fs.readFileSync(file, 'utf-8')
    assert.ok(!content.includes('tongyi_sso_ticket='), `${file} must not contain real credentials`)
    assert.ok(!content.includes('sk-'), `${file} must not contain API keys`)
  }
})

test('fixture files are valid SSE format', () => {
  const content = fs.readFileSync('tests/fixtures/qwen/stream-basic.ssedata', 'utf-8')
  const lines = content.split('\n')
  const eventLines = lines.filter(l => l.startsWith('event:'))
  const dataLines = lines.filter(l => l.startsWith('data:'))
  assert.ok(eventLines.length > 0, 'SSE must have event lines')
  assert.equal(eventLines.length, dataLines.length, 'SSE must have matching event/data pairs')
})
