# Tool Availability Catalog and Contract Design

Date: 2026-06-30

## Purpose

Chat2API's single-truth tool runtime already makes managed tool parsing stricter, but multi-turn sessions can still drift when a model later claims that tools such as `bash` or `write` do not exist. That failure is not primarily a parser or repair problem. It is a current-turn tool availability contract problem.

This phase introduces an explicit `ToolCatalogStore`, immutable per-turn `ToolCatalogSnapshot`s, a model-visible `Tool Contract Header`, narrow availability-drift retry, and structure-only diagnostics. The goal is to ensure every managed tool turn has one authoritative source of available tools and that prompt rendering, validation, protocol mapping, and later quality routing all derive from the same catalog facts.

## Non-Goals

- Chat2API does not execute client tools.
- This phase does not replace all managed XML prompting with OpenAI native `tool_calls`.
- This phase does not add semantic tool repair, argument completion, tool-name guessing, or automatic tool-call generation.
- Availability drift retry does not become a general retry system.
- Diagnostics do not feed back into the current turn's tool runtime decisions.
- LiteLLM-style quality routing remains a later layer and must not parse, repair, or rewrite tool calls.

## Core Principles

1. Tool availability is a runtime contract, not a model memory task.
2. `ToolCatalogStore` is the single source of truth for available tools across managed turns.
3. `sessionManager` may reference catalog identity, but it must not own tool availability truth.
4. Every managed turn consumes an immutable `ToolCatalogSnapshot`.
5. Prompt-rendered tools, allowed tool names, validator input, and protocol rendering must derive from the same snapshot.
6. Drift handling is structural and bounded. It never invents tool semantics.
7. External client boundaries remain OpenAI-compatible.
8. Provider prompt protocol remains profile-specific. Managed XML stays valid for Qwen, GLM, and Qwen AI unless a provider profile explicitly selects another protocol.
9. Diagnostics record structure facts only and avoid logging tool arguments or full schemas.

## Target Boundary Model

```text
OpenAI-compatible clients
  request.tools / response.tool_calls / tool_call_id
        ↓
ToolCatalogStore
  canonical available-tool truth per session/request
        ↓
ToolPlanner
  immutable per-turn plan from ToolCatalogSnapshot
        ↓
PromptRenderer / ProtocolAdapter / Validator
  consume the same snapshot, no local tool inference
        ↓
Provider profile prompt protocol
  managed_xml or future provider-specific protocol
```

## ToolCatalogStore

`ToolCatalogStore` is an independent runtime service. It owns normalized tool availability state and returns immutable snapshots for a turn.

```ts
interface ToolCatalogStore {
  resolveSnapshot(input: ToolCatalogResolveInput): ToolCatalogResolution
  updateFromRequest(input: ToolCatalogUpdateInput): ToolCatalogResolution
  clearSession(sessionId: string): void
}

interface ToolCatalogSnapshot {
  sessionId: string | null
  fingerprint: string
  tools: NormalizedToolDefinition[]
  allowedToolNames: string[]
  schemaHashes: Record<string, string>
  source: 'current_request' | 'session_catalog'
  createdTurnIndex: number
  updatedTurnIndex: number
}
```

The fingerprint must be derived from normalized structural facts:

- ordered tool names after canonical sorting
- stable schema hash per tool
- protocol-relevant tool metadata
- tool choice constraints that affect availability

The fingerprint must not include prompt text, model output, tool arguments, or provider response content.

## Catalog Resolution Policy

The catalog source priority is mixed but explicit:

1. If the current request provides tools, normalize them and update the session catalog.
2. If the current request omits tools and a session catalog exists, reuse the session catalog.
3. If the current request omits tools, no session catalog exists, and managed tool history is present, block with diagnostics.
4. If the current request omits tools, no session catalog exists, and no managed tool context exists, continue as tool-disabled passthrough.

Current request tools are allowed to add tools. Removals and schema changes require drift classification before continuing.

## Drift Classification

Catalog drift is detected by comparing the previous session catalog fingerprint and per-tool schema hashes with the current request.

```ts
type ToolCatalogDriftKind =
  | 'added_tool'
  | 'removed_tool'
  | 'schema_changed'
  | 'missing_current_tools_with_session_catalog'
  | 'missing_current_tools_without_catalog'
  | 'history_references_unknown_tool'
```

Allowed behavior:

- `added_tool`: update catalog and continue.
- `missing_current_tools_with_session_catalog`: reuse catalog and reinject contract.
- `missing_current_tools_without_catalog`: continue only if there is no managed tool history.

Blocking behavior:

- `removed_tool`: block if historical managed context references the removed tool.
- `schema_changed`: block if historical managed context references the changed tool.
- `history_references_unknown_tool`: block because the runtime cannot prove the tool existed in this session.
- `missing_current_tools_without_catalog`: block if historical managed tool context exists.

Blocking must produce a structured diagnostic response rather than asking the model to infer or repair the tool set.

## ToolPlanner Integration

`ToolPlanner` receives a `ToolCatalogSnapshot` or an explicit no-tools resolution. It must not read request tools directly after catalog resolution.

```ts
interface ToolPlanInput {
  catalog: ToolCatalogSnapshot | null
  catalogDiagnostics: ToolCatalogDiagnostics
  providerProfile: ProviderToolProfile
  requestToolChoice: ToolChoiceInput
  hasManagedToolHistory: boolean
}
```

The plan exposes:

- selected execution profile
- selected protocol
- `allowedToolNames` from the snapshot
- snapshot fingerprint
- whether availability drift retry is allowed for this provider profile

No downstream component may recompute allowed tool names from prompt text, request body, history messages, or provider output.

## Tool Contract Header

For managed prompt protocols, the rendered tool prompt must include the full tool list and a compact `Tool Contract Header`.

The header communicates structural facts:

- current tool catalog fingerprint
- protocol id and header version
- allowed tool names
- statement that this list is the current turn's runtime-provided tool set
- instruction that tools in the list are available in this turn

The header must not include a standing drift recovery policy. The model should not be asked to decide how to recover from tool availability drift. Recovery is a runtime decision.

## Availability Drift Detector

Availability drift means the catalog proves tools are available, but the model returns ordinary assistant text claiming tools are unavailable or absent.

Detection is intentionally narrow:

```ts
interface AvailabilityDriftInput {
  catalog: ToolCatalogSnapshot
  providerId: string
  modelId: string
  rawAssistantText: string
  parsedToolCalls: ValidatedToolCall[] | null
  retryAlreadyAttempted: boolean
}
```

A drift retry may be triggered only when all of these are true:

- the current turn has a non-empty `ToolCatalogSnapshot`
- the response contains no valid tool call
- the response is ordinary assistant text
- the text matches explicit "tool unavailable / not provided / does not exist" patterns
- the denied tool name is present in the snapshot, or the text denies tool availability generally while the snapshot has tools
- the provider profile allows availability drift retry
- this turn has not already used availability drift retry

The detector must not infer intended tool calls, intended arguments, or user intent.

## Availability Retry Policy

At most one retry is allowed for a turn.

The retry may only:

- reinject the same `ToolCatalogSnapshot`
- reinject the same full tool list
- reinject the same `Tool Contract Header`
- add one structural clarification that the runtime-provided catalog is authoritative for the current turn

The retry must not:

- create or suggest a tool call
- choose a tool for the model
- modify tool arguments
- alter historical messages except for the bounded clarification
- change the catalog
- retry more than once
- become provider quality routing

If the retry succeeds with a valid tool call, the normal single-truth tool runtime continues. If it fails, Chat2API returns the model output with structured diagnostics or a bounded tool-availability failure, depending on the existing response mode.

## Diagnostics Contract

Every managed tool turn should emit structure-only diagnostic events that later quality routing can consume statistically.

Required events:

```ts
type ToolDiagnosticEvent =
  | 'tool_catalog_resolved'
  | 'tool_catalog_drift_detected'
  | 'tool_contract_injected'
  | 'tool_availability_drift_detected'
  | 'tool_availability_retry_result'
  | 'provider_empty_output'
```

Event payloads may include:

- session id or request id
- provider id and model id
- catalog source
- catalog fingerprint
- tool names
- schema hashes
- drift kind
- protocol id
- header version
- retry attempted/skipped/succeeded/failed
- response mode: streaming or non-streaming

Event payloads must not include:

- tool argument values
- full tool schemas
- full prompts
- provider credentials
- raw OAuth/session data
- full model output unless explicitly enabled by a separate debug setting

Diagnostics are observational. They must not rewrite tool runtime behavior inside the current turn. Later quality routing may use aggregated diagnostics to score providers, but routing must remain outside the tool parsing and repair path.

## Provider Protocol Profile

The external boundary remains OpenAI-compatible:

- client requests use OpenAI-compatible `tools`
- assistant responses return OpenAI-compatible `tool_calls`
- streaming uses OpenAI-compatible `delta.tool_calls`
- tool results preserve `tool_call_id`

The provider prompt boundary remains profile-specific:

```ts
interface ProviderToolProfile {
  providerId: string
  protocol: 'managed_xml' | 'native_openai' | 'future_json_block'
  contractHeaderVersion: number
  availabilityDriftRetry: 'enabled' | 'disabled'
}
```

V1 expected defaults:

- Qwen: `managed_xml`, availability retry enabled
- Qwen AI: `managed_xml`, availability retry enabled
- GLM: `managed_xml`, availability retry enabled
- DeepSeek web reverse: managed protocol only if the provider profile proves stable; empty output diagnostics must be tracked separately

Changing a provider from managed XML to another prompt protocol requires a provider profile change and deterministic tests. It must not happen as parser fallback.

## Runtime Canonical Form

Internal runtime truth is a structured canonical tool event, not XML text and not OpenAI response JSON.

```ts
interface CanonicalToolCall {
  id: string
  name: string
  argumentsText: string
  protocol: 'managed_xml' | 'native_openai' | 'future_json_block'
  source: 'model_output'
  catalogFingerprint: string
}
```

Managed XML is a provider prompt protocol. OpenAI `tool_calls` are a client API representation. Neither is allowed to become the runtime's only source of truth.

## Expected Impact

This phase should directly address multi-turn tool loss where a model claims `bash`, `write`, or other catalog tools do not exist. Each turn will reestablish the tool availability contract from runtime state instead of relying on the model to remember tools from prior context.

Qwen stability should improve for long sessions because tool availability is reinforced every managed turn. GLM may improve, but provider-specific instruction following can still require profile tuning. DeepSeek empty or swallowed output is tracked by diagnostics, but it is likely a separate provider output stability problem rather than a tool availability contract failure.

## Testing Requirements

Deterministic tests must cover:

- request tools create a catalog snapshot with stable fingerprint and schema hashes
- omitted tools reuse an existing session catalog
- omitted tools with no catalog and managed tool history block
- added tools update the catalog
- removed or schema-changed tools block when historical managed context references them
- prompt rendering uses the snapshot's allowed tools and fingerprint
- validator receives allowed tool names only from the snapshot
- model text denying an available tool triggers at most one availability retry
- availability retry does not change tool arguments, generate tool calls, or modify the catalog
- failed availability retry emits diagnostics without retry loops
- diagnostic events omit tool arguments and full schemas
- streaming and non-streaming response modes both preserve OpenAI-compatible output boundaries

The existing final gate remains required after implementation:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

The OpenCode model probe remains the end-to-end evidence layer. This phase should add assertions or captured diagnostics that help distinguish tool availability drift from provider empty-output failures.

## Implementation Phasing

Recommended implementation batches:

1. Add `ToolCatalogStore`, snapshot normalization, fingerprints, and drift classification.
2. Route `ToolPlanner`, prompt rendering, and validation through `ToolCatalogSnapshot`.
3. Add `Tool Contract Header` rendering for managed XML provider profiles.
4. Add availability drift detection and one-shot structural retry.
5. Add diagnostics events and debug visibility.
6. Extend deterministic tests and rerun the OpenCode capability probe.

Each batch should preserve the existing single-truth runtime boundaries: no semantic repair, no parser fallback, no adapter-local prompt injection, and no provider router logic inside the tool runtime.
