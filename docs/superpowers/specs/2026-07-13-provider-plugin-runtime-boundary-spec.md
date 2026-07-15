# Provider Plugin Runtime Boundary Spec

Date: 2026-07-13
Scope: Chat2API provider adapter architecture

## Purpose

Chat2API already has partial modularization:

- `RequestForwarder` has a provider dispatch registry.
- tool protocols have `ToolProtocolAdapter`.
- client tool inputs have `ToolClientAdapter`.
- provider tool behavior has `ProviderToolProfile`.

But provider web protocol logic is still mostly embedded inside large provider-specific adapter classes such as Qwen, GLM, Kimi, DeepSeek, MiniMax, Mimo, Perplexity, and Z.ai.

This spec defines the next architecture step: split common provider runtime behavior from provider-private web protocol behavior.

## Core Answer

This architecture can make common bugs fixable in one place.

It cannot make every provider-private web change fixable in one place.

Correct target:

```text
Common runtime bug -> fix once in Provider Runtime / Core
Provider website protocol change -> fix only that provider plugin
```

Examples of one-place fixes:

- session boundary policy
- compact/fork behavior
- tool child and subagent child handoff
- prompt refresh mode policy
- tool definition no-loss guard
- managed tool parser fixes
- OpenAI-compatible output shaping
- generic stream event normalization
- generic error classification framework
- fixture replay harness

Examples of provider-private fixes:

- Qwen renames `session_id`
- GLM moves `conversation_id`
- Kimi changes stream chunk format
- Perplexity changes delete-session endpoint
- MiniMax changes polling protocol
- a provider changes auth/cookie/token behavior
- a provider adds captcha/risk-control flow

## Design Goal

Move from:

```text
Forwarder
  -> forwardQwen / forwardGLM / forwardKimi / ...
     -> each method owns session, request, response, stream, deletion, errors
```

to:

```text
Forwarder
  -> ProviderRuntime
     -> WebProviderPlugin
```

The core runtime owns common lifecycle and policy.

The provider plugin owns only provider-private web protocol details.

## Target Layers

### Chat2API Core

Owns:

- OpenAI-compatible request/response shape
- tool catalog
- tool prompt ownership through `ToolCallingEngine`
- context management
- session boundary policy
- child session handoff policy
- prompt refresh policy
- diagnostics
- routing

Must not know:

- provider website payload field names
- provider SSE/chunk quirks
- provider auth cookie shape
- provider delete-session endpoints

### Provider Runtime

Owns:

- selecting the plugin
- applying common request preparation
- invoking plugin request builder
- invoking plugin response parser
- storing provider session state
- applying delete/cleanup policy
- converting provider events to OpenAI-compatible output
- applying generic retry/repair policy
- running fixture replay tests

### Web Provider Plugin

Owns:

- auth state acquisition/refresh
- provider request body construction
- provider URL/method/header construction
- stream parser
- non-stream parser
- provider session id extraction
- parent/conversation id extraction
- provider delete-session behavior
- provider-specific error classification
- provider-specific capability manifest

## Proposed Interface

```ts
export interface WebProviderPlugin {
  id: string
  version: string

  matches(provider: Provider): boolean

  capabilities: ProviderPluginCapabilities

  buildRequest(input: ProviderRuntimeRequest): Promise<ProviderWebRequest>

  parseNonStream(input: ProviderWebResponse): Promise<ProviderRuntimeResult>

  parseStream?(input: ProviderWebStream): AsyncIterable<ProviderRuntimeEvent>

  deleteSession?(input: ProviderDeleteSessionInput): Promise<ProviderDeleteSessionResult>

  classifyError?(error: unknown): ProviderRuntimeError
}
```

Capability manifest:

```ts
export interface ProviderPluginCapabilities {
  supportsProviderSession: boolean
  supportsParentMessageId: boolean
  supportsDeleteSession: boolean
  supportsStreaming: boolean
  supportsNonStreaming: boolean
  supportsNativeTools: boolean
  preferredManagedProtocol: 'managed_xml' | 'managed_bracket' | 'native' | 'none'
  sessionIdKind: 'session_id' | 'conversation_id' | 'chat_id' | 'request_id' | 'none'
  transport: 'openai_chat_completions' | 'provider_chat_api' | 'grpc_web_stream' | 'polling_stream' | 'websocket' | 'unknown'
}
```

Normalized runtime event:

```ts
export type ProviderRuntimeEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_delta'; call: ToolCallDelta }
  | { type: 'session_update'; sessionId?: string; parentId?: string }
  | { type: 'done'; finishReason?: string }
  | { type: 'error'; error: ProviderRuntimeError }
```

## What Becomes One-Place Fixable

### Session Boundary

Provider Runtime should apply:

- normal continuation
- compact fork
- tool child fork
- subagent child fork
- repair mode

Plugins should only expose whether and how provider sessions are represented.

One-place fix:

- changing compact fork rules
- preserving tool catalog identity across forks
- grouping tool child sessions by workflow

### Prompt Refresh

Provider Runtime should decide:

- `full`
- `tool_ready`
- `digest`
- `minimal`
- `repair`

Plugins should only render provider-specific request shape.

One-place fix:

- when to resend full tool definitions
- when to use digest/minimal continuation
- when to repair after malformed tool output

### Tool Definition No-Loss

Core and Provider Runtime should own:

- tool catalog session key
- fallback source ordering
- active `assistant.tool_calls`
- matching `tool.tool_call_id`
- no-loss tests

Plugins must not own tool prompt injection.

One-place fix:

- tool schema preservation
- parser repair
- OpenAI-compatible tool call output shaping

### Fixture Replay

Provider Runtime should provide a common replay harness.

Each plugin contributes fixtures:

- request payload fixture
- stream response fixture
- non-stream response fixture
- session extraction fixture
- error fixture

One-place fix:

- replay runner
- redaction rules
- pass/fail reporting
- compatibility matrix

## What Stays Provider-Specific

Each plugin still must handle:

- exact endpoint path
- exact JSON body shape
- exact stream/chunk format
- exact session id field
- exact deletion endpoint
- exact auth/cookie/token flow
- exact risk-control/captcha signal
- provider-specific compression or encoding

This is intentional. These are private web protocol details.

The value of the plugin boundary is that these changes stop leaking into core logic and other providers.

## Migration Strategy

### Phase 1: Extract Interface Without Behavior Change

Goal:

- define `WebProviderPlugin` and normalized runtime types
- wrap one existing adapter, preferably Qwen or GLM, behind the interface
- keep old forwarder behavior equivalent

Acceptance:

- no provider behavior change
- existing deterministic tests pass
- plugin wrapper can call the old adapter internally

### Phase 2: Move Common Session Runtime Out of Forwarder

Goal:

- Provider Runtime owns provider conversation state read/write
- plugin only reports session updates

Acceptance:

- Qwen/GLM session continuity tests still pass
- compact/tool/subagent boundaries remain enforced
- delete-after-chat still works where supported

### Phase 3: Move Common Response Normalization Out of Adapters

Goal:

- plugin emits normalized events/results
- Provider Runtime converts to OpenAI-compatible response/stream

Acceptance:

- streaming and non-streaming tool call tests pass
- provider-specific parsers are fixture-tested

### Phase 4: Add Provider Fixture Replay

Goal:

- every plugin has provider web fixtures
- parser/session/error behavior can be tested without live provider calls

Acceptance:

- a provider web response format change can be captured as a fixture
- failing fixture points to one plugin
- core tests do not need live web provider access

### Phase 5: Convert Remaining Providers

Goal:

- Qwen, GLM, Kimi, DeepSeek, MiniMax, Mimo, Perplexity, Qwen AI, and Z.ai all implement or wrap `WebProviderPlugin`

Acceptance:

- `RequestForwarder` no longer has provider-specific forward methods as primary logic
- adding a provider means registering a plugin and fixtures

## Review Checklist

Do not accept a plugin migration if:

- a provider adapter imports prompt injection helpers
- tool prompt ownership moves out of `ToolCallingEngine`
- session boundary logic is duplicated inside multiple plugins
- plugin code mutates OpenAI messages to inject tool contracts
- provider-private parsing leaks into core runtime
- fixture replay is missing for stream/session extraction behavior

Do accept if:

- common policy lives in Provider Runtime
- private web protocol details live in plugin
- provider fixtures prove parser behavior
- existing tool no-loss tests pass
- live probe behavior is unchanged or improved

## Expected Outcome

After this architecture is in place:

- fixing a compact/session/tool-catalog bug should happen once in core/runtime
- fixing a managed tool parser bug should happen once in protocol parser
- fixing Qwen website API drift should happen only in the Qwen plugin
- fixing GLM website API drift should happen only in the GLM plugin
- adding a new provider should require a plugin, capability manifest, and fixtures, not forwarder surgery

The practical promise is:

```text
Common Chat2API behavior becomes one-place fixable.
Provider-private web drift becomes one-plugin fixable.
```

