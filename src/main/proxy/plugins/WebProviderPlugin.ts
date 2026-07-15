/**
 * WebProviderPlugin Interface
 *
 * Node F: the contract between ProviderRuntime and provider-specific web protocols.
 *
 * Phase 1: define the interface + wrap one existing adapter.
 * Phase 2+: ProviderRuntime takes over common lifecycle; plugins shrink to web-only.
 */

import type {
  ProviderPluginCapabilities,
  ProviderRuntimeRequest,
  ProviderWebRequest,
  ProviderWebResponse,
  ProviderRuntimeResult,
  ProviderRuntimeStreamInput,
  ProviderRuntimeEvent,
  ProviderRuntimeError,
  ProviderDeleteSessionInput,
  ProviderDeleteSessionResult,
} from './types.ts'

export type {
  ProviderPluginCapabilities,
  ProviderRuntimeRequest,
  ProviderWebRequest,
  ProviderWebResponse,
  ProviderRuntimeResult,
  ProviderRuntimeStreamInput,
  ProviderRuntimeEvent,
  ProviderRuntimeError,
  ProviderDeleteSessionInput,
  ProviderDeleteSessionResult,
} from './types.ts'

export interface WebProviderPlugin {
  /** Stable plugin identifier, e.g. "qwen", "glm" */
  readonly id: string

  /** Semantic version */
  readonly version: string

  /** Whether this plugin handles the given provider */
  matches(provider: { id: string }): boolean

  /** Declared capabilities (used by ProviderRuntime for policy decisions) */
  readonly capabilities: ProviderPluginCapabilities

  /**
   * Build a provider-web request from normalized input.
   * Phase 1: delegates internally to the existing adapter.
   */
  buildRequest(input: ProviderRuntimeRequest): Promise<ProviderWebRequest>

  /**
   * Parse a non-streaming provider-web response into normalized result.
   * Phase 1: wraps existing adapter non-stream path.
   */
  parseNonStream(input: ProviderWebResponse): Promise<ProviderRuntimeResult>

  /**
   * Parse a streaming provider-web response into normalized events.
   * Optional — only providers that support streaming.
   * Phase 1: wraps existing adapter stream handler.
   */
  parseStream?(input: ProviderRuntimeStreamInput): AsyncIterable<ProviderRuntimeEvent>

  /**
   * Delete a provider-side conversation session.
   * Optional — only providers that expose session deletion.
   */
  deleteSession?(input: ProviderDeleteSessionInput): Promise<ProviderDeleteSessionResult>

  /**
   * Classify a provider-specific error into a normalized shape.
   * Optional — falls back to generic classification when absent.
   */
  classifyError?(error: unknown): ProviderRuntimeError
}
