import test from 'node:test'
import assert from 'node:assert/strict'

import { detectSummaryContamination } from '../../src/main/proxy/services/summarySanitizer.ts'

test('detectSummaryContamination catches the diagnosis-shaped hallucinated tool catalog fixture', () => {
  const summary = [
    'Assistant correctly identified the full available toolset, including:',
    '',
    '## Available Tools',
    '- Bash (PowerShell 7+ on Windows)',
    '- Filesystem',
    '- Burp Suite MCP',
    '- GitHub Integration',
    '- WebFetch',
    '',
    'Tool context is now established for later turns.',
  ].join('\n')

  const result = detectSummaryContamination(summary)

  assert.equal(result.contaminated, true)
  assert.ok(
    result.signatures.some(hit => hit.signature === '## Available Tools'),
    `Expected "## Available Tools" hit, got: ${JSON.stringify(result.signatures)}`
  )
})
