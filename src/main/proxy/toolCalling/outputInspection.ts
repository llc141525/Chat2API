import { recordToolDiagnosticEvent } from './diagnostics.ts'
import type { ProviderTurnOutcome, ToolCallingPlan } from './types.ts'
import type { ToolStreamObservation } from './ToolStreamParser.ts'

export type NonStreamOutputInspection =
  | { ok: true; outcome: ProviderTurnOutcome }
  | { ok: false; outcome: ProviderTurnOutcome; error: string }

export type StreamOutputInspection = NonStreamOutputInspection

export function inspectNonStreamAssistantOutput(input: {
  result: any
  plan: ToolCallingPlan
}): NonStreamOutputInspection {
  const firstChoice = input.result?.choices?.[0]
  const message = firstChoice?.message
  const content = typeof message?.content === 'string' ? message.content : ''
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
  const finishReason = typeof firstChoice?.finish_reason === 'string' ? firstChoice.finish_reason : undefined

  const outcome = classifyNonStreamOutput({
    content,
    toolCalls,
    finishReason,
    validationFailureKind: input.plan.diagnostics.validationFailureKind,
    availabilityRetryResult: input.plan.diagnostics.availabilityRetryResult,
  })
  input.plan.diagnostics.terminalOutcome = outcome
  if (outcome === 'malformed_tool_output') {
    input.plan.diagnostics.suppressedReason = 'malformed_tool_output'
  }

  if (isSuccessfulOutcome(outcome)) {
    recordToolDiagnosticEvent({
      type: 'provider_output_observed',
      requestId: input.plan.diagnostics.requestId,
      providerId: input.plan.providerId,
      model: input.plan.diagnostics.actualModel ?? input.plan.diagnostics.model,
      responseMode: 'non_streaming',
      contentLength: content.length,
      terminalOutcome: outcome,
    })
    return { ok: true, outcome }
  }

  recordToolDiagnosticEvent({
    type: outcome === 'provider_empty' ? 'provider_empty_output' : 'provider_output_observed',
    requestId: input.plan.diagnostics.requestId,
    providerId: input.plan.providerId,
    model: input.plan.diagnostics.actualModel ?? input.plan.diagnostics.model,
    catalogFingerprint: input.plan.catalogSnapshot?.fingerprint,
    responseMode: 'non_streaming',
    contentLength: content.length,
      terminalOutcome: outcome,
      emptyOutputPolicy: input.plan.contract.emptyOutputPolicy,
      validationFailureKind: input.plan.diagnostics.validationFailureKind,
      suppressedReason: outcome === 'malformed_tool_output' ? 'malformed_tool_output' : undefined,
      availabilityDriftDetected: input.plan.diagnostics.availabilityDriftDetected,
      allowedToolNames: [...input.plan.allowedToolNames],
      deniedToolNames: input.plan.diagnostics.deniedToolNames,
      mentionedUnavailableOnlyTools: input.plan.diagnostics.mentionedUnavailableOnlyTools,
    })

  if (input.plan.contract.emptyOutputPolicy === 'pass_through_without_tool_semantics') {
    return { ok: true, outcome }
  }

  return {
    ok: false,
    outcome,
    error: buildInspectionError(outcome, input.plan.contract.turnId),
  }
}

export function inspectStreamAssistantOutput(input: {
  plan: ToolCallingPlan
  observation: ToolStreamObservation
  finishReason?: string
}): StreamOutputInspection {
  const { observation, plan } = input
  const outcome = classifyStreamOutput(observation)
  plan.diagnostics.terminalOutcome = outcome
  if (observation.suppressedReason) {
    plan.diagnostics.suppressedReason = observation.suppressedReason
  }

  if (isSuccessfulOutcome(outcome)) {
    recordToolDiagnosticEvent({
      type: 'provider_output_observed',
      requestId: plan.diagnostics.requestId,
      providerId: plan.providerId,
      model: plan.diagnostics.actualModel ?? plan.diagnostics.model,
      catalogFingerprint: plan.catalogSnapshot?.fingerprint,
      responseMode: 'streaming',
      contentLength: observation.emittedContentLength,
      terminalOutcome: outcome,
      finishReason: input.finishReason,
      suppressedReason: observation.suppressedReason,
      availabilityDriftDetected: observation.availabilityDriftDetected,
      allowedToolNames: [...plan.allowedToolNames],
      deniedToolNames: observation.deniedToolNames,
      mentionedUnavailableOnlyTools: observation.mentionedUnavailableOnlyTools,
      contentSentToClient: observation.emittedContentLength > 0,
    })
    return { ok: true, outcome }
  }

  recordToolDiagnosticEvent({
    type: outcome === 'provider_empty' ? 'provider_empty_output' : 'provider_output_observed',
    requestId: plan.diagnostics.requestId,
    providerId: plan.providerId,
    model: plan.diagnostics.actualModel ?? plan.diagnostics.model,
    catalogFingerprint: plan.catalogSnapshot?.fingerprint,
    responseMode: 'streaming',
    contentLength: observation.emittedContentLength,
    terminalOutcome: outcome,
    emptyOutputPolicy: plan.contract.emptyOutputPolicy,
    finishReason: input.finishReason,
    suppressedReason: observation.suppressedReason,
    availabilityDriftDetected: observation.availabilityDriftDetected,
    allowedToolNames: [...plan.allowedToolNames],
    deniedToolNames: observation.deniedToolNames,
    mentionedUnavailableOnlyTools: observation.mentionedUnavailableOnlyTools,
    contentSentToClient: observation.emittedContentLength > 0,
  })

  if (plan.contract.emptyOutputPolicy === 'pass_through_without_tool_semantics') {
    return { ok: true, outcome }
  }

  return {
    ok: false,
    outcome,
    error: buildInspectionError(outcome, plan.contract.turnId),
  }
}

function classifyNonStreamOutput(input: {
  content: string
  toolCalls: any[]
  finishReason?: string
  validationFailureKind?: ToolCallingPlan['diagnostics']['validationFailureKind']
  availabilityRetryResult?: ToolCallingPlan['diagnostics']['availabilityRetryResult']
}): ProviderTurnOutcome {
  const { content, toolCalls, validationFailureKind, availabilityRetryResult } = input
  if (toolCalls.length > 0) return 'tool_calls'
  if (availabilityRetryResult === 'failed') return 'tool_availability_drift'
  if (content.trim().length > 0) return 'content'
  if (validationFailureKind === 'malformed_tool_output' || validationFailureKind === 'malformed_container') {
    return 'malformed_tool_output'
  }
  return 'provider_empty'
}

function classifyStreamOutput(observation: ToolStreamObservation): ProviderTurnOutcome {
  if (observation.emittedToolCallCount > 0) return 'tool_calls'
  if (observation.availabilityDriftDetected) return 'tool_availability_drift'
  if (observation.emittedVisibleContentLength > 0) return 'content'
  if (observation.suppressedMalformedToolOutput) return 'malformed_tool_output'
  return 'provider_empty'
}

function isSuccessfulOutcome(outcome: ProviderTurnOutcome): boolean {
  return outcome === 'content' || outcome === 'tool_calls'
}

function buildInspectionError(outcome: ProviderTurnOutcome, turnId: string): string {
  if (outcome === 'tool_availability_drift') {
    return `Provider refused the authoritative tool catalog for managed tool turn ${turnId}`
  }
  if (outcome === 'malformed_tool_output') {
    return `Provider returned malformed tool output without usable assistant content for managed tool turn ${turnId}`
  }
  return `Provider returned empty assistant output for managed tool turn ${turnId}`
}
