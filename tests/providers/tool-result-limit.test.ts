import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { getMaxToolResultLength } from '../../src/main/proxy/shared/toolResultLimit.ts'

const adapterFiles = [
  'qwen',
  'kimi',
  'mimo',
  'minimax',
].map((provider) => `src/main/proxy/adapters/${provider}.ts`)

test('tool result limit accepts only a positive integer environment value', () => {
  const previous = process.env.CHAT2API_MAX_TOOL_RESULT_LENGTH
  try {
    process.env.CHAT2API_MAX_TOOL_RESULT_LENGTH = '4096'
    assert.equal(getMaxToolResultLength(), 4096)

    process.env.CHAT2API_MAX_TOOL_RESULT_LENGTH = '4096junk'
    assert.equal(getMaxToolResultLength(), 2000)

    process.env.CHAT2API_MAX_TOOL_RESULT_LENGTH = '0'
    assert.equal(getMaxToolResultLength(), 2000)
  } finally {
    if (previous === undefined) delete process.env.CHAT2API_MAX_TOOL_RESULT_LENGTH
    else process.env.CHAT2API_MAX_TOOL_RESULT_LENGTH = previous
  }
})

test('legacy provider adapters use the shared tool result limit', () => {
  for (const file of adapterFiles) {
    const source = fs.readFileSync(file, 'utf8')
    assert.match(source, /getMaxToolResultLength/)
    assert.doesNotMatch(source, /rawContent\.length\s*>\s*2000|slice\(0,\s*2000\)/)
  }
})
