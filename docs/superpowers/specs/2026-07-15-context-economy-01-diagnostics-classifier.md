# Context Economy 01: Diagnostics And Payload Classifier

## Objective

Add provider-neutral diagnostics and a pure classifier that distinguishes runtime config, tool contracts, tool exchanges, workflow facts, and provider checkpoints.

This must land before behavior changes so later patches can prove they reduced the right payload classes.

## Current Problem

Provider-visible prompts currently mix:

- `You are opencode`
- `## Available Tools`
- managed XML examples
- skill docs and `superpowers`
- tool call/result payloads
- actual user task state

Without a classifier, summary and compact logic can only use role/text heuristics.

## Implementation

Create:

```text
src/main/proxy/services/contextPayloadClassifier.ts
```

Export:

```ts
export type ContextPayloadClass =
  | 'runtime_config'
  | 'tool_contract'
  | 'tool_exchange'
  | 'workflow_fact'
  | 'workflow_instruction'
  | 'provider_checkpoint'
  | 'user_goal'
  | 'unknown'

export interface ClassifiedPayload {
  className: ContextPayloadClass
  chars: number
  markerHits: string[]
}

export interface PayloadClassSummary {
  counts: Record<ContextPayloadClass, number>
  chars: Record<ContextPayloadClass, number>
  markerCounts: Record<string, number>
}

export function classifyTextPayload(text: string): ClassifiedPayload
export function summarizePayloadClasses(messages: ChatMessage[]): PayloadClassSummary
```

Minimum markers:

- `You are opencode` -> `runtime_config`
- `## Available Tools` -> `tool_contract`
- `<|CHAT2API|tool_calls>` -> `tool_exchange`
- `<|CHAT2API|tool_result` -> `tool_exchange`
- `Tool Contract Header` -> `tool_contract`
- `superpowers` -> `runtime_config`
- `SUBAGENT-STOP` -> `runtime_config`
- `[Active skill workflow state checkpoint]` -> `provider_checkpoint`
- `[Prior conversation summary` -> `workflow_fact`
- `[Child session handoff state]` -> `workflow_fact`

## Diagnostics

Add structured diagnostics at provider request assembly time:

```ts
contextEconomy: {
  boundary,
  promptRefreshMode,
  promptChars,
  payloadClassCounts,
  payloadClassChars,
  repeatedRuntimeConfigMarkers,
  repeatedToolContractMarkers,
}
```

Do not log raw prompts.

## Tests

Add:

```text
tests/services/contextPayloadClassifier.test.ts
tests/providers/context-economy-diagnostics.test.ts
```

Required assertions:

- exported main-session fixture shape reports many runtime/tool-contract repeats;
- ordinary user task text is not classified as runtime config;
- managed XML tool calls classify as `tool_exchange`;
- diagnostics expose counts without raw prompt content.

## Acceptance

- Classifier is pure and deterministic.
- No provider behavior changes yet.
- Existing tests still pass.

