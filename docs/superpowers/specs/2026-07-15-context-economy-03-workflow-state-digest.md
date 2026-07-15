# Context Economy 03: Workflow State Digest

## Objective

Replace "summary as provider-visible message text" with a typed compact artifact that can be rendered into bounded provider prompts.

## Current Problem

`RequestAssembly` extracts compact state by scanning message text:

```ts
extractStructuredCompactSummaryText(input.messages)
```

That makes compact state fragile and encourages storing runtime/tool history as messages.

## Implementation

Add:

```text
src/main/proxy/services/workflowStateDigest.ts
```

Export:

```ts
export interface WorkflowStateDigest {
  kind: 'workflow_state_digest'
  version: 1
  source: 'external_summary' | 'local_fallback' | 'tool_handoff' | 'client_compact'
  userGoal?: string
  confirmedFacts: string[]
  inspectedFiles: string[]
  modifiedFiles: string[]
  pendingObligations: string[]
  nextAction?: string
  activeToolCallIds: string[]
  omitted: {
    runtimeConfig: number
    toolContract: number
    toolPayloadBytes: number
    skillDocumentBytes: number
  }
}

export function buildLocalWorkflowDigest(messages: ChatMessage[], source: WorkflowStateDigest['source']): WorkflowStateDigest
export function renderWorkflowDigestForProvider(digest: WorkflowStateDigest): string
```

## Integration

Extend `ContextProcessResult`:

```ts
workflowDigest?: WorkflowStateDigest
```

`SummaryStrategy` should populate `workflowDigest` for:

- external summary success,
- local fallback,
- skipped active tool workflow,
- tool handoff compact.

Compatibility summary messages may remain temporarily, but assembly must prefer explicit digest.

## Digest Rules

Digest must:

- include task facts and pending obligations;
- include file paths/artifacts when present;
- include active tool call ids only as ids/names, not raw payloads;
- count omitted runtime/tool/skill bytes;
- never embed full skill documents;
- never embed full `## Available Tools`.

## Tests

Add:

- `buildLocalWorkflowDigest extracts goal/facts/files without tool contract`
- `workflow digest records omitted runtime/tool bytes`
- `renderWorkflowDigestForProvider is bounded`
- `SummaryStrategy returns workflowDigest on summary_fallback_local`
- `SummaryStrategy returns workflowDigest when external summary is unusable`

## Acceptance

- Compact state is available without scanning provider message text.
- Digest rendering is bounded and free of raw runtime/tool contract markers.

