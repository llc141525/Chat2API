import type { ChatCompletionResponse, ToolCall } from '../../types.ts'
import type { ToolProtocolId, NormalizedToolDefinition } from '../../toolCalling/types.ts'
import type { ToolPlan } from '../control/types.ts'
import type { StreamGateMode } from '../control/types.ts'

export type PayloadEncoding = 'cdata' | 'text' | 'json_text'

export interface TextSpan {
  start: number
  end: number
}

export interface ExtractedParameterStructure {
  rawName: string
  rawPayload: string
  payloadEncoding: PayloadEncoding
  rawSpan: TextSpan
}

export interface ExtractedCallStructure {
  callIndex: number
  rawToolName: string
  rawParameters: ExtractedParameterStructure[]
  rawSpan: TextSpan
}

export type ProtocolContainerWarningKind =
  | 'foreign_protocol_marker'
  | 'missing_container_close'
  | 'missing_invoke_close'
  | 'missing_parameter_close'
  | 'malformed_parameter'
  | 'fenced_example'

export interface ProtocolContainerWarning {
  kind: ProtocolContainerWarningKind
  marker?: string
  span?: TextSpan
}

export type StructuralContainerFailureKind =
  | 'mixed_protocol_container'
  | 'unterminated_container'
  | 'malformed_container'
  | 'malformed_argument_container'
  | 'argument_payload_not_extractable'
  | 'fenced_example'
  | 'no_tool_intent'

export interface MalformedToolIntent {
  selectedProtocol: ToolProtocolId
  toolName: string
  parameters: Array<{
    name: string
    rawPayload: string
    payloadEncoding: PayloadEncoding
  }>
  rawContainerFingerprint: string
  failureKind: StructuralContainerFailureKind
}

export type ProtocolStructureResult =
  | {
      kind: 'no_intent'
      protocol: ToolProtocolId
      content: string
    }
  | {
      kind: 'container'
      protocol: ToolProtocolId
      extractedCalls: ExtractedCallStructure[]
      rawMatches: string[]
      cleanContent: string
      warnings: ProtocolContainerWarning[]
    }
  | {
      kind: 'malformed_container'
      protocol: ToolProtocolId
      warnings: ProtocolContainerWarning[]
      malformedIntent?: MalformedToolIntent
      rawOutputFingerprint: string
    }

export type ToolStructureFailureKind =
  | 'mixed_protocol_container'
  | 'unterminated_container'
  | 'malformed_container'
  | 'malformed_argument_container'
  | 'argument_payload_not_extractable'
  | 'unknown_tool_name'
  | 'schema_validation_failed'
  | 'fenced_example'
  | 'no_tool_intent'

export interface ToolStructureFailure {
  kind: ToolStructureFailureKind
  selectedProtocol: ToolProtocolId | null
  detail: string
  toolName?: string
}

export interface ValidatedParameterStructure {
  name: string
  rawPayload: string
  payloadEncoding: PayloadEncoding
}

export interface ValidatedCallStructure {
  callIndex: number
  toolName: string
  parameters: ValidatedParameterStructure[]
}

export type StructuralRepairResult =
  | {
      status: 'repaired'
      protocol: ToolProtocolId
      repairedText: string
      method: 'deterministic_rewrap'
    }
  | {
      status: 'not_repairable'
      reason: string
    }

export interface ToolCallAssemblerInput {
  validated: ValidatedCallStructure[]
  tools: NormalizedToolDefinition[]
}

export type EscapedRangeClassification = 'plain_text' | 'unknown'

export interface StreamGateFacts {
  mode: StreamGateMode
  hasEscapedToClient: boolean
  escapedRanges: Array<{
    start: number
    end: number
    classification: EscapedRangeClassification
  }>
  detectedMarkers: Array<{
    protocol: ToolProtocolId
    marker: string
    offset: number
    confidence: 'partial' | 'full'
  }>
  bufferedRawOutput: string
}

export interface StreamGateState {
  mode: StreamGateMode
  buffer: string
  releasedLength: number
  escapedRanges: StreamGateFacts['escapedRanges']
}

export interface StreamGateUpdate {
  state: StreamGateState
  releasedChunks: string[]
}

export interface StreamGateFinishResult {
  rawOutput: string
  facts: StreamGateFacts
  releasedChunks: string[]
}

export type ToolRuntimeMappingInput =
  | { kind: 'valid_tool_calls'; toolCalls: ToolCall[] }
  | { kind: 'plain_text'; content: string }
  | { kind: 'blocked_malformed'; safeMessage: string }

export interface OpenAIResponseMapperInput {
  id: string
  model: string
  created: number
  input: ToolRuntimeMappingInput
}

export type OpenAIStreamChunk = ChatCompletionResponse

export type ToolValidationOutcome =
  | {
      status: 'valid_structure'
      validated: ValidatedCallStructure[]
      cleanContent: string | null
    }
  | {
      status: 'plain_text'
      content: string
    }
  | {
      status: 'invalid_structure'
      failure: ToolStructureFailure
      malformedIntent?: MalformedToolIntent
    }

export interface ToolCallValidatorInput {
  plan: ToolPlan
  protocolResult: ProtocolStructureResult
  tools: NormalizedToolDefinition[]
}
