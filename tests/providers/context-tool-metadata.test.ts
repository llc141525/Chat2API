import test from 'node:test'
import assert from 'node:assert/strict'

import { preserveContextManagedMessageMetadata } from '../../src/main/proxy/contextMessageMetadata.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'

test('context management preserves assistant tool_calls and tool_call_id metadata', () => {
  const original: ChatMessage[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'read file' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_0',
          type: 'function',
          function: { name: 'default_api:read_file', arguments: '{"filePath":"/tmp/a"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call_0', content: 'file body' },
    { role: 'user', content: 'continue' },
  ]

  const processed = original.slice(1).map((message) => ({
    role: message.role,
    content: message.content,
  }))

  const restored = preserveContextManagedMessageMetadata(original, processed as ChatMessage[])

  assert.deepEqual(restored[1].tool_calls, original[2].tool_calls)
  assert.equal(restored[2].tool_call_id, 'call_0')
})
