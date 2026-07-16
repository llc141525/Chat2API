import type { StreamGateMode } from '../../control/types.ts'
import type {
  StreamGateFacts,
  StreamGateFinishResult,
  StreamGateState,
  StreamGateUpdate,
} from '../types.ts'

const MANAGED_XML_TOOL_CALLS = '<|CHAT2API|tool_calls>'

export function createStreamGateState(mode: StreamGateMode): StreamGateState {
  return {
    mode,
    buffer: '',
    releasedLength: 0,
    escapedRanges: [],
  }
}

export function ingestStreamChunk(state: StreamGateState, chunk: string): StreamGateUpdate {
  const nextBuffer = state.buffer + chunk

  if (state.mode === 'pass_through') {
    const start = state.releasedLength
    const end = start + chunk.length

    return {
      state: {
        ...state,
        buffer: nextBuffer,
        releasedLength: end,
        escapedRanges: [
          ...state.escapedRanges,
          { start, end, classification: 'plain_text' },
        ],
      },
      releasedChunks: [chunk],
    }
  }

  return {
    state: {
      ...state,
      buffer: nextBuffer,
    },
    releasedChunks: [],
  }
}

export function finishStreamGate(state: StreamGateState): StreamGateFinishResult {
  return {
    rawOutput: state.buffer,
    releasedChunks: [],
    facts: {
      mode: state.mode,
      hasEscapedToClient: state.escapedRanges.length > 0,
      escapedRanges: [...state.escapedRanges],
      detectedMarkers: detectMarkers(state.buffer),
      bufferedRawOutput: state.buffer,
    },
  }
}

function detectMarkers(buffer: string): StreamGateFacts['detectedMarkers'] {
  const fullMatchOffset = buffer.indexOf(MANAGED_XML_TOOL_CALLS)
  if (fullMatchOffset !== -1) {
    return [{
      protocol: 'managed_xml',
      marker: MANAGED_XML_TOOL_CALLS,
      offset: fullMatchOffset,
      confidence: 'full',
    }]
  }

  for (let index = 0; index < buffer.length; index += 1) {
    const suffix = buffer.slice(index)
    if (MANAGED_XML_TOOL_CALLS.startsWith(suffix)) {
      return [{
        protocol: 'managed_xml',
        marker: MANAGED_XML_TOOL_CALLS,
        offset: index,
        confidence: 'partial',
      }]
    }
  }

  return []
}
