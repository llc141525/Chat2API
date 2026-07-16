import type { NormalizedToolDefinition, NormalizedToolResult, ToolParseResult, ToolProtocolId } from '../types.ts'
import type { ToolProtocolDetection } from './base.ts'
import type { ToolCall } from '../../types.ts'

export function detectMarkers(buffer: string, markers: string[]): ToolProtocolDetection {
  let earliest = -1
  for (const marker of markers) {
    const index = buffer.indexOf(marker)
    if (index !== -1 && (earliest === -1 || index < earliest)) {
      earliest = index
    }
  }

  if (earliest !== -1) {
    return { matched: true, partial: false, markerStart: earliest }
  }

  for (let index = 0; index < buffer.length; index += 1) {
    const suffix = buffer.slice(index)
    if (markers.some((marker) => marker.startsWith(suffix))) {
      return { matched: false, partial: true, markerStart: index }
    }
  }

  return { matched: false, partial: false }
}

export function stripFencedCodeBlocks(content: string): string {
  return content.replace(/```[\s\S]*?```/g, '')
}

export function toolNames(tools: NormalizedToolDefinition[]): Set<string> {
  return new Set(tools.map((tool) => tool.name))
}

export function createParseResult(input: {
  content: string
  toolCalls: ToolCall[]
  protocol: ToolProtocolId | 'unknown'
  rawMatches: string[]
  invalidToolNames?: string[]
  malformedReason?: string
}): ToolParseResult {
  return {
    content: input.content,
    toolCalls: input.toolCalls,
    protocol: input.protocol,
    rawMatches: input.rawMatches,
    malformedReason: input.malformedReason,
    invalidToolNames: input.invalidToolNames ?? [],
  }
}

export function buildToolCall(
  id: string,
  index: number,
  name: string,
  args: string,
  rawText?: string,
  tools: NormalizedToolDefinition[] = [],
): ToolCall {
  const normalizedArgs = normalizeArguments(args)
  const repairedArgs = repairArgumentsForSchema(name, normalizedArgs, tools)

  return {
    id,
    index,
    type: 'function',
    function: {
      name,
      arguments: repairedArgs,
    },
    ...(rawText ? { rawText } : {}),
  } as ToolCall
}

export function tryParseObjectArguments(rawArguments: string): { ok: true; argumentsText: string } | { ok: false; reason: string } {
  try {
    const parsed = JSON.parse(rawArguments)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'arguments_not_object' }
    }
    return { ok: true, argumentsText: JSON.stringify(parsed) }
  } catch {
    return { ok: false, reason: 'arguments_invalid_json' }
  }
}

export function normalizeArguments(args: unknown): string {
  if (typeof args === 'string') {
    const trimmed = args.trim()
    if (!trimmed) return '{}'
    try {
      return JSON.stringify(JSON.parse(trimmed))
    } catch {
      // Try to fix common Qwen JSON errors:
      // 1. Comma-separated objects missing array brackets: {"a":1}, {"b":2} -> [{"a":1}, {"b":2}]
      if (trimmed.startsWith('{') && trimmed.includes('},')) {
        try {
          return JSON.stringify(JSON.parse(`[${trimmed}]`))
        } catch { /* fall through */ }
      }
      // 2. Trailing comma in arrays/objects
      if (trimmed.endsWith(',}') || trimmed.endsWith(',]')) {
        try {
          return JSON.stringify(JSON.parse(trimmed.slice(0, -2) + trimmed.slice(-1)))
        } catch { /* fall through */ }
      }

      return trimmed
    }
  }

  return JSON.stringify(args ?? {})
}

export function parseJsonValue(value: string): unknown {
  const trimmed = unwrapCdata(value).trim()
  if (!trimmed) return ''

  try {
    return JSON.parse(trimmed)
  } catch {
    // Try to fix common model JSON errors:
    if (trimmed.startsWith('{') && trimmed.includes('},')) {
      try { return JSON.parse(`[${trimmed}]`) } catch { /* ok */ }
    }
    if (trimmed.endsWith(',}') || trimmed.endsWith(',]')) {
      try { return JSON.parse(trimmed.slice(0, -2) + trimmed.slice(-1)) } catch { /* ok */ }
    }
    return decodeXml(trimmed)
  }
}

export function unwrapCdata(value: string): string {
  const cdata = value.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/)
  return cdata ? cdata[1] : value
}

export function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

export function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function addParameter(target: Record<string, unknown>, name: string, value: unknown): void {
  const existing = target[name]
  if (existing === undefined) {
    target[name] = value
  } else if (Array.isArray(existing)) {
    target[name] = [...existing, value]
  } else {
    target[name] = [existing, value]
  }
}

export function repairArgumentsForSchema(
  toolName: string,
  args: string,
  tools: NormalizedToolDefinition[],
): string {
  const tool = tools.find((candidate) => candidate.name === toolName)
  if (!tool) return args

  const parsed = safeParseObject(args)
  if (!parsed) return args

  const parameters = tool.parameters ?? {}
  const properties = isRecord(parameters.properties) ? parameters.properties : {}
  let repaired: Record<string, unknown> = { ...parsed }

  for (const [name, schema] of Object.entries(properties)) {
    if (!isRecord(schema)) continue
    if (schema.type === 'array' && repaired[name] !== undefined && !Array.isArray(repaired[name])) {
      repaired = { ...repaired, [name]: [repaired[name]] }
    }
    // Coerce string values to number/integer when schema expects a number
    if ((schema.type === 'number' || schema.type === 'integer') && typeof repaired[name] === 'string') {
      const trimmed = (repaired[name] as string).trim()
      if (trimmed && !isNaN(Number(trimmed))) {
        repaired = { ...repaired, [name]: schema.type === 'integer' ? Math.floor(Number(trimmed)) : Number(trimmed) }
      }
    }
    // Coerce "true"/"false" strings to boolean when schema expects boolean
    if (schema.type === 'boolean' && typeof repaired[name] === 'string') {
      const lower = (repaired[name] as string).trim().toLowerCase()
      if (lower === 'true') repaired = { ...repaired, [name]: true }
      else if (lower === 'false') repaired = { ...repaired, [name]: false }
    }
  }

  const required = Array.isArray(parameters.required) ? parameters.required : []
  if (
    required.includes('prompt')
    && repaired.prompt === undefined
    && typeof repaired.description === 'string'
    && repaired.description.trim()
  ) {
    repaired = { ...repaired, prompt: repaired.description }
  }

  return JSON.stringify(repaired)
}

function safeParseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function renderToolList(tools: NormalizedToolDefinition[]): string {
  return tools
    .map((tool) => {
      const parameters = JSON.stringify(tool.parameters ?? {})
      const required = (tool.parameters as any)?.required
      const requiredStr = (Array.isArray(required) && required.length > 0)
        ? `\n  Required parameters: ${required.join(', ')}`
        : ''
      return `Tool \`${tool.name}\`: ${tool.description || 'No description'}.${requiredStr}\n  JSON schema: ${parameters}`
    })
    .join('\n')
}

export function genericToolResultBlock(result: NormalizedToolResult): string {
  return `[TOOL_RESULT for ${result.toolCallId}] ${result.content}`
}
