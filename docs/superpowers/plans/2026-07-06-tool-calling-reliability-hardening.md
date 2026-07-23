# Tool Calling Reliability Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden managed tool-calling so multi-turn sessions keep tool definitions, protocol drift stays safe, invalid tool calls are rejected structurally, and empty provider output becomes visible diagnostics instead of a silent assistant response.

**Architecture:** Keep `ToolCallingEngine` as the single owner of prompt injection and non-stream parsing. Add one immutable per-turn contract view to the existing `ToolCallingPlan`, preserve tool exchange metadata through context trimming, align structural validation and stream observations around the selected protocol, and add explicit empty-output inspection at forwarder boundaries.

**Tech Stack:** TypeScript, Electron main process, Node `node:test`, existing `toolCalling/*`, `toolRuntime/*`, provider adapters, and OpenAI-compatible chat completion response shapes.

---

## File Structure

- Modify `src/main/proxy/toolCalling/types.ts`
  - Add contract, source-chain, terminal-outcome, and validation diagnostic types.
  - Extend `ToolCallingPlan` with a `contract` field derived from existing plan facts.
- Modify `src/main/proxy/toolCalling/runtimePlan.ts`
  - Build the immutable `ToolTurnContract` once while constructing the runtime plan.
  - Record the exact tool source chain used by the current turn.
- Modify `src/main/proxy/toolCalling/providerProfiles.ts`
  - Make managed prompt owner, stream/non-stream parse support, empty-output policy, and history preservation explicit provider-profile facts.
- Modify `src/main/proxy/toolCalling/diagnostics.ts`
  - Add safe event fields for contract source chain, terminal outcome, parser suppression, and validation failure category.
  - Keep redaction behavior: no full arguments, no full schemas, no prompt bodies.
- Modify `src/main/proxy/contextMessageMetadata.ts`
  - Add a helper that restores complete assistant/tool exchange pairs when context strategies retain only one side.
- Modify `src/main/proxy/services/contextManagementService.ts`
  - Apply tool-exchange preservation after each context strategy.
- Modify `src/main/proxy/toolRuntime/data/validation/ToolCallValidator.ts`
  - Record structural validation categories for invalid tool names, invalid required fields, non-object JSON payloads where applicable, and malformed argument containers.
- Modify `src/main/proxy/toolCalling/ToolStreamParser.ts`
  - Track stream observation facts: raw content seen, content emitted, tool calls emitted, invalid buffer suppressed, and buffer flush behavior.
- Create `src/main/proxy/toolCalling/outputInspection.ts`
  - Provide a small non-stream output inspector that classifies content/tool-call/empty outcomes and records diagnostics.
- Modify `src/main/proxy/forwarder.ts`
  - Call the output inspector after non-stream managed tool post-processing.
  - Return a visible `ForwardResult` failure when a managed turn has no content and no tool calls unless the provider profile explicitly allows intentional silence.
- Modify tests:
  - `tests/tool-calling/runtime-plan.test.ts`
  - `tests/tool-calling/provider-profiles.test.ts`
  - `tests/tool-calling/tool-diagnostics.test.ts`
  - `tests/providers/context-tool-metadata.test.ts`
  - `tests/tool-calling/tool-stream-parser.test.ts`
  - `tests/tool-calling/tool-parser.test.ts`
  - Create `tests/tool-calling/output-inspection.test.ts`

## Task 1: Runtime Contract and Provider Profile Facts

**Files:**
- Modify: `src/main/proxy/toolCalling/types.ts`
- Modify: `src/main/proxy/toolCalling/runtimePlan.ts`
- Modify: `src/main/proxy/toolCalling/providerProfiles.ts`
- Modify: `src/main/proxy/toolCalling/diagnostics.ts`
- Test: `tests/tool-calling/runtime-plan.test.ts`
- Test: `tests/tool-calling/provider-profiles.test.ts`
- Test: `tests/tool-calling/tool-diagnostics.test.ts`

- [ ] **Step 1: Add failing runtime-plan tests for contract facts**

Append these tests to `tests/tool-calling/runtime-plan.test.ts`:

```ts
test('managed runtime plan exposes immutable per-turn contract facts', () => {
  const plan = buildToolCallingRuntimePlan({
    requestId: 'contract-r1',
    providerId: 'qwen',
    actualModel: 'qwen3-coder',
    model: 'qwen/qwen3-coder',
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
    toolSessionKey: 'contract-session',
    messages: [{ role: 'user', content: 'weather' }],
  })

  assert.equal(plan.contract.turnId, 'contract-r1')
  assert.equal(plan.contract.sessionId, 'contract-session')
  assert.equal(plan.contract.providerId, 'qwen')
  assert.equal(plan.contract.model, 'qwen/qwen3-coder')
  assert.equal(plan.contract.protocol, 'managed_xml')
  assert.equal(plan.contract.snapshotFingerprint, plan.catalogSnapshot?.fingerprint)
  assert.deepEqual([...plan.contract.allowedToolNames], ['weather-test:get_weather'])
  assert.equal(plan.contract.shouldInjectPrompt, true)
  assert.equal(plan.contract.shouldParseResponse, true)
  assert.equal(plan.contract.historyMode, 'managed_protocol')
  assert.equal(plan.contract.emptyOutputPolicy, 'diagnose_and_fail')
  assert.deepEqual(plan.contract.toolSourceChain, ['current_request'])
  assert.throws(() => {
    ;(plan.contract.tools as any).push(tools[0])
  }, /object is not extensible|Cannot add property/)
})

test('safe empty fallback is visible in contract source chain', () => {
  const plan = buildToolCallingRuntimePlan({
    requestId: 'contract-empty',
    providerId: 'qwen',
    actualModel: 'qwen3-coder',
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
    toolSessionKey: 'contract-empty-session',
    messages: [{ role: 'user', content: 'hello' }],
  })

  assert.equal(plan.mode, 'disabled')
  assert.equal(plan.contract.snapshotFingerprint, null)
  assert.deepEqual(plan.contract.toolSourceChain, ['current_request', 'session_catalog', 'message_history', 'safe_empty'])
  assert.equal(plan.contract.emptyOutputPolicy, 'diagnose_and_fail')
  assert.equal(plan.diagnostics.catalogSource, 'none')
})
```

- [ ] **Step 2: Run runtime-plan tests and verify they fail**

Run:

```powershell
node --test tests/tool-calling/runtime-plan.test.ts
```

Expected: FAIL because `plan.contract` and `toolSourceChain` do not exist.

- [ ] **Step 3: Add failing provider-profile tests**

Append this test to `tests/tool-calling/provider-profiles.test.ts`:

```ts
test('managed provider profiles expose parser ownership and empty output policy facts', () => {
  for (const providerId of ['glm', 'qwen', 'qwen-ai']) {
    const profile = getProviderToolProfile(providerId)

    assert.equal(profile.managedPromptOwner, 'ToolCallingEngine')
    assert.equal(profile.parseStreaming, true)
    assert.equal(profile.parseNonStreaming, true)
    assert.equal(profile.supportsIntentionalEmptyOutput, false)
    assert.equal(profile.preservesToolHistory, true)
  }
})
```

- [ ] **Step 4: Run provider-profile tests and verify they fail**

Run:

```powershell
node --test tests/tool-calling/provider-profiles.test.ts
```

Expected: FAIL because the new provider-profile facts do not exist.

- [ ] **Step 5: Add failing diagnostic tests for contract fields**

Append this test to `tests/tool-calling/tool-diagnostics.test.ts`:

```ts
test('tool diagnostic events keep contract facts and redact payload detail', () => {
  clearToolDiagnosticEvents()
  recordToolDiagnosticEvent({
    type: 'tool_contract_resolved',
    requestId: 'diag-contract',
    providerId: 'glm',
    model: 'glm-5',
    catalogSource: 'none',
    catalogFingerprint: undefined,
    toolNames: [],
    toolSourceChain: ['current_request', 'session_catalog', 'message_history', 'safe_empty'],
    protocol: 'managed_xml',
    responseMode: 'non_streaming',
    terminalOutcome: 'provider_empty',
    validationFailureKind: 'unknown_tool_name',
    suppressedReason: 'invalid_tool_name',
    argumentsText: '{"secret":"value"}',
    fullSchema: { type: 'object', properties: { secret: { type: 'string' } } },
    prompt: 'do not store this',
  } as any)

  const [event] = getToolDiagnosticEvents()
  assert.equal(event.type, 'tool_contract_resolved')
  assert.deepEqual(event.toolSourceChain, ['current_request', 'session_catalog', 'message_history', 'safe_empty'])
  assert.equal(event.terminalOutcome, 'provider_empty')
  assert.equal(event.validationFailureKind, 'unknown_tool_name')
  assert.equal(event.suppressedReason, 'invalid_tool_name')
  assert.equal((event as any).argumentsText, undefined)
  assert.equal((event as any).fullSchema, undefined)
  assert.equal((event as any).prompt, undefined)
})
```

- [ ] **Step 6: Run diagnostic tests and verify they fail**

Run:

```powershell
node --test tests/tool-calling/tool-diagnostics.test.ts
```

Expected: FAIL because `tool_contract_resolved`, `toolSourceChain`, `terminalOutcome`, `validationFailureKind`, and `suppressedReason` are not typed or copied.

- [ ] **Step 7: Implement contract and diagnostic types**

In `src/main/proxy/toolCalling/types.ts`, add these types after `ToolCatalogSource`:

```ts
export type ToolContractSourceStep =
  | 'current_request'
  | 'session_catalog'
  | 'message_history'
  | 'safe_empty'

export type ToolContractHistoryMode = 'openai_native' | 'managed_protocol'

export type EmptyOutputPolicy = 'diagnose_and_fail' | 'pass_through_without_tool_semantics'

export type ProviderTurnOutcome =
  | 'content'
  | 'tool_calls'
  | 'provider_empty'
  | 'runtime_suppressed_malformed_tool_output'
  | 'adapter_parse_error'
  | 'provider_error'

export interface ToolTurnContract {
  turnId: string
  sessionId: string | null
  providerId: string
  model: string
  protocol: ToolProtocolId
  snapshotFingerprint: string | null
  tools: ReadonlyArray<NormalizedToolDefinition>
  allowedToolNames: ReadonlySet<string>
  toolChoiceMode: 'auto' | 'none' | 'required' | 'forced'
  forcedToolName?: string
  shouldInjectPrompt: boolean
  shouldParseResponse: boolean
  historyMode: ToolContractHistoryMode
  emptyOutputPolicy: EmptyOutputPolicy
  toolSourceChain: ReadonlyArray<ToolContractSourceStep>
}
```

In the same file, extend `ToolCallDiagnostics` with:

```ts
  turnId?: string
  toolSourceChain?: ToolContractSourceStep[]
  terminalOutcome?: ProviderTurnOutcome
  emptyOutputPolicy?: EmptyOutputPolicy
  validationFailureKind?: string
  suppressedReason?: string
```

In the same file, extend `ToolCallingPlan` with:

```ts
  contract: ToolTurnContract
```

- [ ] **Step 8: Implement provider profile facts**

In `src/main/proxy/toolCalling/providerProfiles.ts`, extend `ProviderToolProfile`:

```ts
  managedPromptOwner: 'ToolCallingEngine'
  parseStreaming: boolean
  parseNonStreaming: boolean
  supportsIntentionalEmptyOutput: boolean
  preservesToolHistory: boolean
```

In `chat2ApiXmlHistoryProfile`, add:

```ts
  managedPromptOwner: 'ToolCallingEngine',
  parseStreaming: true,
  parseNonStreaming: true,
  supportsIntentionalEmptyOutput: false,
  preservesToolHistory: true,
```

- [ ] **Step 9: Build the immutable contract in runtimePlan**

In `src/main/proxy/toolCalling/runtimePlan.ts`, update imports:

```ts
import type {
  ToolCallingPlan,
  ToolCatalogSource,
  ToolContractSourceStep,
  ToolTurnContract,
} from './types.ts'
```

Add these helpers near the bottom of the file:

```ts
function buildToolSourceChain(source: ToolCatalogSource): ToolContractSourceStep[] {
  if (source === 'current_request') return ['current_request']
  if (source === 'session_catalog') return ['current_request', 'session_catalog']
  if (source === 'restored_from_history') return ['current_request', 'session_catalog', 'message_history']
  return ['current_request', 'session_catalog', 'message_history', 'safe_empty']
}

function freezeContract(contract: ToolTurnContract): ToolTurnContract {
  return Object.freeze({
    ...contract,
    tools: Object.freeze(contract.tools.map((tool) => Object.freeze({
      ...tool,
      parameters: Object.freeze({ ...tool.parameters }),
    }))),
    allowedToolNames: Object.freeze(new Set(contract.allowedToolNames)),
    toolSourceChain: Object.freeze([...contract.toolSourceChain]),
  })
}
```

Inside `buildToolCallingRuntimePlan`, before `return`, create the contract:

```ts
  const toolSourceChain = buildToolSourceChain(catalogResolution.diagnostics.source)
  const contract = freezeContract({
    turnId: input.requestId ?? `${input.providerId}:${input.actualModel ?? input.model ?? 'unknown'}`,
    sessionId: input.toolSessionKey ?? null,
    providerId: input.providerId,
    model: input.model ?? input.actualModel ?? '',
    protocol,
    snapshotFingerprint: catalogResolution.snapshot?.fingerprint ?? null,
    tools: allowedTools,
    allowedToolNames,
    toolChoiceMode: input.clientRequest.toolChoice.mode,
    forcedToolName: forcedName,
    shouldInjectPrompt,
    shouldParseResponse,
    historyMode: mode === 'managed' ? 'managed_protocol' : 'openai_native',
    emptyOutputPolicy: profile.supportsIntentionalEmptyOutput
      ? 'pass_through_without_tool_semantics'
      : 'diagnose_and_fail',
    toolSourceChain,
  })
```

Add `contract` to the returned plan and add these diagnostic fields:

```ts
      turnId: contract.turnId,
      toolSourceChain,
      emptyOutputPolicy: contract.emptyOutputPolicy,
```

- [ ] **Step 10: Implement diagnostic event fields**

In `src/main/proxy/toolCalling/diagnostics.ts`, import the new types:

```ts
import type {
  EmptyOutputPolicy,
  ProviderTurnOutcome,
  ToolContractSourceStep,
} from './types.ts'
```

Extend `ToolDiagnosticEventType` with:

```ts
  | 'tool_contract_resolved'
  | 'tool_validation_failed'
  | 'tool_stream_buffer_suppressed'
```

Extend `ToolDiagnosticEvent` with:

```ts
  toolSourceChain?: ToolContractSourceStep[]
  terminalOutcome?: ProviderTurnOutcome
  emptyOutputPolicy?: EmptyOutputPolicy
  validationFailureKind?: string
  suppressedReason?: string
```

In `recordToolDiagnosticEvent`, copy only safe fields:

```ts
    toolSourceChain: event.toolSourceChain ? [...event.toolSourceChain] : undefined,
    terminalOutcome: event.terminalOutcome,
    emptyOutputPolicy: event.emptyOutputPolicy,
    validationFailureKind: event.validationFailureKind,
    suppressedReason: event.suppressedReason,
```

In `getToolDiagnosticEvents`, clone `toolSourceChain`:

```ts
    toolSourceChain: event.toolSourceChain ? [...event.toolSourceChain] : undefined,
```

- [ ] **Step 11: Run focused tests**

Run:

```powershell
node --test tests/tool-calling/runtime-plan.test.ts tests/tool-calling/provider-profiles.test.ts tests/tool-calling/tool-diagnostics.test.ts
```

Expected: PASS.

- [ ] **Step 12: Commit Task 1**

Run:

```powershell
git add src/main/proxy/toolCalling/types.ts src/main/proxy/toolCalling/runtimePlan.ts src/main/proxy/toolCalling/providerProfiles.ts src/main/proxy/toolCalling/diagnostics.ts tests/tool-calling/runtime-plan.test.ts tests/tool-calling/provider-profiles.test.ts tests/tool-calling/tool-diagnostics.test.ts
git commit -m "feat: add managed tool turn contract facts"
```

## Task 2: Preserve Tool Exchange Pairs Through Context Management

**Files:**
- Modify: `src/main/proxy/contextMessageMetadata.ts`
- Modify: `src/main/proxy/services/contextManagementService.ts`
- Test: `tests/providers/context-tool-metadata.test.ts`

- [ ] **Step 1: Add failing context-management tests**

Append these tests to `tests/providers/context-tool-metadata.test.ts`:

```ts
import { createContextManagementService } from '../../src/main/proxy/services/contextManagementService.ts'

test('sliding window keeps assistant tool call when retained tool result references it', async () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'read file' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_keep',
        type: 'function',
        function: { name: 'default_api:read_file', arguments: '{"filePath":"/tmp/a"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_keep', content: 'file body' },
    { role: 'user', content: 'continue' },
  ]

  const service = createContextManagementService({
    enabled: true,
    strategies: {
      slidingWindow: { enabled: true, maxMessages: 3 },
      tokenLimit: { enabled: false, maxTokens: 4000 },
      summary: { enabled: false, keepRecentMessages: 20 },
    },
    executionOrder: ['slidingWindow'],
  })

  const result = await service.process(messages)
  assert.ok(result.messages.some((message) => message.role === 'assistant' && message.tool_calls?.[0]?.id === 'call_keep'))
  assert.ok(result.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_keep'))
})

test('token limit keeps tool result when retained assistant tool call references it', async () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'system' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_token',
        type: 'function',
        function: { name: 'default_api:read_file', arguments: '{"filePath":"/tmp/a"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_token', content: 'file body' },
    { role: 'user', content: 'x'.repeat(200) },
  ]

  const service = createContextManagementService({
    enabled: true,
    strategies: {
      slidingWindow: { enabled: false, maxMessages: 20 },
      tokenLimit: { enabled: true, maxTokens: 50 },
      summary: { enabled: false, keepRecentMessages: 20 },
    },
    executionOrder: ['tokenLimit'],
  })

  const result = await service.process(messages)
  assert.ok(result.messages.some((message) => message.role === 'assistant' && message.tool_calls?.[0]?.id === 'call_token'))
  assert.ok(result.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_token'))
})
```

- [ ] **Step 2: Run context metadata tests and verify they fail**

Run:

```powershell
node --test tests/providers/context-tool-metadata.test.ts
```

Expected: FAIL because the context strategies can retain only one side of a tool exchange.

- [ ] **Step 3: Add tool exchange preservation helper**

In `src/main/proxy/contextMessageMetadata.ts`, add:

```ts
export function preserveToolExchangePairs(
  originalMessages: ChatMessage[],
  processedMessages: ChatMessage[],
): ChatMessage[] {
  const retained = [...processedMessages]
  const retainedKeys = new Set(retained.map(messageIdentity))
  const neededToolCallIds = new Set<string>()

  for (const message of retained) {
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) {
        neededToolCallIds.add(call.id)
      }
    }
    if (message.role === 'tool' && message.tool_call_id) {
      neededToolCallIds.add(message.tool_call_id)
    }
  }

  if (neededToolCallIds.size === 0) return retained

  const additions = originalMessages.filter((message) => {
    if (retainedKeys.has(messageIdentity(message))) return false
    if (message.role === 'assistant') {
      return (message.tool_calls ?? []).some((call) => neededToolCallIds.has(call.id))
    }
    if (message.role === 'tool' && message.tool_call_id) {
      return neededToolCallIds.has(message.tool_call_id)
    }
    return false
  })

  if (additions.length === 0) return retained

  const ordered = originalMessages.filter((message) => {
    const key = messageIdentity(message)
    return retainedKeys.has(key) || additions.some((addition) => messageIdentity(addition) === key)
  })

  return ordered
}

function messageIdentity(message: ChatMessage): string {
  const toolCallIds = (message.tool_calls ?? []).map((call) => call.id).join(',')
  return [
    message.role,
    stableContent(message.content),
    message.tool_call_id ?? '',
    toolCallIds,
  ].join('\u0000')
}
```

- [ ] **Step 4: Apply helper after each context strategy**

In `src/main/proxy/services/contextManagementService.ts`, update imports:

```ts
import { preserveToolExchangePairs } from '../contextMessageMetadata'
```

Inside `ContextManagementService.process`, replace:

```ts
      strategyResults.push(result)
      currentMessages = result.messages
```

with:

```ts
      const preservedMessages = preserveToolExchangePairs(currentMessages as ChatMessage[], result.messages as ChatMessage[])
      result = {
        ...result,
        messages: preservedMessages,
        processedCount: preservedMessages.length,
        trimmed: preservedMessages.length < result.originalCount,
      }

      strategyResults.push(result)
      currentMessages = result.messages
```

- [ ] **Step 5: Run context metadata tests**

Run:

```powershell
node --test tests/providers/context-tool-metadata.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

Run:

```powershell
git add src/main/proxy/contextMessageMetadata.ts src/main/proxy/services/contextManagementService.ts tests/providers/context-tool-metadata.test.ts
git commit -m "fix: preserve tool exchanges during context trimming"
```

## Task 3: Structural Validation Diagnostics for Bad Tool Calls

**Files:**
- Modify: `src/main/proxy/toolRuntime/data/validation/ToolCallValidator.ts`
- Modify: `src/main/proxy/toolCalling/ToolCallingEngine.ts`
- Test: `tests/tool-calling/tool-parser.test.ts`
- Test: `tests/tool-calling/tool-diagnostics.test.ts`

- [ ] **Step 1: Add failing parser/validator tests for invalid arguments**

Append these tests to `tests/tool-calling/tool-parser.test.ts`:

```ts
test('managed xml rejects required object parameter with empty payload', () => {
  const objectTool = [{
    name: 'default_api:write_json',
    description: 'Write JSON',
    parameters: {
      type: 'object',
      properties: { data: { type: 'object' } },
      required: ['data'],
    },
    source: 'openai' as const,
  }]

  const result = managedXmlProtocol.parse(
    '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:write_json"><|CHAT2API|parameter name="data"></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>',
    { tools: objectTool, protocol: 'managed_xml' },
  )

  assert.equal(result.toolCalls.length, 0)
})

test('managed bracket rejects array arguments for object-shaped tool calls', () => {
  const result = managedBracketProtocol.parse(
    '[function_calls][call:default_api:read_file]["/tmp/a"][/call][/function_calls]',
    { tools, protocol: 'managed_bracket' },
  )

  assert.equal(result.toolCalls.length, 0)
  assert.equal(result.malformedReason, 'arguments_not_object')
})
```

- [ ] **Step 2: Run parser tests and verify the new bracket test fails**

Run:

```powershell
node --test tests/tool-calling/tool-parser.test.ts
```

Expected: FAIL because bracket parser currently passes raw argument text to `buildToolCall` and does not expose `arguments_not_object`.

- [ ] **Step 3: Add malformed reason support to shared parser output**

Open `src/main/proxy/toolCalling/protocols/shared.ts`. Update `buildToolCall` so JSON-like bracket payloads must parse to an object before returning a tool call. The implementation should follow this shape:

```ts
export function tryParseObjectArguments(rawArguments: string): { ok: true; argumentsText: string } | { ok: false; reason: string } {
  try {
    const parsed = JSON.parse(rawArguments)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'arguments_not_object' }
    }
    return { ok: true, argumentsText: JSON.stringify(parsed) }
  } catch {
    return { ok: false, reason: 'arguments_invalid_json' }
  }
}
```

In `managedBracketProtocol.parse`, replace direct `buildToolCall(...)` usage with:

```ts
        const parsedArguments = tryParseObjectArguments(callMatch[2])
        if (!parsedArguments.ok) {
          return createParseResult({
            content,
            toolCalls: [],
            protocol: 'managed_bracket',
            rawMatches,
            invalidToolNames,
            malformedReason: parsedArguments.reason,
          })
        }

        toolCalls.push(buildToolCall(
          `call_${toolCalls.length}`,
          toolCalls.length,
          name,
          parsedArguments.argumentsText,
          callMatch[0],
          context.tools,
        ))
```

- [ ] **Step 4: Record structural validation failures in ToolCallingEngine**

In `src/main/proxy/toolCalling/ToolCallingEngine.ts`, inside the `validation.status === 'invalid_structure'` branch of `applyNonStreamResponse`, add a diagnostic event before returning:

```ts
      recordToolDiagnosticEvent({
        type: 'tool_validation_failed',
        requestId: plan.diagnostics.requestId,
        providerId: plan.providerId,
        model: plan.diagnostics.actualModel ?? plan.diagnostics.model,
        catalogFingerprint: plan.catalogSnapshot?.fingerprint,
        protocol: plan.protocol,
        responseMode: 'non_streaming',
        validationFailureKind: validation.failure.kind,
      })
```

Also set:

```ts
      plan.diagnostics.validationFailureKind = validation.failure.kind
```

- [ ] **Step 5: Add diagnostic assertion for validation failure**

Append this test to `tests/tool-calling/tool-diagnostics.test.ts`:

```ts
test('validation failure diagnostic records only failure category', () => {
  clearToolDiagnosticEvents()
  recordToolDiagnosticEvent({
    type: 'tool_validation_failed',
    requestId: 'bad-call',
    providerId: 'qwen',
    model: 'qwen3',
    protocol: 'managed_xml',
    responseMode: 'non_streaming',
    validationFailureKind: 'schema_validation_failed',
    argumentsText: '{"secret":"value"}',
  } as any)

  const [event] = getToolDiagnosticEvents()
  assert.equal(event.type, 'tool_validation_failed')
  assert.equal(event.validationFailureKind, 'schema_validation_failed')
  assert.equal((event as any).argumentsText, undefined)
})
```

- [ ] **Step 6: Run parser and diagnostic tests**

Run:

```powershell
node --test tests/tool-calling/tool-parser.test.ts tests/tool-calling/tool-diagnostics.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

Run:

```powershell
git add src/main/proxy/toolCalling/protocols/shared.ts src/main/proxy/toolCalling/protocols/managedBracket.ts src/main/proxy/toolCalling/ToolCallingEngine.ts tests/tool-calling/tool-parser.test.ts tests/tool-calling/tool-diagnostics.test.ts
git commit -m "fix: reject structurally invalid managed tool calls"
```

## Task 4: Stream Parser Observation Facts

**Files:**
- Modify: `src/main/proxy/toolCalling/ToolStreamParser.ts`
- Modify: `src/main/proxy/toolCalling/diagnostics.ts`
- Test: `tests/tool-calling/tool-stream-parser.test.ts`

- [ ] **Step 1: Add failing stream parser observation tests**

Append these tests to `tests/tool-calling/tool-stream-parser.test.ts`:

```ts
test('stream parser records content and tool-call emission facts', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  parser.push('hello ', baseChunk)
  parser.push('<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath">/tmp/a</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>', baseChunk)

  const observation = parser.getObservation()
  assert.equal(observation.rawContentLength > 0, true)
  assert.equal(observation.emittedContentLength, 'hello '.length)
  assert.equal(observation.emittedToolCallCount, 1)
  assert.equal(observation.suppressedMalformedToolOutput, false)
})

test('stream parser records invalid buffer suppression facts', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  parser.push('<|CHAT2API|tool_calls><|CHAT2API|invoke name="missing"><|CHAT2API|parameter name="x">1</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>', baseChunk)

  const observation = parser.getObservation()
  assert.equal(observation.rawContentLength > 0, true)
  assert.equal(observation.emittedToolCallCount, 0)
  assert.equal(observation.suppressedMalformedToolOutput, true)
  assert.equal(observation.suppressedReason, 'invalid_tool_name')
})
```

- [ ] **Step 2: Run stream parser tests and verify they fail**

Run:

```powershell
node --test tests/tool-calling/tool-stream-parser.test.ts
```

Expected: FAIL because `getObservation()` does not exist.

- [ ] **Step 3: Add observation type and state**

In `src/main/proxy/toolCalling/ToolStreamParser.ts`, add near the top:

```ts
export interface ToolStreamObservation {
  rawContentLength: number
  emittedContentLength: number
  emittedToolCallCount: number
  suppressedMalformedToolOutput: boolean
  suppressedReason?: 'invalid_tool_name' | 'malformed_tool_output'
}
```

Inside `ToolStreamParser`, add:

```ts
  private observation: ToolStreamObservation = {
    rawContentLength: 0,
    emittedContentLength: 0,
    emittedToolCallCount: 0,
    suppressedMalformedToolOutput: false,
  }
```

- [ ] **Step 4: Update parser observation counters**

At the start of `push`, after the early return check:

```ts
    this.observation.rawContentLength += content.length
```

Whenever `createContentChunk` is pushed with a content slice, increment `emittedContentLength` by that slice length. Use local variables so lengths are counted once:

```ts
          const emitted = this.buffer.slice(0, markerStart.index)
          this.observation.emittedContentLength += emitted.length
          chunks.push(createContentChunk(baseChunk, emitted, includeRole))
```

When tool call chunks are emitted, increment:

```ts
        this.observation.emittedToolCallCount += 1
```

When invalid names or raw malformed matches are dropped, set:

```ts
      this.observation.suppressedMalformedToolOutput = true
      this.observation.suppressedReason = parsed.invalidToolNames.length > 0
        ? 'invalid_tool_name'
        : 'malformed_tool_output'
```

In `flush`, when a text chunk is released, increment `emittedContentLength` by `text.length`.

Add this method to the class:

```ts
  getObservation(): ToolStreamObservation {
    return {
      ...this.observation,
    }
  }
```

- [ ] **Step 5: Run stream parser tests**

Run:

```powershell
node --test tests/tool-calling/tool-stream-parser.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

Run:

```powershell
git add src/main/proxy/toolCalling/ToolStreamParser.ts tests/tool-calling/tool-stream-parser.test.ts
git commit -m "feat: expose managed stream parser observations"
```

## Task 5: Empty Output Inspection for Non-Streaming Managed Turns

**Files:**
- Create: `src/main/proxy/toolCalling/outputInspection.ts`
- Modify: `src/main/proxy/forwarder.ts`
- Modify: `src/main/proxy/toolCalling/diagnostics.ts`
- Test: `tests/tool-calling/output-inspection.test.ts`

- [ ] **Step 1: Create failing output inspection tests**

Create `tests/tool-calling/output-inspection.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  clearToolDiagnosticEvents,
  getToolDiagnosticEvents,
} from '../../src/main/proxy/toolCalling/diagnostics.ts'
import { inspectNonStreamAssistantOutput } from '../../src/main/proxy/toolCalling/outputInspection.ts'
import type { ToolCallingPlan } from '../../src/main/proxy/toolCalling/types.ts'

function plan(emptyOutputPolicy: ToolCallingPlan['contract']['emptyOutputPolicy'] = 'diagnose_and_fail'): ToolCallingPlan {
  return {
    mode: 'managed',
    protocol: 'managed_xml',
    clientAdapterId: 'standard-openai-tools',
    providerId: 'qwen',
    tools: [],
    shouldInjectPrompt: false,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(),
    catalogDiagnostics: {
      source: 'none',
      driftKinds: [],
      blocked: false,
      reason: 'no_tools',
    },
    availabilityRetryAllowed: false,
    contract: {
      turnId: 'empty-r1',
      sessionId: 'empty-session',
      providerId: 'qwen',
      model: 'qwen3',
      protocol: 'managed_xml',
      snapshotFingerprint: null,
      tools: Object.freeze([]),
      allowedToolNames: Object.freeze(new Set<string>()),
      toolChoiceMode: 'auto',
      shouldInjectPrompt: false,
      shouldParseResponse: true,
      historyMode: 'managed_protocol',
      emptyOutputPolicy,
      toolSourceChain: Object.freeze(['current_request', 'session_catalog', 'message_history', 'safe_empty']),
    },
    diagnostics: {
      requestId: 'empty-r1',
      clientAdapterId: 'standard-openai-tools',
      providerId: 'qwen',
      model: 'qwen3',
      actualModel: 'qwen3',
      toolSource: 'none',
      mode: 'managed',
      protocol: 'managed_xml',
      toolCount: 0,
      injected: false,
      reason: 'no_tools',
      emptyOutputPolicy,
    },
  }
}

test('empty non-stream assistant output fails when policy is diagnose_and_fail', () => {
  clearToolDiagnosticEvents()
  const result = inspectNonStreamAssistantOutput({
    result: {
      choices: [{
        message: { role: 'assistant', content: '' },
        finish_reason: 'stop',
      }],
    },
    plan: plan('diagnose_and_fail'),
  })

  assert.equal(result.ok, false)
  assert.equal(result.outcome, 'provider_empty')
  assert.match(result.error, /empty assistant output/i)

  const [event] = getToolDiagnosticEvents()
  assert.equal(event.type, 'provider_empty_output')
  assert.equal(event.terminalOutcome, 'provider_empty')
})

test('tool calls count as non-empty output', () => {
  const result = inspectNonStreamAssistantOutput({
    result: {
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_0',
            type: 'function',
            function: { name: 'bash', arguments: '{}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    },
    plan: plan('diagnose_and_fail'),
  })

  assert.equal(result.ok, true)
  assert.equal(result.outcome, 'tool_calls')
})

test('intentional silence policy passes through empty output with diagnostic outcome', () => {
  const result = inspectNonStreamAssistantOutput({
    result: {
      choices: [{
        message: { role: 'assistant', content: '' },
        finish_reason: 'stop',
      }],
    },
    plan: plan('pass_through_without_tool_semantics'),
  })

  assert.equal(result.ok, true)
  assert.equal(result.outcome, 'provider_empty')
})
```

- [ ] **Step 2: Run output inspection test and verify it fails**

Run:

```powershell
node --test tests/tool-calling/output-inspection.test.ts
```

Expected: FAIL because `outputInspection.ts` does not exist.

- [ ] **Step 3: Implement output inspector**

Create `src/main/proxy/toolCalling/outputInspection.ts`:

```ts
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
```

- [ ] **Step 4: Wire non-stream inspector into forwarder helper**

In `src/main/proxy/forwarder.ts`, update imports:

```ts
import { inspectNonStreamAssistantOutput } from './toolCalling/outputInspection.ts'
```

Add this helper method inside `RequestForwarder` after `applyToolCallsToResponse`:

```ts
  private inspectManagedNonStreamOutput(
    result: any,
    transformed: ToolCallingTransformResult,
    startTime: number
  ): ForwardResult | undefined {
    const inspection = inspectNonStreamAssistantOutput({
      result,
      plan: transformed.plan,
    })

    if (inspection.ok) return undefined

    return {
      success: false,
      status: 502,
      error: inspection.error,
      latency: Date.now() - startTime,
    }
  }
```

- [ ] **Step 5: Apply inspector to dedicated non-stream return paths**

In each non-stream branch that calls `this.applyToolCallsToResponse(...)`, immediately inspect before returning success.

Use this pattern:

```ts
      const emptyOutputFailure = this.inspectManagedNonStreamOutput(result, transformed, startTime)
      if (emptyOutputFailure) return emptyOutputFailure
```

Apply the same pattern for local response variables named `result`, `parsedResult`, or `responseData` in:

- `forwardDeepSeek`
- `forwardGLM`
- `forwardKimi`
- `forwardQwen`
- `forwardQwenAi`
- `forwardZai`
- `forwardMiniMax`
- `forwardMimo`
- `forwardPerplexity`

For `forwardMimo`, inspect `parsedResult` after retry processing and before `generateConversationTitle`.

For `forwardMiniMax`, inspect `responseData` when `response` exists and inspect `result` when `stream` is converted into a non-stream body.

- [ ] **Step 6: Run output inspection test**

Run:

```powershell
node --test tests/tool-calling/output-inspection.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run a provider-focused subset**

Run:

```powershell
node --test tests/providers/glm-tool-calling.test.ts tests/providers/qwen-request-routing.test.ts tests/tool-calling/output-inspection.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 5**

Run:

```powershell
git add src/main/proxy/toolCalling/outputInspection.ts src/main/proxy/forwarder.ts src/main/proxy/toolCalling/diagnostics.ts tests/tool-calling/output-inspection.test.ts
git commit -m "fix: fail visible empty managed tool outputs"
```

## Task 6: Full Regression Gate

**Files:**
- No source edits unless a regression fails and the root cause is identified.

- [ ] **Step 1: Run deterministic tool-calling gate**

Run:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run build**

Run:

```powershell
npm run build
```

Expected: PASS.

- [ ] **Step 3: Start the app for the model probe**

Run and keep the process running:

```powershell
npm run dev:win 2>&1 | Tee-Object -FilePath .\dev.log
```

Expected: Electron app and proxy start without fatal errors. Keep this terminal open.

- [ ] **Step 4: Run the OpenCode capability probe**

In a second terminal, run:

```powershell
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "glm/GLM-5.2"
```

Expected: PASS. The verifier must confirm generated JSON integrity, `agent-capability-probe` skill invocation, at least two non-skill tool calls, at least one tool call after an observation event, and final `CAPABILITY_PROBE_DONE`.

- [ ] **Step 5: Inspect git diff for scope**

Run:

```powershell
git diff --stat
git diff -- src/main/proxy/toolCalling src/main/proxy/toolRuntime src/main/proxy/contextMessageMetadata.ts src/main/proxy/services/contextManagementService.ts src/main/proxy/forwarder.ts tests/tool-calling tests/providers
```

Expected: Diff is limited to tool-calling reliability, context metadata preservation, output inspection, and related tests.

- [ ] **Step 6: Commit final verification notes if docs changed**

If no docs changed during execution, skip this step. If execution notes are added to a docs file, run:

```powershell
git add docs
git commit -m "docs: record tool calling reliability verification"
```

Expected: Commit succeeds only when a docs file was actually changed.

## Self-Review

Spec coverage:

- Tool definitions lost across turns: Task 1 adds explicit source-chain contract facts; Task 2 preserves tool-call/tool-result pairs through context trimming.
- Raw angle-bracket protocol drift: Task 3 keeps invalid structure diagnostic-only; Task 4 tracks stream suppression without leaking partial markers.
- Wrong tool calls or invalid arguments: Task 3 rejects non-object bracket arguments and records structural validation categories.
- Empty output: Task 5 adds explicit non-stream empty-output classification and failure policy.
- Provider profiles: Task 1 makes parser ownership and empty-output policy explicit.
- Final gate: Task 6 runs the deterministic local regression layer, build, and OpenCode probe.

Placeholder scan:

- No placeholder markers, deferred implementation notes, or vague error-handling instructions remain.
- Each code-changing task has concrete file paths, concrete test code, implementation snippets, commands, and expected outcomes.

Type consistency:

- `ToolTurnContract`, `ProviderTurnOutcome`, `EmptyOutputPolicy`, and `ToolContractSourceStep` are introduced in Task 1 and reused by later tasks.
- `inspectNonStreamAssistantOutput` returns `NonStreamOutputInspection` and is consumed by `RequestForwarder.inspectManagedNonStreamOutput`.
- Diagnostic fields added in Task 1 are used consistently by Tasks 3 and 5.
