import crypto from 'crypto'
import type { NormalizedToolDefinition, ToolCatalogDriftKind } from '../types.ts'
import type { PromptEmbeddedMarkers } from './types.ts'

export interface PromptEmbeddedExtractionResult {
  tools: NormalizedToolDefinition[]
  source: 'prompt_embedded'
  markers: PromptEmbeddedMarkers
  driftKinds: ToolCatalogDriftKind[]
  rawFingerprint: string
}

interface ChatMessage {
  role: string
  content: unknown
}

const AVAILABLE_TOOLS_HEADER = '## Available Tools'
const MANAGED_PROTOCOL_MARKER = '<|CHAT2API|tool_calls>'
const MCP_TOOLS_OPEN = '<tools>'
const MCP_TOOLS_CLOSE = '</tools>'

// Matches: Tool `name`: description text
// Optionally followed by Required parameters line and JSON schema line
const TOOL_ENTRY_PATTERN = /Tool `([^`]+)`[^\n]*/g
const JSON_SCHEMA_PATTERN = /JSON schema:\s*(\{[\s\S]+?\})\s*(?=Tool `|$)/g

// Matches <tool name="x">...</tool> blocks
const MCP_TOOL_BLOCK_PATTERN = /<tool\s+name="([^"]+)">([\s\S]*?)<\/tool>/g
const MCP_DESCRIPTION_PATTERN = /<description>([\s\S]*?)<\/description>/
const MCP_PARAMETERS_PATTERN = /<parameters>([\s\S]*?)<\/parameters>/

const DEGRADED_SCHEMA: Record<string, unknown> = Object.freeze({
  type: 'object',
  additionalProperties: true,
})

export function extractPromptEmbeddedTools(messages: readonly ChatMessage[]): PromptEmbeddedExtractionResult {
  const textBlocks = collectTextBlocks(messages)

  const markers: PromptEmbeddedMarkers = {
    availableToolsHeader: false,
    managedProtocolHeader: false,
    mcpServerBlock: false,
  }

  let toolsFromAvailableTools: NormalizedToolDefinition[] = []
  let toolsFromMcpBlock: NormalizedToolDefinition[] = []

  for (const block of textBlocks) {
    if (!markers.availableToolsHeader && block.includes(AVAILABLE_TOOLS_HEADER)) {
      markers.availableToolsHeader = true
    }
    if (!markers.managedProtocolHeader && block.includes(MANAGED_PROTOCOL_MARKER)) {
      markers.managedProtocolHeader = true
    }
    if (!markers.mcpServerBlock && block.includes(MCP_TOOLS_OPEN) && block.includes(MCP_TOOLS_CLOSE)) {
      markers.mcpServerBlock = true
    }

    if (markers.availableToolsHeader && toolsFromAvailableTools.length === 0) {
      const extracted = extractFromAvailableToolsBlock(block)
      if (extracted.length > 0) toolsFromAvailableTools = extracted
    }

    if (markers.mcpServerBlock && toolsFromMcpBlock.length === 0) {
      const extracted = extractFromMcpBlock(block)
      if (extracted.length > 0) toolsFromMcpBlock = extracted
    }
  }

  const hasAnySignature = markers.availableToolsHeader || markers.mcpServerBlock

  if (!hasAnySignature) {
    return emptyResult(markers)
  }

  const mergedTools = deduplicateTools([...toolsFromAvailableTools, ...toolsFromMcpBlock])

  if (mergedTools.length === 0) {
    return emptyResult(markers)
  }

  const driftKinds: ToolCatalogDriftKind[] = ['prompt_embedded_only_catalog']
  const hasDegradedSchema = mergedTools.some(isDegradedSchema)
  if (hasDegradedSchema) {
    driftKinds.push('schema_degraded_from_prompt')
  }

  return {
    tools: mergedTools,
    source: 'prompt_embedded',
    markers,
    driftKinds,
    rawFingerprint: fingerprintTools(mergedTools),
  }
}

function collectTextBlocks(messages: readonly ChatMessage[]): string[] {
  const blocks: string[] = []
  for (const msg of messages) {
    if (msg.role !== 'system' && msg.role !== 'user') continue
    if (typeof msg.content === 'string') {
      blocks.push(msg.content)
    }
  }
  return blocks
}

function extractFromAvailableToolsBlock(text: string): NormalizedToolDefinition[] {
  const headerIndex = text.indexOf(AVAILABLE_TOOLS_HEADER)
  if (headerIndex < 0) return []

  const block = text.slice(headerIndex)

  // Build a lookup of tool name → schema by scanning for JSON schema lines
  const schemasByName = buildSchemaMap(block)

  const tools: NormalizedToolDefinition[] = []
  const seen = new Set<string>()

  const toolPattern = new RegExp(TOOL_ENTRY_PATTERN.source, 'g')
  for (const match of block.matchAll(toolPattern)) {
    const name = match[1].trim()
    if (!name || seen.has(name)) continue
    seen.add(name)

    const fullLine = match[0]
    const description = extractDescription(fullLine, name)
    const parameters = schemasByName.get(name) ?? { ...DEGRADED_SCHEMA }

    tools.push({
      name,
      description,
      parameters,
      source: 'prompt_embedded',
    })
  }

  return tools
}

function buildSchemaMap(block: string): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>()

  // Split by tool entry lines to associate schemas with names
  const lines = block.split('\n')
  let currentName: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const toolMatch = line.match(/^Tool `([^`]+)`/)
    if (toolMatch) {
      currentName = toolMatch[1].trim()
      continue
    }

    if (currentName && line.trim().startsWith('JSON schema:')) {
      const schemaStr = extractJsonSchemaFromLine(line, lines, i)
      if (schemaStr) {
        const parsed = tryParseSchema(schemaStr)
        if (parsed) {
          map.set(currentName, parsed)
        }
      }
    }
  }

  return map
}

function extractJsonSchemaFromLine(line: string, lines: string[], lineIndex: number): string | null {
  const schemaStart = line.indexOf('JSON schema:')
  if (schemaStart < 0) return null

  let schemaText = line.slice(schemaStart + 'JSON schema:'.length).trim()

  // May span multiple lines if the JSON object is multiline
  if (schemaText.startsWith('{')) {
    const openBraces = countChar(schemaText, '{') - countChar(schemaText, '}')
    if (openBraces <= 0) return schemaText

    for (let j = lineIndex + 1; j < Math.min(lineIndex + 20, lines.length); j++) {
      const nextLine = lines[j].trim()
      // Stop at next tool entry
      if (nextLine.startsWith('Tool `')) break
      schemaText += ' ' + nextLine
      const remaining = countChar(schemaText, '{') - countChar(schemaText, '}')
      if (remaining <= 0) break
    }
    return schemaText
  }

  return null
}

function extractFromMcpBlock(text: string): NormalizedToolDefinition[] {
  const start = text.indexOf(MCP_TOOLS_OPEN)
  if (start < 0) return []
  const end = text.indexOf(MCP_TOOLS_CLOSE, start)
  if (end < 0) return []

  const toolsBlock = text.slice(start, end + MCP_TOOLS_CLOSE.length)
  const tools: NormalizedToolDefinition[] = []
  const seen = new Set<string>()

  const blockPattern = new RegExp(MCP_TOOL_BLOCK_PATTERN.source, 'g')
  for (const match of toolsBlock.matchAll(blockPattern)) {
    const name = match[1].trim()
    if (!name || seen.has(name)) continue
    seen.add(name)

    const innerContent = match[2]
    const description = extractTagContent(innerContent, MCP_DESCRIPTION_PATTERN)?.trim() ?? ''
    const parametersText = extractTagContent(innerContent, MCP_PARAMETERS_PATTERN)?.trim()
    const parameters = parametersText ? (tryParseSchema(parametersText) ?? { ...DEGRADED_SCHEMA }) : { ...DEGRADED_SCHEMA }

    tools.push({
      name,
      description,
      parameters,
      source: 'prompt_embedded',
    })
  }

  return tools
}

function extractDescription(toolLine: string, toolName: string): string {
  // Line format: Tool `name`: description. Required parameters: x, y
  const afterName = toolLine.slice(toolLine.indexOf(`\`${toolName}\``) + toolName.length + 2)
  const afterColon = afterName.replace(/^:\s*/, '')
  // Strip "Required parameters: ..." suffix
  return afterColon.replace(/\s*\.\s*Required parameters:.*$/i, '').replace(/\.$/, '').trim()
}

function extractTagContent(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern)
  return match ? match[1] : null
}

function tryParseSchema(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text.trim())
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

function deduplicateTools(tools: NormalizedToolDefinition[]): NormalizedToolDefinition[] {
  const seen = new Set<string>()
  return tools.filter((tool) => {
    if (seen.has(tool.name)) return false
    seen.add(tool.name)
    return true
  })
}

function isDegradedSchema(tool: NormalizedToolDefinition): boolean {
  const params = tool.parameters as Record<string, unknown>
  return params.additionalProperties === true && !params.properties
}

function fingerprintTools(tools: NormalizedToolDefinition[]): string {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name))
  const payload = JSON.stringify(sorted.map((t) => ({ name: t.name, params: t.parameters })))
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

function emptyResult(markers: PromptEmbeddedMarkers): PromptEmbeddedExtractionResult {
  return {
    tools: [],
    source: 'prompt_embedded',
    markers,
    driftKinds: [],
    rawFingerprint: '',
  }
}

function countChar(str: string, char: string): number {
  let count = 0
  for (const c of str) {
    if (c === char) count++
  }
  return count
}
