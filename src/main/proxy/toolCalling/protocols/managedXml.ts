import type { ToolProtocolAdapter } from './base.ts'
import type { ToolParseContext } from '../types.ts'
import {
  addParameter,
  buildToolCall,
  createParseResult,
  detectMarkers,
  escapeXmlAttribute,
  parseJsonValue,
  renderToolList,
  stripFencedCodeBlocks,
  toolNames,
} from './shared.ts'

const CHAT2API_START = '<|CHAT2API|tool_calls>'
const CHAT2API_END = '</|CHAT2API|tool_calls>'
const XML_START = '<tool_calls>'

export const managedXmlProtocol: ToolProtocolAdapter = {
  id: 'managed_xml',

  renderPrompt(tools) {
    return `## Available Tools
You can invoke the following developer tools. Tool names are case-sensitive.
The tool list in this section is authoritative for the current turn.
Use only the exact tool names listed below. Do not rename, camelCase, translate, shorten, or invent tool names.
Include ALL required parameters listed in the JSON schema for each tool.
Do not claim that a listed tool is unavailable. If a listed tool is needed, call it directly.

${renderToolList(tools)}

When calling tools, respond with only this Chat2API XML block:

<|CHAT2API|tool_calls><|CHAT2API|invoke name="exact_tool_name"><|CHAT2API|parameter name="argument"><![CDATA[value]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>

Tool results will be provided as Chat2API XML result blocks:

<|CHAT2API|tool_result tool_call_id="call_id"><![CDATA[result]]></|CHAT2API|tool_result>`
  },

  detectStart(buffer) {
    return detectMarkers(buffer, [CHAT2API_START, XML_START, '<|CHAT2API|invoke'])
  },

  parse(content: string, context: ToolParseContext) {
    const parseable = stripFencedCodeBlocks(content)
    const allowedNames = toolNames(context.tools)
    const rawMatches: string[] = []
    const invalidToolNames: string[] = []
    const toolCalls: ReturnType<typeof buildToolCall>[] = []

    parseBlocks(parseable, {
      blockPattern: /<\|CHAT2API\|tool_calls>([\s\S]*?)<\/\|CHAT[^|]*\|tool_calls>/g,
      invokePattern: /<\|CHAT2API\|invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/\|CHAT[^|]*\|invoke>/g,
      parameterPattern: /<\|CHAT2API\|parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/(?:\|CHAT[^|]*\|)?parameter>/g,
      fallbackParameterPatterns: [
        /<parameter\s*=\s*"?([^"">\s]+)"?\s*>([\s\S]*?)<\/parameter>/gi,
      ],
      rawMatches,
      invalidToolNames,
      allowedNames,
      tools: context.tools,
      toolCalls,
    })

    parseBlocks(parseable, {
      blockPattern: /<tool_calls>([\s\S]*?)<\/tool_calls>/g,
      invokePattern: /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g,
      parameterPattern: /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/g,
      rawMatches,
      invalidToolNames,
      allowedNames,
      tools: context.tools,
      toolCalls,
    })

    // Also parse standalone <|CHAT2API|invoke> blocks without outer <|CHAT2API|tool_calls> wrapper
    const unmatchedContent = rawMatches.reduce((acc, raw) => acc.replace(raw, ''), parseable)
    parseBlocks(unmatchedContent, {
      blockPattern: /(<\|CHAT2API\|invoke\s+name="[^"]+"\s*>[\s\S]*?<\/\|CHAT[^|]*\|invoke>)/g,
      invokePattern: /<\|CHAT2API\|invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/\|CHAT[^|]*\|invoke>/g,
      parameterPattern: /<\|CHAT2API\|parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/(?:\|CHAT[^|]*\|)?parameter>/g,
      fallbackParameterPatterns: [
        /<parameter\s*=\s*"?([^"">\s]+)"?\s*>([\s\S]*?)<\/parameter>/gi,
      ],
      rawMatches,
      invalidToolNames,
      allowedNames,
      tools: context.tools,
      toolCalls,
    })

    if (toolCalls.length === 0) {
      return createParseResult({
        content,
        toolCalls,
        protocol: rawMatches.length > 0 ? 'managed_xml' : 'unknown',
        rawMatches,
        invalidToolNames,
      })
    }

    const cleanContent = rawMatches.reduce((acc, raw) => acc.replace(raw, ''), parseable).trim()
    return createParseResult({
      content: cleanContent,
      toolCalls,
      protocol: 'managed_xml',
      rawMatches,
      invalidToolNames,
    })
  },

  formatAssistantToolCalls(calls) {
    const invokes = calls.map((call) => {
      const args = safeParseObject(call.arguments)
      const params = Object.entries(args)
        .map(([name, value]) => {
          const text = typeof value === 'string' ? value : JSON.stringify(value)
          return `<|CHAT2API|parameter name="${escapeXmlAttribute(name)}"><![CDATA[${text}]]></|CHAT2API|parameter>`
        })
        .join('')
      return `<|CHAT2API|invoke name="${escapeXmlAttribute(call.name)}">${params}</|CHAT2API|invoke>`
    })
    return `${CHAT2API_START}${invokes.join('')}${CHAT2API_END}`
  },

  formatToolResult(result) {
    return `<|CHAT2API|tool_result tool_call_id="${escapeXmlAttribute(result.toolCallId)}"><![CDATA[${result.content}]]></|CHAT2API|tool_result>`
  },
}

export interface ManagedXmlContractHeaderInput {
  catalogFingerprint: string
  allowedToolNames: string[]
  protocol: string
  contractHeaderVersion: number
}

export function renderManagedXmlContractHeader(input: ManagedXmlContractHeaderInput): string {
  return [
    'Tool Contract Header',
    `contract_header_version: ${input.contractHeaderVersion}`,
    `protocol: ${input.protocol}`,
    `catalog_fingerprint: ${input.catalogFingerprint}`,
    `allowed_tools: ${input.allowedToolNames.join(', ')}`,
    'The tools listed in this contract are available for this turn because they were provided by the runtime.',
    'Treat this contract and the Available Tools section as authoritative, even if earlier conversation text mentions different tools.',
    'Do not say that an allowed tool is unavailable. If one of the allowed tools is needed, emit a tool call instead of explanatory text.',
  ].join('\n')
}

interface ParseBlockOptions {
  blockPattern: RegExp
  invokePattern: RegExp
  parameterPattern: RegExp
  rawMatches: string[]
  invalidToolNames: string[]
  allowedNames: Set<string>
  tools: ToolParseContext['tools']
  toolCalls: ReturnType<typeof buildToolCall>[]
  fallbackParameterPatterns?: RegExp[]
}

function parseBlocks(content: string, options: ParseBlockOptions): void {
  let blockMatch: RegExpExecArray | null

  while ((blockMatch = options.blockPattern.exec(content)) !== null) {
    if (!isProtocolBoundary(content, blockMatch.index)) {
      continue
    }
    options.rawMatches.push(blockMatch[0])
    let invokeMatch: RegExpExecArray | null

    while ((invokeMatch = options.invokePattern.exec(blockMatch[1])) !== null) {
      const name = invokeMatch[1].trim()
      if (!options.allowedNames.has(name)) {
        options.invalidToolNames.push(name)
        continue
      }

      const args: Record<string, unknown> = {}
      let parameterMatch: RegExpExecArray | null
      options.parameterPattern.lastIndex = 0
      while ((parameterMatch = options.parameterPattern.exec(invokeMatch[2])) !== null) {
        addParameter(args, parameterMatch[1].trim(), parseJsonValue(parameterMatch[2]))
      }

      if (options.fallbackParameterPatterns) {
        for (const fallbackPattern of options.fallbackParameterPatterns) {
          let fbMatch: RegExpExecArray | null
          while ((fbMatch = fallbackPattern.exec(invokeMatch[2])) !== null) {
            addParameter(args, fbMatch[1].trim(), parseJsonValue(fbMatch[2]))
          }
        }
      }

      options.toolCalls.push(
        buildToolCall(
          `call_${options.toolCalls.length}`,
          options.toolCalls.length,
          name,
          JSON.stringify(args),
          invokeMatch[0],
          options.tools,
        ),
      )
    }
  }
}

function isProtocolBoundary(content: string, index: number): boolean {
  if (index <= 0) return true
  return /\s/.test(content[index - 1] ?? '')
}

function safeParseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}
