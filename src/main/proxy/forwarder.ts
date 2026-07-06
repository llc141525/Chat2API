/**
 * Proxy Service Module - Request Forwarder
 * Forwards requests to corresponding API based on provider configuration
 */

import axios, { AxiosRequestConfig, AxiosResponse, AxiosError } from 'axios'
import http2 from 'http2'
import { PassThrough } from 'stream'
import { Account, Provider } from '../store/types.ts'
import { ForwardResult, ChatCompletionRequest, ProxyContext } from './types.ts'
import { proxyStatusManager } from './status.ts'
import { storeManager } from '../store/store.ts'
import { DeepSeekAdapter } from './adapters/deepseek.ts'
import { DeepSeekStreamHandler } from './adapters/deepseek-stream.ts'
import { GLMAdapter, GLMStreamHandler } from './adapters/glm.ts'
import { KimiAdapter, KimiStreamHandler } from './adapters/kimi.ts'
import { MimoAdapter, MimoStreamHandler } from './adapters/mimo.ts'
import { QwenAdapter, QwenStreamHandler } from './adapters/qwen.ts'
import { QwenAiAdapter, QwenAiStreamHandler } from './adapters/qwen-ai.ts'
import { ZaiAdapter, ZaiStreamHandler } from './adapters/zai.ts'
import { MiniMaxAdapter, MiniMaxStreamHandler } from './adapters/minimax.ts'
import { PerplexityAdapter } from './adapters/perplexity.ts'
import { PerplexityStreamHandler } from './adapters/perplexity-stream.ts'
import { ToolCallingEngine } from './toolCalling/ToolCallingEngine.ts'
import type { ToolCallingTransformResult } from './toolCalling/types.ts'
import { inspectNonStreamAssistantOutput } from './toolCalling/outputInspection.ts'
import { preserveContextManagedMessageMetadata } from './contextMessageMetadata.ts'
import { sessionManager } from './sessionManager.ts'
import {
  createContextManagementService,
  SummaryGenerator,
  type ChatMessage as ContextChatMessage,
} from './services/contextManagementService.ts'

function shouldDeleteSession(): boolean {
  return sessionManager.shouldDeleteAfterChat()
}

/**
 * Conversation state cache for multi-turn support
 * Stores conversation/parent-message IDs keyed by tool session key
 */
export interface ConversationState {
  parentMessageId?: string
  conversationId?: string
  lastUsedAt: number
}

export const CONVERSATION_STATE_TTL = 5 * 60 * 1000
export const conversationStateCache = new Map<string, ConversationState>()

export function getConversationState(key: string): ConversationState | undefined {
  const state = conversationStateCache.get(key)
  if (state && Date.now() - state.lastUsedAt < CONVERSATION_STATE_TTL) {
    return state
  }
  conversationStateCache.delete(key)
  return undefined
}

export function setConversationState(key: string, update: Partial<ConversationState>): void {
  const existing = conversationStateCache.get(key)
  conversationStateCache.set(key, {
    ...existing,
    ...update,
    lastUsedAt: Date.now(),
  } as ConversationState)
}

type ProviderForwarder = {
  name: string
  matches: (provider: Provider) => boolean
  forward: (
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number,
    context: ProxyContext
  ) => Promise<ForwardResult>
}

/**
 * Request Forwarder
 */
export class RequestForwarder {
  private axiosInstance = axios.create({
    timeout: 120000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  })

  private readonly providerForwarders: ProviderForwarder[] = [
    {
      name: 'deepseek',
      matches: DeepSeekAdapter.isDeepSeekProvider,
      forward: (request, account, provider, actualModel, startTime, context) =>
        this.forwardDeepSeek(request, account, provider, actualModel, startTime, context),
    },
    {
      name: 'glm',
      matches: GLMAdapter.isGLMProvider,
      forward: (request, account, provider, actualModel, startTime, context) =>
        this.forwardGLM(request, account, provider, actualModel, startTime, context),
    },
    {
      name: 'kimi',
      matches: KimiAdapter.isKimiProvider,
      forward: (request, account, provider, actualModel, startTime, context) =>
        this.forwardKimi(request, account, provider, actualModel, startTime, context),
    },
    {
      name: 'qwen',
      matches: QwenAdapter.isQwenProvider,
      forward: (request, account, provider, actualModel, startTime, context) =>
        this.forwardQwen(request, account, provider, actualModel, startTime, context),
    },
    {
      name: 'qwen-ai',
      matches: QwenAiAdapter.isQwenAiProvider,
      forward: (request, account, provider, actualModel, startTime, context) =>
        this.forwardQwenAi(request, account, provider, actualModel, startTime, context),
    },
    {
      name: 'zai',
      matches: ZaiAdapter.isZaiProvider,
      forward: (request, account, provider, actualModel, startTime, context) =>
        this.forwardZai(request, account, provider, actualModel, startTime, context),
    },
    {
      name: 'minimax',
      matches: MiniMaxAdapter.isMiniMaxProvider,
      forward: (request, account, provider, actualModel, startTime, context) =>
        this.forwardMiniMax(request, account, provider, actualModel, startTime, context),
    },
    {
      name: 'mimo',
      matches: MimoAdapter.isMimoProvider,
      forward: (request, account, provider, actualModel, startTime, context) =>
        this.forwardMimo(request, account, provider, actualModel, startTime, context),
    },
    {
      name: 'perplexity',
      matches: PerplexityAdapter.isPerplexityProvider,
      forward: (request, account, provider, actualModel, startTime, context) =>
        this.forwardPerplexity(request, account, provider, actualModel, startTime, context),
    },
  ]

  /**
   * Transform request for prompt-based tool calling
   * For models that don't support native function calling
   * Delegates tool normalization, prompt injection, and parser planning to ToolCallingEngine.
   */
  private transformRequestForPromptToolUse(
    request: ChatCompletionRequest,
    provider?: Provider,
    toolSessionKey?: string | null
  ): ToolCallingTransformResult {
    const config = storeManager.getConfig().toolCallingConfig
    const engine = new ToolCallingEngine(config)

    return engine.transformRequest({
      request,
      provider: provider ?? {
        id: 'custom',
        name: 'Custom',
        type: 'custom',
        authType: 'token',
        apiEndpoint: '',
        headers: {},
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
      },
      actualModel: request.model,
      toolSessionKey: toolSessionKey ?? undefined,
    })
  }

  private applyToolCallsToResponse(result: any, transformed: ToolCallingTransformResult) {
    const engine = new ToolCallingEngine(storeManager.getConfig().toolCallingConfig)
    return engine.applyNonStreamResponse(result, transformed.plan)
  }

  private inspectManagedNonStreamOutput(
    result: any,
    transformed: ToolCallingTransformResult,
    startTime: number
  ): ForwardResult | undefined {
    const inspection = inspectNonStreamAssistantOutput({
      result,
      plan: transformed.plan,
    })

    if (inspection.ok) return undefined

    return {
      success: false,
      status: 502,
      error: inspection.error,
      latency: Date.now() - startTime,
    }
  }

  private buildAvailabilityRetryRequest(
    originalRequest: ChatCompletionRequest,
    transformed: ToolCallingTransformResult,
    clarification: string
  ): ChatCompletionRequest {
    return {
      ...originalRequest,
      stream: false,
      messages: [
        ...transformed.messages,
        {
          role: 'system',
          content: clarification,
        },
      ],
      tools: transformed.tools,
    }
  }

  private buildToolCatalogSessionKey(provider: Provider, account: Account, actualModel: string): string {
    return `${provider.id}:${account.id}:${actualModel}`
  }

  private buildProviderConversationStateKey(
    provider: Provider,
    account: Account,
    actualModel: string,
    request: ChatCompletionRequest,
    context: ProxyContext
  ): string {
    const sessionDimension = typeof request.user === 'string' && request.user.trim().length > 0
      ? request.user.trim()
      : context.requestId

    return `${provider.id}:${account.id}:${actualModel}:${sessionDimension}`
  }

  /**
   * Create summary generator function for context management
   * Uses the current provider and account to generate summaries
   */
  private createSummaryGenerator(
    account: Account,
    provider: Provider,
    actualModel: string,
    context: ProxyContext
  ): SummaryGenerator {
    return async (messages: ContextChatMessage[], prompt?: string): Promise<string> => {
      try {
        console.log('[SummaryGenerator] Generating summary for', messages.length, 'messages')

        const summaryPrompt = prompt || 'Please summarize the following conversation concisely, keeping key information and context:'

        const conversationText = messages
          .map(msg => {
            const role = msg.role.toUpperCase()
            const content = typeof msg.content === 'string'
              ? msg.content
              : Array.isArray(msg.content)
                ? msg.content
                    .filter(part => part.type === 'text' && part.text)
                    .map(part => part.text)
                    .join('\n')
                : ''
            return `${role}: ${content}`
          })
          .join('\n\n')

        const summaryRequest: ChatCompletionRequest = {
          model: actualModel,
          messages: [
            {
              role: 'system',
              content: summaryPrompt,
            },
            {
              role: 'user',
              content: conversationText,
            },
          ],
          stream: false,
          temperature: 0.3,
        }

        const result = await this.doForward(
          summaryRequest,
          account,
          provider,
          actualModel,
          context
        )

        if (result.success && result.body) {
          const summaryContent = result.body.choices?.[0]?.message?.content || ''
          console.log('[SummaryGenerator] Summary generated successfully, length:', summaryContent.length)
          return summaryContent
        }

        console.warn('[SummaryGenerator] Failed to generate summary:', result.error)
        return 'Failed to generate conversation summary.'
      } catch (error) {
        console.error('[SummaryGenerator] Error generating summary:', error)
        return 'Failed to generate conversation summary due to an error.'
      }
    }
  }

  /**
   * Forward Chat Completions Request
   */
  async forwardChatCompletion(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    context: ProxyContext
  ): Promise<ForwardResult> {
    const startTime = Date.now()
    const config = storeManager.getConfig()
    const maxRetries = config.retryCount

    let lastError: string | undefined

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        await this.delay(5000)
      }

      let modifiedRequest = request

      if (config.contextManagement?.enabled && modifiedRequest.messages && modifiedRequest.messages.length > 0) {
        try {
          const summaryGenerator = this.createSummaryGenerator(
            account,
            provider,
            actualModel,
            context
          )

          const contextService = createContextManagementService(
            config.contextManagement || {},
            summaryGenerator
          )

          const originalCount = modifiedRequest.messages.length
          const contextMessages: ContextChatMessage[] = modifiedRequest.messages.map(msg => ({
            role: msg.role as 'user' | 'assistant' | 'system' | 'tool',
            content: msg.content,
            timestamp: Date.now(),
          }))

          const processResult = await contextService.process(contextMessages)

          if (processResult.finalCount !== originalCount) {
            console.log(
              `[Forwarder] Context management applied: ${originalCount} -> ${processResult.finalCount} messages`
            )

            processResult.strategyResults.forEach(result => {
              if (result.trimmed) {
                console.log(
                  `[Forwarder] Strategy ${result.strategyName}: ${result.originalCount} -> ${result.processedCount} messages`
                )
              }
            })

            modifiedRequest = {
              ...modifiedRequest,
              messages: preserveContextManagedMessageMetadata(modifiedRequest.messages, processResult.messages.map(msg => ({
                role: msg.role,
                content: msg.content,
              }))),
            }
          }
        } catch (error) {
          console.error('[Forwarder] Context management failed:', error)
        }
      }

      try {
        const result = await this.doForward(modifiedRequest, account, provider, actualModel, context)

        if (result.success) {
          return result
        }

        lastError = result.error

        if (result.status && result.status < 500 && result.status !== 429) {
          break
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Unknown error'
      }
    }

    return {
      success: false,
      error: lastError || 'Request failed after retries',
      latency: Date.now() - startTime,
    }
  }

  /**
   * Execute Forward
   */
  private async doForward(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    context: ProxyContext
  ): Promise<ForwardResult> {
    const startTime = Date.now()

    const dedicatedForwarder = this.providerForwarders.find(forwarder => forwarder.matches(provider))
    if (dedicatedForwarder) {
      return dedicatedForwarder.forward(request, account, provider, actualModel, startTime, context)
    }

    try {
      const chatPath = provider.chatPath || '/chat/completions'
      const url = this.buildUrl(provider, chatPath)
      const headers = this.buildHeaders(provider, account)
      const body = this.buildRequestBody(request, actualModel, account)

      const axiosConfig: AxiosRequestConfig = {
        method: 'POST',
        url,
        headers,
        data: body,
        timeout: proxyStatusManager.getConfig().timeout,
        responseType: request.stream ? 'stream' : 'json',
        validateStatus: () => true,
      }

      const response: AxiosResponse = await this.axiosInstance.request(axiosConfig)
      const latency = Date.now() - startTime

      if (response.status >= 400) {
        return {
          success: false,
          status: response.status,
          error: this.extractErrorMessage(response),
          latency,
        }
      }

      if (request.stream) {
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: response.data,
          latency,
        }
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: response.data,
        latency,
      }
    } catch (error) {
      const latency = Date.now() - startTime

      if (error instanceof AxiosError) {
        return {
          success: false,
          status: error.response?.status,
          error: error.message,
          latency,
        }
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * DeepSeek Dedicated Forward
   */
  private async forwardDeepSeek(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number,
    context: ProxyContext
  ): Promise<ForwardResult> {
    try {
      const toolSessionKey = this.buildToolCatalogSessionKey(provider, account, actualModel)
      const conversationStateKey = this.buildProviderConversationStateKey(provider, account, actualModel, request, context)
      const transformed = this.transformRequestForPromptToolUse(
        request,
        provider,
        toolSessionKey
      )
      const transformedRequest = {
        ...request,
        messages: transformed.messages,
        tools: transformed.tools,
      }

      // Check for existing conversation state (multi-turn)
      const convState = getConversationState(conversationStateKey)

      const adapter = new DeepSeekAdapter(provider, account)

      const { response, sessionId } = await adapter.chatCompletion({
        model: request.model,
        messages: transformedRequest.messages as any,
        stream: transformedRequest.stream,
        temperature: transformedRequest.temperature,
        web_search: transformedRequest.web_search,
        reasoning_effort: transformedRequest.reasoning_effort,
        parentMessageId: convState?.parentMessageId,
      })

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        if (response.data) {
          if (typeof response.data === 'string') {
            errorMessage = response.data
          } else if (response.data.msg) {
            errorMessage = response.data.msg
          } else if (response.data.error?.message) {
            errorMessage = response.data.error.message
          }
        }
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      // Prepare callback for saving conversation state
      const saveConversationState = () => {
        const lastMessageId = handler.getLastMessageId()
        if (lastMessageId) {
          setConversationState(toolSessionKey, { parentMessageId: lastMessageId })
          setConversationState(conversationStateKey, { parentMessageId: lastMessageId })
        }
      }

      // Prepare callback for deleting session
      const deleteSessionCallback = shouldDeleteSession()
        ? async () => {
            try {
              await adapter.deleteSession(sessionId)
            } catch (error) {
              console.error('[DeepSeek] Failed to delete session:', error)
            }
          }
        : undefined

      // Compose state-saving with optional delete for stream end callback
      // handler's onEnd is sync (() => void); async delete is fire-and-forget (original behavior)
      const composedEndCallback = deleteSessionCallback
        ? () => {
            saveConversationState()
            deleteSessionCallback()
          }
        : saveConversationState

      // DeepSeek always returns streaming response
      const handler = new DeepSeekStreamHandler(
        actualModel,
        sessionId,
        composedEndCallback,
        transformedRequest.web_search,
        transformedRequest.reasoning_effort,
        transformed.plan,
        request.model
      )
      
      if (request.stream) {
        const transformedStream = await handler.handleStream(response.data, response)
        
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: sessionId,
        }
      }

// Non-streaming requests need to collect stream data and convert
      let result = await handler.handleNonStream(response.data, response)

      const retry = this.applyToolCallsToResponse(result, transformed)
      if (retry && transformed.plan.catalogSnapshot?.fingerprint === retry.catalogFingerprint) {
        const retryRequest = this.buildAvailabilityRetryRequest(request, transformed, retry.clarification)
        const retryResponse = await adapter.chatCompletion({
          model: request.model,
          messages: retryRequest.messages as any,
          stream: false,
          temperature: request.temperature,
          web_search: request.web_search,
          reasoning_effort: request.reasoning_effort,
        })
        const retryHandler = new DeepSeekStreamHandler(
          actualModel,
          retryResponse.sessionId,
          deleteSessionCallback,
          retryRequest.web_search,
          retryRequest.reasoning_effort,
          transformed.plan,
          request.model
        )
        result = await retryHandler.handleNonStream(retryResponse.data, retryResponse)
        this.applyToolCallsToResponse(result, transformed)
        // Save state from retry handler (original handler's state is stale)
        const retryMsgId = retryHandler.getLastMessageId()
        if (retryMsgId) {
          setConversationState(conversationStateKey, { parentMessageId: retryMsgId })
        }
      } else {
        // Save state from original handler (no retry occurred)
        saveConversationState()
      }

      if (deleteSessionCallback) {
        await deleteSessionCallback()
      }

      const emptyOutputFailure = this.inspectManagedNonStreamOutput(result, transformed, startTime)
      if (emptyOutputFailure) return emptyOutputFailure

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: sessionId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * GLM Dedicated Forward
   */
  private async forwardGLM(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number,
    context: ProxyContext
  ): Promise<ForwardResult> {
    try {
      const toolSessionKey = this.buildToolCatalogSessionKey(provider, account, actualModel)
      const conversationStateKey = this.buildProviderConversationStateKey(provider, account, actualModel, request, context)
      const transformed = this.transformRequestForPromptToolUse(
        request,
        provider,
        toolSessionKey
      )
      const transformedRequest = {
        ...request,
        messages: transformed.messages,
        tools: transformed.tools,
      }

      // Check for existing conversation state (multi-turn)
      const convState = getConversationState(conversationStateKey)

      const adapter = new GLMAdapter(provider, account)
      const { response, conversationId } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.model,
        messages: transformedRequest.messages as any,
        stream: request.stream,
        temperature: request.temperature,
        web_search: request.web_search,
        reasoning_effort: request.reasoning_effort,
        deep_research: request.deep_research,
        conversationId: convState?.conversationId,
      })

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        if (response.data) {
          if (typeof response.data === 'string') {
            errorMessage = response.data
          } else if (response.data.msg) {
            errorMessage = response.data.msg
          } else if (response.data.message) {
            errorMessage = response.data.message
          } else if (response.data.error?.message) {
            errorMessage = response.data.error.message
          }
        }
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const handler = new GLMStreamHandler(actualModel, undefined, undefined, transformed.plan as any)

      if (request.stream) {
        const transformedStream = await handler.handleStream(response.data, response)

        // If delete session after chat is enabled, we need to handle it after stream ends
        if (shouldDeleteSession()) {
          const originalEnd = transformedStream.end.bind(transformedStream)
          transformedStream.end = function(chunk?: any, encoding?: any, callback?: any) {
            const convId = handler.getConversationId()
            if (convId) {
              setConversationState(conversationStateKey, { conversationId: convId })
              adapter.deleteConversation(convId).catch(err => {
                console.error('[GLM] Failed to delete session:', err)
              })
            }
            return originalEnd(chunk, encoding, callback)
          }
        } else {
          // Save conversation state when stream ends (no deletion)
          const originalEnd = transformedStream.end.bind(transformedStream)
          transformedStream.end = function(chunk?: any, encoding?: any, callback?: any) {
            const convId = handler.getConversationId()
            if (convId) {
              setConversationState(conversationStateKey, { conversationId: convId })
            }
            return originalEnd(chunk, encoding, callback)
          }
        }

        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: handler.getConversationId(),
        }
      }

let result = await handler.handleNonStream(response.data, response)

      const retry = this.applyToolCallsToResponse(result, transformed)
      if (retry && transformed.plan.catalogSnapshot?.fingerprint === retry.catalogFingerprint) {
        const retryRequest = this.buildAvailabilityRetryRequest(request, transformed, retry.clarification)
        const retryResponse = await adapter.chatCompletion({
          model: actualModel,
          originalModel: request.model,
          messages: retryRequest.messages as any,
          stream: false,
          temperature: request.temperature,
          web_search: request.web_search,
          reasoning_effort: request.reasoning_effort,
          deep_research: request.deep_research,
        })
        const retryHandler = new GLMStreamHandler(actualModel, undefined, undefined, transformed.plan as any)
        result = await retryHandler.handleNonStream(retryResponse.data, retryResponse)
        this.applyToolCallsToResponse(result, transformed)
        // Save state from retry handler (original handler's conversationId is stale)
        const retryConvId = retryHandler.getConversationId()
        if (retryConvId) {
          setConversationState(conversationStateKey, { conversationId: retryConvId })
        }
      } else {
        // Save state from original handler (no retry occurred)
        const convId = handler.getConversationId()
        if (convId) {
          setConversationState(conversationStateKey, { conversationId: convId })
        }
      }

      if (shouldDeleteSession()) {
        const convId = handler.getConversationId()
        if (convId) {
          await adapter.deleteConversation(convId)
        }
      }

      const emptyOutputFailure = this.inspectManagedNonStreamOutput(result, transformed, startTime)
      if (emptyOutputFailure) return emptyOutputFailure

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: handler.getConversationId() ?? undefined,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  private async forwardKimi(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(
        request,
        provider,
        this.buildToolCatalogSessionKey(provider, account, actualModel)
      )
      
      const adapter = new KimiAdapter(provider, account)
      const { response, conversationId } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.model,
        messages: transformed.messages,
        stream: request.stream,
        temperature: request.temperature,
        enableThinking: !!request.reasoning_effort,
        enableWebSearch: !!request.web_search,
      })

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const handler = new KimiStreamHandler(actualModel, conversationId, !!request.reasoning_effort, transformed.plan)
      
      if (request.stream) {
        const transformedStream = await handler.handleStream(response.data)
        
        // Add delete conversation callback if needed
        if (shouldDeleteSession()) {
          const originalEnd = transformedStream.end.bind(transformedStream)
          transformedStream.end = function(chunk?: any, encoding?: any, callback?: any) {
            const realChatId = handler.getConversationId()
            if (realChatId) {
              adapter.deleteConversation(realChatId).catch(err => {
                console.error('[Kimi] Failed to delete conversation:', err)
              })
            }
            return originalEnd(chunk, encoding, callback)
          }
        }
        
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: undefined,
        }
      }

      let result = await handler.handleNonStream(response.data)

      const retry = this.applyToolCallsToResponse(result, transformed)
      if (retry && transformed.plan.catalogSnapshot?.fingerprint === retry.catalogFingerprint) {
        const retryRequest = this.buildAvailabilityRetryRequest(request, transformed, retry.clarification)
        const retryResponse = await adapter.chatCompletion({
          model: actualModel,
          originalModel: request.model,
          messages: retryRequest.messages as any,
          stream: false,
          temperature: request.temperature,
          enableThinking: !!request.reasoning_effort,
          enableWebSearch: !!request.web_search,
        })
        const retryHandler = new KimiStreamHandler(actualModel, retryResponse.conversationId, !!request.reasoning_effort, transformed.plan)
        result = await retryHandler.handleNonStream(retryResponse.response.data)
        this.applyToolCallsToResponse(result, transformed)
      }

      if (shouldDeleteSession()) {
        const realChatId = handler.getConversationId()
        if (realChatId) {
          await adapter.deleteConversation(realChatId)
        }
      }

      const emptyOutputFailure = this.inspectManagedNonStreamOutput(result, transformed, startTime)
      if (emptyOutputFailure) return emptyOutputFailure

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: handler.getConversationId() ?? undefined,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Qwen Dedicated Forward
   */
  private async forwardQwen(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(
        request,
        provider,
        this.buildToolCatalogSessionKey(provider, account, actualModel)
      )
      const transformedRequest = {
        ...request,
        messages: transformed.messages,
        tools: transformed.tools,
      }

      const adapter = new QwenAdapter(provider, account)
      const { response, sessionId, reqId } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.model,
        messages: transformedRequest.messages as any,
        stream: request.stream,
        temperature: request.temperature,
        enableThinking: !!request.reasoning_effort,
        enableWebSearch: !!request.web_search,
      })

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const deleteSessionCallback = shouldDeleteSession()
        ? async (sid: string) => {
            try {
              await adapter.deleteSession(sid)
            } catch (err) {
              console.error('[Qwen] Failed to delete session:', err)
            }
          }
        : undefined

      const handler = new QwenStreamHandler(actualModel, deleteSessionCallback, transformed.plan)

      if (request.stream) {
        const transformedStream = await handler.handleStream(response.data, response)

        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: sessionId,
        }
      }

      let result = await handler.handleNonStream(response.data, response)

      const retry = this.applyToolCallsToResponse(result, transformed)
      if (retry && transformed.plan.catalogSnapshot?.fingerprint === retry.catalogFingerprint) {
        const retryRequest = this.buildAvailabilityRetryRequest(request, transformed, retry.clarification)
        const retryResponse = await adapter.chatCompletion({
          model: actualModel,
          originalModel: request.model,
          messages: retryRequest.messages as any,
          stream: false,
          temperature: request.temperature,
          enableThinking: !!request.reasoning_effort,
          enableWebSearch: !!request.web_search,
        })
        const retryHandler = new QwenStreamHandler(actualModel, deleteSessionCallback, transformed.plan)
        result = await retryHandler.handleNonStream(retryResponse.data, retryResponse)
        this.applyToolCallsToResponse(result, transformed)
      }

      const sid = handler.getSessionId()
      if (deleteSessionCallback && sid) {
        await deleteSessionCallback(sid)
      }

      const emptyOutputFailure = this.inspectManagedNonStreamOutput(result, transformed, startTime)
      if (emptyOutputFailure) return emptyOutputFailure

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: sessionId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Qwen AI (International) Dedicated Forward
   */
  private async forwardQwenAi(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(
        request,
        provider,
        this.buildToolCatalogSessionKey(provider, account, actualModel)
      )
      const transformedRequest = {
        ...request,
        messages: transformed.messages,
        tools: transformed.tools,
      }

      const adapter = new QwenAiAdapter(provider, account)
      const { response, chatId, parentId } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.model,
        messages: transformedRequest.messages as any,
        stream: request.stream,
        temperature: request.temperature,
        enable_thinking: !!request.reasoning_effort,
      })

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const handler = new QwenAiStreamHandler(actualModel, undefined, transformed.plan as any)
      handler.setChatId(chatId)

      if (request.stream) {
        const transformedStream = await handler.handleStream(response.data)

        if (shouldDeleteSession()) {
          const originalEnd = transformedStream.end.bind(transformedStream)
          transformedStream.end = function(chunk?: any, encoding?: any, callback?: any) {
            adapter.deleteChat(chatId).catch(err => {
              console.error('[QwenAI] Failed to delete chat:', err)
            })
            return originalEnd(chunk, encoding, callback)
          }
        }

        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: chatId,
        }
      }

      let result = await handler.handleNonStream(response.data)

      const retry = this.applyToolCallsToResponse(result, transformed)
      if (retry && transformed.plan.catalogSnapshot?.fingerprint === retry.catalogFingerprint) {
        const retryRequest = this.buildAvailabilityRetryRequest(request, transformed, retry.clarification)
        const retryResponse = await adapter.chatCompletion({
          model: actualModel,
          originalModel: request.model,
          messages: retryRequest.messages as any,
          stream: false,
          temperature: request.temperature,
          enable_thinking: !!request.reasoning_effort,
        })
        const retryHandler = new QwenAiStreamHandler(actualModel, undefined, transformed.plan as any)
        retryHandler.setChatId(retryResponse.chatId)
        result = await retryHandler.handleNonStream(retryResponse.data)
        this.applyToolCallsToResponse(result, transformed)
      }

      if (shouldDeleteSession()) {
        await adapter.deleteChat(chatId)
      }

      const emptyOutputFailure = this.inspectManagedNonStreamOutput(result, transformed, startTime)
      if (emptyOutputFailure) return emptyOutputFailure

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: chatId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Z.ai Dedicated Forward
   */
  private async forwardZai(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    console.log('[forwardZai] actualModel:', actualModel)
    console.log('[forwardZai] provider.modelMappings:', provider.modelMappings)
    try {
      const transformed = this.transformRequestForPromptToolUse(
        request,
        provider,
        this.buildToolCatalogSessionKey(provider, account, actualModel)
      )
      
      const adapter = new ZaiAdapter(provider, account)
      const { response, chatId, requestId } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.model,
        messages: transformed.messages as any,
        stream: request.stream,
        temperature: request.temperature,
        web_search: request.web_search,
        reasoning_effort: request.reasoning_effort,
      })

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        try {
          const chunks: Buffer[] = []
          response.data.on('data', (chunk: Buffer) => chunks.push(chunk))
          await new Promise<void>((resolve) => {
            response.data.on('end', () => resolve())
            response.data.on('error', () => resolve())
          })
          const errorBody = Buffer.concat(chunks).toString('utf8')
          if (errorBody) {
            errorMessage += ` - ${errorBody.slice(0, 500)}`
          }
        } catch {}
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const deleteChatCallback = shouldDeleteSession()
        ? async (cid: string) => {
            try {
              await adapter.deleteChat(cid)
            } catch (error) {
              console.error('[Z.ai] Failed to delete chat:', error)
            }
          }
        : undefined

      const handler = new ZaiStreamHandler(actualModel, deleteChatCallback, transformed.plan)
      handler.setChatId(chatId)
      
      if (request.stream === true) {
        const transformedStream = await handler.handleStream(response.data)
        
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: chatId,
        }
      }

      let result = await handler.handleNonStream(response.data)

      const retry = this.applyToolCallsToResponse(result, transformed)
      if (retry && transformed.plan.catalogSnapshot?.fingerprint === retry.catalogFingerprint) {
        const retryRequest = this.buildAvailabilityRetryRequest(request, transformed, retry.clarification)
        const retryResponse = await adapter.chatCompletion({
          model: actualModel,
          originalModel: request.model,
          messages: retryRequest.messages as any,
          stream: false,
          temperature: request.temperature,
          web_search: request.web_search,
          reasoning_effort: request.reasoning_effort,
        })
        const retryHandler = new ZaiStreamHandler(actualModel, deleteChatCallback, transformed.plan)
        retryHandler.setChatId(retryResponse.chatId)
        result = await retryHandler.handleNonStream(retryResponse.response.data)
        this.applyToolCallsToResponse(result, transformed)
      }
      
      if (deleteChatCallback) {
        await deleteChatCallback(chatId)
      }

      const emptyOutputFailure = this.inspectManagedNonStreamOutput(result, transformed, startTime)
      if (emptyOutputFailure) return emptyOutputFailure

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: chatId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * MiniMax Dedicated Forward
   */
  private async forwardMiniMax(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    console.log('[forwardMiniMax] actualModel:', actualModel)
    console.log('[forwardMiniMax] provider.modelMappings:', provider.modelMappings)
    try {
      const transformed = this.transformRequestForPromptToolUse(
        request,
        provider,
        this.buildToolCatalogSessionKey(provider, account, actualModel)
      )
      
      const adapter = new MiniMaxAdapter(provider, account)
      const { response, stream, chatId } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.model,
        messages: transformed.messages as any,
        stream: request.stream,
        temperature: request.temperature,
        toolCallingPlan: transformed.plan,
      })

      const latency = Date.now() - startTime

      if (response && response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const deleteChatCallback = shouldDeleteSession()
        ? async (cid: string) => {
            try {
              await adapter.deleteChat(cid)
            } catch (error) {
              console.error('[MiniMax] Failed to delete chat:', error)
            }
          }
        : undefined

      if (request.stream === true && stream) {
        console.log('[forwardMiniMax] Using polling stream')
        
        if (deleteChatCallback) {
          const originalStream = stream.stream as unknown as PassThrough
          const originalEnd = originalStream.end.bind(originalStream)
          originalStream.end = function(chunk?: any, encoding?: any, callback?: any) {
            deleteChatCallback(chatId).catch(err => {
              console.error('[MiniMax] Failed to delete chat:', err)
            })
            return originalEnd(chunk, encoding, callback)
          }
        }
        
        return {
          success: true,
          status: 200,
          headers: {},
          stream: stream.stream as any,
          skipTransform: true,
          latency,
          providerSessionId: chatId,
        }
      }

      if (response) {
        let responseData = response.data
        const retry = this.applyToolCallsToResponse(responseData, transformed)
        if (retry && transformed.plan.catalogSnapshot?.fingerprint === retry.catalogFingerprint) {
          const retryRequest = this.buildAvailabilityRetryRequest(request, transformed, retry.clarification)
          const retryResponse = await adapter.chatCompletion({
            model: actualModel,
            originalModel: request.model,
            messages: retryRequest.messages as any,
            stream: false,
            temperature: request.temperature,
            toolCallingPlan: transformed.plan,
          })
          if (retryResponse.response) {
            responseData = retryResponse.response.data
            this.applyToolCallsToResponse(responseData, transformed)
          }
        }
        
        if (deleteChatCallback) {
          await deleteChatCallback(chatId)
        }

        const emptyOutputFailure = this.inspectManagedNonStreamOutput(responseData, transformed, startTime)
        if (emptyOutputFailure) return emptyOutputFailure

        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          body: responseData,
          latency,
          providerSessionId: chatId,
        }
      }

      if (stream) {
        const handler = new MiniMaxStreamHandler(actualModel, deleteChatCallback, transformed.plan)
        handler.setChatId(chatId)
        let result = await handler.handleNonStream(stream.stream)
        const retry = this.applyToolCallsToResponse(result, transformed)
        if (retry && transformed.plan.catalogSnapshot?.fingerprint === retry.catalogFingerprint) {
          const retryRequest = this.buildAvailabilityRetryRequest(request, transformed, retry.clarification)
          const retryResponse = await adapter.chatCompletion({
            model: actualModel,
            originalModel: request.model,
            messages: retryRequest.messages as any,
            stream: false,
            temperature: request.temperature,
            toolCallingPlan: transformed.plan,
          })
          if (retryResponse.stream) {
            const retryHandler = new MiniMaxStreamHandler(actualModel, deleteChatCallback, transformed.plan)
            retryHandler.setChatId(retryResponse.chatId)
            result = await retryHandler.handleNonStream(retryResponse.stream.stream)
            this.applyToolCallsToResponse(result, transformed)
          }
        }

        if (deleteChatCallback) {
          await deleteChatCallback(chatId)
        }

        const emptyOutputFailure = this.inspectManagedNonStreamOutput(result, transformed, startTime)
        if (emptyOutputFailure) return emptyOutputFailure

        return {
          success: true,
          status: 200,
          headers: {},
          body: result,
          latency,
          providerSessionId: chatId,
        }
      }

      return {
        success: false,
        error: 'No response or stream received',
        latency,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Mimo Dedicated Forward
   * Uses Mimo adapter for Xiaomi AI Studio
   */
  private async forwardMimo(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(
        request,
        provider,
        this.buildToolCatalogSessionKey(provider, account, actualModel)
      )
      const transformedRequest = {
        ...request,
        messages: transformed.messages,
        tools: transformed.tools,
      }
      const adapter = new MimoAdapter(provider, account)

      const { response, conversationId, query } = await adapter.chatCompletion({
        model: actualModel,
        originalModel: request.originalModel,
        messages: transformedRequest.messages as any,
        stream: transformedRequest.stream,
        temperature: transformedRequest.temperature,
      })

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const deleteSessionCallback = shouldDeleteSession()
        ? async (sessionId: string) => {
            try {
              await adapter.deleteSession(sessionId)
            } catch (error) {
              console.error('[Mimo] Failed to delete session:', error)
            }
          }
        : undefined

      const handler = new MimoStreamHandler(actualModel, conversationId, 'separate', transformed.plan)

      if (request.stream) {
        const transformedStream = new PassThrough()
        const openAIStream = handler.handleStream(response.data)

        ;(async () => {
          try {
            for await (const chunk of openAIStream) {
              transformedStream.write(chunk)
            }
            await adapter.generateConversationTitle(
              conversationId,
              query,
              handler.getAssistantContentForTitle()
            )
            if (deleteSessionCallback) {
              await deleteSessionCallback(conversationId)
            }
            transformedStream.end()
          } catch (error) {
            console.error('[Mimo] Stream error:', error)
            transformedStream.end()
          }
        })()

        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: conversationId,
        }
      }

      let result = await handler.handleNonStream(response.data)
      let parsedResult = JSON.parse(result)
      const retry = this.applyToolCallsToResponse(parsedResult, transformed)
      if (retry && transformed.plan.catalogSnapshot?.fingerprint === retry.catalogFingerprint) {
        const retryRequest = this.buildAvailabilityRetryRequest(request, transformed, retry.clarification)
        const retryResponse = await adapter.chatCompletion({
          model: actualModel,
          originalModel: request.originalModel,
          messages: retryRequest.messages as any,
          stream: false,
          temperature: request.temperature,
        })
        const retryHandler = new MimoStreamHandler(actualModel, retryResponse.conversationId, 'separate', transformed.plan)
        const retryResult = await retryHandler.handleNonStream(retryResponse.response.data)
        parsedResult = JSON.parse(retryResult)
        this.applyToolCallsToResponse(parsedResult, transformed)
      }
      await adapter.generateConversationTitle(
        conversationId,
        query,
        handler.getAssistantContentForTitle()
      )
      if (deleteSessionCallback) {
        await deleteSessionCallback(conversationId)
      }

      const emptyOutputFailure = this.inspectManagedNonStreamOutput(parsedResult, transformed, startTime)
      if (emptyOutputFailure) return emptyOutputFailure

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: parsedResult,
        skipTransform: true,
        latency,
        providerSessionId: conversationId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      console.error('[Mimo] Forward error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Perplexity Dedicated Forward
   * Uses Electron's net API to bypass Cloudflare protection
   */
  private async forwardPerplexity(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    console.log('[forwardPerplexity] actualModel:', actualModel)
    try {
      const transformed = this.transformRequestForPromptToolUse(
        request,
        provider,
        this.buildToolCatalogSessionKey(provider, account, actualModel)
      )
      
      const adapter = new PerplexityAdapter(provider, account)
      
      const { stream, sessionId } = await adapter.chatCompletion({
        model: actualModel,
        messages: transformed.messages as any,
        stream: request.stream,
        temperature: request.temperature,
      })

      const latency = Date.now() - startTime

      if (request.stream === true) {
        const deleteSessionCallback = shouldDeleteSession()
          ? async () => {
              try {
                await adapter.deleteSession(sessionId)
              } catch (error) {
                console.error('[Perplexity] Failed to delete session:', error)
              }
            }
          : undefined

        const handler = new PerplexityStreamHandler(actualModel, sessionId, deleteSessionCallback, adapter, transformed.plan)
        const transformedStream = await handler.handleStream(stream)
        
        return {
          success: true,
          status: 200,
          headers: {},
          stream: transformedStream as any,
          skipTransform: true,
          latency,
          providerSessionId: sessionId,
        }
      }

      const handler = new PerplexityStreamHandler(actualModel, sessionId, undefined, adapter, transformed.plan)
      let result = await handler.handleNonStream(stream)
      
      const retry = this.applyToolCallsToResponse(result, transformed)
      if (retry && transformed.plan.catalogSnapshot?.fingerprint === retry.catalogFingerprint) {
        const retryRequest = this.buildAvailabilityRetryRequest(request, transformed, retry.clarification)
        const retryResponse = await adapter.chatCompletion({
          model: actualModel,
          messages: retryRequest.messages as any,
          stream: false,
          temperature: request.temperature,
        })
        const retryHandler = new PerplexityStreamHandler(actualModel, retryResponse.sessionId, undefined, adapter, transformed.plan)
        result = await retryHandler.handleNonStream(retryResponse.stream)
        this.applyToolCallsToResponse(result, transformed)
      }
      
      if (shouldDeleteSession()) {
        await adapter.deleteSession(sessionId)
      }

      const emptyOutputFailure = this.inspectManagedNonStreamOutput(result, transformed, startTime)
      if (emptyOutputFailure) return emptyOutputFailure
      
      return {
        success: true,
        status: 200,
        headers: {},
        body: result,
        latency,
        providerSessionId: sessionId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Build URL
   */
  private buildUrl(provider: Provider, path: string): string {
    let baseUrl = provider.apiEndpoint

    if (baseUrl.endsWith('/')) {
      baseUrl = baseUrl.slice(0, -1)
    }

    if (!path.startsWith('/')) {
      path = '/' + path
    }

    if (baseUrl.includes('/v1') && path.startsWith('/v1')) {
      path = path.slice(3)
    }

    return `${baseUrl}${path}`
  }

  /**
   * Build Request Headers
   */
  private buildHeaders(provider: Provider, account: Account): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...provider.headers,
    }

    const credentials = account.credentials

    if (credentials.token) {
      headers['Authorization'] = `Bearer ${credentials.token}`
    } else if (credentials.apiKey) {
      headers['Authorization'] = `Bearer ${credentials.apiKey}`
    } else if (credentials.accessToken) {
      headers['Authorization'] = `Bearer ${credentials.accessToken}`
    } else if (credentials.refreshToken) {
      headers['Authorization'] = `Bearer ${credentials.refreshToken}`
    }

    if (credentials.cookie) {
      headers['Cookie'] = credentials.cookie
    }

    if (credentials.sessionKey) {
      headers['X-Session-Key'] = credentials.sessionKey
    }

    return headers
  }

  /**
   * Build Request Body
   */
  private buildRequestBody(
    request: ChatCompletionRequest,
    actualModel: string,
    account: Account
  ): any {
    const body: any = {
      model: actualModel,
      messages: request.messages,
      stream: request.stream || false,
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature
    }

    if (request.top_p !== undefined) {
      body.top_p = request.top_p
    }

    if (request.n !== undefined) {
      body.n = request.n
    }

    if (request.stop !== undefined) {
      body.stop = request.stop
    }

    if (request.max_tokens !== undefined) {
      body.max_tokens = request.max_tokens
    }

    if (request.presence_penalty !== undefined) {
      body.presence_penalty = request.presence_penalty
    }

    if (request.frequency_penalty !== undefined) {
      body.frequency_penalty = request.frequency_penalty
    }

    if (request.logit_bias !== undefined) {
      body.logit_bias = request.logit_bias
    }

    if (request.user !== undefined) {
      body.user = request.user
    }

    return body
  }

  /**
   * Extract Response Headers
   */
  private extractHeaders(headers: any): Record<string, string> {
    const result: Record<string, string> = {}

    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === 'string') {
        result[key] = value
      } else if (Array.isArray(value)) {
        result[key] = value.join(', ')
      }
    }

    return result
  }

  /**
   * Extract Error Message
   */
  private extractErrorMessage(response: AxiosResponse): string {
    if (response.data) {
      if (typeof response.data === 'string') {
        return response.data
      }

      if (response.data.error?.message) {
        return response.data.error.message
      }

      if (response.data.message) {
        return response.data.message
      }

      if (response.data.msg) {
        return response.data.msg
      }

      try {
        return JSON.stringify(response.data)
      } catch {
        return 'Unknown error'
      }
    }

    return `HTTP ${response.status}`
  }

  /**
   * Delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Forward Request to Specified URL
   */
  async forwardToUrl(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: any,
    isStream: boolean = false
  ): Promise<ForwardResult> {
    const startTime = Date.now()

    try {
      const config: AxiosRequestConfig = {
        method,
        url,
        headers,
        data: body,
        timeout: proxyStatusManager.getConfig().timeout,
        responseType: isStream ? 'stream' : 'json',
        validateStatus: () => true,
      }

      const response: AxiosResponse = await this.axiosInstance.request(config)
      const latency = Date.now() - startTime

      if (response.status >= 400) {
        return {
          success: false,
          status: response.status,
          error: this.extractErrorMessage(response),
          latency,
        }
      }

      if (isStream) {
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: response.data,
          latency,
        }
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: response.data,
        latency,
      }
    } catch (error) {
      const latency = Date.now() - startTime

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }
}

export const requestForwarder = new RequestForwarder()
export default requestForwarder
