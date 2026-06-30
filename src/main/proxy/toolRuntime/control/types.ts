import type { ToolCallingConfig } from '../../../../shared/toolCalling.ts'
import type { ChatCompletionRequest } from '../../types.ts'
import type { NormalizedClientToolRequest } from '../../toolCalling/clientAdapters/types.ts'
import type { ProviderToolProfile } from '../../toolCalling/providerProfiles.ts'
import type { ToolProtocolId } from '../../toolCalling/types.ts'

export type ToolExecutionProfile =
  | 'disabled_passthrough'
  | 'native_passthrough'
  | 'managed_buffered_structural'

export type ToolRuntimeMode = 'disabled' | 'native' | 'managed'
export type StreamGateMode = 'pass_through' | 'full_buffer' | 'incremental_safe_buffer'
export type ToolParseMode = 'none' | 'selected_protocol_only'
export type ToolRepairMode = 'disabled' | 'deterministic_structural_repair'
export type ToolHistoryFormat = 'openai_native' | 'managed_protocol'

export interface ToolExecutionProfileSettings {
  mode: ToolRuntimeMode
  streamGateMode: StreamGateMode
  parseMode: ToolParseMode
  repairMode: ToolRepairMode
  historyFormat: ToolHistoryFormat
}

export interface ToolPlannerInput {
  request: ChatCompletionRequest
  providerProfile: ProviderToolProfile
  clientToolRequest: NormalizedClientToolRequest
  config: ToolCallingConfig
  requestId?: string
  actualModel?: string
}

export interface ToolPlanDiagnostics {
  requestId?: string
  providerId: string
  model?: string
  actualModel?: string
  profile: ToolExecutionProfile
  mode: ToolRuntimeMode
  protocol: ToolProtocolId | null
  reason: string
  toolCount: number
  toolChoiceMode: 'auto' | 'none' | 'required' | 'forced'
  forcedToolName?: string
  allowedToolNames: string[]
}

export interface ToolPlan {
  profile: ToolExecutionProfile
  protocol: ToolProtocolId | null
  allowedToolNames: string[]
  forcedToolName?: string
  diagnostics: ToolPlanDiagnostics
}

export type ToolOperation =
  | 'invoke_model'
  | 'gate_stream'
  | 'validate_structure'
  | 'repair_structure'
  | 'validate_repaired_structure'
  | 'assemble_tool_calls'
  | 'map_response'
  | 'delegate_error'

export type ToolControlPhase =
  | 'idle'
  | 'awaiting_operation_result'
  | 'terminal_success'
  | 'terminal_failure'

export interface ToolControlState {
  phase: ToolControlPhase
  step: ToolOperation | null
  repairAttempted: boolean
}

export type ToolOperationResultKind =
  | 'model_output'
  | 'plain_text'
  | 'valid_structure'
  | 'repaired_structure_text'
  | 'openai_tool_calls'
  | 'response_mapped'
  | 'error_delegated'

export type ToolOperationFailureKind =
  | 'invalid_structure_repairable'
  | 'invalid_structure_blocked'
  | 'structural_repair_failed'
  | 'assembly_failed'
  | 'mapping_failed'
  | 'model_error'
  | 'stream_error'

export type ToolEvent =
  | { type: 'start' }
  | { type: 'operation_succeeded'; resultKind: ToolOperationResultKind }
  | { type: 'operation_failed'; failureKind: ToolOperationFailureKind }

export type ToolControlReason =
  | 'started'
  | 'model_output_ready'
  | 'plain_text_ready'
  | 'valid_structure_ready'
  | 'repair_allowed'
  | 'repair_exhausted'
  | 'invalid_structure_blocked'
  | 'repair_completed'
  | 'repair_failed'
  | 'tool_calls_assembled'
  | 'response_completed'
  | 'model_error'
  | 'stream_error'
  | 'assembly_failed'
  | 'mapping_failed'
  | 'error_delegated'

export interface ToolTransition {
  nextState: ToolControlState
  nextOperation: ToolOperation | null
  reason: ToolControlReason
}
