# Tool Availability Catalog Phase 2: RuntimePlan Catalog Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this phase task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Source Spec:** [`docs/superpowers/specs/2026-06-30-tool-availability-catalog-design.md`](../specs/2026-06-30-tool-availability-catalog-design.md)

**Parent Index:** [`docs/superpowers/plans/2026-06-30-tool-availability-catalog.md`](./2026-06-30-tool-availability-catalog.md)

## Phase Isolation Rule

- This document contains only Phase 2: RuntimePlan Catalog Resolution.
- Do not implement files or steps from other Phase 7 plan documents while executing or validating this phase.
- If working tree changes from another phase already exist, leave them unvalidated until their own phase review.

### Task 2: RuntimePlan Catalog Resolution

**Files:**
- Modify: `src/main/proxy/toolCalling/runtimePlan.ts`
- Modify: `src/main/proxy/toolCalling/ToolCallingEngine.ts`
- Modify: `tests/tool-calling/runtime-plan.test.ts`
- Modify: `tests/tool-calling/tool-engine.test.ts`

- [ ] **Step 1: Add failing runtime plan tests for catalog reuse and blocking**

Append to `tests/tool-calling/runtime-plan.test.ts`:

```ts
test('catalog snapshot drives allowed tools when current request omits tools', () => {
  const sessionId = `runtime-catalog-${Date.now()}-reuse`
  const first = buildToolCallingRuntimePlan({
    requestId: 'catalog-1',
    providerId: 'qwen',
    actualModel: 'qwen3',
    toolSessionKey: sessionId,
    config: {
      enabled: true,
      mode: 'force',
      clientAdapterId: 'standard-openai-tools',
      diagnosticsEnabled: false,
      advanced: { promptPreviewEnabled: false },
    },
    clientRequest: {
      clientAdapterId: 'standard-openai-tools',
      toolSource: 'openai',
      tools,
      toolChoice: { mode: 'auto' },
      diagnostics: { rawToolCount: 1, normalizedToolNames: ['weather-test:get_weather'] },
    },
    messages: [{ role: 'user', content: 'weather' }],
  })
  const second = buildToolCallingRuntimePlan({
    requestId: 'catalog-2',
    providerId: 'qwen',
    actualModel: 'qwen3',
    toolSessionKey: sessionId,
    config: {
      enabled: true,
      mode: 'force',
      clientAdapterId: 'standard-openai-tools',
      diagnosticsEnabled: false,
      advanced: { promptPreviewEnabled: false },
    },
    clientRequest: {
      clientAdapterId: 'standard-openai-tools',
      toolSource: 'none',
      tools: [],
      toolChoice: { mode: 'auto' },
      diagnostics: { rawToolCount: 0, normalizedToolNames: [] },
    },
    messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather-test:get_weather', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
    ],
  })

  assert.equal(second.mode, 'managed')
  assert.equal(second.shouldInjectPrompt, true)
  assert.equal(second.catalogSnapshot?.source, 'session_catalog')
  assert.equal(second.catalogSnapshot?.fingerprint, first.catalogSnapshot?.fingerprint)
  assert.deepEqual([...second.allowedToolNames], ['weather-test:get_weather'])
})

test('managed history without request tools or catalog blocks instead of reconstructing prompt tool names', () => {
  assert.throws(() => buildToolCallingRuntimePlan({
    requestId: 'catalog-missing',
    providerId: 'qwen',
    actualModel: 'qwen3',
    toolSessionKey: `runtime-catalog-${Date.now()}-missing`,
    config: {
      enabled: true,
      mode: 'force',
      clientAdapterId: 'standard-openai-tools',
      diagnosticsEnabled: false,
      advanced: { promptPreviewEnabled: false },
    },
    clientRequest: {
      clientAdapterId: 'standard-openai-tools',
      toolSource: 'none',
      tools: [],
      toolChoice: { mode: 'auto' },
      diagnostics: { rawToolCount: 0, normalizedToolNames: [] },
    },
    messages: [{
      role: 'system',
      content: '<|CHAT2API|tool_calls><|CHAT2API|invoke name="bash"></|CHAT2API|tool_calls>',
    }],
  }), /managed_history_requires_catalog/)
})
```

- [ ] **Step 2: Run runtime plan tests to verify failure**

Run:

```powershell
node --test tests/tool-calling/runtime-plan.test.ts
```

Expected: FAIL because `toolSessionKey` is not accepted and catalog fields are absent.

- [ ] **Step 3: Update runtimePlan input and catalog resolution**

Modify `src/main/proxy/toolCalling/runtimePlan.ts`:

```ts
import { resolveToolCatalog } from './catalog.ts'
```

Add `toolSessionKey?: string | null` to `buildToolCallingRuntimePlan` input.

Replace the existing `tools`, `toolNames`, and `allowedTools` setup with:

```ts
  const requestTools = input.clientRequest.tools
  const forcedName = input.clientRequest.toolChoice.forcedName
  const hasManagedHistory = hasExistingManagedXmlContext(input.messages)
  const historyToolNames = extractHistoryToolNames(input.messages)
  const catalogResolution = resolveToolCatalog({
    sessionId: input.toolSessionKey ?? null,
    requestTools,
    hasManagedToolHistory: hasManagedHistory,
    historyToolNames,
  })

  if (catalogResolution.blocked) {
    throw new Error(catalogResolution.diagnostics.reason ?? 'tool_catalog_blocked')
  }

  const catalogSnapshot = catalogResolution.snapshot
  const catalogTools = catalogSnapshot?.tools ?? []
  const toolNames = new Set(catalogTools.map((tool) => tool.name))
```

Then keep forced-tool validation, but validate against `catalogTools`:

```ts
  if (input.clientRequest.toolChoice.mode === 'forced' && forcedName && !toolNames.has(forcedName)) {
    throw new Error(`Forced tool ${forcedName} is not declared`)
  }

  const allowedToolNames = forcedName ? new Set([forcedName]) : toolNames
  const allowedTools = forcedName ? catalogTools.filter((tool) => tool.name === forcedName) : catalogTools
```

Remove the old `effectiveTools` and `extractToolNamesFromMessages` fallback. The returned plan must use `allowedTools` and `allowedToolNames`:

```ts
    tools: allowedTools,
    allowedToolNames,
    catalogSnapshot,
    catalogDiagnostics: catalogResolution.diagnostics,
    availabilityRetryAllowed: profile.availabilityDriftRetry === 'enabled',
```

Add diagnostics fields:

```ts
      catalogSource: catalogResolution.diagnostics.source,
      catalogFingerprint: catalogSnapshot?.fingerprint,
      catalogDriftKinds: catalogResolution.diagnostics.driftKinds,
      catalogBlocked: catalogResolution.diagnostics.blocked,
```

Replace `extractToolNamesFromMessages` with:

```ts
const TOOL_CALL_NAME_REGEX = /"name"\s*:\s*"([^"]+)"/g
const MANAGED_INVOKE_NAME_REGEX = /<\|CHAT2API\|invoke\s+name="([^"]+)"/g

function extractHistoryToolNames(messages?: ChatMessage[]): string[] {
  if (!messages) return []
  const names = new Set<string>()

  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const call of msg.tool_calls) {
        if (call.function?.name) names.add(call.function.name)
      }
    }
    if (msg.role === 'system' && typeof msg.content === 'string') {
      collectRegexMatches(msg.content, MANAGED_INVOKE_NAME_REGEX, names)
    }
    if (msg.role === 'assistant' && typeof msg.content === 'string') {
      collectRegexMatches(msg.content, MANAGED_INVOKE_NAME_REGEX, names)
      collectRegexMatches(msg.content, TOOL_CALL_NAME_REGEX, names)
    }
  }

  return [...names].sort()
}

function collectRegexMatches(text: string, regex: RegExp, output: Set<string>): void {
  regex.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    output.add(match[1])
  }
}
```

- [ ] **Step 4: Update provider profile type for retry flag**

Modify `src/main/proxy/toolCalling/providerProfiles.ts`:

```ts
  contractHeaderVersion: number
  availabilityDriftRetry: 'enabled' | 'disabled'
```

Add to `chat2ApiXmlHistoryProfile`:

```ts
  contractHeaderVersion: 1,
  availabilityDriftRetry: 'enabled',
```

- [ ] **Step 5: Update ToolCallingEngine transform input**

Modify `src/main/proxy/toolCalling/ToolCallingEngine.ts` `transformRequest` input type:

```ts
    toolSessionKey?: string | null
```

Pass it into `buildToolCallingRuntimePlan`:

```ts
      toolSessionKey: input.toolSessionKey ?? input.requestId ?? null,
```

- [ ] **Step 6: Add ToolCallingEngine regression for no prompt reconstruction**

Append to `tests/tool-calling/tool-engine.test.ts`:

```ts
test('managed history without catalog is blocked instead of reconstructing tools from old prompt', () => {
  const engine = new ToolCallingEngine()

  assert.throws(() => engine.transformRequest({
    request: request({
      tools: undefined,
      messages: [{
        role: 'system',
        content: '<|CHAT2API|tool_calls><|CHAT2API|invoke name="bash"></|CHAT2API|tool_calls>',
      }],
    }),
    provider,
    actualModel: 'deepseek-chat',
    toolSessionKey: `engine-catalog-${Date.now()}-missing`,
  }), /managed_history_requires_catalog/)
})
```

- [ ] **Step 7: Run focused tests**

Run:

```powershell
node --test tests/tool-calling/tool-catalog.test.ts tests/tool-calling/runtime-plan.test.ts tests/tool-calling/tool-engine.test.ts tests/tool-calling/provider-profiles.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit runtime plan integration**

```powershell
git add src/main/proxy/toolCalling/runtimePlan.ts src/main/proxy/toolCalling/ToolCallingEngine.ts src/main/proxy/toolCalling/providerProfiles.ts tests/tool-calling/runtime-plan.test.ts tests/tool-calling/tool-engine.test.ts
git commit -m "feat: plan tool turns from catalog snapshots"
```

---
