import type { ChatMessage } from './types.ts'
import type { ToolManifest } from './toolCalling/ToolManifest.ts'

export interface AssemblyMetadata {
  contextManagementApplied: boolean
  strategiesExecuted: string[]
  originalMessageCount: number
  finalMessageCount: number
}

export interface RequestAssembly {
  /** Conversation messages (after context management, WITHOUT embedded tool contract strings) */
  messages: ChatMessage[]
  /** Authoritative tool contract for this turn, or null if no tools */
  toolManifest: ToolManifest | null
  /** Summary text if summary compaction occurred, null otherwise */
  summaryText: string | null
  /** Metadata for diagnostics */
  metadata: AssemblyMetadata
}

export interface BuildRequestAssemblyInput {
  messages: ChatMessage[]
  toolManifest: ToolManifest | null
  summaryText?: string | null
  contextResult?: {
    summaryGenerated?: boolean
    strategyResults?: Array<{ strategyName: string; trimmed: boolean }>
    originalCount: number
    finalCount: number
  }
}

export function buildRequestAssembly(input: BuildRequestAssemblyInput): RequestAssembly {
  const strategiesExecuted = input.contextResult?.strategyResults
    ?.filter(r => r.trimmed)
    .map(r => r.strategyName) ?? []

  return {
    messages: input.messages,
    toolManifest: input.toolManifest,
    summaryText: input.summaryText ?? null,
    metadata: {
      contextManagementApplied: input.contextResult?.summaryGenerated ?? false,
      strategiesExecuted,
      originalMessageCount: input.contextResult?.originalCount ?? input.messages.length,
      finalMessageCount: input.contextResult?.finalCount ?? input.messages.length,
    },
  }
}
