# Context Economy 02: Summary Input Quality Gate

## Objective

Prevent provider summary sessions from receiving placeholder-only, skill-doc-only, runtime-config-only, or heavily contaminated inputs.

This directly fixes the GLM root cause: low-value/polluted summary input produces `No conversation to summarize.`

## Current Problem

`createSummaryGenerator()` calls `sanitizeMessagesForSummary()` and then:

```ts
hasSummarizableSummaryInput(sanitizedMessages)
```

That gate only checks whether non-system text exists. But the sanitizer can convert tool calls/results into text placeholders, which still pass the gate.

## Implementation

Create:

```text
src/main/proxy/services/summaryInputQuality.ts
```

Export:

```ts
export interface SummaryInputQuality {
  shouldCallProvider: boolean
  reason:
    | 'has_user_goal_or_workflow_facts'
    | 'empty_after_sanitization'
    | 'tool_placeholder_only'
    | 'runtime_config_only'
    | 'skill_doc_only'
    | 'too_contaminated'
  classSummary: PayloadClassSummary
  estimatedUsefulChars: number
  estimatedDiscardedChars: number
}

export function evaluateSummaryInputQuality(messages: ChatMessage[]): SummaryInputQuality
```

Provider summary calls are allowed only for:

```ts
reason === 'has_user_goal_or_workflow_facts'
```

## Integration

In `RequestForwarder.createSummaryGenerator()`:

1. Sanitize messages.
2. Evaluate summary quality.
3. If rejected, log a structured warning and return `''`.
4. Let `SummaryStrategy` convert the unusable empty summary into local fallback/digest.

Do not call `this.doForward()` for rejected summary input.

## Rejection Rules

Reject if:

- no useful non-system content remains;
- only tool placeholders remain;
- only runtime config remains;
- only skill docs remain;
- discarded/runtime/tool-contract chars dominate useful chars beyond a conservative threshold.

## Tests

Add tests:

- `summaryInputQuality rejects placeholder-only sanitized history`
- `summaryInputQuality rejects skill-document-only history`
- `summaryInputQuality rejects runtime-config-only history`
- `summaryInputQuality accepts real user goal plus workflow facts`
- `createSummaryGenerator does not call provider for rejected quality`
- `GLM no-conversation summary uses local fallback and does not pollute parent`

## Acceptance

- GLM summary child session is not created for placeholder-only or skill-doc-only history.
- Existing summary fallback tests still pass.
- Qwen summary behavior remains compatible.

