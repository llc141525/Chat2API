import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getStructureProtocolAdapter,
  managedXmlStructureAdapter,
} from '../../../src/main/proxy/toolRuntime/data/index.ts'

test('managed_xml adapter is available by selected protocol id', () => {
  const adapter = getStructureProtocolAdapter('managed_xml')

  assert.equal(adapter.id, 'managed_xml')
  assert.equal(adapter, managedXmlStructureAdapter)
})

test('unsupported selected protocol is rejected instead of falling back', () => {
  assert.throws(
    () => getStructureProtocolAdapter('managed_bracket'),
    /Unsupported structure protocol: managed_bracket/,
  )
})
