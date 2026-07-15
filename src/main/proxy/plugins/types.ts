/**
 * Provider Plugin System — Normalized Runtime Types
 *
 * Node F Phase 1: interface extraction without behavior change.
 * These types define the contract between ProviderRuntime (future) and
 * WebProviderPlugin implementations.
 */

import type { Provider, Account } from '../../store/types.ts'
import type { RequestAssembly } from '../RequestAssembly.ts'
import type { PromptRefreshMode } from '../promptBudgetPolicy.ts'
import type { ProxyContext } from '../types.ts'
import type { ToolCallingPlan } from '../toolCalling/types.ts'

// ── Plugin identity ────────────────────────────────────────────────

export interface ProviderPluginCapabilities {
  supportsProviderSession: boolean
  supportsParentMessageId: boolean
  supportsDeleteSession: boolean
  supportsStreaming: boolean
  supportsNonStreaming: boolean
  supportsNativeTools: boolean
  preferredManagedProtocol: 'managed_xml' | 'managed_bracket' | 'native' | 'none'
  sessionIdKind: 'session_id' | 'conversation_id' | 'chat_id' | 'request_id' | 'none'
  transport: 'openai_chat_completions' | 'provider_chat_api' | 'grpc_web_stream' | 'polling_stream' | 'websocket' | 'unknown'
}

// ── Request / response normalization ────────────────────────────────

export interface ProviderRuntimeRequest {
  provider: Provider
  account: Account
  model: string
  originalModel?: string
  assembly: RequestAssembly
  promptRefreshMode?: PromptRefreshMode
  sessionBoundaryReason?: ProxyContext['sessionBoundaryReason']
  messages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: unknown[] }>
  stream?: boolean
  temperature?: number
  sessionId?: string
  parentReqId?: string
  enableThinking?: boolean
  enableWebSearch?: boolean
}

export interface ProviderWebRequest {
  url: string
  method: 'POST' | 'GET'
  headers: Record<string, string>
  body: unknown
  sessionId: string
  reqId: string
  transportOptions?: {
    responseType?: 'stream' | 'json'
    timeout?: number
    decompress?: boolean
    validateStatus?: () => boolean
  }
}

export interface ProviderWebResponse {
  status: number
  headers: Record<string, string>
  data: unknown
}

export interface ProviderRuntimeResult {
  sessionId: string
  reqId: string
  response: ProviderWebResponse
}

export interface ProviderRuntimeStreamInput {
  response: ProviderWebResponse
  rawResponse?: unknown
  model: string
  toolCallingPlan?: ToolCallingPlan
}

// ── Stream events ───────────────────────────────────────────────────

export interface ToolCallDelta {
  index: number
  id?: string
  function?: {
    name?: string
    arguments?: string
  }
}

export type ProviderRuntimeEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_delta'; call: ToolCallDelta }
  | { type: 'session_update'; sessionId?: string; parentId?: string }
  | { type: 'done'; finishReason?: string }
  | { type: 'error'; error: ProviderRuntimeError }

// ── Error classification ────────────────────────────────────────────

export interface ProviderRuntimeError {
  status: number
  code: string
  message: string
  retryable: boolean
  classified: boolean
}

// ── Session management ──────────────────────────────────────────────

export interface ProviderDeleteSessionInput {
  sessionId: string
  provider: Provider
  account: Account
}

export interface ProviderDeleteSessionResult {
  success: boolean
}
