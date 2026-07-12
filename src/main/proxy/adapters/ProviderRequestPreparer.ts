import type { RequestAssembly } from '../RequestAssembly.ts'

/** Options passed to the preparer by the forwarder (provider-specific) */
export interface ProviderRequestOptions {
  model: string
  originalModel?: string
  stream?: boolean
  temperature?: number
  [key: string]: unknown
}

/**
 * Interface that every provider adapter implements to build its API-specific
 * request body from a RequestAssembly.
 *
 * The adapter is the SINGLE POINT where tool contract text (from
 * assembly.toolManifest) joins conversation text (from assembly.messages).
 * No other module should be responsible for this assembly.
 */
export interface ProviderRequestPreparer {
  /** Build the API-specific request body */
  buildRequestBody(assembly: RequestAssembly, options: ProviderRequestOptions): unknown

  /** Build the API-specific messages array (if different from body) */
  buildMessages(assembly: RequestAssembly, options: ProviderRequestOptions): unknown[]
}
