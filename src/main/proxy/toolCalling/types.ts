import type { ChatMessage, ChatCompletionTool, ToolCall } from '../types.ts'

export type ToolCallingMode = 'managed' | 'disabled'
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
  diagnostics: ToolCallDiagnostics
  /** Snapshot of the tool catalog used to build this plan (Phase 2+). */
  catalogSnapshot?: { fingerprint: string }
}

export interface ToolCallingTransformResult {
  messages: ChatMessage[]
  tools?: ChatCompletionTool[]
  plan: ToolCallingPlan
  /** Tool manifest for provider adapters (Phase 2+). Present when shouldInjectPrompt is true. */
  toolManifest?: import('./ToolManifest.ts').ToolManifest
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
