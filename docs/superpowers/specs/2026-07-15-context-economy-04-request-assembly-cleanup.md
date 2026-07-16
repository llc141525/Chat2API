# Context Economy 04: Request Assembly Cleanup

## Objective

Make `RequestAssembly` consume explicit workflow state and strip runtime/tool config from provider history.

## Current Problem

`buildRequestAssembly()` currently keeps `messages` and reconstructs `summaryText` from message text. `selectProviderMessagesForAssembly()` may project active checkpoints as user text, but boundedness and contamination are not enforced centrally.

## Implementation

Extend `RequestAssembly`:

```ts
export interface RequestAssembly {
  messages: ChatMessage[]
  toolManifest: ToolManifest | null
  summaryText: string | null
  workflowDigest?: WorkflowStateDigest | null
  toolActionConstraint?: ToolActionConstraint | null
  metadata: AssemblyMetadata
}
```

Update `BuildRequestAssemblyInput` to accept:

```ts
workflowDigest?: WorkflowStateDigest | null
```

Priority:

1. explicit `workflowDigest`
2. explicit `summaryText`
3. compatibility extraction from message text

Compatibility extraction must emit a diagnostic so it can be retired.

## Provider Message Filtering

Add a filter used by `selectProviderMessagesForAssembly()`:

```ts
selectProviderMessagesForAssembly(assembly, options?: {
  stripRuntimeConfig?: boolean
  stripToolContractHistory?: boolean
  maxCheckpointChars?: number
})
```

Rules:

- remove runtime config history;
- remove old tool-contract history;
- preserve current user goal/task facts;
- preserve bounded workflow digest rendering;
- preserve recent tool continuation only through structured handoff/checkpoint.

## Tool Contract

Current tool contract must still be injected through `ToolManifest.renderedPrompt` according to prompt budget mode.

Do not rely on old `## Available Tools` messages in history to keep tools alive.

## Tests

Add:

- `buildRequestAssembly prefers explicit workflowDigest`
- `buildRequestAssembly compatibility extraction emits diagnostic`
- `selectProviderMessagesForAssembly strips runtime config`
- `selectProviderMessagesForAssembly strips historical tool contract`
- `tool manifest remains present when historical tool contract is stripped`
- `active skill checkpoint rendering is bounded and excludes raw skill docs`

## Acceptance

- Provider messages after compact contain digest + recent task state, not old OpenCode/system/skill/tool contract blobs.
- Existing GLM/Qwen prompt order tests are updated to assert current tool manifest placement, not historical prompt preservation.

