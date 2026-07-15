import type { ToolProtocolId, NormalizedToolDefinition } from './types.ts'

export interface ToolActionConstraint {
  kind: 'first_skill_required' | 'terminal_final_text_required'
  toolName: 'skill' | null
  arguments: {
    name?: string
    exactText?: string
  }
  reason: string
}

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
  /** High-priority one-turn tool action constraint, when active */
  actionConstraint?: ToolActionConstraint | null
}

export interface CreateToolManifestInput {
  protocol: ToolProtocolId
  catalogFingerprint: string
  allowedToolNames: string[]
  tools: NormalizedToolDefinition[]
  renderedPrompt: string
  contractHeaderVersion: number
  actionConstraint?: ToolActionConstraint | null
}

export function createToolManifest(input: CreateToolManifestInput): ToolManifest {
  return {
    protocol: input.protocol,
    catalogFingerprint: input.catalogFingerprint,
    allowedToolNames: Array.from(new Set(input.allowedToolNames)),
    tools: input.tools.map(t => ({ ...t })),
    renderedPrompt: input.renderedPrompt,
    contractHeaderVersion: input.contractHeaderVersion,
    actionConstraint: input.actionConstraint
      ? {
          ...input.actionConstraint,
          arguments: { ...input.actionConstraint.arguments },
        }
      : null,
  }
}
