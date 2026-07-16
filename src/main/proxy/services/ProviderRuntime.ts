/**
 * ProviderRuntime Service
 * Abstracts session state management for provider adapters.
 * Handles reading/writing conversation state with fallback and mirroring logic.
 * This is Phase 3 of the provider plugin architecture migration.
 */

import type { ProxyContext, ChatCompletionRequest } from '../types.ts'
import type { ForwardResult } from '../types.ts'
import type { ChildSessionHandoff } from '../sessionBoundary.ts'
import type { Account, Provider } from '../../store/types.ts'
import type { RequestAssembly } from '../RequestAssembly.ts'
import type { ToolCallingTransformResult } from '../toolCalling/types.ts'
import type { PromptRefreshMode } from '../promptBudgetPolicy.ts'
import { buildSessionBoundaryPlan } from './sessionBoundaryPlan.ts'
import { buildContextEconomyDiagnostics, extractTextContent } from './contextPayloadClassifier.ts'
import { projectRequestAssemblyForPromptMode } from './providerPromptProjection.ts'
import type { WebProviderPlugin } from '../plugins/WebProviderPlugin.ts'
import type { ProviderRuntimeError, ProviderRuntimeEvent, ProviderWebRequest, ProviderWebResponse } from '../plugins/types.ts'
import { normalizeProviderStreamToOpenAI } from './streamNormalizer.ts'
import type { ConversationState } from './providerConversationState.ts'
import {
  getProviderConversationState,
  setProviderConversationState,
  shouldUseProviderConversationFallback,
} from './providerConversationState.ts'
import axios, { AxiosError, type AxiosInstance, type AxiosResponse } from 'axios'

export type ReadSessionStateInput = {
  conversationStateKey: string
  toolSessionKey: string
  context: ProxyContext
  messages?: ChatCompletionRequest['messages']
}

export type WriteSessionStateInput = {
  conversationStateKey: string
  toolSessionKey: string
  context: ProxyContext
  messages?: ChatCompletionRequest['messages']
  update: Partial<ConversationState>
  parentHandoff?: ChildSessionHandoff
}

export type ProviderRuntimeTransport = (request: ProviderWebRequest, input: {
  runtimeRequest: ProviderRuntimeForwardInput
  plugin: WebProviderPlugin
}) => Promise<ProviderWebResponse | AxiosResponse>

export type ProviderRuntimePluginResolver = (provider: Provider) => Promise<WebProviderPlugin | undefined>

export type ProviderRuntimeForwardInput = {
  request: ChatCompletionRequest
  account: Account
  provider: Provider
  actualModel: string
  context: ProxyContext
  assembly: RequestAssembly
  transformed: ToolCallingTransformResult
  promptRefreshMode?: PromptRefreshMode
  conversationStateKey: string
  toolSessionKey: string
  startTime?: number
}

export type ProviderRuntimeOptions = {
  pluginResolver?: ProviderRuntimePluginResolver
  transport?: ProviderRuntimeTransport
  axiosInstance?: AxiosInstance
}

function getProviderSessionIdFromStateUpdate(update: Partial<ConversationState>): string | undefined {
  const candidates = [
    update.providerSessionId,
    update.childProviderSessionId,
    update.conversationId,
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim()
    }
  }

  return undefined
}

/**
 * ProviderRuntime provides a unified interface for reading and writing
 * provider conversation session state. It encapsulates:
 * - Fallback logic (shouldUseProviderConversationFallback)
 * - Mirror-to-fallback decisions
 * - Write target planning and execution
 *
 * Provider-specific forward methods should use this service instead of
 * directly calling getProviderConversationState/setProviderConversationState.
 */
export class ProviderRuntime {
  private readonly pluginResolver: ProviderRuntimePluginResolver
  private readonly transport: ProviderRuntimeTransport
  private readonly axiosInstance: AxiosInstance

  constructor(options: ProviderRuntimeOptions = {}) {
    this.axiosInstance = options.axiosInstance ?? axios.create({
      timeout: 120000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    })
    this.pluginResolver = options.pluginResolver ?? defaultPluginResolver
    this.transport = options.transport ?? this.defaultTransport.bind(this)
  }

  async forward(input: ProviderRuntimeForwardInput): Promise<ForwardResult> {
    const startTime = input.startTime ?? Date.now()
    const plugin = await this.pluginResolver(input.provider)
    if (!plugin) {
      return {
        success: false,
        status: 501,
        error: `No provider runtime plugin registered for provider ${input.provider.id}`,
        latency: Date.now() - startTime,
      }
    }

    const priorState = this.readSessionState({
      conversationStateKey: input.conversationStateKey,
      toolSessionKey: input.toolSessionKey,
      context: input.context,
      messages: input.request.messages,
    })

    const sessionBoundaryPlan = buildSessionBoundaryPlan({
      context: input.context,
      priorState,
      request: input.request,
    })
    const requestedSessionId = input.request.sessionId
    const stateSessionId = priorState?.providerSessionId ?? priorState?.conversationId ?? priorState?.parentMessageId
    const providerSessionId = sessionBoundaryPlan.expectedProviderSessionIdReuse
      ? requestedSessionId ?? stateSessionId
      : undefined
    const providerParentReqId = sessionBoundaryPlan.expectedProviderSessionIdReuse
      ? input.request.parentReqId ?? priorState?.providerParentReqId ?? priorState?.parentMessageId
      : undefined
    const providerSessionIdSource = providerSessionId
      ? requestedSessionId ? 'request' : 'state'
      : 'fresh'

    const providerAssembly = projectRequestAssemblyForPromptMode(input.assembly, input.promptRefreshMode)

    const promptChars = providerAssembly.messages.reduce(
      (total, message) => total + extractTextContent(message.content).length,
      0,
    ) + (providerAssembly.summaryText?.length ?? 0) + (providerAssembly.toolManifest?.renderedPrompt.length ?? 0)
    const contextEconomy = buildContextEconomyDiagnostics(providerAssembly.messages, {
      boundary: sessionBoundaryPlan.boundary,
      promptRefreshMode: input.promptRefreshMode,
      promptChars,
    })
    console.log('[ProviderRuntime] Context economy:', JSON.stringify({
      contextEconomy,
      providerSessionAction: sessionBoundaryPlan.providerSessionAction,
      providerSessionIdSource,
    }))

    const webRequest = await plugin.buildRequest({
      provider: input.provider,
      account: input.account,
      model: input.actualModel,
      originalModel: input.request.originalModel,
      messages: input.request.messages as any,
      assembly: providerAssembly,
      promptRefreshMode: input.promptRefreshMode,
      sessionBoundaryReason: input.context.sessionBoundaryReason,
      sessionBoundaryPlan,
      stream: input.request.stream,
      temperature: input.request.temperature,
      sessionId: providerSessionId,
      parentReqId: providerParentReqId,
      enableThinking: !!input.request.reasoning_effort,
      enableWebSearch: !!input.request.web_search,
    })

    const response = await this.transport(webRequest, { runtimeRequest: input, plugin })
    const status = Number((response as any).status ?? 200)
    const headers = this.normalizeHeaders((response as any).headers)
    const latency = Date.now() - startTime

    if (status >= 400) {
      return {
        success: false,
        status,
        headers,
        error: this.extractResponseError(response),
        latency,
      }
    }

    if (input.request.stream) {
      if (!plugin.parseStream) {
        return {
          success: false,
          status: 501,
          headers,
          error: `Provider runtime plugin ${plugin.id} does not support streaming`,
          latency,
        }
      }

      this.writeRuntimeSessionState(input, {
        plugin,
        webRequest,
        sessionId: webRequest.sessionId,
        reqId: webRequest.reqId,
      })

      return {
        success: true,
        status,
        headers,
        stream: normalizeProviderStreamToOpenAI(this.observeStreamEvents(
          plugin.parseStream({
            response: {
              status,
              headers,
              data: (response as any).data,
            },
            rawResponse: response,
            model: input.actualModel,
            toolCallingPlan: input.transformed.plan,
          }),
          input,
          webRequest,
          plugin,
        )),
        latency,
      }
    }

    if (plugin.parseStream && webRequest.transportOptions?.responseType === 'stream') {
      const aggregated = await this.collectStreamEventsToOpenAI(
        this.observeStreamEvents(
          plugin.parseStream({
            response: {
              status,
              headers,
              data: (response as any).data,
            },
            rawResponse: response,
            model: input.actualModel,
            toolCallingPlan: input.transformed.plan,
          }),
          input,
          webRequest,
          plugin,
        ),
        input.actualModel,
      )

      if ('error' in aggregated) {
        return {
          success: false,
          status: aggregated.error.status || 502,
          headers,
          error: aggregated.error.message,
          latency,
        }
      }

      return {
        success: true,
        status,
        headers,
        body: aggregated.body,
        latency,
      }
    }

    const parsed = await plugin.parseNonStream({
      status,
      headers,
      data: (response as any).data,
    })
    this.writeRuntimeSessionState(input, {
      plugin,
      webRequest,
      sessionId: parsed.sessionId || webRequest.sessionId,
      reqId: parsed.reqId || webRequest.reqId,
    })

    return {
      success: true,
      status,
      headers,
      body: parsed.response.data,
      latency,
    }
  }

  /**
   * Read prior session state for a given conversation state key.
   * Automatically handles fallback to tool session key for managed tool follow-up turns.
   */
  readSessionState(input: ReadSessionStateInput): ConversationState | undefined {
    const allowFallback = shouldUseProviderConversationFallback(input.context)
    return getProviderConversationState({
      primaryKey: input.conversationStateKey,
      fallbackToolSessionKey: input.toolSessionKey,
      messages: input.messages,
      allowFallback,
    })
  }

  /**
   * Write session state after a turn completes.
   * Automatically handles write target decisions, mirroring, and parent handoff.
   */
  writeSessionState(input: WriteSessionStateInput): void {
    const mirrorToFallback = shouldUseProviderConversationFallback(input.context)
    const childProviderSessionId = getProviderSessionIdFromStateUpdate(input.update)
    const parentHandoff = input.parentHandoff && !input.parentHandoff.childProviderSessionId && childProviderSessionId
      ? {
          ...input.parentHandoff,
          childProviderSessionId,
        }
      : input.parentHandoff

    setProviderConversationState({
      context: input.context,
      primaryKey: input.conversationStateKey,
      fallbackToolSessionKey: input.toolSessionKey,
      messages: input.messages,
      mirrorToFallback,
      update: input.update,
      parentHandoff,
    })
  }

  private async defaultTransport(
    request: ProviderWebRequest,
    input: { runtimeRequest: ProviderRuntimeForwardInput },
  ): Promise<AxiosResponse> {
    const transportOptions = request.transportOptions ?? {}
    return this.axiosInstance.request({
      method: request.method,
      url: request.url,
      headers: request.headers,
      data: request.body,
      responseType: transportOptions.responseType ?? (input.runtimeRequest.request.stream ? 'stream' : 'json'),
      timeout: transportOptions.timeout,
      decompress: transportOptions.decompress,
      validateStatus: transportOptions.validateStatus ?? (() => true),
    })
  }

  private writeRuntimeSessionState(
    input: ProviderRuntimeForwardInput,
    result: {
      plugin: WebProviderPlugin
      webRequest: ProviderWebRequest
      sessionId: string
      reqId: string
    },
  ): void {
    const update: Partial<ConversationState> = {
      providerSessionId: result.sessionId,
      providerParentReqId: result.reqId || result.webRequest.reqId,
      ...(result.plugin.capabilities.sessionIdKind === 'conversation_id'
        ? { conversationId: result.sessionId }
        : {}),
      ...(result.plugin.capabilities.supportsParentMessageId
        ? { parentMessageId: result.reqId || result.webRequest.reqId }
        : {}),
    }

    this.writeSessionState({
      conversationStateKey: input.conversationStateKey,
      toolSessionKey: input.toolSessionKey,
      context: input.context,
      messages: input.request.messages,
      update,
    })
  }

  private async *observeStreamEvents(
    events: AsyncIterable<ProviderRuntimeEvent>,
    input: ProviderRuntimeForwardInput,
    webRequest: ProviderWebRequest,
    plugin: WebProviderPlugin,
  ): AsyncIterable<ProviderRuntimeEvent> {
    for await (const event of events) {
      if (event.type === 'session_update' && (event.sessionId || event.parentId)) {
        this.writeRuntimeSessionState(input, {
          plugin,
          webRequest,
          sessionId: event.sessionId || webRequest.sessionId,
          reqId: event.parentId || webRequest.reqId,
        })
      }

      yield event
    }
  }

  private async collectStreamEventsToOpenAI(
    events: AsyncIterable<ProviderRuntimeEvent>,
    model: string,
  ): Promise<{ body: any } | { error: ProviderRuntimeError }> {
    let content = ''
    let finishReason = 'stop'
    const toolCallsByIndex = new Map<number, {
      id?: string
      type: 'function'
      function: {
        name?: string
        arguments: string
      }
    }>()

    for await (const event of events) {
      if (event.type === 'text_delta') {
        content += event.text
        continue
      }

      if (event.type === 'tool_call_delta') {
        const index = event.call.index
        const existing = toolCallsByIndex.get(index) ?? {
          type: 'function' as const,
          function: { arguments: '' },
        }
        if (event.call.id) existing.id = event.call.id
        if (event.call.function?.name) existing.function.name = event.call.function.name
        if (event.call.function?.arguments) {
          existing.function.arguments += event.call.function.arguments
        }
        toolCallsByIndex.set(index, existing)
        continue
      }

      if (event.type === 'done') {
        finishReason = event.finishReason || finishReason
        continue
      }

      if (event.type === 'error') {
        return { error: event.error }
      }
    }

    const toolCalls = [...toolCallsByIndex.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, call]) => ({
        id: call.id || `call_${index}`,
        type: 'function',
        function: {
          name: call.function.name || '',
          arguments: call.function.arguments,
        },
      }))

    if (toolCalls.length > 0) {
      finishReason = 'tool_calls'
    }

    return {
      body: {
        id: `chatcmpl-${Date.now().toString(36)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: toolCalls.length > 0 ? null : content,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: finishReason,
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    }
  }

  private normalizeHeaders(headers: unknown): Record<string, string> {
    if (!headers || typeof headers !== 'object') return {}
    return Object.fromEntries(
      Object.entries(headers as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
    )
  }

  private extractResponseError(response: ProviderWebResponse | AxiosResponse): string {
    const data = (response as any).data
    if (typeof data === 'string') return data
    if (data && typeof data === 'object') {
      const message = (data as any).error?.message ?? (data as any).message ?? (data as any).msg
      if (typeof message === 'string') return message
    }
    return `Provider runtime request failed with status ${(response as any).status ?? 'unknown'}`
  }

  classifyTransportError(error: unknown): string {
    if (error instanceof AxiosError) return error.message
    return error instanceof Error ? error.message : 'Unknown provider runtime error'
  }
}

async function defaultPluginResolver(provider: Provider): Promise<WebProviderPlugin | undefined> {
  const registry = await import('../plugins/registry.ts')
  return registry.getPluginForProvider(provider)
}
