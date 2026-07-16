/**
 * Proxy Service Module - Models Route
 * Implements /v1/models route
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { ModelsResponse, ModelInfo } from '../types.ts'
import { storeManager } from '../../store/store.ts'
import { resolveQualifiedModel } from '../modelMapper.ts'

const router = new Router()

function createModelInfo(id: string, created: number, ownedBy: string): ModelInfo {
  return {
    id,
    object: 'model',
    created,
    owned_by: ownedBy,
  }
}

function isModelSupported(modelId: string, supportedId: string): boolean {
  const normalizedModelId = modelId.toLowerCase()
  const normalizedSupported = supportedId.toLowerCase()
  if (normalizedSupported.endsWith('*')) {
    return normalizedModelId.startsWith(normalizedSupported.slice(0, -1))
  }
  return normalizedSupported === normalizedModelId
}

async function handleListModels(ctx: Context): Promise<void> {
  const providers = storeManager.getProviders().filter(p => p.enabled)
  const models: ModelInfo[] = []
  const addedModels = new Set<string>()

  for (const provider of providers) {
    const accounts = storeManager.getAccountsByProviderId(provider.id)
      .filter(account => account.status === 'active')

    if (accounts.length === 0) {
      continue
    }

    const effectiveModels = storeManager.getEffectiveModels(provider.id)
    for (const model of effectiveModels) {
      if (!addedModels.has(model.displayName)) {
        addedModels.add(model.displayName)
        models.push(createModelInfo(
          model.displayName,
          Math.floor(provider.createdAt / 1000),
          provider.name,
        ))
      }
    }
  }

  const config = storeManager.getConfig()
  const mappings = config.modelMappings || {}
  for (const [requestModel] of Object.entries(mappings)) {
    if (!addedModels.has(requestModel)) {
      addedModels.add(requestModel)
      models.push(createModelInfo(
        requestModel,
        Math.floor(Date.now() / 1000),
        'model-mapping',
      ))
    }
  }

  const response: ModelsResponse = {
    object: 'list',
    data: models,
  }

  ctx.set('Content-Type', 'application/json')
  ctx.body = response
}

async function handleGetModel(ctx: Context): Promise<void> {
  const modelId = ctx.params.model
  const qualified = resolveQualifiedModel(modelId)
  const normalizedModelId = qualified.model
  const preferredProviderId = qualified.providerId

  const config = storeManager.getConfig()
  const mappings = config.modelMappings || {}
  if (mappings[modelId]) {
    ctx.set('Content-Type', 'application/json')
    ctx.body = createModelInfo(
      modelId,
      Math.floor(Date.now() / 1000),
      'model-mapping',
    )
    return
  }

  if (normalizedModelId !== modelId && mappings[normalizedModelId]) {
    ctx.set('Content-Type', 'application/json')
    ctx.body = createModelInfo(
      modelId,
      Math.floor(Date.now() / 1000),
      preferredProviderId || 'model-mapping',
    )
    return
  }

  const providers = storeManager.getProviders().filter(p => p.enabled)

  for (const provider of providers) {
    if (preferredProviderId && provider.id !== preferredProviderId) {
      continue
    }

    const accounts = storeManager.getAccountsByProviderId(provider.id)
      .filter(account => account.status === 'active')

    if (accounts.length === 0) {
      continue
    }

    const effectiveModels = storeManager.getEffectiveModels(provider.id)
    const found = effectiveModels.some(m => isModelSupported(normalizedModelId, m.displayName))

    if (found) {
      ctx.set('Content-Type', 'application/json')
      ctx.body = createModelInfo(
        modelId,
        Math.floor(provider.createdAt / 1000),
        provider.name,
      )
      return
    }
  }

  ctx.status = 404
  ctx.body = {
    error: {
      message: `Model '${modelId}' not found`,
      type: 'invalid_request_error',
      param: 'model',
      code: 'model_not_found',
    },
  }
}

/**
 * Get all available models
 */
router.get('/v1/models', handleListModels)
router.get('/anthropic/v1/models', handleListModels)
router.get('/v1/v1/models', handleListModels)

/**
 * Get specified model info
 */
router.get('/v1/models/:model', handleGetModel)
router.get('/anthropic/v1/models/:model', handleGetModel)
router.get('/v1/v1/models/:model', handleGetModel)

export default router
