import type { ToolProtocolId, NormalizedToolDefinition } from './types.ts'

export interface ToolManifest {
  /** Protocol used to render the prompt (managed_xml, managed_bracket, etc.) */
  protocol: ToolProtocolId
  /** Fingerprint of the tool catalog used to generate this manifest */
  catalogFingerprint: string
  /** List of tool names allowed in this turn */
  allowedToolNames: string[]
  /** The normalized tool definitions */
  tools: NormalizedToolDefinition[]
  /** Pre-rendered prompt text for the whole tool section (header + definitions) */
  renderedPrompt: string
  /** Contract header version from provider profile */
  contractHeaderVersion: number
}

export interface CreateToolManifestInput {
  protocol: ToolProtocolId
  catalogFingerprint: string
  allowedToolNames: string[]
  tools: NormalizedToolDefinition[]
  renderedPrompt: string
  contractHeaderVersion: number
}

export function createToolManifest(input: CreateToolManifestInput): ToolManifest {
  return {
    protocol: input.protocol,
    catalogFingerprint: input.catalogFingerprint,
    allowedToolNames: Array.from(new Set(input.allowedToolNames)),
    tools: input.tools.map(t => ({ ...t })),
    renderedPrompt: input.renderedPrompt,
    contractHeaderVersion: input.contractHeaderVersion,
  }
}
