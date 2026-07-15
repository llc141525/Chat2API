/**
 * Plugin Registry — WebProviderPlugin registration and lookup
 *
 * Central registry for all WebProviderPlugin implementations.
 * Plugins register themselves on module load, and the registry
 * provides lookup by provider identity.
 *
 * Note: PerplexityProviderPlugin depends on Electron (`import { net } from 'electron'`),
 * which is not available in plain Node.js. It is loaded via dynamic import
 * so the registry remains importable in test environments.
 */

import type { WebProviderPlugin } from './WebProviderPlugin.ts'
import { QwenProviderPlugin } from './QwenProviderPlugin.ts'
import { GLMProviderPlugin } from './GLMProviderPlugin.ts'

const pluginMap = new Map<string, WebProviderPlugin>()

/**
 * Register Node-safe plugins immediately. Other provider plugins are loaded on
 * demand so importing the registry in plain Node.js does not eagerly load
 * Electron-bound adapter graphs.
 */
function registerAll(): void {
  registerPlugin(QwenProviderPlugin)
  registerPlugin(GLMProviderPlugin)
}

registerAll()

const lazyPluginLoaders: Record<string, () => Promise<WebProviderPlugin | null>> = {
  deepseek: async () => (await import('./DeepSeekProviderPlugin.ts')).DeepSeekProviderPlugin,
  kimi: async () => (await import('./KimiProviderPlugin.ts')).KimiProviderPlugin,
  minimax: async () => (await import('./MiniMaxProviderPlugin.ts')).MiniMaxProviderPlugin,
  mimo: async () => (await import('./MimoProviderPlugin.ts')).MimoProviderPlugin,
  perplexity: async () => (await import('./PerplexityProviderPlugin.ts')).PerplexityProviderPlugin,
  qwenai: async () => (await import('./QwenAiProviderPlugin.ts')).QwenAiProviderPlugin,
  zai: async () => (await import('./ZaiProviderPlugin.ts')).ZaiProviderPlugin,
}

const lazyPluginPromises = new Map<string, Promise<void>>()

async function ensurePluginRegistered(id: string): Promise<void> {
  const normalized = id.toLowerCase()
  if (pluginMap.has(normalized)) return
  const loader = lazyPluginLoaders[normalized]
  if (!loader) return
  if (lazyPluginPromises.has(normalized)) return lazyPluginPromises.get(normalized)

  const promise = (async () => {
    try {
      const plugin = await loader()
      if (plugin && typeof plugin.id === 'string') {
        registerPlugin(plugin)
      }
    } catch {
      // Some provider adapters require Electron or browser-only globals.
      // Keep registry importable in Node test environments.
    }
  })()

  lazyPluginPromises.set(normalized, promise)
  return promise
}

/**
 * Find the first plugin whose matches() predicate accepts the given provider.
 */
export async function getPluginForProvider(provider: { id: string }): Promise<WebProviderPlugin | undefined> {
  for (const plugin of pluginMap.values()) {
    if (plugin.matches(provider)) {
      return plugin
    }
  }

  await ensurePluginRegistered(provider.id)
  const loaded = pluginMap.get(provider.id.toLowerCase())
  if (loaded?.matches(provider)) return loaded

  return undefined
}

/**
 * Synchronous variant for callers that know they're not looking for Perplexity.
 */
export function getPluginForProviderSync(provider: { id: string }): WebProviderPlugin | undefined {
  for (const plugin of pluginMap.values()) {
    if (plugin.matches(provider)) {
      return plugin
    }
  }
  return undefined
}

/**
 * Register a single plugin by id. Replaces any existing plugin with the same id.
 */
export function registerPlugin(plugin: WebProviderPlugin): void {
  pluginMap.set(plugin.id, plugin)
}

/**
 * Return a snapshot of all registered plugins.
 */
export function getAllPlugins(): WebProviderPlugin[] {
  return [...pluginMap.values()]
}
