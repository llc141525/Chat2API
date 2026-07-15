import type { ChatMessage } from './types'

export interface PreserveToolExchangePairsOptions {
  suppressedToolCallIds?: Iterable<string>
}

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
  options: PreserveToolExchangePairsOptions = {},
): ChatMessage[] {
  const suppressedToolCallIds = new Set(options.suppressedToolCallIds ?? [])
  const neededToolCallIds = new Set<string>()

  for (const message of processedMessages) {
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) {
        if (call?.id && !suppressedToolCallIds.has(call.id)) {
          neededToolCallIds.add(call.id)
        }
      }
    }

    if (
      message.role === 'tool'
      && message.tool_call_id
      && !suppressedToolCallIds.has(message.tool_call_id)
    ) {
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

    if (isRepresentedByProcessedToolCallSubset(message, processedMessages)) {
      return false
    }

    if (message.role === 'assistant') {
      return (message.tool_calls ?? []).some(
        (call) => call?.id
          && !suppressedToolCallIds.has(call.id)
          && neededToolCallIds.has(call.id)
      )
    }

    if (
      message.role === 'tool'
      && message.tool_call_id
      && !suppressedToolCallIds.has(message.tool_call_id)
    ) {
      return neededToolCallIds.has(message.tool_call_id)
    }

    return false
  })

  if (missingOriginalMessages.length === 0) {
    return processedMessages
  }

  const originalPositions = new Map<string, number>()
  originalMessages.forEach((message, index) => {
    originalPositions.set(messageIdentity(message), index)
  })

  const restoredMessages = [...processedMessages]

  for (const message of missingOriginalMessages) {
    const messageIndex = originalPositions.get(messageIdentity(message)) ?? -1
    const insertionIndex = restoredMessages.findIndex((candidate) => {
      const candidateIndex = originalPositions.get(messageIdentity(candidate))
      return candidateIndex !== undefined && candidateIndex > messageIndex
    })

    if (insertionIndex === -1) {
      restoredMessages.push(message)
    } else {
      restoredMessages.splice(insertionIndex, 0, message)
    }
  }

  return restoredMessages
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

function isRepresentedByProcessedToolCallSubset(
  originalMessage: ChatMessage,
  processedMessages: ChatMessage[],
): boolean {
  if (originalMessage.role !== 'assistant' || (originalMessage.tool_calls?.length ?? 0) === 0) {
    return false
  }

  const originalToolCalls = originalMessage.tool_calls ?? []

  return processedMessages.some((candidate) => {
    if (candidate.role !== 'assistant' || (candidate.tool_calls?.length ?? 0) === 0) {
      return false
    }

    if ((candidate.name ?? null) !== (originalMessage.name ?? null)) {
      return false
    }

    if (stableContent(candidate.content) !== stableContent(originalMessage.content)) {
      return false
    }

    const candidateToolCalls = candidate.tool_calls ?? []
    if (candidateToolCalls.length >= originalToolCalls.length) {
      return false
    }

    return candidateToolCalls.every((candidateCall) =>
      originalToolCalls.some((originalCall) =>
        originalCall.id === candidateCall.id
          && originalCall.type === candidateCall.type
          && originalCall.function.name === candidateCall.function.name
          && originalCall.function.arguments === candidateCall.function.arguments
      )
    )
  })
}
