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
const CHAT2API_INVOKE_START = '<|CHAT2API|invoke'
const INVOKE_OPEN = /<\|CHAT2API\|invoke\s+name="([^"]+)"\s*>/g
const PARAM_OPEN = /<\|CHAT2API\|parameter\s+name="([^"]+)"\s*>/g
const INVOKE_CLOSE = '</|CHAT2API|invoke>'
const PARAM_CLOSE = '</|CHAT2API|parameter>'
const CANONICAL_START = '<tool_calls>'
const CANONICAL_END = '</tool_calls>'
const CANONICAL_INVOKE_OPEN = /<invoke\s+name="([^"]+)"\s*>/g
const CANONICAL_PARAM_OPEN = /<parameter\s+name="([^"]+)"\s*>/g
const CANONICAL_INVOKE_CLOSE = '</invoke>'
const CANONICAL_PARAM_CLOSE = '</parameter>'
const FOREIGN_MARKERS = ['</arg_value>', '</tool_call>', '[function_calls]', '[/function_calls]', '[/call]']

export const managedXmlStructureAdapter: StructureProtocolAdapter = {
  id: PROTOCOL,

  detectIntent(rawOutput: string): ProtocolIntentDetection {
    const stripped = stripFencedCodeBlocks(rawOutput)
    const marker = findFirstMarker(stripped)
    const index = marker?.index ?? -1
    if (index !== -1) {
      return { matched: true, partial: false, markerStart: index }
    }

    for (let start = 0; start < stripped.length; start += 1) {
      const suffix = stripped.slice(start)
      if (containerStarts().some((candidate) => candidate.startsWith(suffix))) {
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
    const marker = findFirstMarker(parseable)
    if (!marker) {
      return { kind: 'no_intent', protocol: PROTOCOL, content: rawOutput }
    }

    if (marker.kind === 'standalone') {
      return extractStandaloneInvoke(parseable, marker.index)
    }

    const variant = marker.value === CHAT2API_START ? chat2ApiVariant() : canonicalVariant()
    const warnings = detectForeignMarkers(parseable)
    const start = marker.index
    const end = parseable.indexOf(variant.containerEnd, start + variant.containerStart.length)

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

    const blockEnd = end + variant.containerEnd.length
    const rawBlock = parseable.slice(start, blockEnd)
    const inner = parseable.slice(start + variant.containerStart.length, end)
    const extraction = extractCalls(inner, start + variant.containerStart.length, variant)

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

function extractStandaloneInvoke(parseable: string, start: number): ProtocolStructureResult {
  const variant = chat2ApiVariant()
  const warnings = detectForeignMarkers(parseable)
  variant.invokeOpen.lastIndex = start
  const invokeMatch = variant.invokeOpen.exec(parseable)
  if (!invokeMatch || invokeMatch.index !== start) {
    return malformed(parseable, [warning('malformed_parameter', start, parseable.length)], 'malformed_container')
  }

  const bodyStart = variant.invokeOpen.lastIndex
  const close = parseable.indexOf(variant.invokeClose, bodyStart)
  if (warnings.length > 0) {
    return malformed(parseable, warnings, 'mixed_protocol_container')
  }
  if (close === -1) {
    return malformed(parseable, [warning('missing_invoke_close', start, parseable.length)], 'unterminated_container')
  }

  const body = parseable.slice(bodyStart, close)
  const parameterResult = extractParameters(body, bodyStart, variant)
  if (parameterResult.failureKind) {
    return malformed(parseable, parameterResult.warnings, parameterResult.failureKind)
  }

  const blockEnd = close + variant.invokeClose.length
  const rawBlock = parseable.slice(start, blockEnd)
  return {
    kind: 'container',
    protocol: PROTOCOL,
    extractedCalls: [{
      callIndex: 0,
      rawToolName: decodeXmlAttribute(invokeMatch[1]),
      rawParameters: parameterResult.parameters,
      rawSpan: { start, end: blockEnd },
    }],
    rawMatches: [rawBlock],
    cleanContent: parseable.slice(0, start) + parseable.slice(blockEnd),
    warnings: parameterResult.warnings,
  }
}

function extractCalls(
  inner: string,
  offset: number,
  variant: XmlVariant,
): {
  calls: ExtractedCallStructure[]
  warnings: ProtocolContainerWarning[]
  failureKind?: MalformedToolIntent['failureKind']
} {
  const calls: ExtractedCallStructure[] = []
  const warnings: ProtocolContainerWarning[] = []
  let invokeMatch: RegExpExecArray | null
  variant.invokeOpen.lastIndex = 0

  while ((invokeMatch = variant.invokeOpen.exec(inner)) !== null) {
    const invokeStart = offset + invokeMatch.index
    const bodyStart = variant.invokeOpen.lastIndex
    const close = inner.indexOf(variant.invokeClose, bodyStart)
    if (close === -1) {
      warnings.push(warning('missing_invoke_close', invokeStart, offset + inner.length))
      return { calls, warnings, failureKind: 'unterminated_container' }
    }

    const body = inner.slice(bodyStart, close)
    const parameterResult = extractParameters(body, offset + bodyStart, variant)
    warnings.push(...parameterResult.warnings)
    if (parameterResult.failureKind) {
      return { calls, warnings, failureKind: parameterResult.failureKind }
    }

    const invokeEnd = offset + close + variant.invokeClose.length
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
  variant: XmlVariant,
): {
  parameters: ExtractedParameterStructure[]
  warnings: ProtocolContainerWarning[]
  failureKind?: MalformedToolIntent['failureKind']
} {
  const parameters: ExtractedParameterStructure[] = []
  const warnings: ProtocolContainerWarning[] = []
  let paramMatch: RegExpExecArray | null
  variant.paramOpen.lastIndex = 0

  while ((paramMatch = variant.paramOpen.exec(body)) !== null) {
    const paramStart = offset + paramMatch.index
    const payloadStart = variant.paramOpen.lastIndex
    const close = body.indexOf(variant.paramClose, payloadStart)
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
      rawSpan: { start: paramStart, end: offset + close + variant.paramClose.length },
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
  const marker = findFirstMarker(parseable)
  const variant = marker?.value === CANONICAL_START ? canonicalVariant() : chat2ApiVariant()
  variant.invokeOpen.lastIndex = 0
  const invoke = variant.invokeOpen.exec(parseable)
  if (!invoke) {
    return undefined
  }

  const parameters = extractMalformedParameters(parseable, variant)
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

function extractMalformedParameters(
  parseable: string,
  variant: XmlVariant,
): MalformedToolIntent['parameters'] {
  const parameters: MalformedToolIntent['parameters'] = []
  let match: RegExpExecArray | null
  variant.paramOpen.lastIndex = 0

  while ((match = variant.paramOpen.exec(parseable)) !== null) {
    const payloadStart = variant.paramOpen.lastIndex
    const close = findAnyClose(parseable, payloadStart)
    const rawBody = close === -1 ? parseable.slice(payloadStart) : parseable.slice(payloadStart, close)
    const { rawPayload, payloadEncoding } = unwrapPayload(rawBody, { allowUnclosedCdata: true })
    if (close === -1 && !looksLikeJsonPayload(rawPayload)) {
      continue
    }

    parameters.push({
      name: decodeXmlAttribute(match[1]),
      rawPayload,
      payloadEncoding,
    })
  }

  return parameters
}

function findAnyClose(value: string, start: number): number {
  const closers = [PARAM_CLOSE, INVOKE_CLOSE, CHAT2API_END, '</arg_value>', '</parameter>', '</invoke>', '</tool_call>', '</tool_calls>']
    .map((marker) => value.indexOf(marker, start))
    .filter((index) => index !== -1)

  return closers.length === 0 ? -1 : Math.min(...closers)
}

function looksLikeJsonPayload(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.startsWith('{') || trimmed.startsWith('[')
}

function unwrapPayload(
  value: string,
  options: { allowUnclosedCdata?: boolean } = {},
): { rawPayload: string; payloadEncoding: PayloadEncoding } {
  if (value.includes(']]>') && !value.includes('<![CDATA[')) {
    return { rawPayload: '', payloadEncoding: 'text' }
  }

  const cdataOpen = value.indexOf('<![CDATA[')
  if (cdataOpen !== -1) {
    const afterOpen = value.slice(cdataOpen + 9)
    const cdataClose = findCdataClose(afterOpen)
    if (cdataClose === -1) {
      if (options.allowUnclosedCdata) {
        return { rawPayload: afterOpen.trim(), payloadEncoding: 'cdata' }
      }
      return { rawPayload: '', payloadEncoding: 'text' }
    }
    const closeWidth = afterOpen.startsWith(']]>', cdataClose) ? 3 : 2
    const inner = afterOpen.slice(0, cdataClose)
    const trailing = afterOpen.slice(cdataClose + closeWidth).trim()
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

function findCdataClose(value: string): number {
  const canonicalClose = value.indexOf(']]>')
  if (canonicalClose !== -1) {
    return canonicalClose
  }

  // Qwen can occasionally stream a complete parameter payload as
  // <![CDATA[payload]]</|CHAT2API|parameter>, missing the ">" in the CDATA
  // terminator. Treat only a tail-position "]]" as recoverable; anything with
  // trailing payload text remains malformed.
  const truncatedClose = value.match(/\]\]\s*$/)
  return truncatedClose?.index ?? -1
}

function detectForeignMarkers(value: string): ProtocolContainerWarning[] {
  return FOREIGN_MARKERS.flatMap((marker) => {
    const index = value.indexOf(marker)
    return index === -1 ? [] : [warning('foreign_protocol_marker', index, index + marker.length, marker)]
  })
}

function hasFencedManagedXml(value: string): boolean {
  const fencedBlocks = value.match(/```[\s\S]*?```/g) ?? []
  return fencedBlocks.some((block) => containerStarts().some((marker) => block.includes(marker)))
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

interface XmlVariant {
  containerStart: string
  containerEnd: string
  invokeOpen: RegExp
  invokeClose: string
  paramOpen: RegExp
  paramClose: string
}

function chat2ApiVariant(): XmlVariant {
  return {
    containerStart: CHAT2API_START,
    containerEnd: CHAT2API_END,
    invokeOpen: INVOKE_OPEN,
    invokeClose: INVOKE_CLOSE,
    paramOpen: PARAM_OPEN,
    paramClose: PARAM_CLOSE,
  }
}

function canonicalVariant(): XmlVariant {
  return {
    containerStart: CANONICAL_START,
    containerEnd: CANONICAL_END,
    invokeOpen: CANONICAL_INVOKE_OPEN,
    invokeClose: CANONICAL_INVOKE_CLOSE,
    paramOpen: CANONICAL_PARAM_OPEN,
    paramClose: CANONICAL_PARAM_CLOSE,
  }
}

function containerStarts(): string[] {
  return [CHAT2API_START, CANONICAL_START, CHAT2API_INVOKE_START]
}

function isProtocolBoundary(value: string, index: number): boolean {
  if (index <= 0) return true
  return /\s/.test(value[index - 1] ?? '')
}

function findFirstMarker(value: string): { value: string; index: number; kind: 'container' | 'standalone' } | null {
  return containerStarts()
    .map((marker) => ({
      value: marker,
      index: value.indexOf(marker),
      kind: marker === CHAT2API_INVOKE_START ? 'standalone' as const : 'container' as const,
    }))
    .filter((marker) => marker.index !== -1 && isProtocolBoundary(value, marker.index))
    .sort((left, right) => left.index - right.index)[0] ?? null
}
