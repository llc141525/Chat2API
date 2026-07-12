/**
 * Shared helper for assembling flat-text prompts from separated components.
 *
 * Used by provider adapters that flatten all semantic information into a single
 * text blob (Qwen, GLM, etc.) rather than sending structured messages arrays.
 *
 * The template controls where the tool contract and summary appear relative to
 * the conversation:
 * - 'prefix': tools/summary come before conversation (Qwen style)
 * - 'suffix': tools come after conversation (GLM style)
 */

export type PromptTemplate = 'prefix' | 'suffix'

export interface RenderFinalPromptInput {
  /** Base system instructions extracted from system-role messages */
  systemText: string | null
  /** Summary text from context compaction, or null */
  summaryText: string | null
  /** Rendered tool contract prompt from ToolManifest, or null */
  toolContractText: string | null
  /** Flattened conversation (user/assistant/tool messages) */
  conversationText: string
  /** Where to place tool contract and summary */
  template: PromptTemplate
  /** Separator between sections, defaults to '\n\n' */
  separator?: string
}

export function renderFinalPrompt(input: RenderFinalPromptInput): string {
  const sep = input.separator ?? '\n\n'

  const sections: string[] = []

  // System text always comes first if present
  if (input.systemText) {
    sections.push(input.systemText)
  }

  if (input.template === 'prefix') {
    // Summary (non-authoritative narrative)
    if (input.summaryText) {
      sections.push(input.summaryText)
    }
    // Tool contract (authoritative, after summary to take precedence)
    if (input.toolContractText) {
      sections.push(input.toolContractText)
    }
    // Conversation
    if (input.conversationText.length > 0) {
      sections.push(input.conversationText)
    }
  } else {
    // suffix: conversation first, then summary, then tools
    if (input.summaryText) {
      sections.push(input.summaryText)
    }
    if (input.conversationText.length > 0) {
      sections.push(input.conversationText)
    }
    if (input.toolContractText) {
      sections.push(input.toolContractText)
    }
  }

  return sections.filter(Boolean).join(sep)
}
