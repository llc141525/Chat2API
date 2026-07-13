import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { buildQwenChatRequestBodyForTest } from '../../src/main/proxy/adapters/qwen.ts'

test('Qwen request body uses chat scene when continuing an existing session', () => {
  const body = buildQwenChatRequestBodyForTest({
    request: {
      model: 'Qwen3-Max',
      messages: [{ role: 'user', content: 'continue the thread' }],
      stream: true,
    },
    actualModel: 'Qwen3-Max',
    sessionId: 'existing-session',
    reqId: 'new-req',
    parentReqId: 'prev-req',
    timestamp: 1,
    enableThinking: false,
    enableWebSearch: false,
  })

  assert.equal(body.session_id, 'existing-session')
  assert.equal(body.parent_req_id, 'prev-req')
  assert.equal(body.scene_param, 'chat')
})

test('Qwen request body keeps first_turn semantics for new sessions', () => {
  const body = buildQwenChatRequestBodyForTest({
    request: {
      model: 'Qwen3-Max',
      messages: [{ role: 'user', content: 'start a thread' }],
      stream: true,
    },
    actualModel: 'Qwen3-Max',
    sessionId: 'new-session',
    reqId: 'new-req',
    timestamp: 1,
    enableThinking: false,
    enableWebSearch: false,
  })

  assert.equal(body.parent_req_id, '0')
  assert.equal(body.scene_param, 'first_turn')
})

test('forwardQwen source reads and writes qwen conversation state', () => {
  const forwarderSource = readFileSync('src/main/proxy/forwarder.ts', 'utf8')

  assert.match(forwarderSource, /import\s+\{\s*inspectNonStreamAssistantOutput\s*\}\s+from\s+'\.\/toolCalling\/outputInspection\.ts'/)
  assert.match(forwarderSource, /inspectNonStreamAssistantOutput\(\{/)
  assert.match(forwarderSource, /qwenSessionId\?: string/)
  assert.match(forwarderSource, /qwenParentReqId\?: string/)
  assert.match(forwarderSource, /const convState = getProviderConversationState\(/)
  assert.match(forwarderSource, /sessionId: convState\?\.qwenSessionId/)
  assert.match(forwarderSource, /parentReqId: convState\?\.qwenParentReqId/)
  assert.match(forwarderSource, /setProviderConversationState\(\{[\s\S]*qwenSessionId: sid,[\s\S]*qwenParentReqId: parentReqId \|\| '0'/)
  assert.match(forwarderSource, /if \(!deleteSessionCallback\) \{\s*saveConversationState\(finalSessionId, finalResponseId\)\s*\}/)
  assert.doesNotMatch(forwarderSource, /saveConversationState\(finalSessionId, finalResponseId\)\s*[\r\n]+\s*if \(deleteSessionCallback && finalSessionId\)/)
})
