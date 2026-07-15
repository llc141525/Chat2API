/**
 * Node G — Child Session Cleanup Policy Tests
 *
 * Verify the decision logic for when child provider sessions should be deleted.
 * Run: node --test tests/providers/child-session-cleanup.test.ts
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import type { ChildSessionHandoff } from '../../src/main/proxy/sessionBoundary.ts'

// ── Helpers ──────────────────────────────────────────────────────────

function okHandoff(overrides: Partial<ChildSessionHandoff> = {}): ChildSessionHandoff {
  return {
    kind: 'tool_child',
    status: 'ok',
    summary: 'Task completed successfully.',
    evidence: [{ label: 'result', value: 'build passed' }],
    ...overrides,
  }
}

function failedHandoff(overrides: Partial<ChildSessionHandoff> = {}): ChildSessionHandoff {
  return {
    kind: 'tool_child',
    status: 'failed',
    summary: 'Task failed.',
    evidence: [],
    errorClass: 'timeout',
    ...overrides,
  }
}

function needsDecisionHandoff(overrides: Partial<ChildSessionHandoff> = {}): ChildSessionHandoff {
  return {
    kind: 'subagent_child',
    status: 'needs_parent_decision',
    summary: 'Ambiguous result.',
    evidence: [{ label: 'partial', value: 'incomplete' }],
    ...overrides,
  }
}

// ── Decision function (imported from module under test) ──────────────

let shouldDeleteChildSession: (
  handoff: ChildSessionHandoff,
  debugMode: boolean,
) => boolean
let cleanupChildProviderSession: (input: {
  handoff: ChildSessionHandoff
  debugMode: boolean
  deleteSession: (sessionId: string) => Promise<void>
}) => Promise<boolean>

async function loadModule() {
  if (shouldDeleteChildSession && cleanupChildProviderSession) return
  const mod = await import('../../src/main/proxy/services/childSessionCleanup.ts')
  shouldDeleteChildSession = mod.shouldDeleteChildSession
  cleanupChildProviderSession = mod.cleanupChildProviderSession
}

// ── Tests ────────────────────────────────────────────────────────────

test('successful child session is deleted regardless of debug mode', async () => {
  await loadModule()

  assert.equal(shouldDeleteChildSession(okHandoff(), false), true,
    'ok handoff should be deleted in normal mode')
  assert.equal(shouldDeleteChildSession(okHandoff(), true), true,
    'ok handoff should be deleted in debug mode — handoff state is sufficient')
})

test('successful subagent_child is deleted', async () => {
  await loadModule()

  assert.equal(shouldDeleteChildSession(okHandoff({ kind: 'subagent_child' }), false), true)
  assert.equal(shouldDeleteChildSession(okHandoff({ kind: 'subagent_child' }), true), true)
})

test('failed child session is kept in debug mode', async () => {
  await loadModule()

  assert.equal(shouldDeleteChildSession(failedHandoff(), true), false,
    'failed handoff should be kept in debug mode for investigation')
})

test('failed child session is deleted in normal mode', async () => {
  await loadModule()

  assert.equal(shouldDeleteChildSession(failedHandoff(), false), true,
    'failed handoff should be deleted in normal mode — no need to keep')
})

test('needs_parent_decision handoff is never deleted', async () => {
  await loadModule()

  assert.equal(shouldDeleteChildSession(needsDecisionHandoff(), false), false,
    'pending decision should not be deleted in normal mode')
  assert.equal(shouldDeleteChildSession(needsDecisionHandoff(), true), false,
    'pending decision should not be deleted in debug mode')
})

test('failed handoff without errorClass is still kept in debug mode', async () => {
  await loadModule()

  const noError = failedHandoff({ errorClass: undefined })
  assert.equal(shouldDeleteChildSession(noError, true), false)
  assert.equal(shouldDeleteChildSession(noError, false), true)
})

test('ok handoff with artifacts is still deleted', async () => {
  await loadModule()

  const withArtifacts = okHandoff({
    artifacts: [{ path: '/tmp/output.json', purpose: 'test result' }],
  })
  assert.equal(shouldDeleteChildSession(withArtifacts, false), true,
    'artifacts are file-system references, not session state — safe to delete')
})

test('cleanup uses the recorded child provider session id', async () => {
  await loadModule()

  const deleted: string[] = []
  const deletedResult = await cleanupChildProviderSession({
    handoff: okHandoff({
      childProviderSessionId: 'child-session-123',
    }),
    debugMode: false,
    deleteSession: async (sessionId: string) => {
      deleted.push(sessionId)
    },
  })

  assert.equal(deletedResult, true)
  assert.deepEqual(deleted, ['child-session-123'])
})

test('cleanup is skipped when the handoff has no recorded child provider session id', async () => {
  await loadModule()

  const deletedResult = await cleanupChildProviderSession({
    handoff: okHandoff(),
    debugMode: false,
    deleteSession: async () => {
      throw new Error('deleteSession should not be called without a recorded child session id')
    },
  })

  assert.equal(deletedResult, false)
})

test('cleanup failure is surfaced without mutating unrelated parent state', async () => {
  await loadModule()

  await assert.rejects(
    cleanupChildProviderSession({
      handoff: okHandoff({
        childProviderSessionId: 'child-session-fail',
      }),
      debugMode: false,
      deleteSession: async () => {
        throw new Error('provider delete failed')
      },
    }),
    /provider delete failed/,
  )
})
