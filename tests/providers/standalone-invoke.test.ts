/**
 * Stub tests for standalone <|CHAT2API|invoke> fix.
 * Verifies parser accepts invokes without outer <|CHAT2API|tool_calls> wrapper.
 */
import { describe, test } from 'vitest'
import assert from 'node:assert'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { managedXmlProtocol } from '../../src/main/proxy/toolCalling/protocols/managedXml.ts'
import { GLMStreamHandler } from '../../src/main/proxy/adapters/glm.ts'
import type { ToolCallingPlan } from '../../src/main/proxy/toolCalling/types.ts'

const bashTool = {
  name: 'bash',
  description: 'Run a command',
  parameters: { type: 'object' as const, properties: { command: { type: 'string' } } },
  source: 'openai' as const,
}

function managedPlan(providerId: string): ToolCallingPlan {
  return {
    mode: 'managed',
    protocol: 'managed_xml',
    clientAdapterId: 'standard-openai-tools',
    providerId,
    tools: [bashTool],
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(['bash']),
    forcedToolName: undefined,
    catalogSnapshot: undefined,
    catalogDiagnostics: { source: 'current_request', driftKinds: [], blocked: false },
    availabilityRetryAllowed: false,
    diagnostics: {
      requestId: 'test',
      clientAdapterId: 'standard-openai-tools',
      providerId,
      model: 'test',
      toolSource: 'openai',
      mode: 'managed',
      protocol: 'managed_xml',
      toolCount: 1,
      injected: true,
      reason: 'managed_auto',
      toolChoiceMode: 'auto',
      allowedToolNames: ['bash'],
      catalogSource: 'current_request',
      catalogDriftKinds: [],
      catalogBlocked: false,
    },
  }
}

function sseEvent(data: Record<string, unknown>): string {
  return `event:delta\ndata:${JSON.stringify(data)}\n\n`
}

async function collect(stream: Readable): Promise<string> {
  let output = ''
  for await (const chunk of stream) {
    output += chunk.toString()
  }
  return output
}

const standaloneXml =
  '<|CHAT2API|invoke name="bash"><|CHAT2API|parameter name="command"><![CDATA[ls -la]]></|CHAT2API|parameter></|CHAT2API|invoke>'

const standaloneXmlWithPreamble =
  'I will run the command.\n\n<|CHAT2API|invoke name="bash"><|CHAT2API|parameter name="command"><![CDATA[ls -la]]></|CHAT2API|parameter></|CHAT2API|invoke>'

describe('Standalone <|CHAT2API|invoke> (no outer wrapper)', () => {
  test('1. detectStart matches standalone invoke', () => {
    const result = managedXmlProtocol.detectStart('<|CHAT2API|invoke name="bash">')
    assert.ok(result.matched)
    assert.equal(result.markerStart, 0)
  })

  test('2. detectStart matches standalone invoke with preceding text', () => {
    const result = managedXmlProtocol.detectStart('Some text.\n<|CHAT2API|invoke name="read">')
    assert.ok(result.matched)
    assert.equal(result.markerStart, 11)
  })

  test('3. detectStart partial-matches <|CHAT2API|inv prefix', () => {
    const result = managedXmlProtocol.detectStart('<|CHAT2API|inv')
    assert.ok(result.partial)
  })

  test('4. parse extracts standalone invoke', () => {
    const parsed = managedXmlProtocol.parse(standaloneXml, {
      tools: [bashTool],
      protocol: 'managed_xml',
    })

    assert.equal(parsed.toolCalls.length, 1)
    assert.equal(parsed.toolCalls[0].function.name, 'bash')
    const args = JSON.parse(parsed.toolCalls[0].function.arguments)
    assert.equal(args.command, 'ls -la')
    assert.match(String(parsed.protocol), /managed_xml/)
  })

  test('5. parse handles standalone invoke with preamble text', () => {
    const parsed = managedXmlProtocol.parse(standaloneXmlWithPreamble, {
      tools: [bashTool],
      protocol: 'managed_xml',
    })

    assert.equal(parsed.toolCalls.length, 1)
    assert.equal(parsed.toolCalls[0].function.name, 'bash')
    assert.match(String(parsed.content), /I will run the command/)
  })

  test('6. parse rejects standalone invoke with unknown tool name', () => {
    const parsed = managedXmlProtocol.parse(
      '<|CHAT2API|invoke name="unknown_tool"><|CHAT2API|parameter name="x"><![CDATA[1]]></|CHAT2API|parameter></|CHAT2API|invoke>',
      { tools: [bashTool], protocol: 'managed_xml' },
    )

    assert.equal(parsed.toolCalls.length, 0)
    assert.ok(parsed.invalidToolNames.includes('unknown_tool'))
  })

  test('7. parse still handles wrapped format alongside standalone', () => {
    // Both formats in same output: wrapped should work, standalone also processed
    const mixed =
      'Some text.\n<|CHAT2API|invoke name="bash"><|CHAT2API|parameter name="command"><![CDATA[pwd]]></|CHAT2API|parameter></|CHAT2API|invoke>\nMore text.'

    const parsed = managedXmlProtocol.parse(mixed, {
      tools: [bashTool],
      protocol: 'managed_xml',
    })

    assert.equal(parsed.toolCalls.length, 1)
    assert.equal(parsed.toolCalls[0].function.name, 'bash')
    const args = JSON.parse(parsed.toolCalls[0].function.arguments)
    assert.equal(args.command, 'pwd')
  })

  test('8. GLM stream emits standalone invoke as OpenAI tool_calls', async () => {
    const handler = new GLMStreamHandler('GLM-5.2', undefined, undefined, managedPlan('glm'))
    const body = [
      sseEvent({
        conversation_id: 'glm-standalone-1',
        status: 'streaming',
        parts: [{ logic_id: 'p1', status: 'streaming', content: [{ type: 'text', text: standaloneXml }] }],
      }),
      sseEvent({ conversation_id: 'glm-standalone-1', status: 'finish' }),
    ].join('')

    const output = await collect(
      await handler.handleStream(
        Readable.from([gzipSync(Buffer.from(body))]),
        { headers: { 'content-encoding': 'gzip' } } as any,
      ),
    )

    assert.match(output, /"tool_calls"/)
    assert.match(output, /"name":"bash"/)
    assert.match(output, /"finish_reason":"tool_calls"/)
    assert.equal((output.match(/data: \[DONE\]/g) || []).length, 1)
    assert.doesNotMatch(output, /<\|CHAT2API\|invoke/)
  })

  test('9. GLM stream emits standalone invoke with preamble', async () => {
    const handler = new GLMStreamHandler('GLM-5.2', undefined, undefined, managedPlan('glm'))
    const body = [
      sseEvent({
        conversation_id: 'glm-standalone-2',
        status: 'streaming',
        parts: [{ logic_id: 'p1', status: 'streaming', content: [{ type: 'text', text: standaloneXmlWithPreamble }] }],
      }),
      sseEvent({ conversation_id: 'glm-standalone-2', status: 'finish' }),
    ].join('')

    const output = await collect(
      await handler.handleStream(
        Readable.from([gzipSync(Buffer.from(body))]),
        { headers: { 'content-encoding': 'gzip' } } as any,
      ),
    )

    assert.match(output, /I will run the command/)
    assert.match(output, /"tool_calls"/)
    assert.match(output, /"name":"bash"/)
    assert.doesNotMatch(output, /<\|CHAT2API\|invoke/)
  })

  test('10. standalone invoke with invalid tool name silently dropped', async () => {
    const handler = new GLMStreamHandler('GLM-5.2', undefined, undefined, managedPlan('glm'))
    const invalidXml =
      '<|CHAT2API|invoke name="nonexistent"><|CHAT2API|parameter name="x"><![CDATA[1]]></|CHAT2API|parameter></|CHAT2API|invoke>'
    const body = [
      sseEvent({
        conversation_id: 'glm-standalone-3',
        status: 'streaming',
        parts: [{ logic_id: 'p1', status: 'streaming', content: [{ type: 'text', text: invalidXml }] }],
      }),
      sseEvent({ conversation_id: 'glm-standalone-3', status: 'finish' }),
    ].join('')

    const output = await collect(
      await handler.handleStream(
        Readable.from([gzipSync(Buffer.from(body))]),
        { headers: { 'content-encoding': 'gzip' } } as any,
      ),
    )

    assert.doesNotMatch(output, /"tool_calls"/)
    assert.doesNotMatch(output, /<\|CHAT2API\|invoke/)
    assert.match(output, /"finish_reason":"stop"/)
  })

  test('11. native type=tool_calls content is converted to OpenAI tool_calls', async () => {
    const handler = new GLMStreamHandler('GLM-5.2', undefined, undefined, managedPlan('glm'))
    const nativeToolCall = {
      id: 'call_native_1',
      type: 'function',
      function: {
        name: 'bash',
        arguments: '{"command":"ls -la"}',
      },
    }
    const body = [
      sseEvent({
        conversation_id: 'glm-native-1',
        status: 'streaming',
        parts: [{
          logic_id: 'p1',
          status: 'streaming',
          content: [
            { type: 'text', text: 'Let me check.' },
            { type: 'tool_calls', tool_calls: [nativeToolCall] },
          ],
        }],
      }),
      sseEvent({ conversation_id: 'glm-native-1', status: 'finish' }),
    ].join('')

    const output = await collect(
      await handler.handleStream(
        Readable.from([gzipSync(Buffer.from(body))]),
        { headers: { 'content-encoding': 'gzip' } } as any,
      ),
    )

    assert.match(output, /Let me check/)
    assert.match(output, /"tool_calls"/)
    assert.match(output, /"name":"bash"/)
    assert.match(output, /"finish_reason":"tool_calls"/)
  })

  test('12. native tool_calls are deduplicated by id', async () => {
    const handler = new GLMStreamHandler('GLM-5.2', undefined, undefined, managedPlan('glm'))
    const nativeToolCall = {
      id: 'call_native_2',
      type: 'function',
      function: { name: 'bash', arguments: '{"command":"pwd"}' },
    }
    const body = [
      sseEvent({
        conversation_id: 'glm-native-2',
        status: 'streaming',
        parts: [{
          logic_id: 'p1', status: 'streaming',
          content: [{ type: 'tool_calls', tool_calls: [nativeToolCall] }],
        }],
      }),
      // Second event with same tool_call id (GLM re-sends in subsequent events)
      sseEvent({
        conversation_id: 'glm-native-2',
        status: 'streaming',
        parts: [{
          logic_id: 'p1', status: 'streaming',
          content: [
            { type: 'text', text: '' },
            { type: 'tool_calls', tool_calls: [nativeToolCall] },
          ],
        }],
      }),
      sseEvent({ conversation_id: 'glm-native-2', status: 'finish' }),
    ].join('')

    const output = await collect(
      await handler.handleStream(
        Readable.from([gzipSync(Buffer.from(body))]),
        { headers: { 'content-encoding': 'gzip' } } as any,
      ),
    )

    // tool_call delta should appear exactly once (not counting finish_reason: "tool_calls")
    const tcCount = (output.match(/"tool_calls"\s*:/g) || []).length
    assert.equal(tcCount, 1, 'Native tool_calls delta should be emitted exactly once, got ' + tcCount)
  })

  test('13. native tool_calls in non-stream response is included in content for ToolCallingEngine', async () => {
    const handler = new GLMStreamHandler('GLM-5.2', undefined, undefined, managedPlan('glm'))
    const nativeToolCall = {
      id: 'call_ns_1',
      type: 'function',
      function: { name: 'bash', arguments: '{"command":"ls"}' },
    }
    const body = [
      sseEvent({
        conversation_id: 'glm-ns-native-1',
        status: 'streaming',
        parts: [{
          logic_id: 'p1', status: 'streaming',
          content: [
            { type: 'text', text: 'Running command.' },
            { type: 'tool_calls', tool_calls: [nativeToolCall] },
          ],
        }],
      }),
      sseEvent({ conversation_id: 'glm-ns-native-1', status: 'finish' }),
    ].join('')

    const result = await handler.handleNonStream(
      Readable.from([gzipSync(Buffer.from(body))]),
      { headers: { 'content-encoding': 'gzip' } } as any,
    )

    // Content should include both text and converted XML for ToolCallingEngine to parse
    assert.match(result.choices[0].message.content, /Running command/)
    assert.match(result.choices[0].message.content, /<\|CHAT2API\|tool_calls>/)
    assert.match(result.choices[0].message.content, /name="bash"/)
  })
})
