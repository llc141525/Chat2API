import type { ChatCompletionRequest } from '../../types.ts'
import type { NormalizedToolDefinition } from '../types.ts'
import type { ToolClientAdapterId } from '../../../../shared/toolCalling.ts'

export interface NormalizedToolChoice {
  mode: 'auto' | 'none' | 'required' | 'forced'
  forcedName?: string
}

export interface PromptEmbeddedMarkers {
  availableToolsHeader: boolean
  managedProtocolHeader: boolean
  mcpServerBlock: boolean
}

export interface NormalizedClientToolRequest {
  clientAdapterId: string
  toolSource: 'openai' | 'mcp' | 'prompt_embedded' | 'none'
  tools: NormalizedToolDefinition[]
  toolChoice: NormalizedToolChoice
  diagnostics: {
    requestedClientAdapterId?: string
    fallbackClientAdapterId?: string
    detectedClientType?: string
    rawToolCount: number
    normalizedToolNames: string[]
    promptEmbeddedMarkers?: PromptEmbeddedMarkers
    promptEmbeddedRawFingerprint?: string
    clientSignature?: string
  }
}

export interface ToolClientAdapter {
  id: ToolClientAdapterId
  displayName: string
  normalizeRequest(request: ChatCompletionRequest): NormalizedClientToolRequest
}
