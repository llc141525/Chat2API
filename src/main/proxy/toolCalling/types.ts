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

export type ToolSource = 'openai' | 'mcp' | 'prompt_embedded'

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

export type ToolCatalogSource = 'current_request' | 'session_catalog' | 'prompt_embedded' | 'restored_from_history' | 'none'

export type ToolContractSourceStep =
  | 'current_request'
  | 'session_catalog'
  | 'prompt_embedded'
  | 'message_history'
  | 'safe_empty'

export type ToolContractHistoryMode = 'openai_native' | 'managed_protocol'

export type EmptyOutputPolicy = 'diagnose_and_fail' | 'pass_through_without_tool_semantics'

export type ProviderTurnOutcome =
  | 'content'
  | 'tool_calls'
  | 'tool_availability_drift'
  | 'provider_empty'
  | 'malformed_tool_output'
  | 'runtime_suppressed_malformed_tool_output'
  | 'adapter_parse_error'
  | 'provider_error'

export type ToolValidationFailureKind =
  | 'unknown_tool_name'
  | 'invalid_required_fields'
  | 'arguments_not_object'
  | 'arguments_invalid_json'
  | 'malformed_container'
  | 'schema_validation_failed'
  | 'protocol_mismatch'
  | 'malformed_tool_output'

export type ToolSuppressedReason = 'invalid_tool_name' | 'malformed_tool_output'

export type ToolCatalogDriftKind =
  | 'added_tool'
  | 'removed_tool'
  | 'current_request_subset_of_session_catalog'
  | 'schema_changed'
  | 'missing_current_tools_with_session_catalog'
  | 'missing_current_tools_without_catalog'
  | 'history_references_unknown_tool'
  | 'restored_from_history'
  | 'prompt_embedded_only_catalog'
  | 'schema_degraded_from_prompt'

export interface ToolCatalogSnapshot {
  sessionId: string | null
  fingerprint: string
  tools: ReadonlyArray<NormalizedToolDefinition>
  allowedToolNames: ReadonlyArray<string>
  schemaHashes: Readonly<Record<string, string>>
  source: 'current_request' | 'session_catalog' | 'prompt_embedded' | 'restored_from_history'
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

export interface ToolTurnContract {
  turnId: string
  sessionId: string | null
  providerId: string
  model: string
  protocol: ToolProtocolId
  snapshotFingerprint: string | null
  tools: ReadonlyArray<NormalizedToolDefinition>
  allowedToolNames: ReadonlySet<string>
  toolChoiceMode: 'auto' | 'none' | 'required' | 'forced'
  forcedToolName?: string
  shouldInjectPrompt: boolean
  shouldParseResponse: boolean
  historyMode: ToolContractHistoryMode
  emptyOutputPolicy: EmptyOutputPolicy
  toolSourceChain: ReadonlyArray<ToolContractSourceStep>
}

export interface ToolCallDiagnostics {
  requestId?: string
  turnId?: string
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
  toolSourceChain?: ToolContractSourceStep[]
  terminalOutcome?: ProviderTurnOutcome
  emptyOutputPolicy?: EmptyOutputPolicy
  validationFailureKind?: ToolValidationFailureKind
  suppressedReason?: ToolSuppressedReason
  availabilityDriftDetected?: boolean
  availabilityRetryResult?: 'skipped' | 'attempted' | 'succeeded' | 'failed'
  deniedToolNames?: string[]
  mentionedUnavailableOnlyTools?: string[]
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
  contract: ToolTurnContract
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
