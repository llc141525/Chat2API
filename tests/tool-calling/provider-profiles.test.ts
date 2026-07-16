import test from 'node:test'
import assert from 'node:assert/strict'
import { getProviderToolProfile } from '../../src/main/proxy/toolCalling/providerProfiles.ts'

const calls = [
  { id: 'call_1', name: 'default_api:read_file', arguments: '{"filePath":"/tmp/a"}' },
]

test('first-version providers use managed prompt and managed xml by default', () => {
  for (const providerId of ['deepseek', 'kimi', 'glm', 'minimax', 'qwen']) {
    const profile = getProviderToolProfile(providerId)

    assert.equal(profile.managedSupport, true)
    assert.equal(profile.supportsNativeTools, false)
    assert.equal(profile.preferredManagedProtocol, 'managed_xml')
    assert.equal(profile.contractHeaderVersion, 1)
    assert.equal(profile.availabilityDriftRetry, 'enabled')
  }

  // zai uses managed_bracket protocol
  const zaiProfile = getProviderToolProfile('zai')
  assert.equal(zaiProfile.managedSupport, true)
  assert.equal(zaiProfile.supportsNativeTools, false)
  assert.equal(zaiProfile.preferredManagedProtocol, 'managed_bracket')
})

test('priority providers format tool history with the Chat2API XML protocol', () => {
  for (const providerId of ['deepseek', 'kimi', 'glm', 'minimax', 'qwen']) {
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

  // zai uses the bracket protocol format
  const zaiProfile = getProviderToolProfile('zai')
  assert.equal(
    zaiProfile.formatAssistantToolCalls(calls),
    '[function_calls]\n[call:default_api:read_file]{"filePath":"/tmp/a"}[/call]\n[/function_calls]',
  )
  assert.equal(
    zaiProfile.formatToolResult({ toolCallId: 'call_1', content: 'file body' }),
    '[TOOL_RESULT for call_1] file body',
  )
})

test('unknown providers inherit catalog contract defaults', () => {
  const profile = getProviderToolProfile('custom-provider')

  assert.equal(profile.preferredManagedProtocol, 'managed_xml')
  assert.equal(profile.contractHeaderVersion, 1)
  assert.equal(profile.availabilityDriftRetry, 'enabled')
  assert.equal(profile.managedToolSupportStatus, 'experimental')
  assert.equal(profile.managedTransport, 'unknown')
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
  for (const providerId of ['glm', 'qwen', 'qwen-ai', 'kimi', 'minimax']) {
    const profile = getProviderToolProfile(providerId)

    assert.equal(profile.managedPromptOwner, 'ToolCallingEngine')
    assert.equal(profile.parseStreaming, true)
    assert.equal(profile.parseNonStreaming, true)
    assert.equal(profile.supportsIntentionalEmptyOutput, false)
    assert.equal(profile.preservesToolExchangeHistory, true)
    assert.equal(profile.requiresHistoricalToolContractReplay, false)
  }
})

test('provider capability matrix marks accepted vs experimental managed providers explicitly', () => {
  assert.equal(getProviderToolProfile('deepseek').managedToolSupportStatus, 'accepted')
  assert.equal(getProviderToolProfile('glm').managedToolSupportStatus, 'accepted')
  assert.equal(getProviderToolProfile('qwen').managedToolSupportStatus, 'accepted')
  assert.equal(getProviderToolProfile('kimi').managedToolSupportStatus, 'experimental')
  assert.equal(getProviderToolProfile('minimax').managedToolSupportStatus, 'experimental')
  assert.equal(getProviderToolProfile('zai').managedToolSupportStatus, 'experimental')
})

test('provider capability matrix exposes transport and provider caveats for expansion targets', () => {
  assert.equal(getProviderToolProfile('kimi').managedTransport, 'grpc_web_stream')
  assert.equal(getProviderToolProfile('minimax').managedTransport, 'polling_stream')
  assert.equal(getProviderToolProfile('zai').managedTransport, 'provider_chat_api')
  assert.deepEqual(getProviderToolProfile('zai').providerRiskControlCaveats, ['captcha_or_risk_control'])
})
