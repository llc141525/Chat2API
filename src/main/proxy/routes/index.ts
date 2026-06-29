/**
 * Proxy Service Module - Route Index
 * Export all routes
 */

import chatRouter from './chat'
import modelsRouter from './models'
import completionsRouter from './completions'
import anthropicRouter from './anthropic'

export {
  chatRouter,
  modelsRouter,
  completionsRouter,
  anthropicRouter,
}

export default [
  chatRouter,
  modelsRouter,
  completionsRouter,
  anthropicRouter,
]
