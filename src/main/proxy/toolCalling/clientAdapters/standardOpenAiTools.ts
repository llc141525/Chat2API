import type { ChatCompletionRequest, ChatCompletionTool } from '../../types.ts'
import type { NormalizedToolDefinition } from '../types.ts'
import type { NormalizedClientToolRequest, NormalizedToolChoice, ToolClientAdapter } from './types.ts'
import { extractPromptEmbeddedTools } from './promptEmbeddedToolExtractor.ts'

export function normalizeOpenAiTools(
  tools: ChatCompletionTool[] | undefined,
  source: 'openai' | 'mcp',
): NormalizedToolDefinition[] {
  return (tools ?? [])
    .filter((tool) => tool.type === 'function' && Boolean(tool.function?.name))
    .map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters ?? {},
      source,
    }))
}

export function normalizeToolChoice(
  request: ChatCompletionRequest,
  toolNames: Set<string>,
): NormalizedToolChoice {
  const choice = request.tool_choice
  if (choice === 'none') return { mode: 'none' }
  if (choice === 'required') return { mode: 'required' }
  if (choice && typeof choice === 'object' && choice.type === 'function') {
    return { mode: 'forced', forcedName: choice.function.name }
  }
  if (toolNames.size === 1) return { mode: 'auto' }
  return { mode: 'auto' }
}

export const standardOpenAiToolsAdapter: ToolClientAdapter = {
  id: 'standard-openai-tools',
  displayName: 'Standard OpenAI Tools',
  normalizeRequest(request): NormalizedClientToolRequest {
    const openAiTools = normalizeOpenAiTools(request.tools, 'openai')

    if (openAiTools.length > 0) {
      const toolChoice = normalizeToolChoice(request, new Set(openAiTools.map((tool) => tool.name)))
      return {
        clientAdapterId: 'standard-openai-tools',
        toolSource: 'openai',
        tools: openAiTools,
        toolChoice,
        diagnostics: {
          rawToolCount: request.tools?.length ?? 0,
          normalizedToolNames: openAiTools.map((tool) => tool.name),
        },
      }
    }

    // No OpenAI tools — check if the client embedded its catalog in system prompt text
    const embedded = extractPromptEmbeddedTools(request.messages ?? [])
    if (embedded.tools.length > 0) {
      const toolChoice = normalizeToolChoice(request, new Set(embedded.tools.map((tool) => tool.name)))
      return {
        clientAdapterId: 'standard-openai-tools',
        toolSource: 'prompt_embedded',
        tools: embedded.tools,
        toolChoice,
        diagnostics: {
          rawToolCount: 0,
          normalizedToolNames: embedded.tools.map((tool) => tool.name),
          promptEmbeddedMarkers: embedded.markers,
          promptEmbeddedRawFingerprint: embedded.rawFingerprint,
        },
      }
    }

    const toolChoice = normalizeToolChoice(request, new Set<string>())
    return {
      clientAdapterId: 'standard-openai-tools',
      toolSource: 'none',
      tools: [],
      toolChoice,
      diagnostics: {
        rawToolCount: 0,
        normalizedToolNames: [],
      },
    }
  },
}
