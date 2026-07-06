import test from 'node:test'
import assert from 'node:assert/strict'
import { getProviderToolProfile } from '../../src/main/proxy/toolCalling/providerProfiles.ts'

const calls = [
  { id: 'call_1', name: 'default_api:read_file', arguments: '{"filePath":"/tmp/a"}' },
]

test('first-version providers use managed prompt and managed xml by default', () => {
  for (const providerId of ['deepseek', 'kimi', 'glm', 'qwen']) {
    const profile = getProviderToolProfile(providerId)

    assert.equal(profile.managedSupport, true)
    assert.equal(profile.supportsNativeTools, false)
    assert.equal(profile.preferredManagedProtocol, 'managed_xml')
    assert.equal(profile.contractHeaderVersion, 1)
    assert.equal(profile.availabilityDriftRetry, 'enabled')
  }
})

test('priority providers format tool history with the Chat2API XML protocol', () => {
  for (const providerId of ['deepseek', 'kimi', 'glm', 'qwen']) {
    const profile = getProviderToolProfile(providerId)

    assert.equal(
      profile.formatAssistantToolCalls(calls),
      '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
    )
    assert.equal(
      profile.formatToolResult({ toolCallId: 'call_1', content: 'file body' }),
      '<|CHAT2API|tool_result tool_call_id="call_1"><![CDATA[file body]]></|CHAT2API|tool_result>',
    )
  }
})

test('unknown providers inherit catalog contract defaults', () => {
  const profile = getProviderToolProfile('custom-provider')

  assert.equal(profile.preferredManagedProtocol, 'managed_xml')
  assert.equal(profile.contractHeaderVersion, 1)
  assert.equal(profile.availabilityDriftRetry, 'enabled')
})

test('managed provider profiles expose contract header and availability retry defaults', () => {
  for (const providerId of ['qwen', 'qwen-ai', 'glm']) {
    const profile = getProviderToolProfile(providerId)
    assert.equal(profile.preferredManagedProtocol, 'managed_xml')
    assert.equal(profile.contractHeaderVersion, 1)
    assert.equal(profile.availabilityDriftRetry, 'enabled')
  }
})

test('managed provider profiles expose parser ownership and empty output policy facts', () => {
  for (const providerId of ['glm', 'qwen', 'qwen-ai']) {
    const profile = getProviderToolProfile(providerId)

    assert.equal(profile.managedPromptOwner, 'ToolCallingEngine')
    assert.equal(profile.parseStreaming, true)
    assert.equal(profile.parseNonStreaming, true)
    assert.equal(profile.supportsIntentionalEmptyOutput, false)
    assert.equal(profile.preservesToolHistory, true)
  }
})
