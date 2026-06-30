/**
 * Tool Parser Module - Parse tool calls from text content
 *
 * Supported formats:
 * - Chat2API XML: <|CHAT2API|tool_calls><|CHAT2API|invoke name="..."><|CHAT2API|parameter name="..."><![CDATA[value]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>
 * - Bracket format: [function_calls][call:name]{args}[/call][/function_calls]
 *
 * All formats are normalized to the standard OpenAI tool_calls format
 */

export interface ParsedToolCall {
  index: number
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
  rawText?: string
}

const CHAT2API_XML_START = '<|CHAT2API|tool_calls>'
const CHAT2API_XML_START_ALT = '<tool_calls>'

/**
 * Parse tool calls from text content
 */
export function parseToolCallsFromText(text: string, modelType: string = 'default'): {
  content: string
  toolCalls: ParsedToolCall[]
} {
  console.log('[ToolParser] parseToolCallsFromText called, modelType:', modelType, 'text length:', text?.length || 0)
  if (!text) {
    return { content: '', toolCalls: [] }
  }

  const toolCalls: ParsedToolCall[] = []
  let cleanContent = text

  // Check for Chat2API XML format first: <|CHAT2API|tool_calls> or <tool_calls>
  const hasChat2API = text.includes(CHAT2API_XML_START) || text.includes(CHAT2API_XML_START_ALT)
  console.log('[ToolParser] hasChat2API:', hasChat2API)

  if (hasChat2API) {
    const xmlResults = parseChat2apiXmlFormat(text)
    if (xmlResults.toolCalls.length > 0) {
      toolCalls.push(...xmlResults.toolCalls)
      cleanContent = xmlResults.content
      console.log('[ToolParser] Chat2API XML parsed:', toolCalls.length, 'tool calls')
    }
  }

  // Check for bracket format (even if XML was found, also check for bracket fallback)
  const hasFunctionCalls = text.includes('[function_calls]') ||
                           text.includes('function_calls]') ||
                           /\[call[:=]/.test(text)

  console.log('[ToolParser] hasFunctionCalls:', hasFunctionCalls)

  if (hasFunctionCalls) {
    // Prepend missing opening bracket if needed
    let processedText = cleanContent
    const missingBracketRegex = /(^|[^\/\[])(function_calls\])/g
    if (!processedText.includes('[function_calls]') && missingBracketRegex.test(processedText)) {
      processedText = processedText.replace(/(^|[^\/\[])(function_calls\])/g, '$1[$2')
      console.log('[ToolParser] Prepended opening bracket')
    }

    const blockRegex = /\[function_calls\]([\s\S]*?)(?:\[\/function_calls\]|$)/g
    let blockMatch
    const bracketCalls: ParsedToolCall[] = []

    while ((blockMatch = blockRegex.exec(processedText)) !== null) {
      const blockContent = blockMatch[1]
      console.log('[ToolParser] blockContent:', blockContent?.substring(0, 200))

      if (modelType === 'kimi' || modelType === 'glm' || modelType === 'minimax' || modelType === 'zai') {
        const callRegex = modelType === 'minimax'
          ? /\[(?:call\s*[:=]\s*([a-zA-Z0-9_:-]+)|invoke\s+name\s*=\s*"([a-zA-Z0-9_:-]+)")\]([\s\S]*?)\[\/call\]/g
          : /\[call\s*[:=]?\s*([a-zA-Z0-9_:-]+)\]([\s\S]*?)\[\/call\]/g

        let match
        while ((match = callRegex.exec(blockContent)) !== null) {
          const functionName = match[1] || match[2]
          let argumentsStr = modelType === 'minimax' ? (match[3] || '').trim() : (match[2] || '').trim()
          if (argumentsStr.startsWith('```') && argumentsStr.endsWith('```')) {
            argumentsStr = argumentsStr.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
          }
          const parsed = tryParseJSON(argumentsStr)
          if (parsed) {
            bracketCalls.push({
              index: bracketCalls.length,
              id: `call_${Date.now()}_${bracketCalls.length}`,
              type: 'function',
              function: { name: functionName, arguments: JSON.stringify(parsed) },
              rawText: match[0]
            })
          }
        }
      } else {
        const callStartRegex = /\[call[:=]?([a-zA-Z0-9_:-]+)\]/g
        let callStartMatch
        while ((callStartMatch = callStartRegex.exec(blockContent)) !== null) {
          const functionName = callStartMatch[1]
          const argsStartIndex = callStartMatch.index + callStartMatch[0].length
          const remainingText = blockContent.substring(argsStartIndex)
          let argumentsStr = extractBalancedJson(remainingText)
          let jsonEndIndex = -1
          let parsed = null
          if (argumentsStr) {
            const startIdx = remainingText.indexOf('{')
            jsonEndIndex = startIdx + argumentsStr.length
            let cleanArgsStr = argumentsStr.trim()
            if (cleanArgsStr.startsWith('```') && cleanArgsStr.endsWith('```')) {
              cleanArgsStr = cleanArgsStr.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
            }
            parsed = tryParseJSON(cleanArgsStr)
          }
          if (!parsed) {
            parsed = tryRegexFallback(remainingText)
            if (parsed) {
              const endCallIdx = remainingText.indexOf('[/call]')
              jsonEndIndex = endCallIdx !== -1 ? endCallIdx : remainingText.length
            }
          }
          if (parsed) {
            let rawTextEndIndex = argsStartIndex + jsonEndIndex
            const afterJson = blockContent.substring(rawTextEndIndex)
            const closeTagMatch = afterJson.match(/^\s*\[\/call\]/)
            if (closeTagMatch) rawTextEndIndex += closeTagMatch[0].length
            bracketCalls.push({
              index: bracketCalls.length,
              id: `call_${Date.now()}_${bracketCalls.length}`,
              type: 'function',
              function: { name: functionName, arguments: JSON.stringify(parsed) },
              rawText: blockContent.substring(callStartMatch.index, rawTextEndIndex)
            })
            callStartRegex.lastIndex = rawTextEndIndex
          }
        }
      }

      // Remove the parsed calls from content
      for (const tc of bracketCalls) {
        if (tc.rawText) {
          cleanContent = cleanContent.replace(tc.rawText, '')
        }
      }

      if (blockContent.includes('[/function_calls]')) {
        const emptyBlockRegex = /\[function_calls\]\s*\[\/function_calls\]/g
        cleanContent = cleanContent.replace(emptyBlockRegex, '')
      }
    }

    toolCalls.push(...bracketCalls)
  }

  return {
    content: cleanContent.trim(),
    toolCalls
  }
}

/**
 * Parse Chat2API XML format tool calls: <|CHAT2API|tool_calls><|CHAT2API|invoke name="..."><|CHAT2API|parameter name="..."><![CDATA[value]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>
 * Also supports the simpler <tool_calls>/<invoke>/<parameter> variant
 */
function parseChat2apiXmlFormat(text: string): { content: string; toolCalls: ParsedToolCall[] } {
  const toolCalls: ParsedToolCall[] = []
  let cleanContent = text
  const rawMatches: string[] = []

  // Parse <|CHAT2API|tool_calls> blocks
  const chat2apiBlockRegex = /<\|CHAT2API\|tool_calls>([\s\S]*?)<\/\|CHAT[^|]*\|tool_calls>/g
  let blockMatch: RegExpExecArray | null
  while ((blockMatch = chat2apiBlockRegex.exec(text)) !== null) {
    rawMatches.push(blockMatch[0])
    parseInvokeBlock(blockMatch[1], toolCalls, rawMatches, {
      invokePattern: /<\|CHAT2API\|invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/\|CHAT[^|]*\|invoke>/g,
      parameterPattern: /<\|CHAT2API\|parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/(?:\|CHAT[^|]*\|)?parameter>/g,
    })
  }

  // Parse <tool_calls> blocks (simpler variant)
  const toolCallsBlockRegex = /<tool_calls>([\s\S]*?)<\/tool_calls>/g
  while ((blockMatch = toolCallsBlockRegex.exec(cleanContent)) !== null) {
    if (!rawMatches.includes(blockMatch[0])) {
      rawMatches.push(blockMatch[0])
      parseInvokeBlock(blockMatch[1], toolCalls, rawMatches, {
        invokePattern: /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g,
        parameterPattern: /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/g,
      })
    }
  }

  // Clean up matched raw text from content
  for (const raw of rawMatches) {
    cleanContent = cleanContent.replace(raw, '')
  }

  return { content: cleanContent, toolCalls }
}

function parseInvokeBlock(
  blockContent: string,
  toolCalls: ParsedToolCall[],
  rawMatches: string[],
  patterns: { invokePattern: RegExp; parameterPattern: RegExp }
): void {
  let invokeMatch: RegExpExecArray | null
  while ((invokeMatch = patterns.invokePattern.exec(blockContent)) !== null) {
    const name = invokeMatch[1].trim()
    rawMatches.push(invokeMatch[0])

    const args: Record<string, unknown> = {}
    let paramMatch: RegExpExecArray | null
    while ((paramMatch = patterns.parameterPattern.exec(invokeMatch[2])) !== null) {
      const paramName = paramMatch[1].trim()
      let paramValue = paramMatch[2].trim()
      // Unwrap CDATA
      const cdataMatch = paramValue.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/)
      if (cdataMatch) {
        paramValue = cdataMatch[1]
      }
      // Try JSON parse, fallback to string
      try {
        args[paramName] = JSON.parse(paramValue)
      } catch {
        args[paramName] = paramValue
      }
    }

    // Also try <parameter=name> format (without quotes around name and without closing tag)
    if (Object.keys(args).length === 0) {
      const altParamRegex = /<parameter\s*=\s*"?([^"">\s]+)"?\s*>([\s\S]*?)<\/parameter>/gi
      let altMatch: RegExpExecArray | null
      while ((altMatch = altParamRegex.exec(invokeMatch[2])) !== null) {
        const paramName = altMatch[1].trim()
        let paramValue = altMatch[2].trim()
        const cdataMatch = paramValue.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/)
        if (cdataMatch) paramValue = cdataMatch[1]
        try { args[paramName] = JSON.parse(paramValue) } catch { args[paramName] = paramValue }
      }
    }

    if (name) {
      toolCalls.push({
        index: toolCalls.length,
        id: `call_${Date.now()}_${toolCalls.length}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
        rawText: invokeMatch[0],
      })
    }
  }
}

/**
 * Extract a balanced JSON object string starting from the first '{'
 */
function extractBalancedJson(str: string): string | null {
  const startIdx = str.indexOf('{')
  if (startIdx === -1) return null

  let depth = 0
  let inString = false
  let isEscaped = false

  for (let i = startIdx; i < str.length; i++) {
    const char = str[i]

    if (char === '\\' && !isEscaped) {
      isEscaped = true
      continue
    }

    if (char === '"' && !isEscaped) {
      inString = !inString
    } else if (!inString) {
      if (char === '{') {
        depth++
      } else if (char === '}') {
        depth--
        if (depth === 0) {
          return str.substring(startIdx, i + 1)
        }
      }
    }

    isEscaped = false
  }

  return null
}

/**
 * Try to parse JSON with multiple fallback strategies
 */
function tryParseJSON(str: string): any | null {
  if (!str) return null

  // Try direct parse first
  try {
    return JSON.parse(str)
  } catch (e) {
    // Continue to cleanup attempts
  }

  // Attempt 1: Fix unescaped newlines and tabs inside string values
  try {
    let inString = false
    let isEscaped = false
    let fixedStr = ''

    for (let i = 0; i < str.length; i++) {
      const char = str[i]

      if (char === '\\' && !isEscaped) {
        isEscaped = true
        fixedStr += char
      } else if (char === '"' && !isEscaped) {
        inString = !inString
        fixedStr += char
      } else if (inString && (char === '\n' || char === '\r' || char === '\t')) {
        // Replace unescaped control characters inside string with escaped versions
        if (char === '\n') fixedStr += '\\n'
        else if (char === '\r') fixedStr += '\\r'
        else if (char === '\t') fixedStr += '\\t'
      } else {
        isEscaped = false
        fixedStr += char
      }
    }

    return JSON.parse(fixedStr)
  } catch (e) {
    // Continue to next attempt
  }

  // Attempt 2: Remove all newlines and extra whitespace between JSON tokens
  try {
    let inString = false
    let isEscaped = false
    let compactStr = ''

    for (let i = 0; i < str.length; i++) {
      const char = str[i]

      if (char === '\\' && !isEscaped) {
        isEscaped = true
        compactStr += char
      } else if (char === '"' && !isEscaped) {
        inString = !inString
        compactStr += char
      } else if (!inString && (char === '\n' || char === '\r' || char === '\t')) {
        // Skip whitespace outside strings
        continue
      } else {
        isEscaped = false
        compactStr += char
      }
    }

    return JSON.parse(compactStr)
  } catch (e) {
    // Continue to next attempt
  }

  // Attempt 3: Try to fix common issues like missing quotes around keys
  try {
    const fixedStr = str.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
    let inString = false
    let isEscaped = false
    let compactStr = ''

    for (let i = 0; i < fixedStr.length; i++) {
      const char = fixedStr[i]
      if (char === '\\' && !isEscaped) {
        isEscaped = true
        compactStr += char
      } else if (char === '"' && !isEscaped) {
        inString = !inString
        compactStr += char
      } else if (!inString && (char === '\n' || char === '\r')) {
        continue
      } else {
        isEscaped = false
        compactStr += char
      }
    }
    return JSON.parse(compactStr)
  } catch (e) {
    // Continue to next attempt
  }

  // Attempt 4: Try to fix single quotes (Python dict style)
  try {
    const doubleQuotedStr = str.replace(/'/g, '"')
    return JSON.parse(doubleQuotedStr)
  } catch (e) {
    // All attempts failed
  }

  return null
}

/**
 * Regex fallback for specific known tools (write_to_file, replace_in_file)
 * This is a last resort for completely broken JSON
 */
function tryRegexFallback(str: string): any | null {
  try {
    // Check if it looks like write_to_file
    if (str.includes('"filePath"') && str.includes('"content"')) {
      const filePathMatch = str.match(/"filePath"\s*:\s*"([^"]+)"/)
      if (filePathMatch) {
        const contentStart = str.indexOf('"content"')
        if (contentStart !== -1) {
          const valueStart = str.indexOf('"', contentStart + 9) + 1

          let valueEnd = -1
          const endMatch = str.match(/"\s*\}\s*(?:\[\/call\])?\s*$/)
          if (endMatch) {
            valueEnd = endMatch.index!
          } else {
            return null
          }

          if (valueStart !== 0 && valueEnd > valueStart) {
            const contentValue = str.substring(valueStart, valueEnd)
            return {
              filePath: filePathMatch[1],
              content: contentValue.replace(/\\n/g, '\n').replace(/\\"/g, '"')
            }
          }
        }
      }
    }

    // Check if it looks like replace_in_file
    if (str.includes('"filePath"') && str.includes('"old_str"') && str.includes('"new_str"')) {
      const filePathMatch = str.match(/"filePath"\s*:\s*"([^"]+)"/)
      if (filePathMatch) {
        const oldStrStart = str.indexOf('"old_str"')
        const newStrStart = str.indexOf('"new_str"')

        if (oldStrStart !== -1 && newStrStart !== -1) {
          const oldStrValueStart = str.indexOf('"', oldStrStart + 9) + 1
          const oldStrValueEnd = str.lastIndexOf('"', newStrStart - 1)

          const newStrValueStart = str.indexOf('"', newStrStart + 9) + 1

          let newStrValueEnd = -1
          const endMatch = str.match(/"\s*\}\s*(?:\[\/call\])?\s*$/)
          if (endMatch) {
            newStrValueEnd = endMatch.index!
          } else {
            return null
          }

          if (oldStrValueStart !== 0 && oldStrValueEnd > oldStrValueStart && 
              newStrValueStart !== 0 && newStrValueEnd > newStrValueStart) {

            const oldStrValue = str.substring(oldStrValueStart, oldStrValueEnd)
            const newStrValue = str.substring(newStrValueStart, newStrValueEnd)

            return {
              filePath: filePathMatch[1],
              old_str: oldStrValue.replace(/\\n/g, '\n').replace(/\\"/g, '"'),
              new_str: newStrValue.replace(/\\n/g, '\n').replace(/\\"/g, '"')
            }
          }
        }
      }
    }
  } catch (e) {
    // Regex fallback failed
  }

  return null
}
