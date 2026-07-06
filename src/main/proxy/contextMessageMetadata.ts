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

export function preserveToolExchangePairs(
  originalMessages: ChatMessage[],
  processedMessages: ChatMessage[],
): ChatMessage[] {
  const neededToolCallIds = new Set<string>()

  for (const message of processedMessages) {
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) {
        if (call?.id) {
          neededToolCallIds.add(call.id)
        }
      }
    }

    if (message.role === 'tool' && message.tool_call_id) {
      neededToolCallIds.add(message.tool_call_id)
    }
  }

  if (neededToolCallIds.size === 0) {
    return processedMessages
  }

  const processedIdentities = new Set(processedMessages.map(messageIdentity))
  const missingOriginalMessages = originalMessages.filter((message) => {
    if (processedIdentities.has(messageIdentity(message))) {
      return false
    }

    if (message.role === 'assistant') {
      return (message.tool_calls ?? []).some((call) => call?.id && neededToolCallIds.has(call.id))
    }

    if (message.role === 'tool' && message.tool_call_id) {
      return neededToolCallIds.has(message.tool_call_id)
    }

    return false
  })

  if (missingOriginalMessages.length === 0) {
    return processedMessages
  }

  const originalPositions = new Map<ChatMessage, number>()
  originalMessages.forEach((message, index) => {
    originalPositions.set(message, index)
  })

  const timeline = processedMessages.map((message, processedIndex) => ({
    message,
    originalIndex: originalPositions.get(message) ?? Number.POSITIVE_INFINITY + processedIndex,
  }))

  for (const message of missingOriginalMessages) {
    timeline.push({
      message,
      originalIndex: originalPositions.get(message) ?? Number.POSITIVE_INFINITY,
    })
  }

  timeline.sort((left, right) => left.originalIndex - right.originalIndex)

  return timeline.map((entry) => entry.message)
}

function messageKey(message: ChatMessage): string {
  return `${message.role}\u0000${stableContent(message.content)}`
}

function messageIdentity(message: ChatMessage): string {
  return JSON.stringify({
    role: message.role,
    name: message.name ?? null,
    content: message.content ?? null,
    tool_call_id: message.tool_call_id ?? null,
    tool_calls: (message.tool_calls ?? []).map((call) => ({
      id: call.id,
      type: call.type,
      function: {
        name: call.function.name,
        arguments: call.function.arguments,
      },
    })),
  })
}

function stableContent(content: ChatMessage['content']): string {
  return typeof content === 'string' ? content : JSON.stringify(content ?? null)
}
