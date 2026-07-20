/**
 * Proxy Service Module - Request Forwarder
 * Forwards requests to corresponding API based on provider configuration
 */

import axios, { AxiosRequestConfig, AxiosResponse, AxiosError } from 'axios'
import { Account, Provider } from '../store/types'
import { ForwardResult, ChatCompletionRequest, ProxyContext } from './types'
import { proxyStatusManager } from './status'
import { storeManager } from '../store/store'
import { ToolCallingEngine } from './toolCalling/ToolCallingEngine'
import { buildRequestAssembly, type RequestAssembly } from './RequestAssembly.ts'
import type { ToolCallingTransformResult } from './toolCalling/types'
import { sessionManager } from './sessionManager'
import {
  createContextManagementService,
  SummaryGenerator,
  type ChatMessage as ContextChatMessage,
} from './services/contextManagementService.ts'
import { preserveContextManagedMessageMetadata } from './contextMessageMetadata.ts'
import { sanitizeMessagesForSummary, detectSummaryContamination } from './services/summarySanitizer.ts'
import { evaluateSummaryInputQuality } from './services/summaryInputQuality.ts'
import { ProviderRuntime } from './services/ProviderRuntime.ts'
import {
  buildServerSummaryEpochSource,
  forkProviderConversationContext,
} from './sessionBoundary.ts'
import {
  getConversationState,
  getProviderConversationState,
  setConversationState,
  setProviderConversationState,
  shouldUseProviderConversationFallback,
  type ConversationState,
} from './services/providerConversationState.ts'
import {
  buildPromptBudgetPolicyInput as buildPromptBudgetPolicyInputBase,
  decidePromptBudgetPolicy,
  getPromptBudgetSnapshot,
  recordPromptBudgetSnapshot,
  type PromptBudgetPolicyDecision,
  type PromptBudgetPolicyInput,
  type PromptBudgetPolicySnapshot,
  type PromptRefreshMode,
} from './promptBudgetPolicy.ts'
import type { ContextProcessResult } from './services/contextManagementService.ts'

export {
  CONVERSATION_STATE_TTL,
  conversationStateCache,
  getConversationState,
  getProviderConversationState,
  setConversationState,
  setProviderConversationState,
  shouldUseProviderConversationFallback,
  type ConversationState,
} from './services/providerConversationState.ts'

function shouldDeleteSession(): boolean {
  return sessionManager.shouldDeleteAfterChat()
}

function getSummaryTextContent(content: ContextChatMessage['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
}

function hasSummarizableSummaryInput(messages: ContextChatMessage[]): boolean {
  return messages.some((message) => {
    if (message.role === 'system') return false
    if (message.role === 'tool') return false
    if (message.role === 'assistant' && !getSummaryTextContent(message.content).trim() && (message as any).tool_calls?.length) return false
    return getSummaryTextContent(message.content).trim().length > 0
  })
}

const REGISTERED_PROVIDER_RUNTIME_PLUGIN_IDS = new Set([
  'deepseek',
  'glm',
  'kimi',
  'mimo',
  'minimax',
  'perplexity',
  'qwen',
  'qwen-ai',
  'zai',
])

export function buildPromptBudgetPolicyInput(input: {
  request: ChatCompletionRequest
  context: ProxyContext
  provider: Provider
  account: Account
  actualModel: string
  toolSessionKey: string
  providerConversationStateKey: string
  transformed: ToolCallingTransformResult
  previousSnapshot?: PromptBudgetPolicySnapshot
  skillFingerprint?: string
}): PromptBudgetPolicyInput {
  return buildPromptBudgetPolicyInputBase({
    requestMessages: input.request.messages,
    sessionBoundaryReason: input.context.sessionBoundaryReason,
    providerId: input.provider.id,
    accountId: input.account.id,
    actualModel: input.actualModel,
    toolSessionKey: input.toolSessionKey,
    providerConversationSessionKey: input.providerConversationStateKey,
    toolCatalogFingerprint: input.transformed.plan.catalogSnapshot?.fingerprint,
    hasActiveTools: input.transformed.plan.tools.length > 0,
    hasManagedToolCapableTurn: input.transformed.plan.mode === 'managed' || input.transformed.plan.shouldParseResponse,
    previousSnapshot: input.previousSnapshot,
    skillFingerprint: input.skillFingerprint,
  })
}

export function computeQwenPromptBudgetDiagnostics(input: {
  request: ChatCompletionRequest
  context: ProxyContext
  provider: Provider
  account: Account
  actualModel: string
  toolSessionKey: string
  providerConversationStateKey: string
  transformed: ToolCallingTransformResult
  skillFingerprint?: string
}): { policyInput: PromptBudgetPolicyInput; decision: PromptBudgetPolicyDecision } {
  const previousSnapshot = getPromptBudgetSnapshot(input.providerConversationStateKey)
  const policyInput = buildPromptBudgetPolicyInput({
    ...input,
    previousSnapshot,
  })
  const decision = decidePromptBudgetPolicy(policyInput)
  recordPromptBudgetSnapshot(input.providerConversationStateKey, {
    providerId: input.provider.id,
    modelId: input.actualModel,
    accountId: input.account.id,
    toolCatalogFingerprint: input.transformed.plan.catalogSnapshot?.fingerprint,
    skillFingerprint: input.skillFingerprint,
  })
  return { policyInput, decision }
}

/**
 * Compact messages for retry after malformed tool output.
 * Keeps all system messages + last 20 non-system messages to reduce context size.
 */
function compactMessagesForRetry(messages: ChatCompletionRequest['messages']): ChatCompletionRequest['messages'] {
  const systemMessages = messages.filter((m) => m.role === 'system')
  const nonSystemMessages = messages.filter((m) => m.role !== 'system')
  return [...systemMessages, ...nonSystemMessages.slice(-20)]
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

  private providerRuntime = new ProviderRuntime()

  /**
   * Transform request for prompt-based tool calling
   */
  private prepareRequest(
    request: ChatCompletionRequest,
    provider?: Provider,
    context?: ProxyContext,
    contextResult?: ContextProcessResult,
    toolSessionKey?: string | null
  ): { assembly: RequestAssembly; transformed: ToolCallingTransformResult } {
    const transformed = this.transformRequestForPromptToolUse(request, provider, toolSessionKey, context?.requestId)
    return {
      assembly: buildRequestAssembly({
        messages: request.messages,
        toolManifest: transformed.toolManifest ?? null,
        sessionBoundaryReason: context?.sessionBoundaryReason,
        contextResult,
      }),
      transformed,
    }
  }

  private shouldUseProviderRuntimePilot(provider: Provider): boolean {
    const providerId = provider.id.toLowerCase()
    if (!REGISTERED_PROVIDER_RUNTIME_PLUGIN_IDS.has(providerId)) {
      return false
    }

    const emergencyFallback = String(process.env.CHAT2API_DEDICATED_PROVIDER_FALLBACK ?? '').toLowerCase()
    if (['1', 'true', 'yes', 'on', 'all', '*'].includes(emergencyFallback)) {
      return false
    }
    if (new Set(emergencyFallback.split(',').map(value => value.trim()).filter(Boolean)).has(providerId)) {
      return false
    }

    return true
  }

  private shouldConsumeParentChildSessionHandoff(context: ProxyContext): boolean {
    const boundary = context.sessionBoundaryReason ?? 'normal'
    return boundary !== 'tool_child' && boundary !== 'subagent_child'
  }

  /**
   * Transform request for prompt-based tool calling
   * For models that don't support native function calling
   * Delegates tool normalization, prompt injection, and parser planning to ToolCallingEngine.
   */
  private transformRequestForPromptToolUse(
    request: ChatCompletionRequest,
    provider?: Provider,
    toolSessionKey?: string | null,
    requestId?: string
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
      correlationId: requestId ?? null,
      requestId: requestId ?? null,
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
    // A server summary starts a new provider-side context epoch. Keep state
    // on the epoch key so the first summary request cannot reuse the old
    // provider conversation, while later requests in the same epoch can
    // reuse the fresh provider session created by that request.
    const rawDimension = typeof context.providerConversationSessionKey === 'string' && context.providerConversationSessionKey.trim().length > 0
      ? context.providerConversationSessionKey.trim()
      : typeof request.user === 'string' && request.user.trim().length > 0
      ? request.user.trim()
      : context.requestId

    return `${provider.id}:${account.id}:${actualModel}:${rawDimension}`
  }

  /**
   * Post-processing: if tool calling was planned but no tool calls were extracted,
   * log a diagnostic warning but don't fail the request.
   */

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

        const summaryQuality = evaluateSummaryInputQuality(sanitizedMessages)
        if (!hasSummarizableSummaryInput(sanitizedMessages) || !summaryQuality.shouldCallProvider) {
          console.warn('[SummaryGenerator] Rejected summary input quality:', JSON.stringify({
            reason: summaryQuality.reason,
            estimatedUsefulChars: summaryQuality.estimatedUsefulChars,
            estimatedDiscardedChars: summaryQuality.estimatedDiscardedChars,
            payloadClassCounts: summaryQuality.classSummary.counts,
            payloadClassChars: summaryQuality.classSummary.chars,
          }))
          return ''
        }

        const conversationText = sanitizedMessages
          .map(msg => {
            const role = msg.role.toUpperCase()
            const content = getSummaryTextContent(msg.content)
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

        const summaryContext = forkProviderConversationContext(context, {
          reason: 'summary_generator',
          epochSource: {
            requestId: context.requestId,
            providerId: provider.id,
            accountId: account.id,
            actualModel,
            messageCount: messages.length,
          },
        })

        const result = await this.doForward(
          summaryRequest,
          account,
          provider,
          actualModel,
          summaryContext
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
    let compactedForRetry = false
    context.originalMessages = request.messages.map(message => ({ ...message }))
    context.summaryContaminated = false
    context.summaryRetryAttempted = false

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        await this.delay(5000)
      }

      let modifiedRequest = compactedForRetry
        ? { ...request, messages: compactMessagesForRetry(request.messages) }
        : request
      let forwardContext = context
      let contextProcessResult: ContextProcessResult | undefined

      const isSummaryGeneratorRequest = context.sessionBoundaryReason === 'summary_generator'
      if (!isSummaryGeneratorRequest && config.contextManagement?.enabled && modifiedRequest.messages && modifiedRequest.messages.length > 0) {
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
          contextProcessResult = processResult
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

            if (processResult.summaryGenerated) {
              forwardContext = forkProviderConversationContext(context, {
                reason: 'server_summary',
                epochSource: buildServerSummaryEpochSource({
                  model: actualModel,
                  originalMessageCount: processResult.originalCount,
                  finalMessageCount: processResult.finalCount,
                  messages: modifiedRequest.messages,
                  strategyResults: processResult.strategyResults,
                }),
              })
            }
          }
        } catch (error) {
          console.error('[Forwarder] Context management failed:', error)
        }
      }

      try {
        const result = await this.doForward(modifiedRequest, account, provider, actualModel, forwardContext, contextProcessResult)

        if (result.success) {
          return result
        }

        // Auto-recovery: if managed provider returns malformed tool output,
        // compact messages (keep recent history) and retry transparently
        if (!compactedForRetry && result.error?.startsWith('Provider returned malformed tool output')) {
          console.log('[Forwarder] Malformed tool output detected, compacting messages and retrying...')
          compactedForRetry = true
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
    context: ProxyContext,
    contextResult?: ContextProcessResult
  ): Promise<ForwardResult> {
    const startTime = Date.now()

    if (this.shouldUseProviderRuntimePilot(provider)) {
      const conversationStateKey = this.buildProviderConversationStateKey(provider, account, actualModel, request, context)
      const toolSessionKey = this.buildToolCatalogSessionKey(provider, account, actualModel, context)
      const { assembly, transformed } = this.prepareRequest(request, provider, context, contextResult, toolSessionKey)
      const promptBudgetDiagnostics = computeQwenPromptBudgetDiagnostics({
        request,
        context,
        provider,
        account,
        actualModel,
        toolSessionKey,
        providerConversationStateKey: conversationStateKey,
        transformed,
      })
      console.log('[Forwarder] Runtime pilot request trace:', JSON.stringify({
        correlationId: context.requestId,
        requestId: context.requestId,
        providerId: provider.id,
        sessionBoundaryReason: context.sessionBoundaryReason ?? 'normal',
        toolSessionKeyPresent: toolSessionKey.length > 0,
        providerConversationSessionKeyIsChild: !this.shouldConsumeParentChildSessionHandoff(context),
        parentProviderConversationSessionKeyPresent: typeof context.parentProviderConversationSessionKey === 'string'
          && context.parentProviderConversationSessionKey.length > 0,
        promptRefreshMode: promptBudgetDiagnostics.decision.promptRefreshMode,
      }))

      return this.providerRuntime.forward({
        request,
        account,
        provider,
        actualModel,
        context,
        assembly,
        transformed,
        promptRefreshMode: promptBudgetDiagnostics.decision.promptRefreshMode,
        conversationStateKey,
        toolSessionKey,
        startTime,
      })
    }

    // Generic HTTP fallback for providers without a registered runtime plugin
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
