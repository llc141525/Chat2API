# Tool Calling Reliability Hardening Design

Date: 2026-07-06

## Purpose

Chat2API currently has a strict tool-calling architecture on paper: `ToolCallingEngine` owns managed prompt injection and response parsing decisions, provider adapters forward transformed requests, and OpenAI-compatible clients remain responsible for executing tools. In real multi-turn use, four reliability failures are still being observed:

1. Tool definitions disappear after several turns.
2. Models start emitting raw angle-bracket protocol text instead of following the managed tool contract.
3. Models call tools with wrong names or invalid arguments.
4. Some provider/model paths return an empty assistant output regardless of the input.

This design defines a focused hardening pass for those failures. The goal is to make every managed tool turn derive prompt text, allowed tool names, parser expectations, validation, response assembly, diagnostics, and recovery decisions from one immutable per-turn contract. When a model or provider violates that contract, Chat2API must either safely preserve ordinary text, emit validated OpenAI `tool_calls`, or return a visible diagnostic failure instead of silently producing empty output.

## Existing Boundaries

The current codebase already has the main pieces needed for this design:

- `src/main/proxy/forwarder.ts` routes requests to provider adapters and is the correct place to attach per-turn runtime facts to a provider call.
- `src/main/proxy/sessionManager.ts` stores multi-turn messages and session identifiers.
- `src/main/proxy/services/contextManagementService.ts` trims or summarizes message history and must preserve protocol-critical message metadata.
- `src/main/proxy/toolCalling/ToolCallingEngine.ts` owns managed prompt injection and non-stream response parsing decisions.
- `src/main/proxy/toolCalling/ToolStreamParser.ts` converts streamed managed protocol output into OpenAI-compatible `delta.tool_calls`.
- `src/main/proxy/toolCalling/runtimePlan.ts`, `providerProfiles.ts`, and `types.ts` choose the protocol and parse behavior for a turn.
- `src/main/proxy/toolCalling/catalog.ts`, `catalogPersistence.ts`, `availabilityDrift.ts`, and `diagnostics.ts` already point toward a runtime contract model.
- `src/main/proxy/toolRuntime/*` contains the newer control/data-plane concepts for structural validation, stream gating, repair, mapping, and turn running.
- `tests/tool-calling/*` and provider tests already cover many parser, catalog, routing, and protocol edges.

This phase should connect and tighten these boundaries. It should not create a second parser, a second prompt injector, or a semantic repair system.

## Non-Goals

- Chat2API does not execute client tools.
- Provider adapters do not inject managed tool prompts.
- Provider adapters do not parse managed tool calls independently from the selected runtime plan.
- This design does not add semantic tool repair, tool-name guessing, argument invention, or schema-derived argument completion.
- This design does not replace the existing provider transports.
- This design does not accept malformed XML-like examples as tool calls.
- This design does not hide empty provider output behind an empty assistant message.
- This design does not require a broad rewrite of `toolCalling/*` and `toolRuntime/*` in one step.

## Core Principles

1. A managed tool turn has exactly one runtime contract.
2. The runtime contract is immutable for the duration of the provider call.
3. Tool availability is structural state, not model memory.
4. Prompt-rendered tools, allowed tool names, parser protocol, validator input, and response assembly all reference the same contract fingerprint.
5. Session history may provide fallback tool availability, but it must never become a silent empty source when request tools or stored catalog facts exist.
6. Context trimming and summarization must preserve assistant `tool_calls` and tool `tool_call_id` metadata.
7. Ordinary model text containing angle brackets remains text unless the selected protocol extracts a valid tool call.
8. Invalid tool calls are rejected structurally and diagnosed; they are not rewritten into plausible calls.
9. Empty output is a provider/runtime failure mode with explicit diagnostics, not a valid successful assistant answer.
10. Streaming and non-streaming paths must produce equivalent final semantics.

## Target Runtime Contract

Introduce or complete a per-turn `ToolTurnContract` concept. The name can reuse an existing type if the implementation already has a suitable equivalent, but the runtime facts must exist as one unit.

```ts
interface ToolTurnContract {
  turnId: string
  sessionId: string | null
  providerId: string
  model: string
  protocol: 'managed_xml' | 'managed_bracket' | 'native_openai' | 'none'
  snapshotFingerprint: string | null
  tools: NormalizedToolDefinition[]
  allowedToolNames: ReadonlySet<string>
  toolChoice: ToolChoicePolicyResult
  shouldInjectPrompt: boolean
  shouldParseResponse: boolean
  historyMode: 'openai_native' | 'managed_protocol'
  emptyOutputPolicy: 'diagnose_and_fail' | 'pass_through_without_tool_semantics'
}
```

Hard requirements:

- The contract is created once before provider forwarding.
- `ToolCallingEngine`, stream parsing, non-stream parsing, diagnostics, and provider adapter options receive the same contract or a derived immutable view.
- The contract records whether tool availability came from current request tools, session catalog, message-history extraction, or safe empty fallback.
- If tools are expected but the resolved list is empty, diagnostics must record the failed source chain.
- If `shouldParseResponse` is true, the parser must use only `protocol`; it must not try alternate protocol formats.

## Failure 1: Tool Definitions Lost Across Turns

### Problem

In multi-turn sessions, later requests can arrive without `tools` while still depending on earlier tool definitions. If the runtime resolves tools only from the current request, or if context trimming removes metadata needed to reconstruct tool availability, the model sees no valid tool contract and stops calling tools.

### Design

Tool resolution must follow this exact degradation chain:

```text
Current request tools
  -> Session catalog snapshot
  -> Message history extraction
  -> Safe empty fallback with diagnostic
```

The safe empty fallback is allowed only when all earlier sources are unavailable. It must be observable in diagnostics and must not be indistinguishable from a request that intentionally had no tools.

Session context processing must preserve:

- Assistant messages with `tool_calls`.
- Tool messages with `tool_call_id`.
- Tool-call IDs and function names.
- The association between an assistant tool call and the later tool result.
- Contract fingerprint metadata when present.

Context management may trim ordinary text around tool exchanges, but it must not split a tool-call pair in a way that leaves a tool result without the corresponding assistant `tool_calls`, or an assistant `tool_calls` message without enough following context for the client/model to understand the result.

### Acceptance Criteria

- A request with tools establishes a session catalog snapshot.
- A later request in the same session without request tools still renders the same available tool names when the catalog is present.
- If the catalog is unavailable, tool names can be recovered from retained message history.
- If all sources are unavailable, the turn records a safe-empty diagnostic with the source chain.
- Sliding-window, token-limit, and summary context strategies preserve `tool_calls` and `tool_call_id` fields.

## Failure 2: Raw Angle-Bracket Protocol Drift

### Problem

After multiple turns, models may emit raw managed XML tags, protocol examples, escaped tags, or partial angle-bracket text as assistant content. Some of that text is ordinary content. Some is malformed tool-call output. Some is a valid tool call. Chat2API must distinguish those cases without leaking internal protocol markers or converting examples into tool calls.

### Design

Managed XML remains the canonical protocol for GLM, Qwen, and Qwen AI unless a provider profile explicitly selects another protocol. For each managed turn:

- Prompt injection comes only from `ToolCallingEngine`.
- The selected provider profile chooses exactly one protocol.
- The stream and non-stream parsers use the same protocol adapter.
- Fenced examples, escaped tags, unknown tool names, incomplete tool blocks, and malformed argument blocks remain plain content or are dropped with diagnostics according to the existing parser safety rules.
- Valid managed tool-call blocks convert to OpenAI `tool_calls`.
- Once a valid tool call is emitted for a streaming response, trailing malformed protocol fragments are suppressed or diagnosed rather than appended as assistant text.

Protocol drift detection should be structural. It should record facts such as:

- Protocol marker seen.
- Marker was fenced, escaped, partial, malformed, or valid.
- Tool name was allowed or unknown.
- Arguments parsed as valid JSON object, invalid JSON, non-object JSON, or missing.
- Parser emitted content, emitted tool calls, suppressed unsafe fragments, or failed the turn.

Diagnostics must avoid logging full tool arguments or full schemas.

### Acceptance Criteria

- Ordinary text containing `<`, `>`, XML examples, escaped tags, and fenced tool examples remains content.
- A valid managed XML tool call becomes OpenAI `message.tool_calls` or streamed `delta.tool_calls`.
- Unknown tool names do not produce tool calls.
- Bracket-format output is ignored when the contract selected managed XML.
- Partial protocol markers split across stream chunks do not leak partial markers to the client.
- Malformed managed XML does not become an invented tool call.

## Failure 3: Wrong Tool Calls or Invalid Arguments

### Problem

The model may select the wrong tool name, omit required arguments, provide arguments with the wrong shape, or emit JSON that is syntactically valid but not an object suitable for OpenAI `function.arguments`.

### Design

Validation remains structural and contract-based:

- The tool name must exist in `allowedToolNames`.
- Arguments must parse as JSON.
- Parsed arguments must be a JSON object.
- The serialized `function.arguments` returned to the client must be the original valid object serialized deterministically enough for tests, without semantic rewriting.
- Schema validation may reject obviously invalid shapes when the normalized tool schema makes the requirement structural and deterministic.
- Schema validation must not fill defaults, rename keys, infer missing values, coerce unrelated types, or call a model to repair arguments.

When validation fails, behavior depends on response mode:

- Non-streaming: return plain assistant content only if the output is safe ordinary text; otherwise return a UI-safe tool-call protocol error with diagnostics.
- Streaming: do not emit partial `tool_calls`; finish the stream with a visible error chunk or adapter-consistent failure signal if the provider path supports it.

The exact client-visible error shape should match existing proxy error conventions so OpenAI-compatible clients receive a predictable failure instead of an empty assistant response.

### Acceptance Criteria

- Unknown tool names are rejected before OpenAI response assembly.
- Invalid JSON arguments are rejected.
- Non-object JSON arguments are rejected.
- Missing structurally required arguments are rejected when the normalized schema exposes required fields.
- Valid arguments containing literal `<`, `>`, XML-like strings, JSON strings, CDATA-like text, and newlines are preserved.
- Diagnostics show the validation category without storing sensitive argument payloads.

## Failure 4: Empty Output From Some Models

### Problem

Some provider/model paths can return no assistant content and no tool calls, even when the user input should produce a response. This may happen because provider output is actually empty, because stream gating buffered and dropped content, because a malformed tool buffer was discarded, because thinking/search markers consumed all visible text, or because adapter-specific parsing failed without surfacing an error.

### Design

Every provider call must produce one of these terminal outcomes:

```ts
type ProviderTurnOutcome =
  | 'content'
  | 'tool_calls'
  | 'provider_empty'
  | 'runtime_suppressed_malformed_tool_output'
  | 'adapter_parse_error'
  | 'provider_error'
```

The forwarder or runtime layer must track:

- Whether the provider stream produced raw bytes or events.
- Whether assistant-visible content was observed.
- Whether a valid tool call was emitted.
- Whether content was buffered by `ToolStreamParser` or `StreamGate`.
- Whether buffered content was released, suppressed, or dropped.
- Whether adapter thinking/search stripping removed all visible content.
- Whether the provider returned an explicit error.

If a turn ends with no content and no tool calls, Chat2API must not return a successful empty assistant message unless the provider profile explicitly marks the model as intentionally silent for that mode. Otherwise it should return a visible, UI-safe error and record diagnostics with the terminal outcome.

### Acceptance Criteria

- Non-stream responses with empty content and no tool calls fail with an explicit empty-output diagnostic.
- Streaming responses that receive raw provider data but emit no OpenAI content/tool chunks fail or produce a final diagnostic event according to existing stream conventions.
- Tool parser buffering cannot silently erase the entire assistant answer.
- Thinking/search marker stripping cannot silently erase the entire assistant answer without recording the stripping reason.
- Provider-specific intentional silent modes remain possible only through an explicit provider profile flag.

## Provider Profile Requirements

Provider profiles must declare protocol and empty-output behavior explicitly. At minimum, managed tool providers should be inspectable as:

```ts
interface ProviderToolProfile {
  providerId: string
  defaultProtocol: 'managed_xml' | 'managed_bracket' | 'native_openai' | 'none'
  managedPromptOwner: 'ToolCallingEngine'
  parseStreaming: boolean
  parseNonStreaming: boolean
  supportsIntentionalEmptyOutput: boolean
  preservesToolHistory: boolean
}
```

Required profile facts:

- GLM, Qwen, and Qwen AI use managed XML unless a specific model profile overrides it.
- Provider adapters must not import prompt-injection helpers.
- Non-stream and stream behavior must be aligned for each provider.
- Empty output must be disallowed by default.

## Test Strategy

Use deterministic local regression tests before any model probe.

### Required Test Areas

- `tests/tool-calling/catalog-persistence.test.ts`: catalog snapshot survives later turns without request tools.
- `tests/tool-calling/catalog-fallback.test.ts`: resolution follows request tools, session catalog, message history, safe empty.
- `tests/providers/context-tool-metadata.test.ts`: context processing preserves assistant `tool_calls` and tool `tool_call_id`.
- `tests/tool-calling/tool-parser.test.ts`: managed XML parsing rejects malformed, unknown, fenced, escaped, and bracket-protocol drift.
- `tests/tool-calling/tool-stream-parser.test.ts`: chunk-split markers do not leak and valid calls emit `delta.tool_calls`.
- `tests/tool-calling/runtime-plan.test.ts`: selected protocol is immutable for the turn.
- `tests/tool-calling/tool-diagnostics.test.ts`: source-chain, drift, validation, and empty-output diagnostics redact arguments and schemas.
- `tests/providers/glm-tool-calling.test.ts`: GLM managed XML is injected and parsed through `ToolCallingEngine`.
- `tests/providers/qwen-request-routing.test.ts`: Qwen and Qwen AI keep managed XML behavior and route through the same plan.
- A new or extended provider test for empty output: no content and no tool calls returns an explicit failure unless the provider profile opts into intentional silence.

### Final Regression Command

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

After deterministic tests pass, the existing OpenCode probe remains the final end-to-end gate for large behavior changes:

```powershell
npm run dev:win 2>&1 | Tee-Object -FilePath .\dev.log
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "glm/GLM-5.2"
```

The probe must still verify generated JSON, skill invocation, multiple tool calls, a tool call after an observation event, and final `CAPABILITY_PROBE_DONE` text.

## Rollout Plan

This design should be implemented in small phases:

1. Contract tracing and diagnostics: make each managed turn report tool source, protocol, parser mode, and terminal outcome.
2. Tool preservation: harden session catalog fallback and context metadata preservation.
3. Parser and validator alignment: ensure streaming and non-streaming paths share the selected protocol and structural validation categories.
4. Empty-output policy: fail visible empty outcomes by default and whitelist only intentional provider-profile cases.
5. Provider profile cleanup: make GLM, Qwen, and Qwen AI profile facts explicit and covered by tests.

Each phase must keep Chat2API externally OpenAI-compatible.

## Open Questions Resolved By This Spec

- If tools are missing from the current request but known from the session, Chat2API should continue exposing them through the managed prompt.
- If the model emits malformed protocol text, Chat2API should not repair it semantically.
- If the model emits a valid tool name with invalid arguments, Chat2API should reject the tool call rather than guess the arguments.
- If a provider returns empty content and no tool calls, Chat2API should treat that as an error unless an explicit provider profile says the silence is intentional.

## Self-Review

- Placeholder scan: no placeholder implementation details remain.
- Internal consistency: all four reported failures map to contract, context, parser/validator, or empty-output behavior.
- Scope check: this is one reliability-hardening spec focused on tool calling; it does not require replacing provider transports.
- Ambiguity check: fallback order, parser ownership, repair limits, and empty-output behavior are explicit.
