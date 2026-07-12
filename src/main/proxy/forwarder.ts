/**
 * Proxy Service Module - Request Forwarder
 * Forwards requests to corresponding API based on provider configuration
 */

import axios, { AxiosRequestConfig, AxiosResponse, AxiosError } from 'axios'
import http2 from 'http2'
import { PassThrough } from 'stream'
import { Account, Provider } from '../store/types'
import { ForwardResult, ChatCompletionRequest, ProxyContext } from './types'
import { proxyStatusManager } from './status'
import { storeManager } from '../store/store'
import { DeepSeekAdapter } from './adapters/deepseek'
import { DeepSeekStreamHandler } from './adapters/deepseek-stream'
import { GLMAdapter, GLMStreamHandler } from './adapters/glm'
import { KimiAdapter, KimiStreamHandler } from './adapters/kimi'
import { MimoAdapter, MimoStreamHandler } from './adapters/mimo'
import { QwenAdapter, QwenStreamHandler } from './adapters/qwen'
import { QwenAiAdapter, QwenAiStreamHandler } from './adapters/qwen-ai'
import { ZaiAdapter, ZaiStreamHandler } from './adapters/zai'
import { MiniMaxAdapter, MiniMaxStreamHandler } from './adapters/minimax'
import { PerplexityAdapter } from './adapters/perplexity'
import { PerplexityStreamHandler } from './adapters/perplexity-stream'
import { ToolCallingEngine } from './toolCalling/ToolCallingEngine'
import { buildRequestAssembly, type RequestAssembly } from './RequestAssembly.ts'
import type { ToolCallingTransformResult } from './toolCalling/types'
import { sessionManager } from './sessionManager'
import {
  createContextManagementService,
  SummaryGenerator,
  type ChatMessage as ContextChatMessage,
} from './services/contextManagementService.ts'
import {
  executeBoundedAvailabilityRetry,
  rebuildMessagesForSummaryContaminationRetry,
} from './services/contextManagementRetry.ts'
import { sanitizeMessagesForSummary, detectSummaryContamination } from './services/summarySanitizer.ts'

function shouldDeleteSession(): boolean {
  return sessionManager.shouldDeleteAfterChat()
}

type DeepSeekEnvelope = {
  code?: number
  msg?: string
  data?: {
    biz_code?: number
    biz_msg?: string
    biz_data?: Record<string, unknown> | null
  } | null
}

function buildDeepSeekProviderErrorMessage(payload: DeepSeekEnvelope | null | undefined): string | undefined {
  const bizCode = payload?.data?.biz_code
  const bizMsg = payload?.data?.biz_msg
  const msg = payload?.msg
  const muted = payload?.data?.biz_data && typeof payload.data.biz_data === 'object'
    ? (payload.data.biz_data as Record<string, unknown>).is_muted
    : undefined

  if (typeof bizCode === 'number' && bizCode !== 0) {
    if (typeof bizMsg === 'string' && bizMsg.trim().length > 0) {
      return bizCode === 5 && muted === 1
        ? `DeepSeek provider error: ${bizMsg} (account is muted)`
        : `DeepSeek provider error: ${bizMsg}`
    }
    return `DeepSeek provider error: biz_code ${bizCode}`
  }

  if (typeof msg === 'string' && msg.trim().length > 0 && payload?.code && payload.code !== 0) {
    return `DeepSeek provider error: ${msg}`
  }

  return undefined
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

function hasManagedToolHistory(messages?: ChatCompletionRequest['messages']): boolean {
  if (!messages || messages.length === 0) return false
  return messages.some((message) => (
    (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
    || (message.role === 'tool' && typeof message.tool_call_id === 'string' && message.tool_call_id.length > 0)
  ))
}

export function getProviderConversationState(input: {
  primaryKey: string
  fallbackToolSessionKey?: string | null
  messages?: ChatCompletionRequest['messages']
}): ConversationState | undefined {
  const primary = getConversationState(input.primaryKey)
  if (primary) return primary

  if (!input.fallbackToolSessionKey || !hasManagedToolHistory(input.messages)) {
    return undefined
  }

  return getConversationState(input.fallbackToolSessionKey)
}

export function setProviderConversationState(input: {
  primaryKey: string
  update: Partial<ConversationState>
  fallbackToolSessionKey?: string | null
  messages?: ChatCompletionRequest['messages']
}): void {
  setConversationState(input.primaryKey, input.update)
  if (!input.fallbackToolSessionKey || !hasManagedToolHistory(input.messages)) {
    return
  }
  setConversationState(input.fallbackToolSessionKey, input.update)
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
   * Prepare request assembly by transforming the request and building the assembly.
   */
  private prepareRequest(request: ChatCompletionRequest, provider?: Provider): RequestAssembly {
    const transformed = this.transformRequestForPromptToolUse(request, provider)
    return buildRequestAssembly({
      messages: request.messages,
      toolManifest: transformed.toolManifest ?? null,
    })
  }

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

    const transformed = engine.transformRequest({
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
    console.log('[Forwarder] Tool transform trace:', JSON.stringify({
      providerId: provider?.id ?? 'custom',
      model: request.model,
      toolSessionKeyPresent: typeof toolSessionKey === 'string' && toolSessionKey.length > 0,
      inputMessageCount: request.messages.length,
      outputMessageCount: transformed.messages.length,
      inputToolsPresent: Array.isArray(request.tools),
      outputToolsPresent: Array.isArray(transformed.tools),
      planMode: transformed.plan.mode,
      catalogSource: transformed.plan.catalogDiagnostics.source,
      catalogFingerprint: transformed.plan.catalogSnapshot?.fingerprint,
      toolCount: transformed.plan.tools.length,
      injected: transformed.plan.shouldInjectPrompt,
    }))
    return transformed
  }

  private applyToolCallsToResponse(
    result: any,
    transformed: ToolCallingTransformResult,
    context?: ProxyContext
  ) {
    const engine = new ToolCallingEngine(storeManager.getConfig().toolCallingConfig)
    return engine.applyNonStreamResponse(result, transformed.plan, {
      summaryContaminated: context?.summaryContaminated === true,
    })
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

  private async buildAvailabilityRetryRequest(
    originalRequest: ChatCompletionRequest,
    transformed: ToolCallingTransformResult,
    clarification: string,
    account: Account,
    provider: Provider,
    actualModel: string,
    context: ProxyContext
  ): Promise<ChatCompletionRequest> {
    const summaryContaminationRetry = await this.buildSummaryContaminationRetryRequest(
      originalRequest,
      account,
      provider,
      actualModel,
      context
    )
    if (summaryContaminationRetry) {
      return summaryContaminationRetry
    }

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

  private async readDeepSeekImmediateProviderError(response: AxiosResponse): Promise<string | undefined> {
    const contentType = String(response.headers?.['content-type'] || '').toLowerCase()
    if (!contentType.includes('application/json')) {
      return undefined
    }

    let rawBody = ''
    for await (const chunk of response.data as NodeJS.ReadableStream) {
      rawBody += chunk.toString('utf8')
    }

    try {
      const parsed = JSON.parse(rawBody) as DeepSeekEnvelope
      return buildDeepSeekProviderErrorMessage(parsed)
    } catch {
      return rawBody.trim().length > 0 ? `DeepSeek provider error: ${rawBody.trim()}` : undefined
    }
  }

  private toContextMessages(messages: ChatCompletionRequest['messages']): ContextChatMessage[] {
    return messages.map(msg => ({
      role: msg.role as 'user' | 'assistant' | 'system' | 'tool',
      content: msg.content,
      ...(msg.name !== undefined ? { name: msg.name } : {}),
      ...(msg.tool_call_id !== undefined ? { tool_call_id: msg.tool_call_id } : {}),
      ...(msg.tool_calls !== undefined ? { tool_calls: msg.tool_calls } : {}),
      timestamp: Date.now(),
    }))
  }

  private toRequestMessages(messages: ContextChatMessage[]): ChatCompletionRequest['messages'] {
    return messages.map(msg => ({
      role: msg.role,
      content: msg.content,
      ...(msg.name !== undefined ? { name: msg.name } : {}),
      ...(msg.tool_call_id !== undefined ? { tool_call_id: msg.tool_call_id } : {}),
      ...(msg.tool_calls !== undefined ? { tool_calls: msg.tool_calls } : {}),
    }))
  }

  private async buildSummaryContaminationRetryRequest(
    originalRequest: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    context: ProxyContext
  ): Promise<ChatCompletionRequest | undefined> {
    if (!context.summaryContaminated || context.summaryRetryAttempted) {
      return undefined
    }

    const config = storeManager.getConfig()
    if (!config.contextManagement?.enabled || !originalRequest.messages || originalRequest.messages.length === 0) {
      return undefined
    }

    context.summaryRetryAttempted = true
    console.warn(
      '[Forwarder] availability drift after summary contamination; rebuilding request with sliding-window-only context'
    )

    const sourceMessages = context.originalMessages && context.originalMessages.length > 0
      ? context.originalMessages
      : originalRequest.messages
    const retryMessages = await rebuildMessagesForSummaryContaminationRetry(
      sourceMessages,
      config.contextManagement
    )
    const retryBaseRequest: ChatCompletionRequest = {
      ...originalRequest,
      stream: false,
      messages: retryMessages,
    }
    const retryTransformed = this.transformRequestForPromptToolUse(
      retryBaseRequest,
      provider,
      this.buildToolCatalogSessionKey(provider, account, actualModel, context)
    )

    return {
      ...retryBaseRequest,
      messages: retryTransformed.messages,
      tools: retryTransformed.tools,
    }
  }

  private async retryManagedNonStreamResult<TPayload>(input: {
    originalRequest: ChatCompletionRequest
    transformed: ToolCallingTransformResult
    initialResult: any
    account: Account
    provider: Provider
    actualModel: string
    context: ProxyContext
    executeRetry: (retryRequest: ChatCompletionRequest) => Promise<TPayload>
    parseRetryPayload: (payload: TPayload, retryRequest: ChatCompletionRequest) => Promise<any>
  }): Promise<{ result: any; payload?: TPayload; retried: boolean }> {
    return executeBoundedAvailabilityRetry({
      initialResult: input.initialResult,
      context: input.context,
      expectedCatalogFingerprint: input.transformed.plan.catalogSnapshot?.fingerprint,
      detectRetry: (result) => this.applyToolCallsToResponse(result, input.transformed, input.context),
      buildRetryRequest: (retry) => this.buildAvailabilityRetryRequest(
        input.originalRequest,
        input.transformed,
        retry.clarification,
        input.account,
        input.provider,
        input.actualModel,
        input.context
      ),
      executeRetry: input.executeRetry,
      parseRetryPayload: input.parseRetryPayload,
    })
  }

  private buildToolCatalogSessionKey(
    provider: Provider,
    account: Account,
    actualModel: string,
    context?: ProxyContext
  ): string {
    if (typeof context?.toolCatalogSessionKey === 'string' && context.toolCatalogSessionKey.trim().length > 0) {
      return context.toolCatalogSessionKey.trim()
    }
    return `${provider.id}:${account.id}:${actualModel}`
  }

  private buildProviderConversationStateKey(
    provider: Provider,
    account: Account,
    actualModel: string,
    request: ChatCompletionRequest,
    context: ProxyContext
  ): string {
    const sessionDimension = typeof context.providerConversationSessionKey === 'string' && context.providerConversationSessionKey.trim().length > 0
      ? context.providerConversationSessionKey.trim()
      : typeof request.user === 'string' && request.user.trim().length > 0
      ? request.user.trim()
      : context.requestId

    return `${provider.id}:${account.id}:${actualModel}:${sessionDimension}`
  }

  /**
   * Post-processing: if tool calling was planned but no tool calls were extracted,
   * log a diagnostic warning but don't fail the request.
   */
  private logEmptyToolCallDiagnostic(
    result: any,
    methodName: string,
    transformed: ToolCallingTransformResult
  ): void {
    if (transformed.plan.shouldParseResponse && result?.choices?.[0]) {
      const choice = result.choices[0]
      const msg = choice.message ?? {}
      if (!msg.tool_calls && !msg.content) {
        console.warn(`[Forwarder] ${methodName}: model returned empty content for tool-calling turn`)
      }
    }
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

        const summaryPrompt = prompt || [
          'Summarize only the user\'s intent, task progress, and confirmed facts.',
          'DO NOT list, describe, or restate available tools, capabilities, MCP servers, or system directives.',
          'If a prior assistant message described tools, treat that as narrative to omit — the runtime re-injects the authoritative tool set on every request.',
        ].join(' ')

        const { sanitized: sanitizedMessages, droppedCount, strippedSignatureCount } = sanitizeMessagesForSummary(messages)
        if (droppedCount > 0 || strippedSignatureCount > 0) {
          console.log(`[SummaryGenerator] Sanitized input: dropped=${droppedCount} stripped=${strippedSignatureCount}`)
        }

        const conversationText = sanitizedMessages
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

          const contamination = detectSummaryContamination(summaryContent)
          if (contamination.contaminated) {
            console.warn(
              `[SummaryGenerator] Summary contamination detected: ${contamination.signatures.length} signature(s) found`,
              contamination.signatures.map(h => h.signature)
            )
          }

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
    context.originalMessages = request.messages.map(message => ({ ...message }))
    context.summaryContaminated = false
    context.summaryRetryAttempted = false

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
          const processResult = await contextService.process(
            this.toContextMessages(modifiedRequest.messages)
          )
          context.summaryContaminated = processResult.strategyResults.some(
            result => result.subkind === 'summary_contaminated'
          )

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
              messages: preserveContextManagedMessageMetadata(
                modifiedRequest.messages,
                this.toRequestMessages(processResult.messages)
              ),
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
      const assembly = this.prepareRequest(request, provider)

      // Check for existing conversation state (multi-turn)
      const convState = getProviderConversationState({
        primaryKey: conversationStateKey,
        fallbackToolSessionKey: toolSessionKey,
        messages: request.messages,
      })

      const adapter = new DeepSeekAdapter(provider, account)
      let responseResult: { response: any; sessionId: string }

      if (assembly.toolManifest) {
        responseResult = await adapter.chatCompletionWithAssembly(assembly, {
          model: request.model,
          messages: request.messages as any,
          stream: request.stream,
          temperature: request.temperature,
          web_search: request.web_search,
          reasoning_effort: request.reasoning_effort,
        } as any)
      } else {
        const transformedRequest = {
          ...request,
          messages: transformed.messages,
          tools: transformed.tools,
        }
        responseResult = await adapter.chatCompletion({
          model: request.model,
          messages: transformedRequest.messages as any,
          stream: transformedRequest.stream,
          temperature: transformedRequest.temperature,
          web_search: transformedRequest.web_search,
          reasoning_effort: transformedRequest.reasoning_effort,
        })
      }

      const { response, sessionId } = responseResult

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

      const deepSeekImmediateError = await this.readDeepSeekImmediateProviderError(response)
      if (deepSeekImmediateError) {
        return {
          success: false,
          status: 403,
          error: deepSeekImmediateError,
          latency,
        }
      }

      // Prepare callback for saving conversation state
      const saveConversationState = () => {
        const lastMessageId = handler.getLastMessageId()
        if (lastMessageId) {
          setProviderConversationState({
            primaryKey: conversationStateKey,
            fallbackToolSessionKey: toolSessionKey,
            messages: request.messages,
            update: { parentMessageId: lastMessageId },
          })
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
      const result = await handler.handleNonStream(response.data)
      
      this.applyToolCallsToResponse(result, transformed)
      this.logEmptyToolCallDiagnostic(result, 'DeepSeek', transformed)

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
      const assembly = this.prepareRequest(request, provider)

      // Check for existing conversation state (multi-turn)
      const convState = getProviderConversationState({
        primaryKey: conversationStateKey,
        fallbackToolSessionKey: toolSessionKey,
        messages: request.messages,
      })

      const adapter = new GLMAdapter(provider, account)
      let responseResult: { response: any; conversationId: string }

      if (assembly.toolManifest) {
        responseResult = await adapter.chatCompletionWithAssembly(assembly, {
          model: actualModel,
          originalModel: request.model,
          messages: request.messages as any,
          stream: request.stream,
          temperature: request.temperature,
          web_search: request.web_search,
          reasoning_effort: request.reasoning_effort,
          deep_research: request.deep_research,
        } as any)
      } else {
        const transformedRequest = {
          ...request,
          messages: transformed.messages,
          tools: transformed.tools,
        }
        responseResult = await adapter.chatCompletion({
          model: actualModel,
          originalModel: request.model,
          messages: transformedRequest.messages,
          stream: transformedRequest.stream,
          temperature: transformedRequest.temperature,
          web_search: transformedRequest.web_search,
          reasoning_effort: transformedRequest.reasoning_effort,
          deep_research: transformedRequest.deep_research,
        })
      }

      const { response, conversationId } = responseResult

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
              setProviderConversationState({
                primaryKey: conversationStateKey,
                fallbackToolSessionKey: toolSessionKey,
                messages: request.messages,
                update: { conversationId: convId },
              })
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
              setProviderConversationState({
                primaryKey: conversationStateKey,
                fallbackToolSessionKey: toolSessionKey,
                messages: request.messages,
                update: { conversationId: convId },
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
          providerSessionId: handler.getConversationId(),
        }
      }

      const result = await handler.handleNonStream(response.data)
      
      this.applyToolCallsToResponse(result, transformed)
      this.logEmptyToolCallDiagnostic(result, 'GLM', transformed)

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
    startTime: number,
    context: ProxyContext
  ): Promise<ForwardResult> {
    try {
      const assembly = this.prepareRequest(request, provider)

      const adapter = new KimiAdapter(provider, account)
      let responseResult: { response: any; conversationId: string }

      if (assembly.toolManifest) {
        // New assembly-based path: tool contract comes from manifest, not from messages
        responseResult = await adapter.chatCompletionWithAssembly(assembly, {
          model: actualModel,
          originalModel: request.model,
          messages: request.messages as any,
          stream: request.stream,
          temperature: request.temperature,
          enableThinking: !!request.reasoning_effort,
          enableWebSearch: !!request.web_search,
        } as any)
      } else {
        // Fallback: old path for requests without tool manifest
        responseResult = await adapter.chatCompletion({
          model: actualModel,
          originalModel: request.model,
          messages: transformed.messages as any,
          stream: request.stream,
          temperature: request.temperature,
          enableThinking: !!request.reasoning_effort,
          enableWebSearch: !!request.web_search,
        })
      }

      const { response, conversationId } = responseResult

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

      this.applyToolCallsToResponse(result, transformed)
      this.logEmptyToolCallDiagnostic(result, 'Kimi', transformed)

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
    startTime: number,
    context: ProxyContext
  ): Promise<ForwardResult> {
    try {
      const assembly = this.prepareRequest(request, provider)

      const adapter = new QwenAdapter(provider, account)
      let responseResult: { response: any; sessionId: string; reqId: string }

      if (assembly.toolManifest) {
        // New assembly-based path: tool contract comes from manifest, not from messages
        responseResult = await adapter.chatCompletionWithAssembly(assembly, {
          model: actualModel,
          originalModel: request.model,
          messages: request.messages as any,
          stream: request.stream,
          temperature: request.temperature,
          enableThinking: !!request.reasoning_effort,
          enableWebSearch: !!request.web_search,
        } as any)
      } else {
        // Fallback: old path for requests without tool manifest
        const transformedRequest = {
          ...request,
          messages: transformed.messages,
          tools: transformed.tools,
        }
        responseResult = await adapter.chatCompletion({
          model: actualModel,
          originalModel: request.model,
          messages: transformedRequest.messages as any,
          stream: request.stream,
          temperature: request.temperature,
          enableThinking: !!request.reasoning_effort,
          enableWebSearch: !!request.web_search,
        })
      }

      const { response, sessionId, reqId } = responseResult

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

      this.applyToolCallsToResponse(result, transformed)
      this.logEmptyToolCallDiagnostic(result, 'Qwen', transformed)

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
    startTime: number,
    context: ProxyContext
  ): Promise<ForwardResult> {
    try {
      const assembly = this.prepareRequest(request, provider)

      const adapter = new QwenAiAdapter(provider, account)
      let responseResult: { response: any; chatId: string; parentId: string | null }

      if (assembly.toolManifest) {
        // New assembly-based path: tool contract comes from manifest, not from messages
        responseResult = await adapter.chatCompletionWithAssembly(assembly, {
          model: actualModel,
          originalModel: request.model,
          messages: request.messages as any,
          stream: request.stream,
          temperature: request.temperature,
          enable_thinking: !!request.reasoning_effort,
        } as any)
      } else {
        // Fallback: old path for requests without tool manifest
        responseResult = await adapter.chatCompletion({
          model: actualModel,
          originalModel: request.model,
          messages: transformed.messages as any,
          stream: request.stream,
          temperature: request.temperature,
          enable_thinking: !!request.reasoning_effort,
        })
      }

      const { response, chatId, parentId } = responseResult

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

      this.applyToolCallsToResponse(result, transformed)
      this.logEmptyToolCallDiagnostic(result, 'QwenAI', transformed)

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
      const assembly = this.prepareRequest(request, provider)

      const adapter = new ZaiAdapter(provider, account)
      let responseResult: { response: any; chatId: string; requestId: string }

      if (assembly.toolManifest) {
        // New assembly-based path: tool contract comes from manifest, not from messages
        responseResult = await adapter.chatCompletionWithAssembly(assembly, {
          model: actualModel,
          originalModel: request.model,
          messages: request.messages as any,
          stream: request.stream,
          temperature: request.temperature,
          web_search: request.web_search,
          reasoning_effort: request.reasoning_effort,
        } as any)
      } else {
        // Fallback: old path for requests without tool manifest
        const transformedRequest = {
          ...request,
          messages: transformed.messages,
          tools: transformed.tools,
        }
        responseResult = await adapter.chatCompletion({
          model: actualModel,
          originalModel: request.model,
          messages: transformedRequest.messages as any,
          stream: request.stream,
          temperature: request.temperature,
          web_search: request.web_search,
          reasoning_effort: request.reasoning_effort,
        })
      }

      const { response, chatId, requestId } = responseResult

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

      this.applyToolCallsToResponse(result, transformed)
      this.logEmptyToolCallDiagnostic(result, 'ZAI', transformed)

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
    startTime: number,
    context: ProxyContext
  ): Promise<ForwardResult> {
    console.log('[forwardMiniMax] actualModel:', actualModel)
    console.log('[forwardMiniMax] provider.modelMappings:', provider.modelMappings)
    try {
      const assembly = this.prepareRequest(request, provider)

      const adapter = new MiniMaxAdapter(provider, account)
      let responseResult: { response: any; stream: any; chatId: string }

      if (assembly.toolManifest) {
        // New assembly-based path: tool contract comes from manifest, not from messages
        responseResult = await adapter.chatCompletionWithAssembly(assembly, {
          model: actualModel,
          originalModel: request.model,
          messages: request.messages as any,
          stream: request.stream,
          temperature: request.temperature,
          toolCallingPlan: transformed.plan,
        } as any)
      } else {
        // Fallback: old path for requests without tool manifest
        responseResult = await adapter.chatCompletion({
          model: actualModel,
          originalModel: request.model,
          messages: transformed.messages as any,
          stream: request.stream,
          temperature: request.temperature,
          toolCallingPlan: transformed.plan,
        })
      }

      const { response, stream, chatId } = responseResult

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
        this.applyToolCallsToResponse(response.data, transformed)
        this.logEmptyToolCallDiagnostic(response.data, 'MiniMax', transformed)

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
        const result = await handler.handleNonStream(stream.stream)
        this.applyToolCallsToResponse(result, transformed)
        this.logEmptyToolCallDiagnostic(result, 'MiniMax', transformed)

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
    startTime: number,
    context: ProxyContext
  ): Promise<ForwardResult> {
    try {
      const assembly = this.prepareRequest(request, provider)

      const adapter = new MimoAdapter(provider, account)
      let responseResult: { response: any; conversationId: string; query: string }

      if (assembly.toolManifest) {
        // New assembly-based path: tool contract comes from manifest, not from messages
        responseResult = await adapter.chatCompletionWithAssembly(assembly, {
          model: actualModel,
          originalModel: request.originalModel,
          messages: request.messages as any,
          stream: request.stream,
          temperature: request.temperature,
        })
      } else {
        // Fallback: old path for requests without tool manifest
        const transformedRequest = {
          ...request,
          messages: transformed.messages,
          tools: transformed.tools,
        }
        responseResult = await adapter.chatCompletion({
          model: actualModel,
          originalModel: request.originalModel,
          messages: transformedRequest.messages as any,
          stream: transformedRequest.stream,
          temperature: transformedRequest.temperature,
        })
      }

      const { response, conversationId, query } = responseResult

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

      const result = await handler.handleNonStream(response.data)
      const parsedResult = JSON.parse(result)
      this.applyToolCallsToResponse(parsedResult, transformed)
      this.logEmptyToolCallDiagnostic(parsedResult, 'Mimo', transformed)
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
    startTime: number,
    context: ProxyContext
  ): Promise<ForwardResult> {
    console.log('[forwardPerplexity] actualModel:', actualModel)
    try {
      const assembly = this.prepareRequest(request, provider)

      const adapter = new PerplexityAdapter(provider, account)
      let responseResult: { stream: any; sessionId: string }

      if (assembly.toolManifest) {
        // New assembly-based path: tool contract comes from manifest, not from messages
        responseResult = await adapter.chatCompletionWithAssembly(assembly, {
          model: actualModel,
          messages: request.messages as any,
          stream: request.stream,
          temperature: request.temperature,
        } as any)
      } else {
        // Fallback: old path for requests without tool manifest
        responseResult = await adapter.chatCompletion({
          model: actualModel,
          messages: transformed.messages as any,
          stream: request.stream,
          temperature: request.temperature,
        })
      }

      const { stream, sessionId } = responseResult

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
      const result = await handler.handleNonStream(stream)

      this.applyToolCallsToResponse(result, transformed)
      this.logEmptyToolCallDiagnostic(result, 'Perplexity', transformed)

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
