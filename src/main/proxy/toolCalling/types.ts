import type { ChatMessage, ChatCompletionTool, ToolCall } from '../types.ts'

export type ToolCallingMode = 'managed' | 'disabled'
export type DisabledReason =
  | 'mode_off'
  | 'tool_choice_none'
  | 'no_tools'
  | 'provider_not_supported'
  | 'no_tools_with_managed_history'
  | 'catalog_blocked'
export type ToolProtocolId =
  | 'openai_chat'
  | 'managed_bracket'
  | 'managed_xml'
  | 'anthropic_tool_use'
  | 'codex_responses'

export type ToolSource = 'openai' | 'mcp'

export interface NormalizedToolDefinition {
  name: string
  description?: string
  parameters: Record<string, unknown>
  source: ToolSource
}

export interface NormalizedToolCall {
  id: string
  index: number
  name: string
  arguments: string
  protocol: ToolProtocolId
  rawText?: string
}

export interface NormalizedToolResult {
  toolCallId: string
  name?: string
  content: string
}

export type ToolCatalogSource = 'current_request' | 'session_catalog' | 'restored_from_history' | 'none'

export type ToolCatalogDriftKind =
  | 'added_tool'
  | 'removed_tool'
  | 'schema_changed'
  | 'missing_current_tools_with_session_catalog'
  | 'missing_current_tools_without_catalog'
  | 'history_references_unknown_tool'
  | 'restored_from_history'

export interface ToolCatalogSnapshot {
  sessionId: string | null
  fingerprint: string
  tools: ReadonlyArray<NormalizedToolDefinition>
  allowedToolNames: ReadonlyArray<string>
  schemaHashes: Readonly<Record<string, string>>
  source: 'current_request' | 'session_catalog' | 'restored_from_history'
  createdTurnIndex: number
  updatedTurnIndex: number
}

export interface ToolCatalogDiagnostics {
  source: ToolCatalogSource
  fingerprint?: string
  driftKinds: ToolCatalogDriftKind[]
  blocked: boolean
  reason?: string
}

export interface ToolCallDiagnostics {
  requestId?: string
  clientAdapterId: string
  detectedClientType?: string
  providerId: string
  model?: string
  actualModel?: string
  toolSource: 'openai' | 'mcp' | 'none'
  mode: ToolCallingMode
  protocol: ToolProtocolId
  toolCount: number
  injected: boolean
  reason: string
  parserFormat?: ToolProtocolId | 'unknown'
  parsedToolCallCount?: number
  malformedReason?: string
  invalidToolNames?: string[]
  wrapperLeakDetected?: boolean
  toolChoiceMode?: 'auto' | 'none' | 'required' | 'forced'
  forcedToolName?: string
  allowedToolNames?: string[]
  catalogSource?: ToolCatalogSource
  catalogFingerprint?: string
  catalogDriftKinds?: ToolCatalogDriftKind[]
  catalogBlocked?: boolean
  availabilityDriftDetected?: boolean
  availabilityRetryResult?: 'skipped' | 'attempted' | 'succeeded' | 'failed'
}

export interface AvailabilityRetryRequest {
  type: 'availability_retry'
  catalogFingerprint: string
  clarification: string
}

export interface ToolCallingPlan {
  mode: ToolCallingMode
  protocol: ToolProtocolId
  clientAdapterId: string
  providerId: string
  tools: NormalizedToolDefinition[]
  shouldInjectPrompt: boolean
  shouldParseResponse: boolean
  toolChoiceMode: 'auto' | 'none' | 'required' | 'forced'
  allowedToolNames: Set<string>
  forcedToolName?: string
  catalogSnapshot?: ToolCatalogSnapshot
  catalogDiagnostics: ToolCatalogDiagnostics
  availabilityRetryAllowed: boolean
  availabilityRetryAttempted?: boolean
  diagnostics: ToolCallDiagnostics
}

export interface ToolCallingTransformResult {
  messages: ChatMessage[]
  tools?: ChatCompletionTool[]
  plan: ToolCallingPlan
}

export interface ToolParseContext {
  tools: NormalizedToolDefinition[]
  protocol: ToolProtocolId
}

export interface ToolParseResult {
  content: string
  toolCalls: ToolCall[]
  protocol: ToolProtocolId | 'unknown'
  rawMatches: string[]
  malformedReason?: string
  invalidToolNames: string[]
}
