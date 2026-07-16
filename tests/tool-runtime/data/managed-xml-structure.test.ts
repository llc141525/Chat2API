import test from 'node:test'
import assert from 'node:assert/strict'

import { managedXmlStructureAdapter } from '../../../src/main/proxy/toolRuntime/data/index.ts'

test('valid Chat2API managed XML extracts call structure only', () => {
  const raw = [
    'before ',
    '<|CHAT2API|tool_calls>',
    '<|CHAT2API|invoke name="bash">',
    '<|CHAT2API|parameter name="argument"><![CDATA[Get-ChildItem D:\\\\]]></|CHAT2API|parameter>',
    '</|CHAT2API|invoke>',
    '</|CHAT2API|tool_calls>',
    ' after',
  ].join('')

  const result = managedXmlStructureAdapter.extractStructure(raw)

  assert.equal(result.kind, 'container')
  assert.equal(result.protocol, 'managed_xml')
  assert.equal(result.cleanContent, 'before  after')
  assert.deepEqual(result.warnings, [])

  assert.equal(result.extractedCalls.length, 1)
  assert.equal(result.extractedCalls[0].callIndex, 0)
  assert.equal(result.extractedCalls[0].rawToolName, 'bash')
  assert.equal(result.extractedCalls[0].rawParameters.length, 1)
  assert.deepEqual(result.extractedCalls[0].rawParameters[0], {
    rawName: 'argument',
    rawPayload: 'Get-ChildItem D:\\\\',
    payloadEncoding: 'cdata',
    rawSpan: result.extractedCalls[0].rawParameters[0].rawSpan,
  })
})

test('plain text has no tool intent', () => {
  const result = managedXmlStructureAdapter.extractStructure('hello <xml> but no marker')

  assert.deepEqual(result, {
    kind: 'no_intent',
    protocol: 'managed_xml',
    content: 'hello <xml> but no marker',
  })
})

test('standalone Chat2API invoke extracts as managed XML structure', () => {
  const raw = 'before <|CHAT2API|invoke name="bash"><|CHAT2API|parameter name="argument">pwd</|CHAT2API|parameter></|CHAT2API|invoke> after'
  const result = managedXmlStructureAdapter.extractStructure(raw)

  assert.equal(result.kind, 'container')
  if (result.kind !== 'container') throw new Error('expected container')
  assert.equal(result.cleanContent, 'before  after')
  assert.equal(result.rawMatches.length, 1)
  assert.equal(result.extractedCalls[0].rawToolName, 'bash')
  assert.deepEqual(result.extractedCalls[0].rawParameters[0], {
    rawName: 'argument',
    rawPayload: 'pwd',
    payloadEncoding: 'text',
    rawSpan: result.extractedCalls[0].rawParameters[0].rawSpan,
  })
})

test('fenced tool example is treated as no intent', () => {
  const result = managedXmlStructureAdapter.extractStructure([
    'Example:',
    '```xml',
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="bash"></|CHAT2API|invoke></|CHAT2API|tool_calls>',
    '```',
  ].join('\n'))

  assert.equal(result.kind, 'no_intent')
})

test('mixed Chat2API and OpenCode closing tags creates malformed structural intent', () => {
  const raw = '<|CHAT2API|tool_calls><|CHAT2API|invoke name="bash"><|CHAT2API|parameter name="argument"><![CDATA[Get-ChildItem D:\\\\]]></arg_value></tool_call>'
  const result = managedXmlStructureAdapter.extractStructure(raw)

  assert.equal(result.kind, 'malformed_container')
  assert.equal(result.protocol, 'managed_xml')
  assert.equal(result.warnings.some((warning) => warning.kind === 'foreign_protocol_marker'), true)
  assert.deepEqual(result.malformedIntent, {
    selectedProtocol: 'managed_xml',
    toolName: 'bash',
    parameters: [{
      name: 'argument',
      rawPayload: 'Get-ChildItem D:\\\\',
      payloadEncoding: 'cdata',
    }],
    rawContainerFingerprint: result.malformedIntent?.rawContainerFingerprint,
    failureKind: 'mixed_protocol_container',
  })
})

test('bracket protocol block is not parsed as managed XML fallback', () => {
  const raw = '[function_calls]\n[call:bash]{"argument":"pwd"}[/call]\n[/function_calls]'
  const result = managedXmlStructureAdapter.extractStructure(raw)

  assert.equal(result.kind, 'no_intent')
})

test('unterminated Chat2API container creates malformed result without tool calls', () => {
  const raw = '<|CHAT2API|tool_calls><|CHAT2API|invoke name="bash"><|CHAT2API|parameter name="argument">pwd'
  const result = managedXmlStructureAdapter.extractStructure(raw)

  assert.equal(result.kind, 'malformed_container')
  assert.equal(result.malformedIntent?.toolName, 'bash')
  assert.equal(result.malformedIntent?.parameters[0].name, 'argument')
  assert.equal(result.malformedIntent?.parameters[0].rawPayload, 'pwd')
  assert.equal(result.malformedIntent?.failureKind, 'unterminated_container')
})
