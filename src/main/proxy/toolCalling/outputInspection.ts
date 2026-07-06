import { recordToolDiagnosticEvent } from './diagnostics.ts'
import type { ProviderTurnOutcome, ToolCallingPlan } from './types.ts'

export type NonStreamOutputInspection =
  | { ok: true; outcome: ProviderTurnOutcome }
  | { ok: false; outcome: ProviderTurnOutcome; error: string }

export function inspectNonStreamAssistantOutput(input: {
  result: any
  plan: ToolCallingPlan
}): NonStreamOutputInspection {
  const message = input.result?.choices?.[0]?.message
  const content = typeof message?.content === 'string' ? message.content : ''
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : []

  const outcome = classifyOutput(content, toolCalls)
  input.plan.diagnostics.terminalOutcome = outcome

  if (outcome === 'content' || outcome === 'tool_calls') {
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
    type: 'provider_empty_output',
    requestId: input.plan.diagnostics.requestId,
    providerId: input.plan.providerId,
    model: input.plan.diagnostics.actualModel ?? input.plan.diagnostics.model,
    catalogFingerprint: input.plan.catalogSnapshot?.fingerprint,
    responseMode: 'non_streaming',
    contentLength: content.length,
    terminalOutcome: outcome,
    emptyOutputPolicy: input.plan.contract.emptyOutputPolicy,
  })

  if (input.plan.contract.emptyOutputPolicy === 'pass_through_without_tool_semantics') {
    return { ok: true, outcome }
  }

  return {
    ok: false,
    outcome,
    error: `Provider returned empty assistant output for managed tool turn ${input.plan.contract.turnId}`,
  }
}

function classifyOutput(content: string, toolCalls: any[]): ProviderTurnOutcome {
  if (toolCalls.length > 0) return 'tool_calls'
  if (content.trim().length > 0) return 'content'
  return 'provider_empty'
}
