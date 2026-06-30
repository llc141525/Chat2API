import type { ToolProtocolId } from '../../../toolCalling/types.ts'
import type { ProtocolStructureResult } from '../types.ts'

export interface ProtocolIntentDetection {
  matched: boolean
  partial: boolean
  markerStart?: number
}

export interface StructureProtocolAdapter {
  id: ToolProtocolId
  detectIntent(rawOutput: string): ProtocolIntentDetection
  extractStructure(rawOutput: string): ProtocolStructureResult
}
