import { logger } from '../shared/logger.ts'
/**
 * ProviderRuntime Service
 * Abstracts session state management for provider adapters.
 * Handles reading/writing conversation state with fallback and mirroring logic.
 * This is Phase 3 of the provider plugin architecture migration.
 */

import type { ProxyContext, ChatCompletionRequest } from '../types.ts'
import type { ForwardResult } from '../types.ts'
import {
  buildChildSessionHandoff,
  renderChildSessionHandoffStateMessage,
  type ChildSessionHandoff,
} from '../sessionBoundary.ts'
import type { Account, Provider } from '../../store/types.ts'
import type { RequestAssembly } from '../RequestAssembly.ts'
import type { ToolCallingTransformResult } from '../toolCalling/types.ts'
import type { PromptRefreshMode } from '../promptBudgetPolicy.ts'
import type { CleanedRequest } from '../core/requestCleaner.ts'
import { buildCleanedRequest } from '../core/requestCleaner.ts'
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
import { markProviderRequestStreamFinished, runThroughProviderRequestGate } from './providerRequestGate.ts'
import { primeProviderStreamEvents } from './providerStreamGuard.ts'
import { inspectStreamAssistantOutput } from '../toolCalling/outputInspection.ts'
import { cleanupChildProviderSession } from './childSessionCleanup.ts'

function requiresBufferedToolValidation(constraint: RequestAssembly['toolActionConstraint']): boolean {
  return constraint?.kind === 'first_skill_required' || constraint?.kind === 'next_required_tool'
}

function isChildBoundary(context: ProxyContext): boolean {
  return context.sessionBoundaryReason === 'tool_child' || context.sessionBoundaryReason === 'subagent_child'
}

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

    const primaryPriorState = this.readSessionState({
      conversationStateKey: input.conversationStateKey,
      toolSessionKey: input.toolSessionKey,
      context: input.context,
      messages: input.request.messages,
    })
    const childBoundary = isChildBoundary(input.context)
    const parentState = childBoundary && plugin.capabilities.reuseProviderSessionForToolChild
      && input.context.parentProviderConversationSessionKey
      ? getProviderConversationState({
          primaryKey: input.context.parentProviderConversationSessionKey,
          allowFallback: false,
        })
      : undefined
    const priorState = primaryPriorState ?? parentState

    const sessionBoundaryPlan = buildSessionBoundaryPlan({
      context: input.context,
      priorState,
      request: input.request,
      reuseProviderSessionForToolChild: plugin.capabilities.reuseProviderSessionForToolChild,
    })
    const consumedChildHandoff = sessionBoundaryPlan.providerSessionAction === 'consume_child_handoff'
      ? priorState?.childSessionHandoff
      : undefined
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

    const providerAssemblyBase = projectRequestAssemblyForPromptMode(input.assembly, input.promptRefreshMode)
    const providerAssembly = sessionBoundaryPlan.providerSessionAction === 'consume_child_handoff'
      && priorState?.childSessionHandoff
      ? {
          ...providerAssemblyBase,
          messages: [
            {
              role: 'system' as const,
              content: renderChildSessionHandoffStateMessage(priorState.childSessionHandoff),
            },
            ...providerAssemblyBase.messages,
          ],
        }
      : providerAssemblyBase

    // Phase 3a: Pre-build CleanedRequest so the plugin receives
    // a pre-filtered, truncated, delta-selected set of messages
    const cleanedRequest = buildCleanedRequest(providerAssembly, {
      promptRefreshMode: input.promptRefreshMode ?? 'full',
      hasProviderSession: Boolean(providerSessionId),
    })

    const rawAssemblyChars = providerAssembly.messages.reduce(
      (total, message) => total + extractTextContent(message.content).length,
      0,
    )
    const cleanedMessages = cleanedRequest.infrastructurePrompt
      ? [
          ...cleanedRequest.messages,
          { role: 'system' as const, content: cleanedRequest.infrastructurePrompt },
        ]
      : cleanedRequest.messages
    const cleanedPromptChars = cleanedMessages.reduce(
      (total, message) => total + extractTextContent(message.content).length,
      0,
    ) + (cleanedRequest.summaryText?.length ?? 0) + (cleanedRequest.toolContractText?.length ?? 0)
    const contextEconomy = buildContextEconomyDiagnostics(cleanedMessages, {
      boundary: sessionBoundaryPlan.boundary,
      promptRefreshMode: input.promptRefreshMode,
      promptChars: cleanedPromptChars,
    })
    logger.info('[ProviderRuntime] Context economy:', JSON.stringify({
      correlationId: input.context.requestId,
      requestId: input.context.requestId,
      providerPlugin: plugin.id,
      assemblyMessageCount: providerAssembly.messages.length,
      assemblyToolContractChars: providerAssembly.toolManifest?.renderedPrompt.length ?? 0,
      assemblyActionConstraint: providerAssembly.toolActionConstraint ?? null,
      contextEconomy,
      rawAssemblyChars,
      cleanedPromptChars,
      providerSessionAction: sessionBoundaryPlan.providerSessionAction,
      providerSessionIdSource,
    }))

    let webRequest: ProviderWebRequest | undefined
    const executeRequest = () => plugin.buildRequest({
      provider: input.provider,
      account: input.account,
      model: input.actualModel,
      originalModel: input.request.originalModel,
      messages: input.request.messages as any,
      assembly: providerAssembly,
      cleanedRequest,
      promptRefreshMode: input.promptRefreshMode,
      sessionBoundaryReason: input.context.sessionBoundaryReason,
      sessionBoundaryPlan,
      stream: input.request.stream,
      temperature: input.request.temperature,
      sessionId: providerSessionId,
      parentReqId: providerParentReqId,
      enableThinking: !!input.request.reasoning_effort,
      enableWebSearch: !!input.request.web_search,
      correlationId: input.context.requestId,
    }).then(request => {
      webRequest = request
      return this.transport(request, { runtimeRequest: input, plugin })
    })

    const response = plugin.capabilities.requestThrottle
      ? await runThroughProviderRequestGate(
        `${input.provider.id}:${input.account.id}`,
        plugin.capabilities.requestThrottle,
        executeRequest,
        result => Number((result as any).status ?? 200),
      )
      : await executeRequest()
    const status = Number((response as any).status ?? 200)
    const headers = this.normalizeHeaders((response as any).headers)
    const latency = Date.now() - startTime
    logger.info('[ProviderRuntime] Provider response boundary:', JSON.stringify({
      providerPlugin: plugin.id,
      model: input.actualModel,
      correlationId: input.context.requestId,
      status,
      contentType: headers['content-type'] ?? null,
      contentEncoding: headers['content-encoding'] ?? null,
      responseDataKind: (response as any).data == null
        ? 'nullish'
        : typeof (response as any).data,
      responseDataReadable: Boolean((response as any).data?.pipe && (response as any).data?.on),
      streamRequested: input.request.stream,
      actionConstraint: input.assembly.toolActionConstraint ?? null,
    }))

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
      webRequest: webRequest!,
      sessionId: webRequest!.sessionId,
      reqId: webRequest!.reqId,
      })

      const observedEvents = this.withChildLifecycleOnStreamSettled(this.observeStreamEvents(
        plugin.parseStream({
          response: {
            status,
            headers,
            data: (response as any).data,
          },
          rawResponse: response,
          model: input.actualModel,
          toolCallingPlan: input.transformed.plan,
          correlationId: input.context.requestId,
          toolActionConstraint: input.assembly.toolActionConstraint,
        }),
        input,
        webRequest,
        plugin,
        plugin.capabilities.requestThrottle
          ? () => markProviderRequestStreamFinished(
            `${input.provider.id}:${input.account.id}`,
            plugin.capabilities.requestThrottle!,
          )
          : undefined,
      ), input, plugin, webRequest!, consumedChildHandoff)
      const guardedEvents = plugin.capabilities.firstStreamEventTimeoutMs
        ? await primeProviderStreamEvents(
          observedEvents,
          plugin.capabilities.firstStreamEventTimeoutMs,
          () => {
            const rawStream = (response as any).data
            rawStream?.destroy?.(new Error('Provider stream first-event timeout'))
          },
          event => event.type !== 'session_update',
        )
        : { events: observedEvents }
      if ('error' in guardedEvents) {
        logger.error('[ProviderRuntime] Provider stream guard rejected stream:', JSON.stringify({
          providerPlugin: plugin.id,
          model: input.actualModel,
          correlationId: input.context.requestId,
          actionConstraint: input.assembly.toolActionConstraint ?? null,
          error: guardedEvents.error.message,
        }))
        return {
          success: false,
          status: 504,
          headers,
          error: guardedEvents.error.message,
          latency: Date.now() - startTime,
        }
      }

      if (requiresBufferedToolValidation(input.assembly.toolActionConstraint)) {
        const aggregated = await this.collectStreamEventsToOpenAI(
          guardedEvents.events,
          input.actualModel,
          input.transformed.plan,
        )
        if ('error' in aggregated) {
          logger.error('[ProviderRuntime] Provider stream event aggregation failed:', JSON.stringify({
            providerPlugin: plugin.id,
            model: input.actualModel,
            correlationId: input.context.requestId,
            actionConstraint: input.assembly.toolActionConstraint ?? null,
            error: aggregated.error,
          }))
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
          stream: normalizeProviderStreamToOpenAI((async function* () {
            yield* aggregated.events
          })()),
          latency,
        }
      }

      return {
        success: true,
        status,
        headers,
        stream: normalizeProviderStreamToOpenAI(guardedEvents.events),
        latency,
      }
    }

    if (plugin.parseStream && webRequest.transportOptions?.responseType === 'stream') {
      const observedEvents = this.withChildLifecycleOnStreamSettled(this.observeStreamEvents(
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
        webRequest!,
        plugin,
        plugin.capabilities.requestThrottle
          ? () => markProviderRequestStreamFinished(
            `${input.provider.id}:${input.account.id}`,
            plugin.capabilities.requestThrottle!,
          )
          : undefined,
      ), input, plugin, webRequest!, consumedChildHandoff)
      const guardedEvents = plugin.capabilities.firstStreamEventTimeoutMs
        ? await primeProviderStreamEvents(
          observedEvents,
          plugin.capabilities.firstStreamEventTimeoutMs,
          () => {
            const rawStream = (response as any).data
            rawStream?.destroy?.(new Error('Provider stream first-event timeout'))
          },
          event => event.type !== 'session_update',
        )
        : { events: observedEvents }
      if ('error' in guardedEvents) {
        logger.error('[ProviderRuntime] Provider stream guard rejected stream:', JSON.stringify({
          providerPlugin: plugin.id,
          model: input.actualModel,
          correlationId: input.context.requestId,
          actionConstraint: input.assembly.toolActionConstraint ?? null,
          error: guardedEvents.error.message,
        }))
        return {
          success: false,
          status: 504,
          headers,
          error: guardedEvents.error.message,
          latency: Date.now() - startTime,
        }
      }
      const aggregated = await this.collectStreamEventsToOpenAI(
        guardedEvents.events,
        input.actualModel,
        input.transformed.plan,
      )

      if ('error' in aggregated) {
        logger.error('[ProviderRuntime] Provider stream event aggregation failed:', JSON.stringify({
          providerPlugin: plugin.id,
          model: input.actualModel,
          correlationId: input.context.requestId,
          actionConstraint: input.assembly.toolActionConstraint ?? null,
          error: aggregated.error,
        }))
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
      webRequest: webRequest!,
      sessionId: parsed.sessionId || webRequest!.sessionId,
      reqId: parsed.reqId || webRequest!.reqId,
      parentHandoff: this.buildSettledChildHandoff(
        input,
        parsed.response.data,
        parsed.sessionId || webRequest!.sessionId,
      ),
    })
    await this.cleanupConsumedChildHandoff(input, plugin, consumedChildHandoff)

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

  private buildDeleteSessionCallback(plugin: WebProviderPlugin, input: ProviderRuntimeForwardInput): ((sessionId: string) => Promise<void>) | undefined {
    if (!plugin.capabilities.supportsDeleteSession || !plugin.deleteSession) {
      return undefined
    }

    return async (sessionId: string) => {
      const result = await plugin.deleteSession!({
        sessionId,
        provider: input.provider,
        account: input.account,
      })
      if (!result.success) {
        throw new Error(`Provider plugin ${plugin.id} did not delete child session ${sessionId}`)
      }
    }
  }

  private async cleanupConsumedChildHandoff(input: ProviderRuntimeForwardInput, plugin: WebProviderPlugin, handoff?: ChildSessionHandoff): Promise<void> {
    if (!handoff) return
    const deleteSession = this.buildDeleteSessionCallback(plugin, input)
    if (!deleteSession) {
      logger.debug('[ProviderRuntime] Child handoff consumed without provider delete capability:', JSON.stringify({
        providerPlugin: plugin.id,
        correlationId: input.context.requestId,
        handoffStatus: handoff.status,
        childProviderSessionIdPresent: typeof handoff.childProviderSessionId === 'string' && handoff.childProviderSessionId.length > 0,
      }))
      return
    }

    try {
      const deleted = await cleanupChildProviderSession({
        handoff,
        debugMode: false,
        deleteSession,
      })
      logger.debug('[ProviderRuntime] Child handoff cleanup decision:', JSON.stringify({
        providerPlugin: plugin.id,
        correlationId: input.context.requestId,
        handoffStatus: handoff.status,
        deleted,
      }))
    } catch (error) {
      logger.warn('[ProviderRuntime] Child handoff cleanup failed:', JSON.stringify({
        providerPlugin: plugin.id,
        correlationId: input.context.requestId,
        error: error instanceof Error ? error.message : String(error),
      }))
    }
  }

  private buildSettledChildHandoff(input: ProviderRuntimeForwardInput, responseBody: any, childProviderSessionId?: string): ChildSessionHandoff | undefined {
    return buildChildSessionHandoff({
      context: input.context,
      requestMessages: input.request.messages,
      responseBody,
      childProviderSessionId,
    })
  }

  private async *withChildLifecycleOnStreamSettled(
    events: AsyncIterable<ProviderRuntimeEvent>,
    input: ProviderRuntimeForwardInput,
    plugin: WebProviderPlugin,
    webRequest: ProviderWebRequest,
    consumedChildHandoff?: ChildSessionHandoff,
  ): AsyncIterable<ProviderRuntimeEvent> {
    let content = ''
    let finishReason: string | undefined
    let emittedToolCall = false
    let latestSessionId = webRequest.sessionId
    let latestReqId = webRequest.reqId
    let completed = false

    try {
      for await (const event of events) {
        if (event.type === 'session_update') {
          if (event.sessionId) latestSessionId = event.sessionId
          if (event.parentId) latestReqId = event.parentId
        } else if (event.type === 'text_delta') {
          content += event.text
        } else if (event.type === 'tool_call_delta') {
          emittedToolCall = true
        } else if (event.type === 'done') {
          finishReason = event.finishReason
          completed = true
        } else if (event.type === 'error') {
          completed = true
        }

        yield event
      }
    } finally {
      if (isChildBoundary(input.context) && completed && !emittedToolCall) {
        const parentHandoff = this.buildSettledChildHandoff(
          input,
          {
            choices: [{
              finish_reason: finishReason ?? 'stop',
              message: {
                role: 'assistant',
                content,
              },
            }],
          },
          latestSessionId,
        )
        if (parentHandoff) {
          this.writeRuntimeSessionState(input, {
            plugin,
            webRequest,
            sessionId: latestSessionId,
            reqId: latestReqId,
            parentHandoff,
          })
        }
      }

      await this.cleanupConsumedChildHandoff(input, plugin, consumedChildHandoff)
    }
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
      parentHandoff?: ChildSessionHandoff
    },
  ): void {
    const update: Partial<ConversationState> = {
      providerSessionId: result.sessionId,
      providerParentReqId: result.reqId || result.webRequest.reqId,
      ...(input.context.sessionBoundaryReason === 'normal'
        ? { childSessionHandoff: undefined }
        : {}),
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
      parentHandoff: result.parentHandoff,
    })

    if ((input.context.sessionBoundaryReason === 'tool_child'
      || input.context.sessionBoundaryReason === 'subagent_child')
      && result.plugin.capabilities.reuseProviderSessionForToolChild
      && input.context.parentProviderConversationSessionKey
      && input.context.parentProviderConversationSessionKey !== input.conversationStateKey) {
      this.writeSessionState({
        conversationStateKey: input.context.parentProviderConversationSessionKey,
        toolSessionKey: input.toolSessionKey,
        context: input.context,
        messages: input.request.messages,
        update,
      })
    }
  }

  private async *observeStreamEvents(
    events: AsyncIterable<ProviderRuntimeEvent>,
    input: ProviderRuntimeForwardInput,
    webRequest: ProviderWebRequest,
    plugin: WebProviderPlugin,
    onStreamSettled?: () => void,
  ): AsyncIterable<ProviderRuntimeEvent> {
    try {
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
    } finally {
      onStreamSettled?.()
    }
  }

  private async collectStreamEventsToOpenAI(
    events: AsyncIterable<ProviderRuntimeEvent>,
    model: string,
    toolCallingPlan?: ToolCallingTransformResult['plan'],
  ): Promise<{ body: any; events: ProviderRuntimeEvent[] } | { error: ProviderRuntimeError }> {
    let content = ''
    let finishReason = 'stop'
    const observedEvents: ProviderRuntimeEvent[] = []
    const toolCallsByIndex = new Map<number, {
      id?: string
      type: 'function'
      function: {
        name?: string
        arguments: string
      }
    }>()

    for await (const event of events) {
      observedEvents.push(event)
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

    if (toolCallingPlan && requiresBufferedToolValidation(toolCallingPlan.actionConstraint)) {
      const inspection = inspectStreamAssistantOutput({
        plan: toolCallingPlan,
        observation: {
          rawContentLength: content.length,
          emittedContentLength: content.length,
          emittedVisibleContentLength: content.trim().length,
          emittedToolCallCount: toolCalls.length,
          availabilityDriftDetected: false,
          deniedToolNames: [],
          mentionedUnavailableOnlyTools: [],
          suppressedMalformedToolOutput: false,
        },
        finishReason,
      })
      if (!inspection.ok) {
        return {
          error: {
            status: 502,
            code: 'MALFORMED_TOOL_OUTPUT',
            message: inspection.error,
            retryable: true,
            classified: true,
          },
        }
      }
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
      events: observedEvents,
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
