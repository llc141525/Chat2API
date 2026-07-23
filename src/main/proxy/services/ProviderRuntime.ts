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
import type { RecoveryEvent, SessionKind } from './sessionRecoveryState.ts'
import type { SessionRecoveryState } from './sessionRecoveryState.ts'
import { renderRecoveryContextForProvider } from './recoveryPromptProjection.ts'

const PROVIDER_ERROR_PREVIEW_LIMIT = 1000

function requiresBufferedToolValidation(constraint: RequestAssembly['toolActionConstraint']): boolean {
  return constraint?.kind === 'first_skill_required' || constraint?.kind === 'next_required_tool'
}

function isChildBoundary(context: ProxyContext): boolean {
  return context.sessionBoundaryReason === 'tool_child' || context.sessionBoundaryReason === 'subagent_child'
}

type RecoveryHandoffMetadata = {
  recoveryHandoffId?: string
  recoveryFromSessionId?: string
  recoveryToSessionId?: string
  recoveryChildKind?: Exclude<SessionKind, 'main'>
}

type RecoveryTrackedChildSessionHandoff = ChildSessionHandoff & RecoveryHandoffMetadata

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
  recoveryBridge?: ProviderRuntimeRecoveryBridge
}

export type ProviderRuntimeRecoverySessionInput = {
  sessionId: string
  sessionKind: SessionKind
  parentSessionId?: string
  toolCallId?: string
  providerSessionId?: string
  providerId?: string
  accountId?: string
  model?: string
}

export type ProviderRuntimeRecoveryEvent = Omit<RecoveryEvent, 'expectedStateVersion'>

export interface ProviderRuntimeRecoveryBridge {
  ensureSession(input: ProviderRuntimeRecoverySessionInput): void | Promise<void>
  applyEvent(sessionId: string, event: ProviderRuntimeRecoveryEvent): void | Promise<void>
  readState?(sessionId: string): SessionRecoveryState | undefined | null | Promise<SessionRecoveryState | undefined | null>
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

const defaultRecoveryBridge: ProviderRuntimeRecoveryBridge = {
  async ensureSession(input) {
    const { sessionManager } = await import('../sessionManager.ts')
    sessionManager.ensureRecoverySession(input)
  },
  async applyEvent(sessionId, event) {
    const { sessionManager } = await import('../sessionManager.ts')
    sessionManager.applyRecoveryEventWithCurrentVersion(sessionId, event as Omit<RecoveryEvent, 'expectedStateVersion'>)
  },
  async readState(sessionId) {
    const { sessionManager } = await import('../sessionManager.ts')
    return sessionManager.getSessionRecoveryState(sessionId)
  },
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
  private readonly recoveryBridge: ProviderRuntimeRecoveryBridge | null

  constructor(options: ProviderRuntimeOptions = {}) {
    this.axiosInstance = options.axiosInstance ?? axios.create({
      timeout: 120000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    })
    this.pluginResolver = options.pluginResolver ?? defaultPluginResolver
    this.transport = options.transport ?? this.defaultTransport.bind(this)
    this.recoveryBridge = options.recoveryBridge ?? defaultRecoveryBridge
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

    await this.ensureRecoverySession(input)

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

    const recoveryContextText = await this.buildRecoveryContextText(input)
    const assemblyWithRecoveryContext = recoveryContextText
      ? { ...input.assembly, recoveryContextText }
      : input.assembly
    const providerAssemblyBase = projectRequestAssemblyForPromptMode(assemblyWithRecoveryContext, input.promptRefreshMode)
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
    ) + (cleanedRequest.summaryText?.length ?? 0)
      + (cleanedRequest.recoveryContextText?.length ?? 0)
      + (cleanedRequest.toolContractText?.length ?? 0)
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
      const errorDiagnostics = await this.buildProviderHttpErrorDiagnostics(
        response,
        input,
        plugin,
        headers,
      )
      logger.error('[ProviderRuntime] Provider HTTP error response:', JSON.stringify(errorDiagnostics))
      return {
        success: false,
        status,
        headers,
        error: this.extractResponseError(response, errorDiagnostics.upstreamErrorPreview),
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
        reqId: plugin.id === 'deepseek' ? '' : webRequest!.reqId,
        allowSyntheticProviderParentReqId: plugin.id !== 'deepseek',
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
    const parentHandoff = this.buildSettledChildHandoff(
      input,
      parsed.response.data,
      parsed.sessionId || webRequest!.sessionId,
    )
    this.writeRuntimeSessionState(input, {
      plugin,
      webRequest: webRequest!,
      sessionId: parsed.sessionId || webRequest!.sessionId,
      reqId: parsed.reqId,
      parentHandoff,
      allowSyntheticProviderParentReqId: plugin.id !== 'deepseek',
    })
    await this.recordRecoveryChildSettled(input, parentHandoff)
    await this.recordRecoveryHandoffConsumed(input, consumedChildHandoff)
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

  private async ensureRecoverySession(input: ProviderRuntimeForwardInput): Promise<void> {
    const recoverySessionId = input.context.recoverySessionId?.trim()
    if (!recoverySessionId || !this.recoveryBridge) return

    await this.recoveryBridge.ensureSession({
      sessionId: recoverySessionId,
      sessionKind: this.getRecoverySessionKind(input.context),
      parentSessionId: input.context.parentRecoverySessionId,
      toolCallId: input.context.recoveryToolCallId,
      providerSessionId: input.context.providerSessionId,
      providerId: input.provider.id,
      accountId: input.account.id,
      model: input.actualModel,
    })

    await this.recordRecoveryChildCreate(input)
  }

  private async recordProviderSessionChange(input: ProviderRuntimeForwardInput, nextProviderSessionId: string): Promise<void> {
    const recoverySessionId = input.context.recoverySessionId?.trim()
    if (!recoverySessionId || !this.recoveryBridge) return

    await this.recoveryBridge.applyEvent(recoverySessionId, {
      type: 'provider_session_change',
      eventId: `provider-session:${input.context.requestId}:${nextProviderSessionId}`,
      sessionId: recoverySessionId,
      occurredAt: Date.now(),
      previousProviderSessionId: input.context.providerSessionId,
      nextProviderSessionId,
    })
  }

  private async buildRecoveryContextText(input: ProviderRuntimeForwardInput): Promise<string | null> {
    const recoverySessionId = input.context.recoverySessionId?.trim()
    if (!recoverySessionId || !this.recoveryBridge?.readState) return null
    if (!this.shouldProjectRecoveryContext(input.context.sessionBoundaryReason)) return null

    const state = await this.recoveryBridge.readState(recoverySessionId)
    if (!state || state.sessionId !== recoverySessionId) return null
    return renderRecoveryContextForProvider(state)
  }

  private shouldProjectRecoveryContext(boundary: ProxyContext['sessionBoundaryReason']): boolean {
    return boundary === 'client_compact' || boundary === 'server_summary' || boundary === 'summary_generator'
  }

  private async recordRecoveryChildCreate(input: ProviderRuntimeForwardInput): Promise<void> {
    const childSessionId = input.context.recoverySessionId?.trim()
    const parentSessionId = input.context.parentRecoverySessionId?.trim()
    const childKind = this.getRecoveryChildKind(input.context)
    if (!childSessionId || !parentSessionId || !childKind || !this.recoveryBridge) return

    await this.recoveryBridge.applyEvent(parentSessionId, {
      type: 'child_create',
      eventId: `child-create:${parentSessionId}:${childKind}:${childSessionId}`,
      sessionId: parentSessionId,
      occurredAt: Date.now(),
      childSessionId,
      childKind,
      toolCallId: input.context.recoveryToolCallId,
      providerSessionId: input.context.providerSessionId,
    })
  }

  private async recordRecoveryChildSettled(input: ProviderRuntimeForwardInput, handoff?: ChildSessionHandoff): Promise<void> {
    const metadata = handoff as RecoveryTrackedChildSessionHandoff | undefined
    const parentSessionId = metadata?.recoveryToSessionId?.trim() || input.context.parentRecoverySessionId?.trim()
    const childSessionId = metadata?.recoveryFromSessionId?.trim() || input.context.recoverySessionId?.trim()
    const childKind = metadata?.recoveryChildKind || this.getRecoveryChildKind(input.context)
    const handoffId = metadata?.recoveryHandoffId || this.buildRecoveryHandoffId(parentSessionId, childSessionId, childKind)
    if (!parentSessionId || !childSessionId || !childKind || !handoffId || !this.recoveryBridge) return

    const occurredAt = Date.now()
    await this.recoveryBridge.applyEvent(parentSessionId, {
      type: 'child_complete',
      eventId: `child-complete:${parentSessionId}:${childKind}:${childSessionId}`,
      sessionId: parentSessionId,
      occurredAt,
      childSessionId,
      handoffId,
    })
    await this.recoveryBridge.applyEvent(parentSessionId, {
      type: 'handoff_create',
      eventId: `handoff-create:${handoffId}`,
      sessionId: parentSessionId,
      occurredAt,
      handoffId,
      fromSessionId: childSessionId,
      toSessionId: parentSessionId,
      childKind,
    })
  }

  private async recordRecoveryHandoffConsumed(input: ProviderRuntimeForwardInput, handoff?: ChildSessionHandoff): Promise<void> {
    const metadata = handoff as RecoveryTrackedChildSessionHandoff | undefined
    const parentSessionId = input.context.recoverySessionId?.trim()
    const childSessionId = metadata?.recoveryFromSessionId?.trim()
    const handoffId = metadata?.recoveryHandoffId?.trim()
    if (!parentSessionId || !childSessionId || !handoffId || !this.recoveryBridge) return

    await this.recoveryBridge.applyEvent(parentSessionId, {
      type: 'handoff_consume',
      eventId: `handoff-consume:${handoffId}`,
      sessionId: parentSessionId,
      occurredAt: Date.now(),
      handoffId,
      fromSessionId: childSessionId,
    })
  }

  private getRecoverySessionKind(context: ProxyContext): SessionKind {
    if (context.sessionBoundaryReason === 'tool_child') return 'tool_child'
    if (context.sessionBoundaryReason === 'subagent_child') return 'subagent_child'
    return 'main'
  }

  private getRecoveryChildKind(context: ProxyContext): Exclude<SessionKind, 'main'> | undefined {
    if (context.sessionBoundaryReason === 'tool_child') return 'tool_child'
    if (context.sessionBoundaryReason === 'subagent_child') return 'subagent_child'
    return undefined
  }

  private buildRecoveryHandoffId(
    parentSessionId: string | undefined,
    childSessionId: string | undefined,
    childKind: Exclude<SessionKind, 'main'> | undefined,
  ): string | undefined {
    if (!parentSessionId || !childSessionId || !childKind) return undefined
    return `handoff:${parentSessionId}:${childKind}:${childSessionId}`
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
    const handoff = buildChildSessionHandoff({
      context: input.context,
      requestMessages: input.request.messages,
      responseBody,
      childProviderSessionId,
    })
    if (!handoff) return undefined

    const parentSessionId = input.context.parentRecoverySessionId?.trim()
    const childSessionId = input.context.recoverySessionId?.trim()
    const childKind = this.getRecoveryChildKind(input.context)
    const handoffId = this.buildRecoveryHandoffId(parentSessionId, childSessionId, childKind)
    if (!parentSessionId || !childSessionId || !childKind || !handoffId) return handoff

    return {
      ...handoff,
      recoveryHandoffId: handoffId,
      recoveryFromSessionId: childSessionId,
      recoveryToSessionId: parentSessionId,
      recoveryChildKind: childKind,
    } as RecoveryTrackedChildSessionHandoff
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
          await this.recordRecoveryChildSettled(input, parentHandoff)
        }
      }

      await this.recordRecoveryHandoffConsumed(input, consumedChildHandoff)
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
      allowSyntheticProviderParentReqId?: boolean
    },
  ): void {
    const allowSyntheticProviderParentReqId = result.allowSyntheticProviderParentReqId ?? true
    const providerParentReqId = result.reqId || (allowSyntheticProviderParentReqId ? result.webRequest.reqId : undefined)
    const update: Partial<ConversationState> = {
      providerSessionId: result.sessionId,
      ...(providerParentReqId ? { providerParentReqId } : {}),
      ...(input.context.sessionBoundaryReason === 'normal'
        ? { childSessionHandoff: undefined }
        : {}),
      ...(result.plugin.capabilities.sessionIdKind === 'conversation_id'
        ? { conversationId: result.sessionId }
        : {}),
      ...(result.plugin.capabilities.supportsParentMessageId
        ? (providerParentReqId ? { parentMessageId: providerParentReqId } : {})
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

    void this.recordProviderSessionChange(input, result.sessionId)

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

  private async buildProviderHttpErrorDiagnostics(
    response: ProviderWebResponse | AxiosResponse,
    input: ProviderRuntimeForwardInput,
    plugin: WebProviderPlugin,
    headers: Record<string, string>,
  ): Promise<Record<string, unknown> & { upstreamErrorPreview?: string }> {
    const data = (response as any).data
    const responseDataReadable = this.isReadableStream(data)
    let upstreamErrorPreview: string | undefined

    if (responseDataReadable) {
      upstreamErrorPreview = await this.readProviderErrorStreamPreview(data, PROVIDER_ERROR_PREVIEW_LIMIT)
      ;(response as any).data = upstreamErrorPreview
    } else {
      upstreamErrorPreview = this.previewProviderErrorData(data)
    }

    return {
      providerPlugin: plugin.id,
      providerId: input.provider.id,
      model: input.actualModel,
      correlationId: input.context.requestId,
      status: Number((response as any).status ?? 0),
      contentType: headers['content-type'] ?? null,
      responseDataKind: data == null ? 'nullish' : typeof data,
      responseDataReadable,
      streamRequested: input.request.stream,
      transportResponseType: responseDataReadable ? 'stream' : 'json',
      upstreamErrorPreview,
    }
  }

  private isReadableStream(value: unknown): value is NodeJS.ReadableStream {
    return Boolean(value && typeof (value as any).on === 'function' && typeof (value as any).pipe === 'function')
  }

  private async readProviderErrorStreamPreview(stream: NodeJS.ReadableStream, limit: number): Promise<string> {
    const chunks: Buffer[] = []
    let total = 0

    try {
      for await (const chunk of stream as AsyncIterable<Buffer | string | Uint8Array>) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        const remaining = Math.max(0, limit - total)
        if (remaining > 0) {
          chunks.push(buffer.subarray(0, remaining))
          total += Math.min(buffer.length, remaining)
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'failed to read provider error stream'
      return this.sanitizeProviderErrorPreview(`[stream read failed: ${message}]`)
    }

    const suffix = total >= limit ? '... [truncated]' : ''
    return this.sanitizeProviderErrorPreview(Buffer.concat(chunks).toString('utf8') + suffix)
  }

  private previewProviderErrorData(data: unknown): string | undefined {
    if (typeof data === 'string') {
      return this.sanitizeProviderErrorPreview(data.slice(0, PROVIDER_ERROR_PREVIEW_LIMIT))
    }
    if (data && typeof data === 'object') {
      try {
        return this.sanitizeProviderErrorPreview(JSON.stringify(data).slice(0, PROVIDER_ERROR_PREVIEW_LIMIT))
      } catch {
        return '[unserializable provider error body]'
      }
    }
    return undefined
  }

  private sanitizeProviderErrorPreview(value: string): string {
    return value
      .replace(/("(?:authorization|cookie|token|api[_-]?key|secret|password|access_token|refresh_token)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
      .replace(/(authorization|cookie|token|api[_-]?key|secret|password|access_token|refresh_token)(["'\s:=]+)([^"'\s,;}]+)/gi, '$1$2[REDACTED]')
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
  }

  private extractResponseError(response: ProviderWebResponse | AxiosResponse, fallbackPreview?: string): string {
    const data = (response as any).data
    if (typeof data === 'string') return data
    if (data && typeof data === 'object') {
      const message = (data as any).error?.message ?? (data as any).message ?? (data as any).msg
      if (typeof message === 'string') return message
    }
    if (fallbackPreview) return fallbackPreview
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
