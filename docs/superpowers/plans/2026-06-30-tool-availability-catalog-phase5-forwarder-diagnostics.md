# Tool Availability Catalog Phase 5: Forwarder Retry Hook and Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this phase task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Source Spec:** [`docs/superpowers/specs/2026-06-30-tool-availability-catalog-design.md`](../specs/2026-06-30-tool-availability-catalog-design.md)

**Parent Index:** [`docs/superpowers/plans/2026-06-30-tool-availability-catalog.md`](./2026-06-30-tool-availability-catalog.md)

## Phase Isolation Rule

- This document contains only Phase 5: Forwarder Retry Hook and Diagnostics.
- Do not implement files or steps from other Phase 7 plan documents while executing or validating this phase.
- If working tree changes from another phase already exist, leave them unvalidated until their own phase review.

### Task 5: Forwarder Retry Hook and Diagnostics

**Files:**
- Modify: `src/main/proxy/forwarder.ts`
- Modify: `src/main/proxy/toolCalling/diagnostics.ts`
- Modify: `src/main/proxy/toolCalling/ToolCallingEngine.ts`
- Create: `tests/tool-calling/tool-diagnostics.test.ts`

- [ ] **Step 1: Add failing diagnostics tests**

Create `tests/tool-calling/tool-diagnostics.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  clearToolDiagnosticEvents,
  getToolDiagnosticEvents,
  recordToolDiagnosticEvent,
} from '../../src/main/proxy/toolCalling/diagnostics.ts'

test('tool diagnostic events store structure facts without arguments or full schemas', () => {
  clearToolDiagnosticEvents()
  recordToolDiagnosticEvent({
    type: 'tool_catalog_resolved',
    requestId: 'r1',
    providerId: 'qwen',
    model: 'qwen3',
    catalogFingerprint: 'abc',
    toolNames: ['bash'],
    schemaHashes: { bash: 'hash' },
    argumentsText: '{"argument":"rm -rf /"}',
    fullSchema: { type: 'object', properties: { argument: { type: 'string' } } },
    prompt: 'secret prompt',
  } as any)

  const events = getToolDiagnosticEvents()
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'tool_catalog_resolved')
  assert.deepEqual(events[0].toolNames, ['bash'])
  assert.equal((events[0] as any).argumentsText, undefined)
  assert.equal((events[0] as any).fullSchema, undefined)
  assert.equal((events[0] as any).prompt, undefined)
})
```

- [ ] **Step 2: Run failing diagnostics test**

Run:

```powershell
node --test tests/tool-calling/tool-diagnostics.test.ts
```

Expected: FAIL because the event functions do not exist.

- [ ] **Step 3: Add diagnostic event store**

Modify `src/main/proxy/toolCalling/diagnostics.ts`:

```ts
export type ToolDiagnosticEventType =
  | 'tool_catalog_resolved'
  | 'tool_catalog_drift_detected'
  | 'tool_contract_injected'
  | 'tool_availability_drift_detected'
  | 'tool_availability_retry_result'
  | 'provider_empty_output'

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
  }))
}

export function clearToolDiagnosticEvents(): void {
  toolDiagnosticEvents = []
}
```

- [ ] **Step 4: Record catalog/header/retry events in engine**

Modify `src/main/proxy/toolCalling/ToolCallingEngine.ts`:

```ts
import { recordToolDiagnosticEvent } from './diagnostics.ts'
```

After planning in `transformRequest`, record catalog resolution:

```ts
    if (plan.catalogSnapshot) {
      recordToolDiagnosticEvent({
        type: 'tool_catalog_resolved',
        requestId,
        providerId: provider.id,
        model: actualModel,
        catalogSource: plan.catalogDiagnostics.source,
        catalogFingerprint: plan.catalogSnapshot.fingerprint,
        toolNames: plan.catalogSnapshot.allowedToolNames,
        schemaHashes: plan.catalogSnapshot.schemaHashes,
        driftKinds: plan.catalogDiagnostics.driftKinds,
        responseMode: request.stream ? 'streaming' : 'non_streaming',
      })
      if (plan.catalogDiagnostics.driftKinds.length > 0) {
        recordToolDiagnosticEvent({
          type: 'tool_catalog_drift_detected',
          requestId,
          providerId: provider.id,
          model: actualModel,
          catalogFingerprint: plan.catalogSnapshot.fingerprint,
          driftKinds: plan.catalogDiagnostics.driftKinds,
          responseMode: request.stream ? 'streaming' : 'non_streaming',
        })
      }
    }
```

When injecting prompt, record:

```ts
      recordToolDiagnosticEvent({
        type: 'tool_contract_injected',
        requestId,
        providerId: provider.id,
        model: actualModel,
        catalogFingerprint: plan.catalogSnapshot?.fingerprint,
        toolNames: plan.catalogSnapshot?.allowedToolNames,
        protocol: plan.protocol,
        headerVersion: getProviderToolProfile(plan.providerId).contractHeaderVersion,
        responseMode: request.stream ? 'streaming' : 'non_streaming',
      })
```

Inside `maybeBuildAvailabilityRetry`, record:

```ts
  recordToolDiagnosticEvent({
    type: 'tool_availability_drift_detected',
    requestId: plan.diagnostics.requestId,
    providerId: plan.providerId,
    model: plan.diagnostics.actualModel ?? plan.diagnostics.model,
    catalogFingerprint: plan.catalogSnapshot.fingerprint,
    toolNames: plan.catalogSnapshot.allowedToolNames,
    responseMode: 'non_streaming',
  })
  recordToolDiagnosticEvent({
    type: 'tool_availability_retry_result',
    requestId: plan.diagnostics.requestId,
    providerId: plan.providerId,
    model: plan.diagnostics.actualModel ?? plan.diagnostics.model,
    catalogFingerprint: plan.catalogSnapshot.fingerprint,
    retryResult: 'attempted',
    responseMode: 'non_streaming',
  })
```

- [ ] **Step 5: Add forwarder retry helper for non-streaming managed requests**

Modify `src/main/proxy/forwarder.ts` `applyToolCallsToResponse` so it returns the retry request:

```ts
  private applyToolCallsToResponse(result: any, transformed: ToolCallingTransformResult) {
    const engine = new ToolCallingEngine(storeManager.getConfig().toolCallingConfig)
    return engine.applyNonStreamResponse(result, transformed.plan)
  }
```

Add this helper method to `RequestForwarder`:

```ts
  private buildAvailabilityRetryRequest(
    originalRequest: ChatCompletionRequest,
    transformed: ToolCallingTransformResult,
    clarification: string
  ): ChatCompletionRequest {
    return {
      ...originalRequest,
      stream: false,
      messages: [
        ...transformed.messages,
        {
          role: 'system',
          content: clarification,
        },
      ],
      tools: transformed.tools,
    }
  }
```

The helper preserves the original transformed messages and appends only the bounded structural clarification returned by `ToolCallingEngine`. It does not add tool arguments, choose a tool, or change the catalog snapshot.

- [ ] **Step 6: Pass toolSessionKey from forwarder transform call**

Modify `src/main/proxy/forwarder.ts` by adding this method to `RequestForwarder`:

```ts
  private buildToolCatalogSessionKey(provider: Provider, account: Account, actualModel: string): string {
    return `${provider.id}:${account.id}:${actualModel}`
  }
```

Then modify `transformRequestForPromptToolUse` input:

```ts
  private transformRequestForPromptToolUse(
    request: ChatCompletionRequest,
    provider?: Provider,
    toolSessionKey?: string | null
  ): ToolCallingTransformResult {
```

Pass:

```ts
      toolSessionKey: toolSessionKey ?? undefined,
```

Update each provider-specific transform call from:

```ts
const transformed = this.transformRequestForPromptToolUse(request, provider)
```

to:

```ts
const transformed = this.transformRequestForPromptToolUse(
  request,
  provider,
  this.buildToolCatalogSessionKey(provider, account, actualModel)
)
```

Apply that exact call shape in these methods:

- `forwardDeepSeek`
- `forwardGLM`
- `forwardKimi`
- `forwardQwen`
- `forwardQwenAi`
- `forwardZai`
- `forwardMiniMax`
- `forwardMimo`
- `forwardPerplexity`

Do not derive the catalog key from prompt text, model output, or provider response content. The key is intentionally independent of `sessionManager`; later work may replace it with a more precise client/session id when one is available at this boundary.

For the first implementation, keep the existing call sites unchanged so they pass `undefined` and use request-scoped catalog unless a later forward path already has a concrete session id in scope. Do not derive the catalog key from prompt text or provider output.

- [ ] **Step 7: Wire one-shot non-streaming retry for Qwen**

Modify `src/main/proxy/forwarder.ts` inside `forwardQwen`, replacing:

```ts
      const result = await handler.handleNonStream(response.data, response)

      this.applyToolCallsToResponse(result, transformed)
```

with:

```ts
      let result = await handler.handleNonStream(response.data, response)

      const retry = this.applyToolCallsToResponse(result, transformed)
      if (retry && transformed.plan.catalogSnapshot?.fingerprint === retry.catalogFingerprint) {
        const retryRequest = this.buildAvailabilityRetryRequest(request, transformed, retry.clarification)
        const retryResponse = await adapter.chatCompletion({
          model: actualModel,
          originalModel: request.model,
          messages: retryRequest.messages as any,
          stream: false,
          temperature: request.temperature,
          enableThinking: !!request.reasoning_effort,
          enableWebSearch: !!request.web_search,
        })
        const retryHandler = new QwenStreamHandler(actualModel, deleteSessionCallback, transformed.plan)
        result = await retryHandler.handleNonStream(retryResponse.response.data, retryResponse.response)
        this.applyToolCallsToResponse(result, transformed)
      }
```

This retry uses the same `transformed.plan` and therefore the same immutable catalog fingerprint. It is non-streaming only and cannot retry a second time because `plan.availabilityRetryAttempted` is already true.

- [ ] **Step 8: Wire one-shot non-streaming retry for GLM**

Modify `src/main/proxy/forwarder.ts` inside `forwardGLM`, replacing:

```ts
      const result = await handler.handleNonStream(response.data, response)

      this.applyToolCallsToResponse(result, transformed)
```

with:

```ts
      let result = await handler.handleNonStream(response.data, response)

      const retry = this.applyToolCallsToResponse(result, transformed)
      if (retry && transformed.plan.catalogSnapshot?.fingerprint === retry.catalogFingerprint) {
        const retryRequest = this.buildAvailabilityRetryRequest(request, transformed, retry.clarification)
        const retryResponse = await adapter.chatCompletion({
          model: actualModel,
          originalModel: request.model,
          messages: retryRequest.messages as any,
          stream: false,
          temperature: request.temperature,
          web_search: request.web_search,
          reasoning_effort: request.reasoning_effort,
          deep_research: request.deep_research,
        })
        const retryHandler = new GLMStreamHandler(actualModel, undefined, undefined, transformed.plan as any)
        result = await retryHandler.handleNonStream(retryResponse.response.data, retryResponse.response)
        this.applyToolCallsToResponse(result, transformed)
      }
```

- [ ] **Step 9: Wire one-shot non-streaming retry for DeepSeek**

Modify `src/main/proxy/forwarder.ts` inside `forwardDeepSeek`, replacing:

```ts
      const result = await handler.handleNonStream(response.data, response)
      
      this.applyToolCallsToResponse(result, transformed)
```

with:

```ts
      let result = await handler.handleNonStream(response.data, response)

      const retry = this.applyToolCallsToResponse(result, transformed)
      if (retry && transformed.plan.catalogSnapshot?.fingerprint === retry.catalogFingerprint) {
        const retryRequest = this.buildAvailabilityRetryRequest(request, transformed, retry.clarification)
        const retryResponse = await adapter.chatCompletion({
          model: request.model,
          messages: retryRequest.messages as any,
          stream: false,
          temperature: request.temperature,
          web_search: request.web_search,
          reasoning_effort: request.reasoning_effort,
        })
        const retryHandler = new DeepSeekStreamHandler(
          actualModel,
          retryResponse.sessionId,
          deleteSessionCallback,
          retryRequest.web_search,
          retryRequest.reasoning_effort,
          transformed.plan,
          request.model
        )
        result = await retryHandler.handleNonStream(retryResponse.response.data, retryResponse.response)
        this.applyToolCallsToResponse(result, transformed)
      }
```

- [ ] **Step 10: Wire one-shot non-streaming retry for Qwen AI**

Modify `src/main/proxy/forwarder.ts` inside `forwardQwenAi`, replacing:

```ts
      const result = await handler.handleNonStream(response.data)

      this.applyToolCallsToResponse(result, transformed)
```

with:

```ts
      let result = await handler.handleNonStream(response.data)

      const retry = this.applyToolCallsToResponse(result, transformed)
      if (retry && transformed.plan.catalogSnapshot?.fingerprint === retry.catalogFingerprint) {
        const retryRequest = this.buildAvailabilityRetryRequest(request, transformed, retry.clarification)
        const retryResponse = await adapter.chatCompletion({
          model: actualModel,
          originalModel: request.model,
          messages: retryRequest.messages as any,
          stream: false,
          temperature: request.temperature,
          enable_thinking: !!request.reasoning_effort,
        })
        const retryHandler = new QwenAiStreamHandler(actualModel, undefined, transformed.plan as any)
        retryHandler.setChatId(retryResponse.chatId)
        result = await retryHandler.handleNonStream(retryResponse.response.data)
        this.applyToolCallsToResponse(result, transformed)
      }
```

- [ ] **Step 11: Verify forwarder retry code typechecks**

Run:

```powershell
npm run build
```

Expected: PASS. If this fails in one provider-specific retry block, fix that block by matching the exact adapter method arguments and response property names already used by the first-call path in the same `forward*` method. Do not add a generic provider abstraction in this task.

- [ ] **Step 12: Run diagnostics and focused regression tests**

Run:

```powershell
node --test tests/tool-calling/tool-diagnostics.test.ts tests/tool-calling/tool-engine.test.ts tests/tool-calling/runtime-plan.test.ts
```

Expected: PASS.

- [ ] **Step 13: Commit diagnostics and forwarder retry hook**

```powershell
git add src/main/proxy/forwarder.ts src/main/proxy/toolCalling/diagnostics.ts src/main/proxy/toolCalling/ToolCallingEngine.ts tests/tool-calling/tool-diagnostics.test.ts
git commit -m "feat: record tool catalog diagnostics"
```

---
