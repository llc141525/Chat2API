import type { ToolClientAdapterId, ToolSmokeCategory } from '../../../shared/toolCalling.ts'

export interface ToolCallingSmokeResult {
  success: boolean
  category: ToolSmokeCategory
  message: string
  clientAdapterId: ToolClientAdapterId
  providerId?: string
  requestId?: string
  timestamp: number
}

let latestSmokeResult: ToolCallingSmokeResult = {
  success: false,
  category: 'not_run',
  message: 'No smoke test has been run.',
  clientAdapterId: 'standard-openai-tools',
  timestamp: 0,
}

export function getLatestToolCallingSmokeResult(): ToolCallingSmokeResult {
  return latestSmokeResult
}

export function setLatestToolCallingSmokeResult(result: ToolCallingSmokeResult): ToolCallingSmokeResult {
  latestSmokeResult = { ...result }
  return latestSmokeResult
}

export function buildSmokeFixture(clientAdapterId: ToolClientAdapterId) {
  return {
    model: 'tool-smoke-test',
    stream: false,
    messages: [{ role: 'user', content: 'Get weather for Hangzhou with the weather tool.' }],
    tools: [{
      type: 'function',
      function: {
        name: 'weather-test:get_weather',
        description: 'Get weather for a city',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    }],
    tool_choice: clientAdapterId === 'cherry-studio-mcp'
      ? { type: 'function', function: { name: 'weather-test:get_weather' } }
      : 'auto',
  }
}

export type ToolDiagnosticEventType =
  | 'tool_catalog_resolved'
  | 'tool_catalog_drift_detected'
  | 'tool_contract_injected'
  | 'tool_availability_drift_detected'
  | 'tool_availability_retry_result'
  | 'provider_empty_output'
  | 'provider_output_observed'

export interface ToolDiagnosticEvent {
  type: ToolDiagnosticEventType
  requestId?: string
  providerId?: string
  model?: string
  catalogSource?: string
  catalogFingerprint?: string
  toolNames?: string[]
  schemaHashes?: Record<string, string>
  driftKinds?: string[]
  protocol?: string
  headerVersion?: number
  retryResult?: 'skipped' | 'attempted' | 'succeeded' | 'failed'
  responseMode?: 'streaming' | 'non_streaming'
  contentLength?: number
  reasoningLength?: number
  fragmentTypes?: string[]
  upstreamDoneSeen?: boolean
  finishReason?: string
  timestamp: number
}

const MAX_TOOL_DIAGNOSTIC_EVENTS = 200
let toolDiagnosticEvents: ToolDiagnosticEvent[] = []

export function recordToolDiagnosticEvent(event: Omit<ToolDiagnosticEvent, 'timestamp'>): ToolDiagnosticEvent {
  const safeEvent: ToolDiagnosticEvent = {
    type: event.type,
    requestId: event.requestId,
    providerId: event.providerId,
    model: event.model,
    catalogSource: event.catalogSource,
    catalogFingerprint: event.catalogFingerprint,
    toolNames: event.toolNames ? [...event.toolNames] : undefined,
    schemaHashes: event.schemaHashes ? { ...event.schemaHashes } : undefined,
    driftKinds: event.driftKinds ? [...event.driftKinds] : undefined,
    protocol: event.protocol,
    headerVersion: event.headerVersion,
    retryResult: event.retryResult,
    responseMode: event.responseMode,
    contentLength: event.contentLength,
    reasoningLength: event.reasoningLength,
    fragmentTypes: event.fragmentTypes ? [...event.fragmentTypes] : undefined,
    upstreamDoneSeen: event.upstreamDoneSeen,
    finishReason: event.finishReason,
    timestamp: Date.now(),
  }

  toolDiagnosticEvents = [...toolDiagnosticEvents, safeEvent].slice(-MAX_TOOL_DIAGNOSTIC_EVENTS)
  return safeEvent
}

export function getToolDiagnosticEvents(): ToolDiagnosticEvent[] {
  return toolDiagnosticEvents.map((event) => ({
    ...event,
    toolNames: event.toolNames ? [...event.toolNames] : undefined,
    schemaHashes: event.schemaHashes ? { ...event.schemaHashes } : undefined,
    driftKinds: event.driftKinds ? [...event.driftKinds] : undefined,
    fragmentTypes: event.fragmentTypes ? [...event.fragmentTypes] : undefined,
  }))
}

export function clearToolDiagnosticEvents(): void {
  toolDiagnosticEvents = []
}
