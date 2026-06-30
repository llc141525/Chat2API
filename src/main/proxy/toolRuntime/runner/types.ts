import type { ToolCall } from '../../types.ts'
import type { NormalizedToolDefinition } from '../../toolCalling/types.ts'
import type { ToolPlan } from '../control/types.ts'
import type {
  MalformedToolIntent,
  ProtocolStructureResult,
  StructuralRepairResult,
  ToolRuntimeMappingInput,
  ToolValidationOutcome,
  ValidatedCallStructure,
} from '../data/types.ts'

export interface ModelInvocationResult {
  status: 'completed'
  rawOutput: string
}

export interface ToolTurnRunnerDeps {
  invokeModel(): Promise<ModelInvocationResult>
  extractStructure(rawOutput: string): ProtocolStructureResult
  validateStructure(protocolResult: ProtocolStructureResult): ToolValidationOutcome
  canRepair(intent: MalformedToolIntent | undefined, outcome: ToolValidationOutcome): boolean
  repairStructure(intent: MalformedToolIntent): StructuralRepairResult
  assembleToolCalls(validated: ValidatedCallStructure[], tools: NormalizedToolDefinition[]): ToolCall[]
  mapResponse(input: ToolRuntimeMappingInput): unknown
}

export interface ToolTurnRunnerInput {
  plan: ToolPlan
  tools: NormalizedToolDefinition[]
  deps: ToolTurnRunnerDeps
}

export type ToolTurnRunnerResult =
  | { status: 'success'; response: unknown }
  | { status: 'failed'; error: string }
