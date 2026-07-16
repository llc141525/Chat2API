/**
 * Anthropic Messages compatibility routes.
 * Supports SDKs configured with /anthropic/v1 or /v1 base URLs.
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { requestForwarder } from '../forwarder.ts'
import { loadBalancer } from '../loadbalancer.ts'
import { modelMapper } from '../modelMapper.ts'
import { proxyStatusManager } from '../status.ts'
import { storeManager } from '../../store/store.ts'
import {
  anthropicError,
  anthropicRequestToOpenAI,
  anthropicToolToOpenAI,
  classifyAnthropicForwardError,
  classifyAnthropicSelectionFailure,
  generateAnthropicRequestId,
  openAIResponseToAnthropic,
  transformOpenAIStreamToAnthropic,
  type AnthropicMessagesRequest,
} from './anthropicCompat.ts'
import {
  collectAnthropicCatalogEvidence,
  deriveAnthropicSessionIdentity,
} from './anthropicSession.ts'

const router = new Router()

function getClientIP(ctx: Context): string {
  return ctx.headers['x-real-ip'] as string ||
    ctx.headers['x-forwarded-for'] as string ||
    ctx.ip ||
    'unknown'
}

async function handleMessages(ctx: Context): Promise<void> {
  const startTime = Date.now()
  const requestId = generateAnthropicRequestId()
  const request = ctx.request.body as AnthropicMessagesRequest

  if (!request?.model) {
    ctx.status = 400
    ctx.body = anthropicError('Missing required field: model')
    return
  }

  if (!Array.isArray(request.messages)) {
    ctx.status = 400
    ctx.body = anthropicError('Missing required field: messages')
    return
  }

  const openAIRequest = anthropicRequestToOpenAI(request)
  const preferredProviderId = modelMapper.getPreferredProvider(openAIRequest.model)
  const sessionIdentity = deriveAnthropicSessionIdentity({
    request,
    headers: ctx.headers as Record<string, string | string[] | undefined>,
    clientIP: getClientIP(ctx),
    providerId: preferredProviderId,
  })
  const catalogEvidence = collectAnthropicCatalogEvidence(request)
  const config = storeManager.getConfig()
  const preferredAccountId = modelMapper.getPreferredAccount(openAIRequest.model)
  const providersForModel = modelMapper.getProvidersForModel(openAIRequest.model)
  const configuredAccountCount = providersForModel.reduce(
    (total, provider) => total + storeManager.getAccountsByProviderId(provider.id, true).length,
    0,
  )
  const availableAccountCount = loadBalancer.getAvailableAccountCount(
    openAIRequest.model,
    preferredProviderId,
  )

  console.log('[AnthropicRoute] Request summary:', JSON.stringify({
    path: ctx.path,
    anthropicRequestId: requestId,
    claudeSessionKey: sessionIdentity.claudeSessionKey,
    claudeSessionKeySource: sessionIdentity.source,
    model: request.model,
    normalizedModel: openAIRequest.model,
    stream: !!request.stream,
    topLevelToolCount: catalogEvidence.topLevelToolCount,
    topLevelToolNames: catalogEvidence.topLevelToolNames,
    messageCount: catalogEvidence.messageCount,
    hasToolUseHistory: catalogEvidence.hasToolUseHistory,
    hasToolResultHistory: catalogEvidence.hasToolResultHistory,
    hasContractHeaderText: catalogEvidence.hasContractHeaderText,
    contractHeaderAllowedToolNames: catalogEvidence.contractHeaderAllowedToolNames,
    compactSuspected: catalogEvidence.compactSuspected,
  }))

  const selection = loadBalancer.selectAccount(
    openAIRequest.model,
    config.loadBalanceStrategy,
    preferredProviderId,
    preferredAccountId,
  )

  if (!selection) {
    const classified = classifyAnthropicSelectionFailure({
      requestedModel: openAIRequest.model,
      supportedProviderCount: providersForModel.length,
      configuredAccountCount,
      availableAccountCount,
    })
    console.warn('[AnthropicRoute] Model selection failed:', JSON.stringify({
      path: ctx.path,
      model: openAIRequest.model,
      preferredProviderId,
      preferredAccountId,
      supportedProviderCount: providersForModel.length,
      configuredAccountCount,
      availableAccountCount,
      errorClass: classified.diagnosticClass,
    }))
    ctx.status = 503
    ctx.body = anthropicError(classified.message, classified.type)
    return
  }

  const { account, provider, actualModel } = selection
  console.log('[AnthropicRoute] Selected upstream target:', JSON.stringify({
    path: ctx.path,
    model: openAIRequest.model,
    providerId: provider.id,
    accountId: account.id,
    actualModel,
  }))
  proxyStatusManager.recordRequestStart(openAIRequest.model, provider.id, account.id)

  const result = await requestForwarder.forwardChatCompletion(
    openAIRequest,
    account,
    provider,
    actualModel,
    {
      requestId,
      providerId: provider.id,
      accountId: account.id,
      model: openAIRequest.model,
      actualModel,
      startTime,
      isStream: openAIRequest.stream || false,
      clientIP: getClientIP(ctx),
      toolCatalogSessionKey: sessionIdentity.claudeSessionKey,
      providerConversationSessionKey: sessionIdentity.claudeSessionKey,
    }
  )

  const latency = Date.now() - startTime

  if (!result.success) {
    proxyStatusManager.recordRequestFailure(latency)
    const classified = classifyAnthropicForwardError(result.status, result.error)
    console.warn('[AnthropicRoute] Upstream request failed:', JSON.stringify({
      path: ctx.path,
      model: openAIRequest.model,
      providerId: provider.id,
      accountId: account.id,
      actualModel,
      status: result.status ?? null,
      errorClass: classified.diagnosticClass,
    }))
    ctx.status = result.status || 500
    ctx.body = anthropicError(classified.message, classified.type)
    return
  }

  proxyStatusManager.recordRequestSuccess(latency)

  if (openAIRequest.stream && result.stream) {
    ctx.set('Content-Type', 'text/event-stream')
    ctx.set('Cache-Control', 'no-cache')
    ctx.set('Connection', 'keep-alive')
    ctx.body = transformOpenAIStreamToAnthropic(result.stream, actualModel)
    return
  }

  ctx.set('Content-Type', 'application/json')
  ctx.body = openAIResponseToAnthropic(result.body, actualModel)
}

router.post('/anthropic/v1/messages', handleMessages)
router.post('/v1/messages', handleMessages)
router.post('/v1/v1/messages', handleMessages)

export {
  anthropicToolToOpenAI,
  openAIResponseToAnthropic,
}

export default router
