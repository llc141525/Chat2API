import type { ToolProtocolId } from '../../../toolCalling/types.ts'
import type {
  ExtractedCallStructure,
  ExtractedParameterStructure,
  MalformedToolIntent,
  PayloadEncoding,
  ProtocolContainerWarning,
  ProtocolContainerWarningKind,
  ProtocolStructureResult,
} from '../types.ts'
import type { ProtocolIntentDetection, StructureProtocolAdapter } from './ProtocolAdapter.ts'

const PROTOCOL: ToolProtocolId = 'managed_xml'
const CHAT2API_START = '<|CHAT2API|tool_calls>'
const CHAT2API_END = '</|CHAT2API|tool_calls>'
const INVOKE_OPEN = /<\|CHAT2API\|invoke\s+name="([^"]+)"\s*>/g
const PARAM_OPEN = /<\|CHAT2API\|parameter\s+name="([^"]+)"\s*>/g
const INVOKE_CLOSE = '</|CHAT2API|invoke>'
const PARAM_CLOSE = '</|CHAT2API|parameter>'
const FOREIGN_MARKERS = ['</arg_value>', '</tool_call>', '[function_calls]', '[/function_calls]', '[/call]']

export const managedXmlStructureAdapter: StructureProtocolAdapter = {
  id: PROTOCOL,

  detectIntent(rawOutput: string): ProtocolIntentDetection {
    const stripped = stripFencedCodeBlocks(rawOutput)
    const index = stripped.indexOf(CHAT2API_START)
    if (index !== -1) {
      return { matched: true, partial: false, markerStart: index }
    }

    for (let start = 0; start < stripped.length; start += 1) {
      const suffix = stripped.slice(start)
      if (CHAT2API_START.startsWith(suffix)) {
        return { matched: false, partial: true, markerStart: start }
      }
    }

    return { matched: false, partial: false }
  },

  extractStructure(rawOutput: string): ProtocolStructureResult {
    if (hasFencedManagedXml(rawOutput)) {
      return { kind: 'no_intent', protocol: PROTOCOL, content: rawOutput }
    }

    const parseable = stripFencedCodeBlocks(rawOutput)
    if (!parseable.includes(CHAT2API_START)) {
      return { kind: 'no_intent', protocol: PROTOCOL, content: rawOutput }
    }

    const warnings = detectForeignMarkers(parseable)
    const start = parseable.indexOf(CHAT2API_START)
    const end = parseable.indexOf(CHAT2API_END, start + CHAT2API_START.length)

    if (warnings.length > 0) {
      return malformed(parseable, warnings, 'mixed_protocol_container')
    }

    if (end === -1) {
      return malformed(
        parseable,
        [warning('missing_container_close', start, parseable.length)],
        'unterminated_container',
      )
    }

    const blockEnd = end + CHAT2API_END.length
    const rawBlock = parseable.slice(start, blockEnd)
    const inner = parseable.slice(start + CHAT2API_START.length, end)
    const extraction = extractCalls(inner, start + CHAT2API_START.length)

    if (extraction.failureKind) {
      return malformed(parseable, extraction.warnings, extraction.failureKind)
    }

    if (extraction.calls.length === 0) {
      return malformed(parseable, [warning('malformed_parameter', start, blockEnd)], 'malformed_container')
    }

    return {
      kind: 'container',
      protocol: PROTOCOL,
      extractedCalls: extraction.calls,
      rawMatches: [rawBlock],
      cleanContent: parseable.slice(0, start) + parseable.slice(blockEnd),
      warnings: extraction.warnings,
    }
  },
}

function extractCalls(
  inner: string,
  offset: number,
): {
  calls: ExtractedCallStructure[]
  warnings: ProtocolContainerWarning[]
  failureKind?: MalformedToolIntent['failureKind']
} {
  const calls: ExtractedCallStructure[] = []
  const warnings: ProtocolContainerWarning[] = []
  let invokeMatch: RegExpExecArray | null
  INVOKE_OPEN.lastIndex = 0

  while ((invokeMatch = INVOKE_OPEN.exec(inner)) !== null) {
    const invokeStart = offset + invokeMatch.index
    const bodyStart = INVOKE_OPEN.lastIndex
    const close = inner.indexOf(INVOKE_CLOSE, bodyStart)
    if (close === -1) {
      warnings.push(warning('missing_invoke_close', invokeStart, offset + inner.length))
      return { calls, warnings, failureKind: 'unterminated_container' }
    }

    const body = inner.slice(bodyStart, close)
    const parameterResult = extractParameters(body, offset + bodyStart)
    warnings.push(...parameterResult.warnings)
    if (parameterResult.failureKind) {
      return { calls, warnings, failureKind: parameterResult.failureKind }
    }

    const invokeEnd = offset + close + INVOKE_CLOSE.length
    calls.push({
      callIndex: calls.length,
      rawToolName: decodeXmlAttribute(invokeMatch[1]),
      rawParameters: parameterResult.parameters,
      rawSpan: { start: invokeStart, end: invokeEnd },
    })
  }

  return { calls, warnings }
}

function extractParameters(
  body: string,
  offset: number,
): {
  parameters: ExtractedParameterStructure[]
  warnings: ProtocolContainerWarning[]
  failureKind?: MalformedToolIntent['failureKind']
} {
  const parameters: ExtractedParameterStructure[] = []
  const warnings: ProtocolContainerWarning[] = []
  let paramMatch: RegExpExecArray | null
  PARAM_OPEN.lastIndex = 0

  while ((paramMatch = PARAM_OPEN.exec(body)) !== null) {
    const paramStart = offset + paramMatch.index
    const payloadStart = PARAM_OPEN.lastIndex
    const close = body.indexOf(PARAM_CLOSE, payloadStart)
    if (close === -1) {
      warnings.push(warning('missing_parameter_close', paramStart, offset + body.length))
      return { parameters, warnings, failureKind: 'unterminated_container' }
    }

    const rawBody = body.slice(payloadStart, close)
    const { rawPayload, payloadEncoding } = unwrapPayload(rawBody)
    parameters.push({
      rawName: decodeXmlAttribute(paramMatch[1]),
      rawPayload,
      payloadEncoding,
      rawSpan: { start: paramStart, end: offset + close + PARAM_CLOSE.length },
    })
  }

  return { parameters, warnings }
}

function malformed(
  parseable: string,
  warnings: ProtocolContainerWarning[],
  failureKind: MalformedToolIntent['failureKind'],
): ProtocolStructureResult {
  const malformedIntent = extractMalformedIntent(parseable, failureKind)

  return {
    kind: 'malformed_container',
    protocol: PROTOCOL,
    warnings,
    ...(malformedIntent ? { malformedIntent } : {}),
    rawOutputFingerprint: fingerprint(parseable),
  }
}

function extractMalformedIntent(
  parseable: string,
  failureKind: MalformedToolIntent['failureKind'],
): MalformedToolIntent | undefined {
  INVOKE_OPEN.lastIndex = 0
  const invoke = INVOKE_OPEN.exec(parseable)
  if (!invoke) {
    return undefined
  }

  const parameters = extractMalformedParameters(parseable)
  if (parameters.length === 0) {
    return undefined
  }

  return {
    selectedProtocol: PROTOCOL,
    toolName: decodeXmlAttribute(invoke[1]),
    parameters,
    rawContainerFingerprint: fingerprint(parseable),
    failureKind,
  }
}

function extractMalformedParameters(parseable: string): MalformedToolIntent['parameters'] {
  const parameters: MalformedToolIntent['parameters'] = []
  let match: RegExpExecArray | null
  PARAM_OPEN.lastIndex = 0

  while ((match = PARAM_OPEN.exec(parseable)) !== null) {
    const payloadStart = PARAM_OPEN.lastIndex
    const close = findAnyClose(parseable, payloadStart)
    const rawBody = close === -1 ? parseable.slice(payloadStart) : parseable.slice(payloadStart, close)
    const { rawPayload, payloadEncoding } = unwrapPayload(rawBody)

    parameters.push({
      name: decodeXmlAttribute(match[1]),
      rawPayload,
      payloadEncoding,
    })
  }

  return parameters
}

function findAnyClose(value: string, start: number): number {
  const closers = [PARAM_CLOSE, '</arg_value>', '</parameter>', '</tool_call>']
    .map((marker) => value.indexOf(marker, start))
    .filter((index) => index !== -1)

  return closers.length === 0 ? -1 : Math.min(...closers)
}

function unwrapPayload(value: string): { rawPayload: string; payloadEncoding: PayloadEncoding } {
  if (value.includes(']]>') && !value.includes('<![CDATA[')) {
    return { rawPayload: '', payloadEncoding: 'text' }
  }

  const cdataOpen = value.indexOf('<![CDATA[')
  if (cdataOpen !== -1) {
    const afterOpen = value.slice(cdataOpen + 9)
    const cdataClose = afterOpen.indexOf(']]>')
    if (cdataClose === -1) {
      return { rawPayload: '', payloadEncoding: 'text' }
    }
    const inner = afterOpen.slice(0, cdataClose)
    const trailing = afterOpen.slice(cdataClose + 3).trim()
    if (trailing.length > 0) {
      return { rawPayload: '', payloadEncoding: 'text' }
    }
    return { rawPayload: inner, payloadEncoding: 'cdata' }
  }

  const trimmed = value.trim()
  const payloadEncoding: PayloadEncoding =
    trimmed.startsWith('{') || trimmed.startsWith('[') ? 'json_text' : 'text'

  return { rawPayload: decodeXmlText(trimmed), payloadEncoding }
}

function detectForeignMarkers(value: string): ProtocolContainerWarning[] {
  return FOREIGN_MARKERS.flatMap((marker) => {
    const index = value.indexOf(marker)
    return index === -1 ? [] : [warning('foreign_protocol_marker', index, index + marker.length, marker)]
  })
}

function hasFencedManagedXml(value: string): boolean {
  const fencedBlocks = value.match(/```[\s\S]*?```/g) ?? []
  return fencedBlocks.some((block) => block.includes(CHAT2API_START))
}

function stripFencedCodeBlocks(value: string): string {
  return value.replace(/```[\s\S]*?```/g, '')
}

function decodeXmlAttribute(value: string): string {
  return decodeXmlText(value.replace(/&quot;/g, '"').replace(/&apos;/g, "'"))
}

function decodeXmlText(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

function fingerprint(value: string): string {
  return `${value.length}:${value.slice(0, 32)}:${value.slice(-32)}`
}

function warning(
  kind: ProtocolContainerWarningKind,
  start: number,
  end: number,
  marker?: string,
): ProtocolContainerWarning {
  return {
    kind,
    ...(marker ? { marker } : {}),
    span: { start, end },
  }
}
