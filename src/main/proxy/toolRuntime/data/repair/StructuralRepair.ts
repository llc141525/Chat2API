import type { MalformedToolIntent, StructuralRepairResult } from '../types.ts'

const CHAT2API_START = '<|CHAT2API|tool_calls>'
const CHAT2API_END = '</|CHAT2API|tool_calls>'

export function repairStructure(intent: MalformedToolIntent): StructuralRepairResult {
  if (intent.selectedProtocol !== 'managed_xml') {
    return {
      status: 'not_repairable',
      reason: `Unsupported repair protocol: ${intent.selectedProtocol}`,
    }
  }

  if (intent.parameters.length === 0) {
    return {
      status: 'not_repairable',
      reason: 'Cannot repair a tool call with no extracted parameters',
    }
  }

  if (
    intent.failureKind === 'unterminated_container'
    && intent.parameters.some((parameter) => parameter.rawPayload.trim().length === 0)
  ) {
    return {
      status: 'not_repairable',
      reason: 'Cannot repair unterminated container: model output was truncated',
    }
  }

  const params = intent.parameters
    .map((parameter) => {
      return `<|CHAT2API|parameter name="${escapeXmlAttribute(parameter.name)}">${wrapPayload(parameter.rawPayload, parameter.payloadEncoding)}</|CHAT2API|parameter>`
    })
    .join('')

  return {
    status: 'repaired',
    protocol: intent.selectedProtocol,
    method: 'deterministic_rewrap',
    repairedText: `${CHAT2API_START}<|CHAT2API|invoke name="${escapeXmlAttribute(intent.toolName)}">${params}</|CHAT2API|invoke>${CHAT2API_END}`,
  }
}

function wrapPayload(
  payload: string,
  encoding: MalformedToolIntent['parameters'][number]['payloadEncoding'],
): string {
  if (encoding === 'cdata') {
    return `<![CDATA[${payload}]]>`
  }

  return escapeXmlText(payload)
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
