# Step 01: Log And Request Assembly Traces

Status: Accepted
Owner: main-session acceptance

## Goal

Add metadata-only trace points around the flows needed to debug tool loss after context management:

- context management configuration and strategy outcomes
- tool prompt transform planning
- Qwen request assembly
- final tool-injection placement

## Files In Scope

- `src/main/proxy/services/contextManagementService.ts`
- `src/main/proxy/forwarder.ts`
- `src/main/proxy/toolCalling/ToolCallingEngine.ts`
- `src/main/proxy/adapters/qwen.ts`

## Required Behavior

Trace logs must show enough to answer:

- Did context management run?
- Was a summary inserted or skipped?
- How many `system`, `tool`, and tool-call messages survived?
- Did `ToolCallingEngine` decide to inject?
- What catalog source and fingerprint were used?
- Did the final Qwen request still contain the managed tool contract?

Trace logs must not include:

- full prompt bodies
- user message content
- secrets, cookies, tokens, or authorization headers
- raw provider response bodies

## Acceptance

- A read-only review finds no new secret or prompt-body leakage in the new trace fields.
- Trace fields include enough metadata to correlate a failed live probe with context compaction and tool contract presence.
- Any pre-existing unsafe logs are documented separately and not conflated with this step unless newly touched.

## Round Notes

Explorer review reported no blocking findings for the new trace logs. It flagged pre-existing Qwen logs as P2 cleanup candidates:

- `src/main/proxy/adapters/qwen.ts` serialized message detail logging
- thinking-content snippets
- parse-error data snippets
- wholesale response header logging

Main acceptance:
- Accepted for this batch. New trace logs are metadata-only and provide the needed compaction/tool-contract correlation points.
