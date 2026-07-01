import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { DeepSeekStreamHandler } from '../../src/main/proxy/adapters/deepseek-stream.ts'
import {
  clearToolDiagnosticEvents,
  getToolDiagnosticEvents,
} from '../../src/main/proxy/toolCalling/diagnostics.ts'

function sse(events: unknown[]): Readable {
  return Readable.from(events.map(event => `data: ${JSON.stringify(event)}\n\n`))
}

function rawSse(lines: string[]): Readable {
  return Readable.from(lines.map(line => `${line}\n\n`))
}

async function collect(stream: NodeJS.ReadableStream): Promise<string[]> {
  const chunks: string[] = []
  for await (const chunk of stream) {
    chunks.push(String(chunk))
  }
  return chunks
}

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0
}

test('DeepSeek stream appends citations from HAR fragment results', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-flash-search', 'session-1', undefined, true)
  const source = sse([
    { response_message_id: '2', model_type: 'default' },
    {
      v: {
        response: {
          thinking_enabled: false,
          fragments: [{
            type: 'SEARCH',
            results: [{
              url: 'https://www.nmc.cn/publish/forecast/ABJ/beijing.html',
              title: '北京-天气预报',
              cite_index: 1,
            }],
          }],
        },
      },
    },
    { p: 'response/fragments/-1/results', v: [{
      url: 'https://example.com/weather',
      title: '天气样例',
      cite_index: 2,
    }] },
    { p: 'response/fragments', o: 'APPEND', v: [{ id: 3, type: 'RESPONSE', content: '北京明天天气多云。' }] },
  ])

  const output = await collect(await handler.handleStream(source))
  const joined = output.join('')

  assert.match(joined, /北京明天天气多云/)
  assert.match(joined, /\[1\]: \[北京-天气预报\]\(https:\/\/www\.nmc\.cn\/publish\/forecast\/ABJ\/beijing\.html\)/)
  assert.match(joined, /\[2\]: \[天气样例\]\(https:\/\/example\.com\/weather\)/)
  assert.match(joined, /data: \[DONE\]/)
})

test('DeepSeek stream keeps existing cite index when merging duplicate URL without cite index', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-flash-search', 'session-duplicates', undefined, true)
  const source = sse([
    { response_message_id: '2', model_type: 'default' },
    { p: 'response/search_results', v: [{
      url: 'https://example.com/forecast',
      title: '初始天气来源',
      cite_index: 3,
    }] },
    { p: 'response/fragments/-1/results', v: [{
      url: 'https://example.com/forecast',
      title: '更新天气来源',
    }] },
    { p: 'response/fragments', o: 'APPEND', v: [{ id: 4, type: 'RESPONSE', content: '引用来源已更新。' }] },
  ])

  const output = await collect(await handler.handleStream(source))
  const joined = output.join('')

  assert.match(joined, /\[3\]: \[更新天气来源\]\(https:\/\/example\.com\/forecast\)/)
})

test('DeepSeek stream keeps existing cite index when duplicate URL has invalid cite index', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-flash-search', 'session-invalid-cite', undefined, true)
  const source = sse([
    { response_message_id: '2', model_type: 'default' },
    { p: 'response/search_results', v: [
      {
        url: 'https://example.com/invalid-null',
        title: '初始空引用',
        cite_index: 1,
      },
      {
        url: 'https://example.com/invalid-string',
        title: '初始字符串引用',
        cite_index: 2,
      },
    ] },
    { p: 'response/fragments/-1/results', v: [
      {
        url: 'https://example.com/invalid-null',
        title: '更新空引用',
        cite_index: null,
      },
      {
        url: 'https://example.com/invalid-string',
        title: '更新字符串引用',
        cite_index: '9',
      },
    ] },
    { p: 'response/fragments', o: 'APPEND', v: [{ id: 8, type: 'RESPONSE', content: '引用索引保持稳定。' }] },
  ])

  const output = await collect(await handler.handleStream(source))
  const joined = output.join('')

  assert.match(joined, /\[1\]: \[更新空引用\]\(https:\/\/example\.com\/invalid-null\)/)
  assert.match(joined, /\[2\]: \[更新字符串引用\]\(https:\/\/example\.com\/invalid-string\)/)
})

test('DeepSeek stream normalizes camelCase citeIndex search results', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-flash-search', 'session-camel', undefined, true)
  const source = sse([
    { response_message_id: '2', model_type: 'default' },
    { p: 'response/fragments/-1/results', v: [{
      url: 'https://example.com/camel',
      title: '驼峰引用',
      citeIndex: 4,
    }] },
    { p: 'response/fragments', o: 'APPEND', v: [{ id: 5, type: 'RESPONSE', content: '引用格式正常。' }] },
  ])

  const output = await collect(await handler.handleStream(source))
  const joined = output.join('')

  assert.match(joined, /\[4\]: \[驼峰引用\]\(https:\/\/example\.com\/camel\)/)
})

test('DeepSeek stream handles upstream DONE followed by stream end once', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-flash-search', 'session-done', undefined, true)
  const source = Readable.from([
    `data: ${JSON.stringify({ response_message_id: '2', model_type: 'default' })}\n\n`,
    `data: ${JSON.stringify({ p: 'response/fragments', o: 'APPEND', v: [{ id: 6, type: 'RESPONSE', content: '完成。' }] })}\n\n`,
    'data: [DONE]\n\n',
  ])

  const output = await collect(await handler.handleStream(source))
  const joined = output.join('')

  assert.equal(countMatches(joined, /data: \[DONE\]/g), 1)
  assert.equal(countMatches(joined, /"finish_reason":"stop"/g), 1)
})

test('DeepSeek search-silent stream suppresses citations', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-flash-search-silent', 'session-silent', undefined, true)
  const source = sse([
    { response_message_id: '2', model_type: 'default' },
    { p: 'response/fragments/-1/results', v: [{
      url: 'https://example.com/silent',
      title: '静默引用',
      cite_index: 5,
    }] },
    { p: 'response/fragments', o: 'APPEND', v: [{ id: 7, type: 'RESPONSE', content: '不会附加引用。' }] },
  ])

  const output = await collect(await handler.handleStream(source))
  const joined = output.join('')

  assert.match(joined, /不会附加引用/)
  assert.doesNotMatch(joined, /\[5\]: \[静默引用\]\(https:\/\/example\.com\/silent\)/)
  assert.match(joined, /data: \[DONE\]/)
})

test('DeepSeek non-stream appends HAR fragment citations to content', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-flash-search', 'session-1', undefined, true)
  const source = sse([
    { response_message_id: '2', model_type: 'default' },
    { p: 'response/fragments/-1/results', v: [{
      url: 'https://example.com/weather',
      title: '天气样例',
      cite_index: 1,
    }] },
    { p: 'response/fragments', o: 'APPEND', v: [{ id: 3, type: 'RESPONSE', content: '北京明天天气多云。' }] },
  ])

  const response: any = await handler.handleNonStream(source)

  assert.equal(response.choices[0].message.content, '北京明天天气多云。\n\n[1]: [天气样例](https://example.com/weather)')
  assert.equal(response.choices[0].finish_reason, 'stop')
})

test('DeepSeek stream handler uses requested alias semantics when actual model is primary', async () => {
  const searchHandler = new DeepSeekStreamHandler(
    'deepseek-v4-flash',
    'session-semantic-search',
    undefined,
    false,
    undefined,
    undefined,
    'deepseek-v4-flash-search',
  )
  const searchResponse: any = await searchHandler.handleNonStream(sse([{ v: '搜索正文。' }]))

  assert.equal(searchResponse.model, 'deepseek-v4-flash')
  assert.equal(searchResponse.choices[0].message.content, '搜索正文。')

  const thinkingHandler = new DeepSeekStreamHandler(
    'deepseek-v4-flash',
    'session-semantic-thinking',
    undefined,
    false,
    undefined,
    undefined,
    'DeepSeek-R1',
  )
  const thinkingResponse: any = await thinkingHandler.handleNonStream(sse([{ v: '思考内容。' }]))

  assert.equal(thinkingResponse.model, 'deepseek-v4-flash')
  assert.equal(thinkingResponse.choices[0].message.reasoning_content, '思考内容。')
  assert.equal(thinkingResponse.choices[0].message.content, '')
})

test('DeepSeek non-stream applies batched cite index patches to search results', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-flash-search', 'session-batch', undefined, true)
  const source = sse([
    { response_message_id: '2', model_type: 'default' },
    { p: 'response/fragments/-1/results', v: [{
      url: 'https://example.com/batch',
      title: '批量引用',
    }] },
    { p: 'response/fragments/-1/results', o: 'BATCH', v: [{ p: '0/cite_index', v: 1 }] },
    { p: 'response/fragments', o: 'APPEND', v: [{ id: 9, type: 'RESPONSE', content: '批量引用已生成。' }] },
  ])

  const response: any = await handler.handleNonStream(source)

  assert.equal(response.choices[0].message.content, '批量引用已生成。\n\n[1]: [批量引用](https://example.com/batch)')
  assert.equal(response.choices[0].finish_reason, 'stop')
})

test('DeepSeek non-stream returns citation without leading blank lines when content is empty', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-flash-search', 'session-empty-content', undefined, true)
  const source = sse([
    { response_message_id: '2', model_type: 'default' },
    { p: 'response/search_results', v: [{
      url: 'https://example.com/empty',
      title: '空正文引用',
      cite_index: 1,
    }] },
  ])

  const response: any = await handler.handleNonStream(source)

  assert.equal(response.choices[0].message.content, '[1]: [空正文引用](https://example.com/empty)')
  assert.equal(response.choices[0].finish_reason, 'stop')
})

test('DeepSeek non-stream keeps existing cite index when duplicate URL has invalid cite index', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-flash-search', 'session-nonstream-invalid-cite', undefined, true)
  const source = sse([
    { response_message_id: '2', model_type: 'default' },
    { p: 'response/search_results', v: [{
      url: 'https://example.com/nonstream-invalid',
      title: '初始引用',
      cite_index: 1,
    }] },
    { p: 'response/fragments/-1/results', v: [{
      url: 'https://example.com/nonstream-invalid',
      title: '更新引用',
      cite_index: '9',
    }] },
    { p: 'response/fragments', o: 'APPEND', v: [{ id: 10, type: 'RESPONSE', content: '引用索引稳定。' }] },
  ])

  const response: any = await handler.handleNonStream(source)

  assert.equal(response.choices[0].message.content, '引用索引稳定。\n\n[1]: [更新引用](https://example.com/nonstream-invalid)')
  assert.equal(response.choices[0].finish_reason, 'stop')
})

test('DeepSeek non-stream leaves managed XML for ToolCallingEngine to convert', async () => {
  const managedXmlToolCall = '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>'
  const handler = new DeepSeekStreamHandler('deepseek-v4-pro', 'session-managed-xml', undefined, false)
  const response: any = await handler.handleNonStream(sse([
    {
      v: {
        response: {
          thinking_enabled: false,
          fragments: [{ type: 'RESPONSE', content: managedXmlToolCall }],
        },
      },
    },
  ]))

  assert.equal(response.choices[0].message.tool_calls, undefined)
  assert.equal(response.choices[0].finish_reason, 'stop')
  assert.match(response.choices[0].message.content, /<\|CHAT2API\|tool_calls>/)
})

test('DeepSeek non-stream preserves bracket tool-like text as content for the engine boundary', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-flash-search', 'session-tool-citation', undefined, true)
  const source = sse([
    { response_message_id: '2', model_type: 'default' },
    { p: 'response/search_results', v: [{
      url: 'https://example.com/tool',
      title: '工具引用',
      cite_index: 1,
    }] },
    {
      p: 'response/fragments',
      o: 'APPEND',
      v: [{
        id: 11,
        type: 'RESPONSE',
        content: '[function_calls][call:get_weather]{"city":"北京"}[/call][/function_calls]',
      }],
    },
  ])

  const response: any = await handler.handleNonStream(source)

  assert.equal(response.choices[0].message.tool_calls, undefined)
  assert.equal(response.choices[0].finish_reason, 'stop')
  assert.match(response.choices[0].message.content, /\[function_calls\]/)
  assert.match(response.choices[0].message.content, /\[1\]: \[工具引用\]/)
})

test('DeepSeek non-stream records provider output diagnostics for empty assistant output', async () => {
  clearToolDiagnosticEvents()
  const handler = new DeepSeekStreamHandler('deepseek-v4-pro', 'session-empty-diagnostics', undefined, false)

  await handler.handleNonStream(sse([
    { response_message_id: 'msg-empty', model_type: 'default' },
  ]))

  const events = getToolDiagnosticEvents().filter((event) => event.type === 'provider_empty_output')
  assert.equal(events.length, 1)
  assert.equal(events[0].providerId, 'deepseek')
  assert.equal(events[0].model, 'deepseek-v4-pro')
  assert.equal(events[0].responseMode, 'non_streaming')
  assert.equal((events[0] as any).contentLength, 0)
  assert.equal((events[0] as any).reasoningLength, 0)
  assert.equal((events[0] as any).upstreamDoneSeen, false)
})

test('DeepSeek non-stream records provider output stats without prompt or arguments', async () => {
  clearToolDiagnosticEvents()
  const handler = new DeepSeekStreamHandler('DeepSeek-R1', 'session-stats-diagnostics', undefined, false)

  await handler.handleNonStream(rawSse([
    `data: ${JSON.stringify({ response_message_id: 'msg-stats', model_type: 'default' })}`,
    `data: ${JSON.stringify({ v: { response: { thinking_enabled: true, fragments: [{ type: 'THINK', content: 'reasoning text' }] } } })}`,
    `data: ${JSON.stringify({ p: 'response/fragments', o: 'APPEND', v: [{ id: 1, type: 'RESPONSE', content: 'answer text' }] })}`,
    'data: [DONE]',
  ]))

  const events = getToolDiagnosticEvents().filter((event) => event.type === 'provider_output_observed')
  assert.equal(events.length, 1)
  assert.equal((events[0] as any).contentLength, 'answer text'.length)
  assert.equal((events[0] as any).reasoningLength, 'reasoning text'.length)
  assert.equal((events[0] as any).fragmentTypes.includes('THINK'), true)
  assert.equal((events[0] as any).fragmentTypes.includes('RESPONSE'), true)
  assert.equal((events[0] as any).prompt, undefined)
  assert.equal((events[0] as any).argumentsText, undefined)
})

test('DeepSeek non-search responses preserve search text at fragment start', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-flash', 'session-preserve-search', undefined, false)
  const exactContent = [
    'search.example.com',
    'Search should remain at the beginning.',
    'https://search-api.example.com',
    'https://example.com/test?search=value',
  ].join('\n')
  const source = sse([
    {
      v: {
        response: {
          thinking_enabled: false,
          fragments: [{ type: 'RESPONSE', content: exactContent }],
        },
      },
    },
  ])

  const response: any = await handler.handleNonStream(source)

  assert.equal(response.choices[0].message.content, exactContent)
})

test('DeepSeek non-search streams preserve search text at chunk start', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-flash', 'session-preserve-stream-search', undefined, false)
  const source = sse([
    { v: { response: { thinking_enabled: false } } },
    { p: 'response/fragments', o: 'APPEND', v: [{ id: 12, type: 'RESPONSE', content: 'search.example.com' }] },
  ])

  const output = await collect(await handler.handleStream(source))
  const joined = output.join('')

  assert.match(joined, /"content":"search\.example\.com"/)
  assert.doesNotMatch(joined, /"content":"\.example\.com"/)
})

test('DeepSeek search responses still strip explicit search control markers', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-flash-search', 'session-strip-search-marker', undefined, true)
  const source = sse([
    {
      v: {
        response: {
          thinking_enabled: false,
          fragments: [{ type: 'RESPONSE', content: 'SEARCH 搜索正文。' }],
        },
      },
    },
  ])

  const response: any = await handler.handleNonStream(source)

  assert.equal(response.choices[0].message.content, '搜索正文。')
})
