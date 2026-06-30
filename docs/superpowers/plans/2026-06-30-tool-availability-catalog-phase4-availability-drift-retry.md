# Tool Availability Catalog Phase 4: Non-Streaming Availability Drift Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this phase task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Source Spec:** [`docs/superpowers/specs/2026-06-30-tool-availability-catalog-design.md`](../specs/2026-06-30-tool-availability-catalog-design.md)

**Parent Index:** [`docs/superpowers/plans/2026-06-30-tool-availability-catalog.md`](./2026-06-30-tool-availability-catalog.md)

## Phase Isolation Rule

- This document contains only Phase 4: Non-Streaming Availability Drift Retry.
- Do not implement files or steps from other Phase 7 plan documents while executing or validating this phase.
- If working tree changes from another phase already exist, leave them unvalidated until their own phase review.

### Task 4: Non-Streaming Availability Drift Retry

**Files:**
- Create: `src/main/proxy/toolCalling/availabilityDrift.ts`
- Modify: `src/main/proxy/toolCalling/types.ts`
- Modify: `src/main/proxy/toolCalling/ToolCallingEngine.ts`
- Modify: `tests/tool-calling/tool-engine.test.ts`

- [ ] **Step 1: Add failing availability drift unit behavior through engine**

Append to `tests/tool-calling/tool-engine.test.ts`:

```ts
test('non-stream response denying an available tool marks one availability retry request', () => {
  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: `engine-catalog-${Date.now()}-drift`,
  })
  const result: any = {
    choices: [{
      message: {
        role: 'assistant',
        content: 'I cannot use default_api:read_file because that tool is not available in this conversation.',
      },
      finish_reason: 'stop',
    }],
  }

  const retry = engine.applyNonStreamResponse(result, transformed.plan)

  assert.equal(retry?.type, 'availability_retry')
  assert.equal(retry?.catalogFingerprint, transformed.plan.catalogSnapshot?.fingerprint)
  assert.equal(transformed.plan.availabilityRetryAttempted, true)
  assert.equal(transformed.plan.diagnostics.availabilityDriftDetected, true)
  assert.equal(transformed.plan.diagnostics.availabilityRetryResult, 'attempted')
})

test('availability drift retry does not trigger twice for one plan', () => {
  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: `engine-catalog-${Date.now()}-drift-once`,
  })
  const result: any = {
    choices: [{
      message: {
        role: 'assistant',
        content: 'The default_api:read_file tool does not exist.',
      },
      finish_reason: 'stop',
    }],
  }

  const first = engine.applyNonStreamResponse(result, transformed.plan)
  const second = engine.applyNonStreamResponse(result, transformed.plan)

  assert.equal(first?.type, 'availability_retry')
  assert.equal(second, undefined)
  assert.equal(transformed.plan.diagnostics.availabilityRetryResult, 'skipped')
})

test('availability drift retry does not trigger when valid tool_calls were parsed', () => {
  const engine = new ToolCallingEngine()
  const transformed = engine.transformRequest({
    request: request(),
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: `engine-catalog-${Date.now()}-drift-valid`,
  })
  const result: any = {
    choices: [{
      message: {
        role: 'assistant',
        content: '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="argument"><![CDATA[{}]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
      },
      finish_reason: 'stop',
    }],
  }

  const retry = engine.applyNonStreamResponse(result, transformed.plan)

  assert.equal(retry, undefined)
  assert.equal(result.choices[0].finish_reason, 'tool_calls')
  assert.equal(transformed.plan.diagnostics.availabilityDriftDetected, undefined)
})
```

- [ ] **Step 2: Run failing engine tests**

Run:

```powershell
node --test tests/tool-calling/tool-engine.test.ts
```

Expected: FAIL because `applyNonStreamResponse` returns `void` and no retry detector exists.

- [ ] **Step 3: Add availability drift types**

Modify `src/main/proxy/toolCalling/types.ts`:

```ts
export interface AvailabilityRetryRequest {
  type: 'availability_retry'
  catalogFingerprint: string
  clarification: string
}
```

Extend `ToolCallDiagnostics`:

```ts
  availabilityDriftDetected?: boolean
  availabilityRetryResult?: 'skipped' | 'attempted' | 'succeeded' | 'failed'
```

- [ ] **Step 4: Implement drift detector**

Create `src/main/proxy/toolCalling/availabilityDrift.ts`:

```ts
import type { ToolCallingPlan } from './types.ts'

export interface AvailabilityDriftDetection {
  detected: boolean
  deniedToolName?: string
}

const UNAVAILABLE_PATTERNS = [
  /\btool(?:s)?\b[\s\S]{0,80}\b(?:not available|unavailable|not provided|not found|does not exist|don't exist|do not exist)\b/i,
  /\b(?:not available|unavailable|not provided|not found|does not exist|don't exist|do not exist)\b[\s\S]{0,80}\btool(?:s)?\b/i,
  /不存在.{0,20}工具|工具.{0,20}不存在|没有.{0,20}工具|未提供.{0,20}工具/i,
]

export function detectAvailabilityDrift(plan: ToolCallingPlan, rawAssistantText: string): AvailabilityDriftDetection {
  if (!plan.catalogSnapshot || plan.catalogSnapshot.allowedToolNames.length === 0) {
    return { detected: false }
  }

  const matched = UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(rawAssistantText))
  if (!matched) return { detected: false }

  const lowerText = rawAssistantText.toLowerCase()
  const deniedToolName = plan.catalogSnapshot.allowedToolNames.find((name) => lowerText.includes(name.toLowerCase()))
  if (deniedToolName) {
    return { detected: true, deniedToolName }
  }

  return { detected: true }
}

export function buildAvailabilityRetryClarification(plan: ToolCallingPlan): string {
  return [
    'Tool availability clarification:',
    `catalog_fingerprint: ${plan.catalogSnapshot?.fingerprint ?? ''}`,
    `available_tools: ${plan.catalogSnapshot?.allowedToolNames.join(', ') ?? ''}`,
    'The runtime-provided catalog in this clarification is authoritative for this turn. Use only tools listed in that catalog when a tool call is needed.',
  ].join('\n')
}
```

- [ ] **Step 5: Return retry request from non-stream response mapping**

Modify `src/main/proxy/toolCalling/ToolCallingEngine.ts`:

```ts
import { buildAvailabilityRetryClarification, detectAvailabilityDrift } from './availabilityDrift.ts'
import type { AvailabilityRetryRequest } from './types.ts'
```

Change method signature:

```ts
  applyNonStreamResponse(result: any, plan: ToolCallingPlan): AvailabilityRetryRequest | undefined {
```

For early non-parse return:

```ts
    if (!plan.shouldParseResponse) return undefined
```

After the `plain_text` branch sets parser diagnostics, add:

```ts
      return maybeBuildAvailabilityRetry(message.content, plan)
```

After successful tool call assembly, set retry result if needed:

```ts
    if (plan.availabilityRetryAttempted) {
      plan.diagnostics.availabilityRetryResult = 'succeeded'
    }
```

Add helper:

```ts
function maybeBuildAvailabilityRetry(content: string, plan: ToolCallingPlan): AvailabilityRetryRequest | undefined {
  if (!plan.availabilityRetryAllowed || plan.availabilityRetryAttempted || !plan.catalogSnapshot) {
    if (plan.availabilityRetryAttempted) {
      plan.diagnostics.availabilityRetryResult = 'skipped'
    }
    return undefined
  }

  const detection = detectAvailabilityDrift(plan, content)
  if (!detection.detected) return undefined

  plan.availabilityRetryAttempted = true
  plan.diagnostics.availabilityDriftDetected = true
  plan.diagnostics.availabilityRetryResult = 'attempted'

  return {
    type: 'availability_retry',
    catalogFingerprint: plan.catalogSnapshot.fingerprint,
    clarification: buildAvailabilityRetryClarification(plan),
  }
}
```

This task only creates the retry request object. It does not perform a second provider call yet.

- [ ] **Step 6: Run focused tests**

Run:

```powershell
node --test tests/tool-calling/tool-engine.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit availability drift detector**

```powershell
git add src/main/proxy/toolCalling/availabilityDrift.ts src/main/proxy/toolCalling/ToolCallingEngine.ts src/main/proxy/toolCalling/types.ts tests/tool-calling/tool-engine.test.ts
git commit -m "feat: detect tool availability drift"
```

---
