import { preserveContextManagedMessageMetadata } from '../contextMessageMetadata.ts'
import type { ChatCompletionRequest, ProxyContext } from '../types.ts'
import type { AvailabilityRetryRequest } from '../toolCalling/types.ts'
import { createContextManagementService, type ContextManagementConfig } from './contextManagementService.ts'

export function stripSummaryMessagesForRetry(
  messages: ChatCompletionRequest['messages']
): ChatCompletionRequest['messages'] {
  return messages.filter(message => {
    if (message.role !== 'system' || typeof message.content !== 'string') {
      return true
    }
    return !message.content.includes('[Prior conversation summary')
      && !message.content.startsWith('[Conversation Summary]')
  })
}

export async function rebuildMessagesForSummaryContaminationRetry(
  messages: ChatCompletionRequest['messages'],
  contextManagementConfig: ContextManagementConfig
): Promise<ChatCompletionRequest['messages']> {
  const cleanSourceMessages = stripSummaryMessagesForRetry(messages)
  const contextService = createContextManagementService({
    enabled: true,
    strategies: {
      slidingWindow: {
        ...contextManagementConfig.strategies?.slidingWindow,
        enabled: true,
      },
      tokenLimit: {
        ...contextManagementConfig.strategies?.tokenLimit,
        enabled: false,
      },
      summary: {
        ...contextManagementConfig.strategies?.summary,
        enabled: false,
      },
    },
    executionOrder: ['slidingWindow'],
  })

  const processResult = await contextService.process(
    cleanSourceMessages.map(msg => ({
      role: msg.role as 'user' | 'assistant' | 'system' | 'tool',
      content: msg.content,
      ...(msg.name !== undefined ? { name: msg.name } : {}),
      ...(msg.tool_call_id !== undefined ? { tool_call_id: msg.tool_call_id } : {}),
      ...(msg.tool_calls !== undefined ? { tool_calls: msg.tool_calls } : {}),
      timestamp: Date.now(),
    }))
  )

  return preserveContextManagedMessageMetadata(
    cleanSourceMessages,
    processResult.messages.map(msg => ({
      role: msg.role,
      content: msg.content,
      ...(msg.name !== undefined ? { name: msg.name } : {}),
      ...(msg.tool_call_id !== undefined ? { tool_call_id: msg.tool_call_id } : {}),
      ...(msg.tool_calls !== undefined ? { tool_calls: msg.tool_calls } : {}),
    }))
  )
}

export async function executeBoundedAvailabilityRetry<TPayload>(input: {
  initialResult: any
  context: ProxyContext
  expectedCatalogFingerprint?: string
  detectRetry: (result: any) => AvailabilityRetryRequest | undefined
  buildRetryRequest: (retry: AvailabilityRetryRequest) => Promise<ChatCompletionRequest>
  executeRetry: (retryRequest: ChatCompletionRequest) => Promise<TPayload>
  parseRetryPayload: (payload: TPayload, retryRequest: ChatCompletionRequest) => Promise<any>
}): Promise<{ result: any; payload?: TPayload; retried: boolean }> {
  const retry = input.detectRetry(input.initialResult)
  if (!retry || input.expectedCatalogFingerprint !== retry.catalogFingerprint) {
    return { result: input.initialResult, retried: false }
  }

  const retryRequest = await input.buildRetryRequest(retry)
  const payload = await input.executeRetry(retryRequest)
  const result = await input.parseRetryPayload(payload, retryRequest)
  input.detectRetry(result)
  return { result, payload, retried: true }
}
