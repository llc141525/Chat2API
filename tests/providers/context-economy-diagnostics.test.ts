import test from 'node:test'
import assert from 'node:assert/strict'

import { buildContextEconomyDiagnostics } from '../../src/main/proxy/services/contextPayloadClassifier.ts'

test('context economy diagnostics expose counts without raw prompt bodies', () => {
  const secretSkillBody = 'PRIVATE_SKILL_DOCUMENT_BODY'
  const secretSchemaBody = 'PRIVATE_TOOL_SCHEMA_BODY'
  const diagnostics = buildContextEconomyDiagnostics([
    { role: 'system', content: `You are opencode. superpowers ${secretSkillBody}` },
    { role: 'system', content: `## Available Tools\n${secretSchemaBody}` },
    { role: 'system', content: 'You are opencode. SUBAGENT-STOP' },
    { role: 'user', content: 'Continue the actual task.' },
  ], {
    boundary: 'client_compact',
    promptRefreshMode: 'digest',
  })

  const serialized = JSON.stringify(diagnostics)
  assert.equal(diagnostics.boundary, 'client_compact')
  assert.equal(diagnostics.promptRefreshMode, 'digest')
  assert.ok(diagnostics.repeatedRuntimeConfigMarkers > 0)
  assert.ok(diagnostics.payloadClassCounts.tool_contract > 0)
  assert.equal(serialized.includes(secretSkillBody), false)
  assert.equal(serialized.includes(secretSchemaBody), false)
})
