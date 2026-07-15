/**
 * Proxy Service Module - Chat Completions Route
 * Implements /v1/chat/completions route
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { PassThrough } from 'stream'
import type { ChatCompletionRequest, ProxyContext } from '../types.ts'
import { applyOpenAISessionIdentity } from './openaiSession.ts'

interface ChatRouteDependencies {
  getConfig: () => { loadBalanceStrategy: string }
  getPreferredProvider: (model: string) => string | undefined
  getPreferredAccount: (model: string) => string | undefined
  selectAccount: (
    model: string,
    strategy: string,
    preferredProviderId?: string,
    preferredAccountId?: string,
  ) => {
    account: any
    provider: any
    actualModel: string
  } | null
  recordRequestStart: (model: string, providerId: string, accountId: string) => void
  forwardChatCompletion: (
    request: ChatCompletionRequest,
    account: any,
    provider: any,
    actualModel: string,
    context: ProxyContext,
  ) => Promise<{
    success: boolean
    status?: number
    headers?: Record<string, string>
    body?: any
    stream?: NodeJS.ReadableStream
    skipTransform?: boolean
    error?: string
    latency?: number
    providerSessionId?: string
    parentMessageId?: string
  }>
}

const router = new Router({ prefix: '/v1/chat' })

type ChatRouteSelection = ReturnType<ChatRouteDependencies['selectAccount']>

interface PreparedChatForwardRequest {
  request: ChatCompletionRequest
  selection: NonNullable<ChatRouteSelection>
  context: ProxyContext
  result: Awaited<ReturnType<ChatRouteDependencies['forwardChatCompletion']>>
  startTime: number
  requestId: string
}

const defaultChatRouteDependencies: ChatRouteDependencies = {
  getConfig: () => {
    throw new Error('default getConfig dependency unavailable before runtime initialization')
  },
  getPreferredProvider: () => undefined,
  getPreferredAccount: () => undefined,
  selectAccount: () => {
    throw new Error('default selectAccount dependency unavailable before runtime initialization')
  },
  recordRequestStart: () => undefined,
  forwardChatCompletion: async (request, account, provider, actualModel, context) => {
    const { requestForwarder } = await import('../forwarder.ts')
    return requestForwarder.forwardChatCompletion(request, account, provider, actualModel, context)
  },
}

async function resolveChatRouteDependencies(
  deps: ChatRouteDependencies,
): Promise<ChatRouteDependencies> {
  if (deps !== defaultChatRouteDependencies) {
    return deps
  }

  const [
    { storeManager },
    { modelMapper },
    { loadBalancer },
    { proxyStatusManager },
  ] = await Promise.all([
    import('../../store/store.ts'),
    import('../modelMapper.ts'),
    import('../loadbalancer.ts'),
    import('../status.ts'),
  ])

  return {
    getConfig: () => storeManager.getConfig(),
    getPreferredProvider: (model) => modelMapper.getPreferredProvider(model),
    getPreferredAccount: (model) => modelMapper.getPreferredAccount(model),
    selectAccount: (model, strategy, preferredProviderId, preferredAccountId) => loadBalancer.selectAccount(
      model,
      strategy,
      preferredProviderId,
      preferredAccountId,
    ),
    recordRequestStart: (model, providerId, accountId) => proxyStatusManager.recordRequestStart(model, providerId, accountId),
    forwardChatCompletion: defaultChatRouteDependencies.forwardChatCompletion,
  }
}

/**
 * Generate Request ID
 */
function generateRequestId(): string {
  return `chatcmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Get Client IP
 */
function getClientIP(ctx: Context): string {
  return ctx.headers['x-real-ip'] as string ||
    ctx.headers['x-forwarded-for'] as string ||
    ctx.ip ||
    'unknown'
}

/**
 * Extract user input from messages (last user message, full content)
 */
function extractUserInput(messages: Array<{ role: string; content?: string | any[] | null }>): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'user' && msg.content) {
      let content = ''
      if (typeof msg.content === 'string') {
        content = msg.content
      } else if (Array.isArray(msg.content)) {
        const textParts = msg.content.filter((p: any) => p.type === 'text')
        if (textParts.length > 0) {
          content = textParts.map((p: any) => p.text || '').join(' ')
        }
      }
      if (content) {
        return content
      }
    }
  }
  return undefined
}

interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

function extractTokenUsageFromBody(body: unknown): TokenUsage | undefined {
  const usage = (body as { usage?: unknown } | undefined)?.usage
  if (!usage || typeof usage !== 'object') return undefined

  const usageRecord = usage as Record<string, unknown>
  const promptTokens = normalizeTokenCount(usageRecord.prompt_tokens)
  const completionTokens = normalizeTokenCount(usageRecord.completion_tokens)
  const totalTokens = normalizeTokenCount(usageRecord.total_tokens) || promptTokens + completionTokens

  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
    return undefined
  }

  return { promptTokens, completionTokens, totalTokens }
}

function extractTokenUsageFromSse(content: string): TokenUsage | undefined {
  let usage: TokenUsage | undefined

  for (const line of content.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue

    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue

    try {
      const parsed = JSON.parse(payload)
      usage = extractTokenUsageFromBody(parsed) || usage
    } catch {
      // Ignore non-JSON SSE data.
    }
  }

  return usage
}

function normalizeTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0
}

/**
 * Handle Chat Completions Request
 */
export async function prepareAndForwardChatCompletion(
  ctx: Context,
  deps: ChatRouteDependencies = defaultChatRouteDependencies,
): Promise<PreparedChatForwardRequest | null> {
  const resolvedDeps = await resolveChatRouteDependencies(deps)
  const startTime = Date.now()
  const requestId = generateRequestId()
  const clientIP = getClientIP(ctx)

  let request: ChatCompletionRequest
  try {
    request = ctx.request.body as ChatCompletionRequest
  } catch (error) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Invalid request body',
        type: 'invalid_request_error',
        param: null,
        code: null,
      },
    }
    return
  }

  if (!request.model) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Missing required field: model',
        type: 'invalid_request_error',
        param: 'model',
        code: null,
      },
    }
    return
  }

  if (!request.messages || !Array.isArray(request.messages) || request.messages.length === 0) {
    ctx.status = 400
    ctx.body = {
      error: {
        message: 'Missing required field: messages',
        type: 'invalid_request_error',
        param: 'messages',
        code: null,
      },
    }
    return
  }

  // Read feature parameters from Headers (lower priority than request body)
  const webSearchFromHeader = ctx.headers['x-web-search'] === 'true'
  const reasoningEffortFromHeader = ctx.headers['x-reasoning-effort'] as 'low' | 'medium' | 'high' | undefined
  const deepResearchFromHeader = ctx.headers['x-deep-research'] === 'true'

  // Handle reasoningEffort (camelCase) from AI SDK - convert to reasoning_effort (snake_case)
  const requestAny = request as any
  if (requestAny.reasoningEffort && !request.reasoning_effort) {
    request.reasoning_effort = requestAny.reasoningEffort
    console.log('[Chat] Reasoning effort set via reasoningEffort (camelCase):', requestAny.reasoningEffort)
    delete requestAny.reasoningEffort
  }

  // Merge into request (request body parameters take priority)
  if (webSearchFromHeader && request.web_search === undefined) {
    request.web_search = true
    console.log('[Chat] Web search enabled via X-Web-Search header')
  }
  if (reasoningEffortFromHeader && request.reasoning_effort === undefined) {
    request.reasoning_effort = reasoningEffortFromHeader
    console.log('[Chat] Reasoning effort set via X-Reasoning-Effort header:', reasoningEffortFromHeader)
  }
  if (deepResearchFromHeader && request.deep_research === undefined) {
    request.deep_research = true
    console.log('[Chat] Deep research enabled via X-Deep-Research header')
  }

  const config = resolvedDeps.getConfig()
  const preferredProviderId = resolvedDeps.getPreferredProvider(request.model)
  const preferredAccountId = resolvedDeps.getPreferredAccount(request.model)

  const selection = resolvedDeps.selectAccount(
    request.model,
    config.loadBalanceStrategy,
    preferredProviderId,
    preferredAccountId
  )

  if (!selection) {
    ctx.status = 503
    ctx.body = {
      error: {
        message: `No available account for model: ${request.model}`,
        type: 'service_unavailable_error',
        param: null,
        code: 'no_available_account',
      },
    }
    return null
  }

  const { account, provider, actualModel } = selection

  const baseContext: ProxyContext = {
    requestId,
    providerId: provider.id,
    accountId: account.id,
    model: request.model,
    actualModel,
    startTime,
    isStream: request.stream || false,
    clientIP,
  }

  const context = applyOpenAISessionIdentity(
    baseContext,
    request,
    ctx.headers as Record<string, string | string[] | undefined>,
  )

  resolvedDeps.recordRequestStart(request.model, provider.id, account.id)

  const result = await resolvedDeps.forwardChatCompletion(
    request,
    account,
    provider,
    actualModel,
    context,
  )

  return {
    request,
    selection,
    context,
    result,
    startTime,
    requestId,
  }
}

export function createChatCompletionsHandler(
  deps: ChatRouteDependencies = defaultChatRouteDependencies,
) {
  return async (ctx: Context) => {
    const prepared = await prepareAndForwardChatCompletion(ctx, deps)
    if (!prepared) {
      return
    }

    const [
      { loadBalancer },
      { proxyStatusManager },
      { storeManager },
    ] = await Promise.all([
      import('../loadbalancer.ts'),
      import('../status.ts'),
      import('../../store/store.ts'),
    ])

    const {
      request,
      selection: { account, provider, actualModel },
      result,
      startTime,
      requestId,
    } = prepared

    try {

    const latency = Date.now() - startTime

    if (!result.success) {
      proxyStatusManager.recordRequestFailure(latency)

      if (result.status && result.status >= 400 && result.status !== 429) {
        loadBalancer.markAccountFailed(account.id)
      }

      ctx.status = result.status || 500
      ctx.body = {
        error: {
          message: result.error || 'Request failed',
          type: 'api_error',
          param: null,
          code: null,
        },
      }

      storeManager.addLog('error', `Request failed: ${result.error}`, {
        requestId,
        providerId: provider.id,
        accountId: account.id,
        model: request.model,
        latency,
      })

      const userInput = extractUserInput(request.messages)
      const errorResponseBody = JSON.stringify({
        error: {
          message: result.error || 'Request failed',
          type: 'api_error',
          param: null,
          code: null,
        },
      })
      storeManager.addRequestLog({
        timestamp: startTime,
        status: 'error',
        statusCode: result.status || 500,
        method: 'POST',
        url: '/v1/chat/completions',
        model: request.model,
        actualModel,
        providerId: provider.id,
        providerName: provider.name,
        accountId: account.id,
        accountName: account.name,
        requestBody: JSON.stringify(request),
        userInput,
        webSearch: request.web_search,
        reasoningEffort: request.reasoning_effort,
        responseStatus: result.status || 500,
        responseBody: errorResponseBody,
        latency,
        isStream: request.stream || false,
        errorMessage: result.error,
      })

      storeManager.recordRequestInStats(false, latency, request.model, provider.id, account.id)

      return
    }

    loadBalancer.clearAccountFailure(account.id)

    proxyStatusManager.recordRequestSuccess(latency)

    storeManager.updateAccount(account.id, {
      lastUsed: Date.now(),
      requestCount: (account.requestCount || 0) + 1,
      todayUsed: (account.todayUsed || 0) + 1,
    })

    storeManager.addLog('debug', `Request succeeded`, {
      requestId,
      providerId: provider.id,
      accountId: account.id,
      model: request.model,
      actualModel,
      latency,
      isStream: request.stream,
    })

    const userInput = extractUserInput(request.messages)
    // Prepare response body for logging (only for non-stream requests)
    const responseBodyForLog = !request.stream && result.body
      ? JSON.stringify(result.body)
      : undefined
    const responseTokenUsage = !request.stream ? extractTokenUsageFromBody(result.body) : undefined

    // For streaming requests, we'll collect content and update the log later
    let logEntryId: string | undefined

    if (!request.stream) {
      // Non-streaming: record log with response body now
      const logEntry = storeManager.addRequestLog({
        timestamp: startTime,
        status: 'success',
        statusCode: 200,
        method: 'POST',
        url: '/v1/chat/completions',
        model: request.model,
        actualModel,
        providerId: provider.id,
        providerName: provider.name,
        accountId: account.id,
        accountName: account.name,
        requestBody: JSON.stringify(request),
        userInput,
        webSearch: request.web_search,
        reasoningEffort: request.reasoning_effort,
        responseStatus: 200,
        responseBody: responseBodyForLog,
        promptTokens: responseTokenUsage?.promptTokens,
        completionTokens: responseTokenUsage?.completionTokens,
        totalTokens: responseTokenUsage?.totalTokens,
        latency,
        isStream: false,
      })
      logEntryId = logEntry.id
    } else {
      // Streaming: record log now, will update response body later
      const logEntry = storeManager.addRequestLog({
        timestamp: startTime,
        status: 'success',
        statusCode: 200,
        method: 'POST',
        url: '/v1/chat/completions',
        model: request.model,
        actualModel,
        providerId: provider.id,
        providerName: provider.name,
        accountId: account.id,
        accountName: account.name,
        requestBody: JSON.stringify(request),
        userInput,
        webSearch: request.web_search,
        reasoningEffort: request.reasoning_effort,
        responseStatus: 200,
        latency,
        isStream: true,
      })
      logEntryId = logEntry.id
    }

    storeManager.recordRequestInStats(true, latency, request.model, provider.id, account.id, responseTokenUsage)

    if (request.stream === true && result.stream) {
      ctx.set('Content-Type', 'text/event-stream')
      ctx.set('Cache-Control', 'no-cache')
      ctx.set('Connection', 'keep-alive')
      ctx.set('X-Accel-Buffering', 'no')

      // Create a wrapper stream to handle errors and collect content
      const wrapperStream = new PassThrough()

      // Collect stream content for logging (raw SSE output)
      let collectedContent = ''
      const updateStreamingRequestLog = () => {
        if (!logEntryId) return

        const tokenUsage = extractTokenUsageFromSse(collectedContent)
        storeManager.updateRequestLog(logEntryId, {
          responseBody: collectedContent || undefined,
          promptTokens: tokenUsage?.promptTokens,
          completionTokens: tokenUsage?.completionTokens,
          totalTokens: tokenUsage?.totalTokens,
        })

        if (tokenUsage) {
          storeManager.addTokenUsageToStats(tokenUsage)
        }
      }

      // Handle stream errors
      result.stream.once('error', (err: Error) => {
        console.error('[Chat] Stream error:', err.message)

        // Send error as SSE event
        const errorEvent = {
          id: requestId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: actualModel,
          choices: [{
            index: 0,
            delta: {
              content: `\n\n[Error: ${err.message}]`,
            },
            finish_reason: 'stop',
          }],
        }

        wrapperStream.write(`data: ${JSON.stringify(errorEvent)}\n\n`)
        wrapperStream.write('data: [DONE]\n\n')
        wrapperStream.end()

        storeManager.addLog('error', `Stream error: ${err.message}`, {
          requestId,
          providerId: provider.id,
          accountId: account.id,
          model: request.model,
        })
      })

      // Check if stream is already in correct SSE format (from adapters like Kimi, GLM, DeepSeek)
      if (result.skipTransform) {
        // Stream is already formatted, pipe through wrapper and collect
        result.stream.on('data', (chunk: Buffer) => {
          collectedContent += chunk.toString()
        })

        result.stream.pipe(wrapperStream, { end: false })

        // When source stream ends normally, update log and end wrapper
        result.stream.once('end', () => {
          updateStreamingRequestLog()
          wrapperStream.end()
        })
      } else {
        // Need to transform the stream
        const { streamHandler } = await import('../stream.ts')
        const transformStream = streamHandler.createTransformStream(
          actualModel,
          requestId,
          () => {
            storeManager.addLog('debug', `Stream response completed`, { requestId })
          }
        )

        // Collect from transform stream output
        transformStream.on('data', (chunk: Buffer) => {
          collectedContent += chunk.toString()
        })

        result.stream.pipe(transformStream)
        transformStream.pipe(wrapperStream, { end: false })

        transformStream.once('end', () => {
          updateStreamingRequestLog()
          wrapperStream.end()
        })
      }

      ctx.body = wrapperStream
    } else {
      ctx.set('Content-Type', 'application/json')

      if (result.body) {
        // Check if we need to transform to Anthropic format
        const {
          isAnthropicToolFormat,
          transformResponseToAnthropic,
        } = await import('../utils/toolFormatConverter.ts')
        if (isAnthropicToolFormat(request.tool_format)) {
          ctx.body = transformResponseToAnthropic(result.body)
          console.log('[Chat] Transformed response to Anthropic tool format')
        } else {
          ctx.body = result.body
        }
      } else {
        ctx.body = {
          id: requestId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: actualModel,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
            },
            finish_reason: 'stop',
          }],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
        }
      }
    }
    } catch (error) {
    const latency = Date.now() - startTime
    proxyStatusManager.recordRequestFailure(latency)

    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    const errorStack = error instanceof Error ? error.stack : undefined

    ctx.status = 500
    ctx.body = {
      error: {
        message: errorMessage,
        type: 'internal_error',
        param: null,
        code: null,
      },
    }

    storeManager.addLog('error', `Request exception: ${errorMessage}`, {
      requestId,
      providerId: provider.id,
      accountId: account.id,
      model: request.model,
      latency,
      error: errorMessage,
    })

    const userInput = extractUserInput(request.messages)
    const exceptionResponseBody = JSON.stringify({
      error: {
        message: errorMessage,
        type: 'internal_error',
        param: null,
        code: null,
      },
    })
    storeManager.addRequestLog({
      timestamp: startTime,
      status: 'error',
      statusCode: 500,
      method: 'POST',
      url: '/v1/chat/completions',
      model: request.model,
      actualModel,
      providerId: provider.id,
      providerName: provider.name,
      accountId: account.id,
      accountName: account.name,
      requestBody: JSON.stringify(request),
      userInput,
      webSearch: request.web_search,
      reasoningEffort: request.reasoning_effort,
      responseStatus: 500,
      responseBody: exceptionResponseBody,
      latency,
      isStream: request.stream || false,
      errorMessage,
      errorStack,
    })

    storeManager.recordRequestInStats(false, latency, request.model, provider.id, account.id)
    }
  }
}

router.post('/completions', createChatCompletionsHandler())

export default router
