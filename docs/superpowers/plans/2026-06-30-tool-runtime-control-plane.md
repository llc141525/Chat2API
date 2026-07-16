# Tool Runtime Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first batch of the Chat2API single truth tool runtime: closed execution profiles, a static `ToolPlanner`, and a pure `ToolStateMachine`.

**Architecture:** This batch creates only pure control-plane code under `src/main/proxy/toolRuntime/control`. It does not connect to `RequestForwarder`, provider adapters, stream parsing, structural validation, repair, or response mapping. The output is a tested kernel that later batches can call without reintroducing policy flag combinations or hidden side effects.

**Tech Stack:** TypeScript, Node.js built-in test runner (`node --test`), existing Chat2API proxy/tool-calling types.

---

## Scope

This plan implements only Phase 1 control-plane foundations from [`docs/superpowers/specs/2026-06-30-chat2api-tool-runtime-litellm-design.md`](../specs/2026-06-30-chat2api-tool-runtime-litellm-design.md):

- `ToolExecutionProfile` and derived profile settings.
- `ToolPlanner`, including immutable plan creation and profile selection.
- `ToolStateMachine`, including atomic control-flow transitions and one-repair maximum.

This plan intentionally does not implement:

- Protocol parsing or extraction.
- Validation.
- Structural repair.
- Tool call assembly.
- Stream buffering.
- Runner integration.
- Changes to existing `ToolCallingEngine`, `forwarder`, or provider adapters.

## File Structure

- Create: `src/main/proxy/toolRuntime/control/executionProfiles.ts`
  - Owns the closed execution profile enum and the immutable table of derived settings.
- Create: `src/main/proxy/toolRuntime/control/types.ts`
  - Owns shared control-plane types used by planner and state machine.
- Create: `src/main/proxy/toolRuntime/control/ToolPlanner.ts`
  - Owns static request-start planning and managed-context detection.
- Create: `src/main/proxy/toolRuntime/control/ToolStateMachine.ts`
  - Owns pure FSM transitions only.
- Create: `src/main/proxy/toolRuntime/control/index.ts`
  - Re-exports public control-plane APIs.
- Create: `tests/tool-runtime/control/execution-profiles.test.ts`
  - Verifies closed profile settings and immutability.
- Create: `tests/tool-runtime/control/tool-planner.test.ts`
  - Verifies profile selection, allowed tools, forced tool validation, and managed context.
- Create: `tests/tool-runtime/control/tool-state-machine.test.ts`
  - Verifies valid transitions, invalid transitions, and repair loop prevention.

## Shared Type Decisions

Use existing source types where useful:

- `ChatCompletionRequest` from `src/main/proxy/types.ts`
- `ToolCallingConfig` from `src/shared/toolCalling.ts`
- `NormalizedClientToolRequest` from `src/main/proxy/toolCalling/clientAdapters/types.ts`
- `ProviderToolProfile` from `src/main/proxy/toolCalling/providerProfiles.ts`
- `ToolProtocolId` and `NormalizedToolDefinition` from `src/main/proxy/toolCalling/types.ts`

Do not modify these existing files in this batch.

---

### Task 1: Closed Execution Profiles

**Files:**
- Create: `tests/tool-runtime/control/execution-profiles.test.ts`
- Create: `src/main/proxy/toolRuntime/control/executionProfiles.ts`
- Create: `src/main/proxy/toolRuntime/control/types.ts`
- Create: `src/main/proxy/toolRuntime/control/index.ts`

- [ ] **Step 1: Write the failing execution profile tests**

Create `tests/tool-runtime/control/execution-profiles.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TOOL_EXECUTION_PROFILES,
  getExecutionProfileSettings,
  isToolExecutionProfile,
  TOOL_EXECUTION_PROFILE_IDS,
} from '../../../src/main/proxy/toolRuntime/control/index.ts'

test('execution profiles are closed to the three v1 profiles', () => {
  assert.deepEqual(TOOL_EXECUTION_PROFILE_IDS, [
    'disabled_passthrough',
    'native_passthrough',
    'managed_buffered_structural',
  ])

  assert.equal(isToolExecutionProfile('disabled_passthrough'), true)
  assert.equal(isToolExecutionProfile('native_passthrough'), true)
  assert.equal(isToolExecutionProfile('managed_buffered_structural'), true)
  assert.equal(isToolExecutionProfile('managed_incremental_structural'), false)
  assert.equal(isToolExecutionProfile(''), false)
})

test('disabled passthrough profile derives no parse or repair behavior', () => {
  assert.deepEqual(getExecutionProfileSettings('disabled_passthrough'), {
    mode: 'disabled',
    streamGateMode: 'pass_through',
    parseMode: 'none',
    repairMode: 'disabled',
    historyFormat: 'openai_native',
  })
})

test('native passthrough profile derives native mode without managed behavior', () => {
  assert.deepEqual(getExecutionProfileSettings('native_passthrough'), {
    mode: 'native',
    streamGateMode: 'pass_through',
    parseMode: 'none',
    repairMode: 'disabled',
    historyFormat: 'openai_native',
  })
})

test('managed buffered structural profile derives full-buffer selected-protocol behavior', () => {
  assert.deepEqual(getExecutionProfileSettings('managed_buffered_structural'), {
    mode: 'managed',
    streamGateMode: 'full_buffer',
    parseMode: 'selected_protocol_only',
    repairMode: 'deterministic_structural_repair',
    historyFormat: 'managed_protocol',
  })
})

test('profile settings are returned as defensive copies', () => {
  const settings = getExecutionProfileSettings('managed_buffered_structural') as any
  settings.streamGateMode = 'pass_through'

  assert.equal(
    getExecutionProfileSettings('managed_buffered_structural').streamGateMode,
    'full_buffer',
  )
  assert.equal(TOOL_EXECUTION_PROFILES.managed_buffered_structural.streamGateMode, 'full_buffer')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```powershell
node --test tests/tool-runtime/control/execution-profiles.test.ts
```

Expected: FAIL with a module resolution error for `src/main/proxy/toolRuntime/control/index.ts`.

- [ ] **Step 3: Create shared control-plane types**

Create `src/main/proxy/toolRuntime/control/types.ts`:

```ts
import type { ToolProtocolId } from '../../toolCalling/types.ts'

export type ToolExecutionProfile =
  | 'disabled_passthrough'
  | 'native_passthrough'
  | 'managed_buffered_structural'

export type ToolRuntimeMode = 'disabled' | 'native' | 'managed'
export type StreamGateMode = 'pass_through' | 'full_buffer' | 'incremental_safe_buffer'
export type ToolParseMode = 'none' | 'selected_protocol_only'
export type ToolRepairMode = 'disabled' | 'deterministic_structural_repair'
export type ToolHistoryFormat = 'openai_native' | 'managed_protocol'

export interface ToolExecutionProfileSettings {
  mode: ToolRuntimeMode
  streamGateMode: StreamGateMode
  parseMode: ToolParseMode
  repairMode: ToolRepairMode
  historyFormat: ToolHistoryFormat
}

export interface ToolPlanDiagnostics {
  requestId?: string
  providerId: string
  model?: string
  actualModel?: string
  profile: ToolExecutionProfile
  mode: ToolRuntimeMode
  protocol: ToolProtocolId | null
  reason: string
  toolCount: number
  toolChoiceMode: 'auto' | 'none' | 'required' | 'forced'
  forcedToolName?: string
  allowedToolNames: string[]
}

export interface ToolPlan {
  profile: ToolExecutionProfile
  protocol: ToolProtocolId | null
  allowedToolNames: string[]
  forcedToolName?: string
  diagnostics: ToolPlanDiagnostics
}
```

- [ ] **Step 4: Implement execution profiles**

Create `src/main/proxy/toolRuntime/control/executionProfiles.ts`:

```ts
import type { ToolExecutionProfile, ToolExecutionProfileSettings } from './types.ts'

export const TOOL_EXECUTION_PROFILE_IDS = [
  'disabled_passthrough',
  'native_passthrough',
  'managed_buffered_structural',
] as const satisfies readonly ToolExecutionProfile[]

export const TOOL_EXECUTION_PROFILES = Object.freeze({
  disabled_passthrough: Object.freeze({
    mode: 'disabled',
    streamGateMode: 'pass_through',
    parseMode: 'none',
    repairMode: 'disabled',
    historyFormat: 'openai_native',
  }),
  native_passthrough: Object.freeze({
    mode: 'native',
    streamGateMode: 'pass_through',
    parseMode: 'none',
    repairMode: 'disabled',
    historyFormat: 'openai_native',
  }),
  managed_buffered_structural: Object.freeze({
    mode: 'managed',
    streamGateMode: 'full_buffer',
    parseMode: 'selected_protocol_only',
    repairMode: 'deterministic_structural_repair',
    historyFormat: 'managed_protocol',
  }),
} satisfies Record<ToolExecutionProfile, ToolExecutionProfileSettings>)

const profileIds = new Set<string>(TOOL_EXECUTION_PROFILE_IDS)

export function isToolExecutionProfile(value: string): value is ToolExecutionProfile {
  return profileIds.has(value)
}

export function getExecutionProfileSettings(
  profile: ToolExecutionProfile,
): ToolExecutionProfileSettings {
  return { ...TOOL_EXECUTION_PROFILES[profile] }
}
```

- [ ] **Step 5: Add the control-plane barrel export**

Create `src/main/proxy/toolRuntime/control/index.ts`:

```ts
export * from './types.ts'
export * from './executionProfiles.ts'
```

- [ ] **Step 6: Run the execution profile tests**

Run:

```powershell
node --test tests/tool-runtime/control/execution-profiles.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 1**

Run:

```powershell
git add src/main/proxy/toolRuntime/control/types.ts src/main/proxy/toolRuntime/control/executionProfiles.ts src/main/proxy/toolRuntime/control/index.ts tests/tool-runtime/control/execution-profiles.test.ts
git commit -m "feat: add tool runtime execution profiles"
```

Expected: commit includes only the files listed above.

---

### Task 2: Static ToolPlanner

**Files:**
- Modify: `src/main/proxy/toolRuntime/control/types.ts`
- Modify: `src/main/proxy/toolRuntime/control/index.ts`
- Create: `src/main/proxy/toolRuntime/control/ToolPlanner.ts`
- Create: `tests/tool-runtime/control/tool-planner.test.ts`

- [ ] **Step 1: Write the failing planner tests**

Create `tests/tool-runtime/control/tool-planner.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'

import { planToolExecution } from '../../../src/main/proxy/toolRuntime/control/index.ts'
import type { ChatCompletionRequest } from '../../../src/main/proxy/types.ts'
import type { ProviderToolProfile } from '../../../src/main/proxy/toolCalling/providerProfiles.ts'
import type { NormalizedClientToolRequest } from '../../../src/main/proxy/toolCalling/clientAdapters/types.ts'
import type { NormalizedToolDefinition } from '../../../src/main/proxy/toolCalling/types.ts'
import type { ToolCallingConfig } from '../../../src/shared/toolCalling.ts'

const baseConfig: ToolCallingConfig = {
  enabled: true,
  mode: 'auto',
  clientAdapterId: 'standard-openai-tools',
  diagnosticsEnabled: false,
  advanced: { promptPreviewEnabled: false },
}

const bashTool: NormalizedToolDefinition = {
  name: 'bash',
  description: 'Run a shell command',
  parameters: {
    type: 'object',
    properties: {
      argument: { type: 'string' },
    },
    required: ['argument'],
  },
  source: 'openai',
}

const managedProfile: ProviderToolProfile = {
  providerId: 'qwen',
  managedSupport: true,
  supportsNativeTools: false,
  preferredManagedProtocol: 'managed_xml',
  formatAssistantToolCalls: () => '',
  formatToolResult: () => '',
}

const nativeProfile: ProviderToolProfile = {
  ...managedProfile,
  providerId: 'native-provider',
  managedSupport: false,
  supportsNativeTools: true,
}

function request(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: 'qwen-test',
    messages: [{ role: 'user', content: 'use a tool' }],
    stream: false,
    ...overrides,
  }
}

function clientRequest(
  overrides: Partial<NormalizedClientToolRequest> = {},
): NormalizedClientToolRequest {
  const tools = overrides.tools ?? [bashTool]
  return {
    clientAdapterId: 'standard-openai-tools',
    toolSource: tools.length > 0 ? 'openai' : 'none',
    tools,
    toolChoice: { mode: 'auto' },
    diagnostics: {
      rawToolCount: tools.length,
      normalizedToolNames: tools.map((tool) => tool.name),
    },
    ...overrides,
  }
}

test('disabled config selects disabled passthrough', () => {
  const plan = planToolExecution({
    request: request(),
    providerProfile: managedProfile,
    clientToolRequest: clientRequest(),
    config: { ...baseConfig, enabled: false, mode: 'off' },
    requestId: 'r-disabled',
    actualModel: 'qwen-web',
  })

  assert.equal(plan.profile, 'disabled_passthrough')
  assert.equal(plan.protocol, null)
  assert.deepEqual(plan.allowedToolNames, [])
  assert.equal(plan.diagnostics.reason, 'tool_calling_disabled')
  assert.equal(plan.diagnostics.mode, 'disabled')
})

test('tool choice none selects disabled passthrough', () => {
  const plan = planToolExecution({
    request: request(),
    providerProfile: managedProfile,
    clientToolRequest: clientRequest({ toolChoice: { mode: 'none' } }),
    config: baseConfig,
  })

  assert.equal(plan.profile, 'disabled_passthrough')
  assert.equal(plan.protocol, null)
  assert.equal(plan.diagnostics.reason, 'tool_choice_none')
})

test('native provider with tools selects native passthrough', () => {
  const plan = planToolExecution({
    request: request({ stream: true }),
    providerProfile: nativeProfile,
    clientToolRequest: clientRequest(),
    config: baseConfig,
  })

  assert.equal(plan.profile, 'native_passthrough')
  assert.equal(plan.protocol, null)
  assert.deepEqual(plan.allowedToolNames, ['bash'])
  assert.equal(plan.diagnostics.reason, 'provider_native_tools')
})

test('managed provider with tools selects managed buffered structural', () => {
  const plan = planToolExecution({
    request: request({ stream: true }),
    providerProfile: managedProfile,
    clientToolRequest: clientRequest(),
    config: baseConfig,
    requestId: 'r-managed',
    actualModel: 'qwen-web',
  })

  assert.equal(plan.profile, 'managed_buffered_structural')
  assert.equal(plan.protocol, 'managed_xml')
  assert.deepEqual(plan.allowedToolNames, ['bash'])
  assert.equal(plan.diagnostics.requestId, 'r-managed')
  assert.equal(plan.diagnostics.providerId, 'qwen')
  assert.equal(plan.diagnostics.model, 'qwen-test')
  assert.equal(plan.diagnostics.actualModel, 'qwen-web')
  assert.equal(plan.diagnostics.reason, 'provider_managed_tools')
})

test('forced tool choice restricts allowed tools', () => {
  const secondTool: NormalizedToolDefinition = {
    ...bashTool,
    name: 'read_file',
  }

  const plan = planToolExecution({
    request: request(),
    providerProfile: managedProfile,
    clientToolRequest: clientRequest({
      tools: [bashTool, secondTool],
      toolChoice: { mode: 'forced', forcedName: 'read_file' },
    }),
    config: baseConfig,
  })

  assert.equal(plan.profile, 'managed_buffered_structural')
  assert.deepEqual(plan.allowedToolNames, ['read_file'])
  assert.equal(plan.forcedToolName, 'read_file')
  assert.equal(plan.diagnostics.forcedToolName, 'read_file')
})

test('forced missing tool is rejected before provider call', () => {
  assert.throws(() => planToolExecution({
    request: request(),
    providerProfile: managedProfile,
    clientToolRequest: clientRequest({
      toolChoice: { mode: 'forced', forcedName: 'missing_tool' },
    }),
    config: baseConfig,
  }), /Forced tool missing_tool is not declared/)
})

test('no tools and no managed context selects disabled passthrough', () => {
  const plan = planToolExecution({
    request: request({ messages: [{ role: 'user', content: 'hello' }] }),
    providerProfile: managedProfile,
    clientToolRequest: clientRequest({ tools: [] }),
    config: baseConfig,
  })

  assert.equal(plan.profile, 'disabled_passthrough')
  assert.equal(plan.protocol, null)
  assert.equal(plan.diagnostics.reason, 'no_tools_or_managed_context')
})

test('no tools but assistant tool_calls context selects managed buffered structural', () => {
  const plan = planToolExecution({
    request: request({
      messages: [{
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'bash', arguments: '{"argument":"pwd"}' },
        }],
      }],
    }),
    providerProfile: managedProfile,
    clientToolRequest: clientRequest({ tools: [] }),
    config: baseConfig,
  })

  assert.equal(plan.profile, 'managed_buffered_structural')
  assert.equal(plan.protocol, 'managed_xml')
  assert.deepEqual(plan.allowedToolNames, [])
  assert.equal(plan.diagnostics.reason, 'existing_managed_tool_context')
})

test('no tools but system managed prompt signature selects managed buffered structural', () => {
  const plan = planToolExecution({
    request: request({
      messages: [{
        role: 'system',
        content: '## Available Tools\nYou can invoke the following developer tools.',
      }],
    }),
    providerProfile: managedProfile,
    clientToolRequest: clientRequest({ tools: [] }),
    config: baseConfig,
  })

  assert.equal(plan.profile, 'managed_buffered_structural')
  assert.equal(plan.protocol, 'managed_xml')
  assert.equal(plan.diagnostics.reason, 'existing_managed_tool_context')
})
```

- [ ] **Step 2: Run the planner tests to verify they fail**

Run:

```powershell
node --test tests/tool-runtime/control/tool-planner.test.ts
```

Expected: FAIL with `The requested module ... does not provide an export named 'planToolExecution'`.

- [ ] **Step 3: Extend control-plane types for planner input**

Modify `src/main/proxy/toolRuntime/control/types.ts` to add imports and `ToolPlannerInput`.

The file should become:

```ts
import type { ToolCallingConfig } from '../../../../shared/toolCalling.ts'
import type { ChatCompletionRequest } from '../../types.ts'
import type { NormalizedClientToolRequest } from '../../toolCalling/clientAdapters/types.ts'
import type { ProviderToolProfile } from '../../toolCalling/providerProfiles.ts'
import type { ToolProtocolId } from '../../toolCalling/types.ts'

export type ToolExecutionProfile =
  | 'disabled_passthrough'
  | 'native_passthrough'
  | 'managed_buffered_structural'

export type ToolRuntimeMode = 'disabled' | 'native' | 'managed'
export type StreamGateMode = 'pass_through' | 'full_buffer' | 'incremental_safe_buffer'
export type ToolParseMode = 'none' | 'selected_protocol_only'
export type ToolRepairMode = 'disabled' | 'deterministic_structural_repair'
export type ToolHistoryFormat = 'openai_native' | 'managed_protocol'

export interface ToolExecutionProfileSettings {
  mode: ToolRuntimeMode
  streamGateMode: StreamGateMode
  parseMode: ToolParseMode
  repairMode: ToolRepairMode
  historyFormat: ToolHistoryFormat
}

export interface ToolPlannerInput {
  request: ChatCompletionRequest
  providerProfile: ProviderToolProfile
  clientToolRequest: NormalizedClientToolRequest
  config: ToolCallingConfig
  requestId?: string
  actualModel?: string
}

export interface ToolPlanDiagnostics {
  requestId?: string
  providerId: string
  model?: string
  actualModel?: string
  profile: ToolExecutionProfile
  mode: ToolRuntimeMode
  protocol: ToolProtocolId | null
  reason: string
  toolCount: number
  toolChoiceMode: 'auto' | 'none' | 'required' | 'forced'
  forcedToolName?: string
  allowedToolNames: string[]
}

export interface ToolPlan {
  profile: ToolExecutionProfile
  protocol: ToolProtocolId | null
  allowedToolNames: string[]
  forcedToolName?: string
  diagnostics: ToolPlanDiagnostics
}
```

- [ ] **Step 4: Implement ToolPlanner**

Create `src/main/proxy/toolRuntime/control/ToolPlanner.ts`:

```ts
import { hasGeneralToolPromptSignature } from '../../constants/signatures.ts'
import { getExecutionProfileSettings } from './executionProfiles.ts'
import type { ToolExecutionProfile, ToolPlan, ToolPlannerInput } from './types.ts'

export function planToolExecution(input: ToolPlannerInput): ToolPlan {
  const forcedName = input.clientToolRequest.toolChoice.forcedName
  const allTools = input.clientToolRequest.tools
  const allToolNames = new Set(allTools.map((tool) => tool.name))

  if (input.clientToolRequest.toolChoice.mode === 'forced' && forcedName && !allToolNames.has(forcedName)) {
    throw new Error(`Forced tool ${forcedName} is not declared`)
  }

  const allowedToolNames = forcedName ? [forcedName] : allTools.map((tool) => tool.name)
  const hasTools = allowedToolNames.length > 0
  const managedContext = hasExistingManagedToolContext(input.request.messages)

  if (!input.config.enabled || input.config.mode === 'off') {
    return createPlan(input, 'disabled_passthrough', null, [], undefined, 'tool_calling_disabled')
  }

  if (input.clientToolRequest.toolChoice.mode === 'none') {
    return createPlan(input, 'disabled_passthrough', null, [], undefined, 'tool_choice_none')
  }

  if (hasTools && input.providerProfile.supportsNativeTools) {
    return createPlan(input, 'native_passthrough', null, allowedToolNames, forcedName, 'provider_native_tools')
  }

  if (hasTools && input.providerProfile.managedSupport) {
    return createPlan(
      input,
      'managed_buffered_structural',
      input.providerProfile.preferredManagedProtocol,
      allowedToolNames,
      forcedName,
      'provider_managed_tools',
    )
  }

  if (!hasTools && managedContext && input.providerProfile.managedSupport) {
    return createPlan(
      input,
      'managed_buffered_structural',
      input.providerProfile.preferredManagedProtocol,
      [],
      undefined,
      'existing_managed_tool_context',
    )
  }

  return createPlan(input, 'disabled_passthrough', null, [], undefined, 'no_tools_or_managed_context')
}

function createPlan(
  input: ToolPlannerInput,
  profile: ToolExecutionProfile,
  protocol: ToolPlan['protocol'],
  allowedToolNames: string[],
  forcedToolName: string | undefined,
  reason: string,
): ToolPlan {
  const settings = getExecutionProfileSettings(profile)

  return {
    profile,
    protocol,
    allowedToolNames,
    ...(forcedToolName ? { forcedToolName } : {}),
    diagnostics: {
      requestId: input.requestId,
      providerId: input.providerProfile.providerId,
      model: input.request.model,
      actualModel: input.actualModel,
      profile,
      mode: settings.mode,
      protocol,
      reason,
      toolCount: allowedToolNames.length,
      toolChoiceMode: input.clientToolRequest.toolChoice.mode,
      ...(forcedToolName ? { forcedToolName } : {}),
      allowedToolNames,
    },
  }
}

function hasExistingManagedToolContext(messages: ToolPlannerInput['request']['messages']): boolean {
  for (const message of messages) {
    if (message.role === 'system' && typeof message.content === 'string') {
      if (hasGeneralToolPromptSignature(message.content)) return true
    }

    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      return true
    }

    if (message.role === 'tool' && message.tool_call_id) {
      return true
    }
  }

  return false
}
```

- [ ] **Step 5: Export ToolPlanner**

Modify `src/main/proxy/toolRuntime/control/index.ts`:

```ts
export * from './types.ts'
export * from './executionProfiles.ts'
export * from './ToolPlanner.ts'
```

- [ ] **Step 6: Run planner and profile tests**

Run:

```powershell
node --test tests/tool-runtime/control/execution-profiles.test.ts tests/tool-runtime/control/tool-planner.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

Run:

```powershell
git add src/main/proxy/toolRuntime/control/types.ts src/main/proxy/toolRuntime/control/ToolPlanner.ts src/main/proxy/toolRuntime/control/index.ts tests/tool-runtime/control/tool-planner.test.ts
git commit -m "feat: add static tool runtime planner"
```

Expected: commit includes only Task 2 files.

---

### Task 3: Pure ToolStateMachine

**Files:**
- Modify: `src/main/proxy/toolRuntime/control/types.ts`
- Modify: `src/main/proxy/toolRuntime/control/index.ts`
- Create: `src/main/proxy/toolRuntime/control/ToolStateMachine.ts`
- Create: `tests/tool-runtime/control/tool-state-machine.test.ts`

- [ ] **Step 1: Write the failing state machine tests**

Create `tests/tool-runtime/control/tool-state-machine.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createInitialToolControlState,
  transitionToolState,
} from '../../../src/main/proxy/toolRuntime/control/index.ts'

test('start transitions to invoke_model', () => {
  const transition = transitionToolState(createInitialToolControlState(), { type: 'start' })

  assert.deepEqual(transition.nextState, {
    phase: 'awaiting_operation_result',
    step: 'invoke_model',
    repairAttempted: false,
  })
  assert.equal(transition.nextOperation, 'invoke_model')
  assert.equal(transition.reason, 'started')
})

test('model output transitions to validate_structure', () => {
  const state = {
    phase: 'awaiting_operation_result' as const,
    step: 'invoke_model' as const,
    repairAttempted: false,
  }

  const transition = transitionToolState(state, {
    type: 'operation_succeeded',
    resultKind: 'model_output',
  })

  assert.deepEqual(transition.nextState, {
    phase: 'awaiting_operation_result',
    step: 'validate_structure',
    repairAttempted: false,
  })
  assert.equal(transition.nextOperation, 'validate_structure')
  assert.equal(transition.reason, 'model_output_ready')
})

test('plain text validation maps response', () => {
  const state = {
    phase: 'awaiting_operation_result' as const,
    step: 'validate_structure' as const,
    repairAttempted: false,
  }

  const transition = transitionToolState(state, {
    type: 'operation_succeeded',
    resultKind: 'plain_text',
  })

  assert.equal(transition.nextState.step, 'map_response')
  assert.equal(transition.nextOperation, 'map_response')
  assert.equal(transition.reason, 'plain_text_ready')
})

test('valid structure transitions to assemble_tool_calls', () => {
  const state = {
    phase: 'awaiting_operation_result' as const,
    step: 'validate_structure' as const,
    repairAttempted: false,
  }

  const transition = transitionToolState(state, {
    type: 'operation_succeeded',
    resultKind: 'valid_structure',
  })

  assert.equal(transition.nextState.step, 'assemble_tool_calls')
  assert.equal(transition.nextOperation, 'assemble_tool_calls')
  assert.equal(transition.reason, 'valid_structure_ready')
})

test('repairable invalid structure transitions to one structural repair', () => {
  const state = {
    phase: 'awaiting_operation_result' as const,
    step: 'validate_structure' as const,
    repairAttempted: false,
  }

  const transition = transitionToolState(state, {
    type: 'operation_failed',
    failureKind: 'invalid_structure_repairable',
  })

  assert.deepEqual(transition.nextState, {
    phase: 'awaiting_operation_result',
    step: 'repair_structure',
    repairAttempted: true,
  })
  assert.equal(transition.nextOperation, 'repair_structure')
  assert.equal(transition.reason, 'repair_allowed')
})

test('repairable invalid structure after repair maps blocked response', () => {
  const state = {
    phase: 'awaiting_operation_result' as const,
    step: 'validate_repaired_structure' as const,
    repairAttempted: true,
  }

  const transition = transitionToolState(state, {
    type: 'operation_failed',
    failureKind: 'invalid_structure_repairable',
  })

  assert.deepEqual(transition.nextState, {
    phase: 'awaiting_operation_result',
    step: 'map_response',
    repairAttempted: true,
  })
  assert.equal(transition.nextOperation, 'map_response')
  assert.equal(transition.reason, 'repair_exhausted')
})

test('blocked invalid structure maps response without repair', () => {
  const state = {
    phase: 'awaiting_operation_result' as const,
    step: 'validate_structure' as const,
    repairAttempted: false,
  }

  const transition = transitionToolState(state, {
    type: 'operation_failed',
    failureKind: 'invalid_structure_blocked',
  })

  assert.equal(transition.nextState.step, 'map_response')
  assert.equal(transition.nextOperation, 'map_response')
  assert.equal(transition.reason, 'invalid_structure_blocked')
})

test('structural repair success transitions to validate_repaired_structure', () => {
  const state = {
    phase: 'awaiting_operation_result' as const,
    step: 'repair_structure' as const,
    repairAttempted: true,
  }

  const transition = transitionToolState(state, {
    type: 'operation_succeeded',
    resultKind: 'repaired_structure_text',
  })

  assert.equal(transition.nextState.step, 'validate_repaired_structure')
  assert.equal(transition.nextOperation, 'validate_repaired_structure')
  assert.equal(transition.reason, 'repair_completed')
})

test('assembled tool calls transition to map_response', () => {
  const state = {
    phase: 'awaiting_operation_result' as const,
    step: 'assemble_tool_calls' as const,
    repairAttempted: false,
  }

  const transition = transitionToolState(state, {
    type: 'operation_succeeded',
    resultKind: 'openai_tool_calls',
  })

  assert.equal(transition.nextState.step, 'map_response')
  assert.equal(transition.nextOperation, 'map_response')
  assert.equal(transition.reason, 'tool_calls_assembled')
})

test('mapped response reaches terminal success', () => {
  const state = {
    phase: 'awaiting_operation_result' as const,
    step: 'map_response' as const,
    repairAttempted: false,
  }

  const transition = transitionToolState(state, {
    type: 'operation_succeeded',
    resultKind: 'response_mapped',
  })

  assert.deepEqual(transition.nextState, {
    phase: 'terminal_success',
    step: null,
    repairAttempted: false,
  })
  assert.equal(transition.nextOperation, null)
  assert.equal(transition.reason, 'response_completed')
})

test('model error reaches terminal failure through delegate_error', () => {
  const state = {
    phase: 'awaiting_operation_result' as const,
    step: 'invoke_model' as const,
    repairAttempted: false,
  }

  const transition = transitionToolState(state, {
    type: 'operation_failed',
    failureKind: 'model_error',
  })

  assert.equal(transition.nextState.step, 'delegate_error')
  assert.equal(transition.nextOperation, 'delegate_error')
  assert.equal(transition.reason, 'model_error')

  const terminal = transitionToolState(transition.nextState, {
    type: 'operation_succeeded',
    resultKind: 'error_delegated',
  })

  assert.equal(terminal.nextState.phase, 'terminal_failure')
  assert.equal(terminal.nextOperation, null)
  assert.equal(terminal.reason, 'error_delegated')
})

test('invalid transition throws', () => {
  assert.throws(() => transitionToolState(createInitialToolControlState(), {
    type: 'operation_succeeded',
    resultKind: 'model_output',
  }), /Invalid tool state transition/)
})
```

- [ ] **Step 2: Run the state machine tests to verify they fail**

Run:

```powershell
node --test tests/tool-runtime/control/tool-state-machine.test.ts
```

Expected: FAIL with missing exports for `createInitialToolControlState` and `transitionToolState`.

- [ ] **Step 3: Extend control-plane types for the FSM**

Append these types to `src/main/proxy/toolRuntime/control/types.ts`:

```ts
export type ToolOperation =
  | 'invoke_model'
  | 'gate_stream'
  | 'validate_structure'
  | 'repair_structure'
  | 'validate_repaired_structure'
  | 'assemble_tool_calls'
  | 'map_response'
  | 'delegate_error'

export type ToolControlPhase =
  | 'idle'
  | 'awaiting_operation_result'
  | 'terminal_success'
  | 'terminal_failure'

export interface ToolControlState {
  phase: ToolControlPhase
  step: ToolOperation | null
  repairAttempted: boolean
}

export type ToolOperationResultKind =
  | 'model_output'
  | 'plain_text'
  | 'valid_structure'
  | 'repaired_structure_text'
  | 'openai_tool_calls'
  | 'response_mapped'
  | 'error_delegated'

export type ToolOperationFailureKind =
  | 'invalid_structure_repairable'
  | 'invalid_structure_blocked'
  | 'structural_repair_failed'
  | 'assembly_failed'
  | 'mapping_failed'
  | 'model_error'
  | 'stream_error'

export type ToolEvent =
  | { type: 'start' }
  | { type: 'operation_succeeded'; resultKind: ToolOperationResultKind }
  | { type: 'operation_failed'; failureKind: ToolOperationFailureKind }

export type ToolControlReason =
  | 'started'
  | 'model_output_ready'
  | 'plain_text_ready'
  | 'valid_structure_ready'
  | 'repair_allowed'
  | 'repair_exhausted'
  | 'invalid_structure_blocked'
  | 'repair_completed'
  | 'repair_failed'
  | 'tool_calls_assembled'
  | 'response_completed'
  | 'model_error'
  | 'stream_error'
  | 'assembly_failed'
  | 'mapping_failed'
  | 'error_delegated'

export interface ToolTransition {
  nextState: ToolControlState
  nextOperation: ToolOperation | null
  reason: ToolControlReason
}
```

- [ ] **Step 4: Implement the pure state machine**

Create `src/main/proxy/toolRuntime/control/ToolStateMachine.ts`:

```ts
import type {
  ToolControlReason,
  ToolControlState,
  ToolEvent,
  ToolOperation,
  ToolOperationFailureKind,
  ToolOperationResultKind,
  ToolTransition,
} from './types.ts'

export function createInitialToolControlState(): ToolControlState {
  return {
    phase: 'idle',
    step: null,
    repairAttempted: false,
  }
}

export function transitionToolState(
  state: ToolControlState,
  event: ToolEvent,
): ToolTransition {
  if (state.phase === 'idle' && event.type === 'start') {
    return next(state, 'invoke_model', 'started')
  }

  if (state.phase !== 'awaiting_operation_result' || state.step === null) {
    throw invalidTransition(state, event)
  }

  if (event.type === 'operation_succeeded') {
    return transitionSucceeded(state, event.resultKind)
  }

  if (event.type === 'operation_failed') {
    return transitionFailed(state, event.failureKind)
  }

  throw invalidTransition(state, event)
}

function transitionSucceeded(
  state: ToolControlState,
  resultKind: ToolOperationResultKind,
): ToolTransition {
  switch (state.step) {
    case 'invoke_model':
    case 'gate_stream':
      if (resultKind === 'model_output') return next(state, 'validate_structure', 'model_output_ready')
      break
    case 'validate_structure':
    case 'validate_repaired_structure':
      if (resultKind === 'plain_text') return next(state, 'map_response', 'plain_text_ready')
      if (resultKind === 'valid_structure') return next(state, 'assemble_tool_calls', 'valid_structure_ready')
      break
    case 'repair_structure':
      if (resultKind === 'repaired_structure_text') {
        return next(state, 'validate_repaired_structure', 'repair_completed')
      }
      break
    case 'assemble_tool_calls':
      if (resultKind === 'openai_tool_calls') return next(state, 'map_response', 'tool_calls_assembled')
      break
    case 'map_response':
      if (resultKind === 'response_mapped') {
        return {
          nextState: { ...state, phase: 'terminal_success', step: null },
          nextOperation: null,
          reason: 'response_completed',
        }
      }
      break
    case 'delegate_error':
      if (resultKind === 'error_delegated') {
        return {
          nextState: { ...state, phase: 'terminal_failure', step: null },
          nextOperation: null,
          reason: 'error_delegated',
        }
      }
      break
  }

  throw invalidTransition(state, { type: 'operation_succeeded', resultKind } as ToolEvent)
}

function transitionFailed(
  state: ToolControlState,
  failureKind: ToolOperationFailureKind,
): ToolTransition {
  if (failureKind === 'model_error') return next(state, 'delegate_error', 'model_error')
  if (failureKind === 'stream_error') return next(state, 'delegate_error', 'stream_error')
  if (failureKind === 'assembly_failed') return next(state, 'delegate_error', 'assembly_failed')
  if (failureKind === 'mapping_failed') return next(state, 'delegate_error', 'mapping_failed')

  if (state.step === 'validate_structure' || state.step === 'validate_repaired_structure') {
    if (failureKind === 'invalid_structure_repairable' && !state.repairAttempted) {
      return {
        nextState: {
          phase: 'awaiting_operation_result',
          step: 'repair_structure',
          repairAttempted: true,
        },
        nextOperation: 'repair_structure',
        reason: 'repair_allowed',
      }
    }

    if (failureKind === 'invalid_structure_repairable' && state.repairAttempted) {
      return next(state, 'map_response', 'repair_exhausted')
    }

    if (failureKind === 'invalid_structure_blocked') {
      return next(state, 'map_response', 'invalid_structure_blocked')
    }
  }

  if (state.step === 'repair_structure' && failureKind === 'structural_repair_failed') {
    return next(state, 'map_response', 'repair_failed')
  }

  throw invalidTransition(state, { type: 'operation_failed', failureKind } as ToolEvent)
}

function next(
  state: ToolControlState,
  operation: ToolOperation,
  reason: ToolControlReason,
): ToolTransition {
  return {
    nextState: {
      phase: 'awaiting_operation_result',
      step: operation,
      repairAttempted: state.repairAttempted,
    },
    nextOperation: operation,
    reason,
  }
}

function invalidTransition(state: ToolControlState, event: ToolEvent): Error {
  return new Error(
    `Invalid tool state transition from ${state.phase}:${state.step ?? 'none'} with ${event.type}`,
  )
}
```

- [ ] **Step 5: Export the state machine**

Modify `src/main/proxy/toolRuntime/control/index.ts`:

```ts
export * from './types.ts'
export * from './executionProfiles.ts'
export * from './ToolPlanner.ts'
export * from './ToolStateMachine.ts'
```

- [ ] **Step 6: Run all control-plane tests**

Run:

```powershell
node --test tests/tool-runtime/control/execution-profiles.test.ts tests/tool-runtime/control/tool-planner.test.ts tests/tool-runtime/control/tool-state-machine.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run TypeScript check for main process**

Run:

```powershell
npx tsc -p tsconfig.node.json --noEmit
```

Expected: PASS, or only pre-existing errors unrelated to files in `src/main/proxy/toolRuntime/control`. If unrelated pre-existing errors appear, record them in the task handoff before committing.

- [ ] **Step 8: Commit Task 3**

Run:

```powershell
git add src/main/proxy/toolRuntime/control/types.ts src/main/proxy/toolRuntime/control/ToolStateMachine.ts src/main/proxy/toolRuntime/control/index.ts tests/tool-runtime/control/tool-state-machine.test.ts
git commit -m "feat: add tool runtime state machine"
```

Expected: commit includes only Task 3 files.

---

## Batch Verification

After Tasks 1-3 are complete, run:

```powershell
node --test tests/tool-runtime/control/*.test.ts
npx tsc -p tsconfig.node.json --noEmit
```

Expected:

- All `tests/tool-runtime/control/*.test.ts` pass.
- TypeScript check passes or reports only documented pre-existing errors unrelated to the new control-plane files.

Do not run the full AGENTS final gate for this batch. This batch does not alter the live forwarding/tool-calling path.

## Self-Review Checklist

- Execution profiles are closed and derived settings are not freely combinable.
- `ToolPlanner` does not parse model output, call providers, or inspect runtime failures.
- `ToolStateMachine` does not know XML, schemas, provider IDs, tool names, response mapping, or router policy.
- The state machine cannot repair twice.
- New code is isolated under `src/main/proxy/toolRuntime/control`.
- Existing `ToolCallingEngine`, provider adapters, stream parsers, and forwarder are untouched.
