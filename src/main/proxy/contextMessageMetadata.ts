import type { ChatMessage } from './types'

export function preserveContextManagedMessageMetadata(
  originalMessages: ChatMessage[],
  processedMessages: ChatMessage[],
): ChatMessage[] {
  const buckets = new Map<string, ChatMessage[]>()

  for (const message of originalMessages) {
    const key = messageKey(message)
    const existing = buckets.get(key) ?? []
    buckets.set(key, [...existing, message])
  }

  return processedMessages.map((message) => {
    const key = messageKey(message)
    const candidates = buckets.get(key) ?? []
    const original = candidates.shift()
    buckets.set(key, candidates)

    if (!original) return message

    return {
      ...message,
      ...(original.name !== undefined ? { name: original.name } : {}),
      ...(original.tool_call_id !== undefined ? { tool_call_id: original.tool_call_id } : {}),
      ...(original.tool_calls !== undefined ? { tool_calls: original.tool_calls } : {}),
    }
  })
}

function messageKey(message: ChatMessage): string {
  return `${message.role}\u0000${stableContent(message.content)}`
}

function stableContent(content: ChatMessage['content']): string {
  return typeof content === 'string' ? content : JSON.stringify(content ?? null)
}
