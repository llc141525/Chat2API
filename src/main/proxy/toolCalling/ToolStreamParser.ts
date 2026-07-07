import type { ToolCallingPlan, ToolParseResult } from './types.ts'
import { getToolProtocol } from './protocols/index.ts'
import {
  assembleOpenAIToolCalls,
  getStructureProtocolAdapter,
  validateToolCallStructure,
  type ProtocolStructureResult,
} from '../toolRuntime/data/index.ts'

export interface ToolStreamObservation {
  rawContentLength: number
  emittedContentLength: number
  emittedToolCallCount: number
  suppressedMalformedToolOutput: boolean
  suppressedReason?: 'invalid_tool_name' | 'malformed_tool_output'
}

export class ToolStreamParser {
  private readonly plan: ToolCallingPlan
  private buffer = ''
  private isBufferingToolCall = false
  private emittedToolCall = false
  private nextToolCallIndex = 0
  private observation: ToolStreamObservation = {
    rawContentLength: 0,
    emittedContentLength: 0,
    emittedToolCallCount: 0,
    suppressedMalformedToolOutput: false,
  }

  constructor(plan: ToolCallingPlan) {
    this.plan = plan
  }

  push(content: string, baseChunk: any, includeRole: boolean = false): any[] {
    if (!content || !this.plan.shouldParseResponse) return []

    this.observation.rawContentLength += content.length
    this.buffer += content
    const chunks: any[] = []

    if (!this.isBufferingToolCall) {
      const markerStart = findMarkerStart(this.buffer, this.plan)
      if (markerStart.matched) {
        if (markerStart.index > 0) {
          const emitted = this.buffer.slice(0, markerStart.index)
          this.observation.emittedContentLength += emitted.length
          chunks.push(createContentChunk(baseChunk, emitted, includeRole))
        }
        this.buffer = this.buffer.slice(markerStart.index)
        this.isBufferingToolCall = true
      } else if (markerStart.partial) {
        if (markerStart.index > 0) {
          const emitted = this.buffer.slice(0, markerStart.index)
          this.observation.emittedContentLength += emitted.length
          chunks.push(createContentChunk(baseChunk, emitted, includeRole))
          this.buffer = this.buffer.slice(markerStart.index)
        }
        this.isBufferingToolCall = true
        return chunks
      } else {
        this.observation.emittedContentLength += this.buffer.length
        chunks.push(createContentChunk(baseChunk, this.buffer, includeRole))
        this.buffer = ''
        return chunks
      }
    }

    const parsed = parseBufferedToolCall(this.buffer, this.plan)
    if (parsed.toolCalls.length > 0) {
      for (const toolCall of parsed.toolCalls) {
        const indexedToolCall = {
          ...toolCall,
          index: this.nextToolCallIndex,
          id: toolCall.id || `call_${this.nextToolCallIndex}`,
        }
        this.nextToolCallIndex += 1
        this.observation.emittedToolCallCount += 1
        chunks.push(createToolCallChunk(baseChunk, indexedToolCall, includeRole && !this.emittedToolCall))
      }
      this.emittedToolCall = true
      this.isBufferingToolCall = false
      this.buffer = ''
      return chunks
    }

    if (parsed.invalidToolNames.length > 0 || parsed.rawMatches.length > 0) {
      this.observation.suppressedMalformedToolOutput = true
      this.observation.suppressedReason = parsed.invalidToolNames.length > 0
        ? 'invalid_tool_name'
        : 'malformed_tool_output'
      console.warn(
        `[ToolStreamParser] Dropping tool call buffer — invalid names: [${parsed.invalidToolNames.join(', ')}], ` +
        `allowed names: [${[...this.plan.allowedToolNames].join(', ')}], ` +
        `raw matches: ${parsed.rawMatches.length > 0}`,
      )
      this.isBufferingToolCall = false
      this.buffer = ''
    }

    return chunks
  }

  flush(baseChunk: any): any[] {
    if (!this.buffer) return []

    const parsed = parseBufferedToolCall(this.buffer, this.plan)
    if (parsed.toolCalls.length > 0) {
      const chunks = parsed.toolCalls.map((toolCall) => {
        const indexedToolCall = {
          ...toolCall,
          index: this.nextToolCallIndex,
          id: toolCall.id || `call_${this.nextToolCallIndex}`,
        }
        this.nextToolCallIndex += 1
        this.emittedToolCall = true
        this.observation.emittedToolCallCount += 1
        return createToolCallChunk(baseChunk, indexedToolCall, false)
      })
      this.buffer = ''
      this.isBufferingToolCall = false
      return chunks
    }

    if (parsed.invalidToolNames.length > 0 || parsed.rawMatches.length > 0 || this.isBufferingToolCall) {
      this.observation.suppressedMalformedToolOutput = true
      this.observation.suppressedReason = parsed.invalidToolNames.length > 0
        ? 'invalid_tool_name'
        : 'malformed_tool_output'
    }

    const shouldReleaseText = !this.emittedToolCall
    const text = this.buffer
    this.buffer = ''
    this.isBufferingToolCall = false
    if (shouldReleaseText) {
      this.observation.emittedContentLength += text.length
    }
    return shouldReleaseText ? [createContentChunk(baseChunk, text, false)] : []
  }

  hasEmittedToolCall(): boolean {
    return this.emittedToolCall
  }

  isBuffering(): boolean {
    return this.isBufferingToolCall
  }

  getObservation(): ToolStreamObservation {
    return {
      ...this.observation,
    }
  }
}

function parseBufferedToolCall(buffer: string, plan: ToolCallingPlan): ToolParseResult {
  if (plan.protocol === 'managed_xml') {
    const parsed = parseManagedXmlBufferedToolCall(buffer, plan)
    if (parsed) return parsed
  }

  const selected = getToolProtocol(plan.protocol)
  return selected.parse(buffer, { tools: plan.tools, protocol: plan.protocol })
}

function parseManagedXmlBufferedToolCall(buffer: string, plan: ToolCallingPlan): ToolParseResult | null {
  const adapter = getStructureProtocolAdapter(plan.protocol)
  const protocolResult = adapter.extractStructure(buffer)

  if (protocolResult.kind === 'no_intent') {
    return null
  }

  if (isUnterminated(protocolResult)) {
    return emptyParseResult(buffer, 'managed_xml')
  }

  const validation = validateToolCallStructure({
    plan: runtimePlanFromCallingPlan(plan),
    protocolResult,
    tools: plan.tools,
  })

  if (validation.status === 'valid_structure') {
    return {
      content: validation.cleanContent ?? '',
      toolCalls: assembleOpenAIToolCalls({
        validated: validation.validated,
        tools: plan.tools,
      }),
      protocol: 'managed_xml',
      rawMatches: protocolResult.kind === 'container' ? protocolResult.rawMatches : [],
      invalidToolNames: [],
    }
  }

  if (validation.status === 'invalid_structure') {
    return {
      content: buffer,
      toolCalls: [],
      protocol: 'managed_xml',
      rawMatches: protocolRawMatches(protocolResult, buffer),
      malformedReason: validation.failure.kind,
      invalidToolNames: validation.failure.kind === 'unknown_tool_name' && validation.failure.toolName
        ? [validation.failure.toolName]
        : [],
    }
  }

  return null
}

function emptyParseResult(buffer: string, protocol: ToolParseResult['protocol']): ToolParseResult {
  return {
    content: buffer,
    toolCalls: [],
    protocol,
    rawMatches: [],
    invalidToolNames: [],
  }
}

function isUnterminated(protocolResult: ProtocolStructureResult): boolean {
  return protocolResult.kind === 'malformed_container'
    && protocolResult.malformedIntent?.failureKind === 'unterminated_container'
}

function protocolRawMatches(protocolResult: ProtocolStructureResult, buffer: string): string[] {
  if (protocolResult.kind === 'container') return protocolResult.rawMatches
  if (protocolResult.kind === 'malformed_container') return [buffer]
  return []
}

function runtimePlanFromCallingPlan(plan: ToolCallingPlan) {
  return {
    profile: 'managed_buffered_structural' as const,
    protocol: plan.protocol,
    allowedToolNames: [...plan.allowedToolNames],
    forcedToolName: plan.forcedToolName,
    diagnostics: {
      providerId: plan.providerId,
      model: plan.diagnostics.model,
      actualModel: plan.diagnostics.actualModel,
      profile: 'managed_buffered_structural' as const,
      mode: 'managed' as const,
      protocol: plan.protocol,
      reason: plan.diagnostics.reason,
      toolCount: plan.tools.length,
      toolChoiceMode: plan.toolChoiceMode,
      forcedToolName: plan.forcedToolName,
      allowedToolNames: [...plan.allowedToolNames],
    },
  }
}

function findMarkerStart(buffer: string, plan: ToolCallingPlan): { matched: boolean; partial: boolean; index: number } {
  const protocol = getToolProtocol(plan.protocol)
  const ranges = fencedRanges(buffer)
  let partialIndex = -1

  for (let index = 0; index < buffer.length; index += 1) {
    if (isInsideRange(index, ranges)) continue

    const suffix = buffer.slice(index)
    const detection = protocol.detectStart(suffix)
    if (detection.matched && detection.markerStart === 0) {
      return { matched: true, partial: false, index }
    }
    if (detection.partial && detection.markerStart === 0 && partialIndex === -1) {
      partialIndex = index
    }
  }

  return partialIndex === -1
    ? { matched: false, partial: false, index: -1 }
    : { matched: false, partial: true, index: partialIndex }
}

function fencedRanges(content: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  const pattern = /```[\s\S]*?```/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }

  return ranges
}

function isInsideRange(index: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => index >= range.start && index < range.end)
}

function createContentChunk(baseChunk: any, content: string, includeRole: boolean): any {
  return {
    ...baseChunk,
    choices: [{
      index: 0,
      delta: {
        ...(includeRole ? { role: 'assistant' } : {}),
        content,
      },
      finish_reason: null,
    }],
  }
}

function createToolCallChunk(baseChunk: any, toolCall: any, includeRole: boolean): any {
  const { rawText, ...openAiToolCall } = toolCall
  void rawText

  return {
    ...baseChunk,
    choices: [{
      index: 0,
      delta: {
        ...(includeRole ? { role: 'assistant' } : {}),
        tool_calls: [openAiToolCall],
      },
      finish_reason: null,
    }],
  }
}
