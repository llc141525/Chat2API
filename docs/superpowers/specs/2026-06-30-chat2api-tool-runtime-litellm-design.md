# Chat2API Single Truth Tool Runtime and LiteLLM-Style Routing Design

Date: 2026-06-30

## Purpose

Chat2API should keep its web reverse provider transports, but the current tool-calling path needs a stricter architecture. The immediate problem is not only routing reliability. It is that prompt injection, protocol parsing, streaming behavior, response mutation, repair attempts, and provider adapter behavior can compete with each other. This allows malformed model output such as a Chat2API opening container with OpenCode-style closing tags to drift into client-executable tool calls.

The goal is to introduce a single truth tool runtime that produces OpenAI-compatible `tool_calls` only after one selected protocol has produced structural facts and those facts have passed validation. Chat2API will not execute tools. OpenCode, Cline, Roo, and other OpenAI-compatible clients continue to execute tools.

LiteLLM-style quality routing is a follow-up reliability layer behind the tool runtime. It must not own tool protocol parsing or repair.

## Target Stack

```text
Client executes tools
  OpenCode / Cline / Roo / OpenAI-compatible SDKs
        ↓
Single Truth Tool Runtime
  control plane + data plane, no semantic repair
        ↓
ModelInvoker
  current Chat2API forwarder first, QualityRouter later
        ↓
Chat2API provider transports
  GLM / Qwen / Kimi / MiniMax / DeepSeek / Perplexity
```

## Non-Goals

- Chat2API does not execute client tools.
- The tool runtime does not choose provider accounts or score model health.
- Provider adapters do not inject a second tool prompt.
- Parser fallback is not allowed. A selected protocol is the only parser for a turn.
- Structural repair does not invent, normalize, complete, rename, or semantically rewrite tool arguments.
- LiteLLM-style routing does not repair malformed tool markup or change tool protocol.

## Core Principles

1. Client tools are executed by the client, not by Chat2API.
2. Tool runtime either emits validated OpenAI `tool_calls` or blocks unsafe malformed output.
3. `ToolPlanner` chooses one immutable execution profile per request.
4. `ToolStateMachine` is a pure control-flow kernel.
5. `ProtocolAdapter` extracts protocol structure only.
6. `ToolCallValidator` returns structural verdicts only.
7. `StructuralRepair` is a canonical rewrapper, not a parser or validator.
8. `ToolCallAssembler` is the only component that creates OpenAI `tool_calls`.
9. `StreamGate` uses full buffering for tool requests in v1, with an interface that can later support safe incremental buffering.
10. `QualityRouter` later replaces `ModelInvoker`; it does not enter the tool protocol layer.

## Control Plane

### Execution Profiles

`ToolPlanner` must not return arbitrary combinations of stream, parse, repair, and history flags. It chooses one closed execution profile. The profile expands into derived settings.

```ts
type ToolExecutionProfile =
  | 'disabled_passthrough'
  | 'native_passthrough'
  | 'managed_buffered_structural'
```

V1 profiles:

```ts
const TOOL_EXECUTION_PROFILES = {
  disabled_passthrough: {
    mode: 'disabled',
    streamGateMode: 'pass_through',
    parseMode: 'none',
    repairMode: 'disabled',
    historyFormat: 'openai_native',
  },

  native_passthrough: {
    mode: 'native',
    streamGateMode: 'pass_through',
    parseMode: 'none',
    repairMode: 'disabled',
    historyFormat: 'openai_native',
  },

  managed_buffered_structural: {
    mode: 'managed',
    streamGateMode: 'full_buffer',
    parseMode: 'selected_protocol_only',
    repairMode: 'deterministic_structural_repair',
    historyFormat: 'managed_protocol',
  },
} as const
```

Future incremental streaming requires a new profile, for example `managed_incremental_structural`, with its own tests. It must not be enabled by flipping a single flag.

### ToolPlanner

`ToolPlanner` runs once at the start of a request and returns an immutable plan.

```ts
interface ToolPlan {
  profile: ToolExecutionProfile
  protocol: ToolProtocolId | null
  allowedToolNames: string[]
  forcedToolName?: string
  diagnostics: ToolPlanDiagnostics
}
```

V1 planning rules:

- If tool calling is disabled, choose `disabled_passthrough`.
- If `tool_choice` is `none`, choose `disabled_passthrough`.
- If the request has tools and the provider supports native tools, choose `native_passthrough`.
- If the request has tools and the provider supports managed tools, choose `managed_buffered_structural`.
- If the request has no tools but existing managed tool context is present, choose `managed_buffered_structural`.
- If the request has no tools and no managed context, choose `disabled_passthrough`.

`ToolPlanner` may select protocol, profile, allowed tool names, forced tool name, and diagnostics. It must not parse model output, decide repair for a failure, construct repaired output, call providers, or choose provider accounts.

### ToolStateMachine

`ToolStateMachine` is a pure finite-state-machine kernel. It only models control-flow semantics.

```ts
interface ToolControlState {
  phase: 'idle' | 'awaiting_operation_result' | 'terminal_success' | 'terminal_failure'
  step: ToolOperation | null
  repairAttempted: boolean
}

type ToolOperation =
  | 'invoke_model'
  | 'gate_stream'
  | 'validate_structure'
  | 'repair_structure'
  | 'validate_repaired_structure'
  | 'assemble_tool_calls'
  | 'map_response'
  | 'delegate_error'

type ToolEvent =
  | { type: 'start' }
  | { type: 'operation_succeeded'; resultKind: ToolOperationResultKind }
  | { type: 'operation_failed'; failureKind: ToolOperationFailureKind }

interface ToolTransition {
  nextState: ToolControlState
  nextOperation: ToolOperation | null
  reason: ToolControlReason
}
```

The FSM must not know XML, schemas, tool names, provider types, OpenAI response shapes, repair prompt text, or router policy. It only knows the current step, operation result kind, whether repair has already been attempted, and the next operation.

Repair loops are impossible by construction. After `repairAttempted` is true, no transition may lead to `repair_structure` again.

## Data Plane

### ProtocolAdapter

Only the selected protocol may produce structural facts for a turn. If the selected protocol is `managed_xml`, no bracket, legacy, or OpenCode parser may be tried as a fallback.

`ProtocolAdapter` handles protocol syntax only:

```ts
interface ProtocolAdapter {
  id: ToolProtocolId

  renderPrompt(input: {
    tools: NormalizedToolDefinition[]
    toolChoice: ToolChoicePlan
  }): string

  formatAssistantToolCalls(input: {
    calls: OpenAIToolCall[]
  }): string

  formatToolResult(input: {
    result: NormalizedToolResult
  }): string

  detectIntent(input: {
    rawOutput: string
  }): ProtocolIntentDetection

  extractStructure(input: {
    rawOutput: string
  }): ProtocolStructureResult
}
```

It must not check allowed tool names, validate schema, repair containers, parse other protocols, infer missing data, or create OpenAI `tool_calls`.

Structural output:

```ts
interface ExtractedCallStructure {
  callIndex: number
  rawToolName: string
  rawParameters: Array<{
    rawName: string
    rawPayload: string
    payloadEncoding: 'cdata' | 'text' | 'json_text'
  }>
  rawSpan: { start: number; end: number }
}
```

### ToolCallValidator

`ToolCallValidator` is the only component that declares structural validity, but it still does not create tool calls.

```ts
type ToolValidationOutcome =
  | {
      status: 'valid_structure'
      validated: ValidatedCallStructure[]
      cleanContent: string | null
    }
  | {
      status: 'plain_text'
      content: string
    }
  | {
      status: 'invalid_structure'
      failure: ToolStructureFailure
      malformedIntent?: MalformedToolIntent
    }
```

`ValidatedCallStructure` is still not an OpenAI tool call:

```ts
interface ValidatedCallStructure {
  callIndex: number
  toolName: string
  parameters: Array<{
    name: string
    rawPayload: string
    payloadEncoding: 'cdata' | 'text' | 'json_text'
  }>
}
```

Validator must not generate `tool_calls`, repair JSON, rename parameters, fill required fields, or parse protocol raw text outside the selected protocol adapter.

### StructuralRepair

`StructuralRepair` is a semantics-preserving canonical rewrapper. It repairs container structure only.

It may receive only extracted malformed intent, not full raw model output:

```ts
interface MalformedToolIntent {
  selectedProtocol: ToolProtocolId
  toolName: string
  parameters: Array<{
    name: string
    rawPayload: string
    payloadEncoding: 'cdata' | 'text' | 'json_text'
  }>
  rawContainerFingerprint: string
  failureKind: StructuralContainerFailureKind
}
```

Allowed transformation:

```text
(protocol, toolName, parameter raw payloads) -> canonical protocol container text
```

Hard constraints:

- Tool name is unchanged.
- Parameter names are unchanged.
- Payloads are unchanged.
- Parameter count is unchanged.
- No parameters are added or removed.
- No JSON is repaired or normalized.
- No schema validation is performed.
- No model is called.
- No OpenAI `tool_calls` are emitted.

Repair results are non-authoritative. Repaired text must re-enter the selected `ProtocolAdapter` and `ToolCallValidator`. Until it passes validation, it is invalid.

### ToolCallAssembler

`ToolCallAssembler` is the only component that may create OpenAI `tool_calls`.

```ts
interface ToolCallAssembler {
  assemble(input: {
    validated: ValidatedCallStructure[]
    tools: NormalizedToolDefinition[]
  }): OpenAIToolCall[]
}
```

It must not parse protocol text, run repair, rename tools, add parameters, fill missing required values, or semantically rewrite arguments. It only unwraps payload encodings and assembles validated structures into the OpenAI shape.

### StreamGate

`StreamGate` has three interface modes:

```ts
type StreamGateMode =
  | 'pass_through'
  | 'full_buffer'
  | 'incremental_safe_buffer'
```

V1 behavior:

- No tools: `pass_through`.
- Managed tools: `full_buffer`.
- `incremental_safe_buffer` exists as an interface shape only and is not enabled by default.

`StreamGate` is an I/O gate. It may collect chunks, release pass-through chunks, and report facts. It must not parse protocols, validate structures, decide repair, or map responses.

```ts
interface StreamGateFacts {
  mode: StreamGateMode
  hasEscapedToClient: boolean
  escapedRanges: Array<{
    start: number
    end: number
    classification: 'plain_text' | 'unknown'
  }>
  detectedMarkers: Array<{
    protocol: ToolProtocolId
    marker: string
    offset: number
    confidence: 'partial' | 'full'
  }>
  bufferedRawOutput: string
}
```

Future incremental mode may use:

```text
chunk -> heuristic detect -> safe buffer -> final validate
```

but final validation must remain outside `StreamGate`.

## Execution Shell

`ToolTurnRunner` is a dependency executor, not a policy owner.

It only:

1. Calls `ToolStateMachine` to get the next operation.
2. Executes that operation through injected dependencies.
3. Reduces the result into the next FSM event.

```ts
interface ToolTurnRunnerDeps {
  modelInvoker: ModelInvoker
  streamGate: StreamGate
  protocolAdapterRegistry: ProtocolAdapterRegistry
  validator: ToolCallValidator
  repairPolicy: RepairPolicy
  structuralRepair: StructuralRepair
  assembler: ToolCallAssembler
  responseMapper: OpenAIResponseMapper
  telemetry: ToolTelemetry
}
```

The runner may ask `RepairPolicy` for a decision, but it cannot inspect failure kinds itself to choose repair. It must reduce the decision to an abstract operation result such as `invalid_structure_repairable` or `invalid_structure_blocked`.

## ModelInvoker and QualityRouter

`ModelInvoker` represents one model call.

```ts
interface ModelInvoker {
  invoke(input: ModelInvocationInput): Promise<ModelInvocationResult>
}
```

V1 implementation:

```text
CurrentForwarderInvoker -> existing RequestForwarder/load balancer/provider adapters
```

Future implementation:

```text
QualityRouterInvoker -> LiteLLM-style router
```

QualityRouter may own:

- model groups
- retry budget
- fallback chains
- cooldowns
- timeout policy
- account and provider health scores
- rate-limit backoff

QualityRouter must not own:

- tool protocol selection
- parser fallback
- structural repair
- decision to emit OpenAI `tool_calls`
- prompt/history tool formatting

Tool telemetry may feed future model health scoring. For example, repeated `tool_structure_invalid` events can lower a model/account score for later turns. The current turn's validation result is still owned by the tool runtime.

## Handling Mixed Protocol Output

Example malformed output:

```text
<|CHAT2API|tool_calls><|CHAT2API|invoke name="bash"><|CHAT2API|parameter name="argument"><![CDATA[Get-ChildItem ...]]></arg_value></tool_call>
```

Expected V1 path:

```text
ToolPlanner selects managed_buffered_structural + managed_xml
StreamGate full-buffers the provider output
managed_xml ProtocolAdapter extracts structural facts or malformed intent
ToolCallValidator classifies mixed container
StructuralRepair runs only if toolName and raw payload are already extractable
Repaired text re-enters managed_xml ProtocolAdapter and ToolCallValidator
ToolCallAssembler emits OpenAI tool_calls only after valid_structure
OpenAIResponseMapper returns tool_calls to the client
```

If pure structural repair is not possible:

```text
Return a safe blocked message.
Do not return raw malformed markup as executable text.
Do not emit OpenAI tool_calls.
Record telemetry.
```

Suggested safe message:

```text
The model attempted a tool call but produced invalid tool-call markup. Chat2API blocked it to avoid executing an unsafe or malformed tool request.
```

## Migration Plan

### Phase 1: Add the New Runtime Kernel

Create:

```text
src/main/proxy/toolRuntime/
  control/
    ToolPlanner.ts
    ToolStateMachine.ts
    executionProfiles.ts
  data/
    protocols/
    validation/
    repair/
    assembly/
    stream/
    mapping/
  runner/
    ToolTurnRunner.ts
```

Start with pure functions and unit tests. Do not connect the forwarder yet.

### Phase 2: Thin the Existing ToolCallingEngine

Keep `ToolCallingEngine` as a compatibility facade. Move planning, selected-protocol structure extraction, validation, assembly, and mapping behind the new runtime components.

The facade should stop directly parsing selected output and mutating responses without the new single truth chain.

### Phase 3: Full Buffer for Streaming Tool Requests

Freeze old streaming tool parser expansion:

```text
src/main/proxy/utils/streamToolHandler.ts
src/main/proxy/utils/toolParser*
src/main/proxy/utils/unifiedToolParser.ts
```

Managed requests with tools go through `StreamGate(full_buffer)`. Requests without tools remain pass-through.

### Phase 4: Provider Adapters Become Transport Only

Adapters receive prepared messages and transport them. They do not add tool prompts or select parsers. Existing warnings that direct adapter tool injection is disabled should remain, backed by tests.

### Phase 5: Add LiteLLM-Style QualityRouter

Replace `CurrentForwarderInvoker` with `QualityRouterInvoker` behind the `ModelInvoker` interface. Do this after the tool runtime is stable so routing failures and tool protocol failures remain distinguishable.

## Test Matrix

### Control Plane

- Planner selects only one of the closed profiles.
- Illegal derived flag combinations are impossible.
- `request.stream && tools` selects `managed_buffered_structural`.
- FSM valid transitions succeed.
- FSM invalid transitions fail.
- FSM cannot repair twice.

### Protocol and Validation

- Valid managed XML extracts structure facts.
- ProtocolAdapter never emits OpenAI `tool_calls`.
- Validator never emits OpenAI `tool_calls`.
- Selected protocol only: bracket/OpenCode blocks do not fallback-parse under `managed_xml`.
- Fenced tool examples remain plain text.
- Unknown tool names are blocked.
- Missing required parameters are blocked without semantic repair.

### StructuralRepair

- Rewrap does not change tool name.
- Rewrap does not change parameter names.
- Rewrap does not change raw payload.
- Rewrap does not add or remove parameters.
- Rewrap does not repair JSON.
- Rewrap does not validate schema.
- Repaired output must re-validate before assembly.

### StreamGate

- No-tools streams pass through.
- Tool streams full-buffer.
- Split markers across chunks do not leak.
- Valid buffered tool output maps to stream `delta.tool_calls`.
- Malformed mixed protocol output does not leak raw executable markup.
- `incremental_safe_buffer` facts shape is tested but not enabled by default.

### Integration and Final Gate

Keep and extend the deterministic regression command:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

Add focused tests under:

```text
tests/tool-runtime/planner.test.ts
tests/tool-runtime/state-machine.test.ts
tests/tool-runtime/managed-xml-structure.test.ts
tests/tool-runtime/validator.test.ts
tests/tool-runtime/structural-repair.test.ts
tests/tool-runtime/stream-gate.test.ts
tests/tool-runtime/runner.test.ts
```

Final acceptance still requires the existing OpenCode model probe after deterministic tests pass.

Hard failure rule:

```text
Any malformed or mixed protocol case that reaches client tool execution is a failed build.
```

## Deferred Decisions

1. Native provider tools are listed as a profile for architectural completeness. V1 implementation may keep native support disabled unless a provider has a tested native path.
2. Incremental streaming is deferred. It requires a new execution profile and leak tests before it can be enabled.
3. QualityRouter scoring is deferred until after the tool runtime is stable. When added, it may consume tool telemetry for future routing decisions, but it must not alter tool protocol decisions inside the current turn.
