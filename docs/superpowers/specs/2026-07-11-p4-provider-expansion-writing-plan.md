# P4 Provider Expansion Writing Plan

Date: 2026-07-11
Parent spec: `docs/superpowers/specs/2026-07-10-agent-tooling-stability-spec.md`
Depends on:

- `docs/superpowers/specs/2026-07-11-p0-p1-followup-plan.md`
- `docs/superpowers/specs/2026-07-11-p0-p1-summary-contamination-plan.md`

## Objective

Extend the managed tool-calling reliability work beyond DeepSeek, GLM, and Qwen to the next provider set:

- Z.ai
- Kimi
- MiniMax

The target state is that OpenCode can run the same deterministic skill/tool probe through each provider and prove real multi-turn tool use, not just final text completion.

## Why This Exists

The current high-confidence acceptance surface is concentrated on GLM, Qwen, and DeepSeek. Z.ai, Kimi, and MiniMax already have adapter code and some deterministic tests, but they are not yet held to the same real-agent acceptance standard.

This matters because each provider has a different transport and response shape:

- Z.ai uses a dedicated chat API and is documented as captcha/risk-control sensitive.
- Kimi uses web/gRPC-like framing and multi-stage stream events.
- MiniMax can return either direct response data or polling/streaming response data.

All three can fail in provider-specific ways even when `ToolCallingEngine` produces a valid managed tool plan.

## Non-Goals

- Do not re-open DeepSeek, GLM, or Qwen in this plan except as comparison baselines.
- Do not add provider-adapter-owned prompt injection.
- Do not bypass provider risk controls, captcha, or platform policy.
- Do not claim support for a provider until the OpenCode probe proves skill invocation, at least two non-skill tools, and a post-result tool call.
- Do not use model self-reporting as evidence that tools work.

## Invariants

All existing invariants still apply:

- INV-001 Single Ownership — `ToolCallingEngine` is the only owner of managed tool prompt injection.
- INV-002 Stateless Fallback — `Session Store -> OpenAI Tools -> Prompt-Embedded -> History -> Safe Empty`.
- INV-003 Delete = Risk.
- INV-004 Client Quirks Matrix.
- INV-005 Config-vs-History Split — summaries must not become authoritative tool catalogs.

Provider-specific extension:

- **INV-006 Provider Parity Gate** — every managed provider listed as OpenCode-compatible must pass the same deterministic contract tests and the same real OpenCode capability probe shape. A provider cannot be marked compatible because another provider with the same managed XML protocol passed.

## Current Code Surface

Primary files:

- `src/main/proxy/forwarder.ts`
- `src/main/proxy/adapters/zai.ts`
- `src/main/proxy/adapters/kimi.ts`
- `src/main/proxy/adapters/minimax.ts`
- `src/main/proxy/toolCalling/ToolCallingEngine.ts`
- `src/main/proxy/toolCalling/ToolStreamParser.ts`
- `src/main/proxy/toolCalling/providerProfiles.ts`
- `src/main/proxy/toolCalling/outputInspection.ts`
- `src/main/proxy/toolCalling/availabilityDrift.ts`
- `src/main/proxy/config/modelProfiles.ts`
- `src/main/providers/builtin/zai.ts`
- `src/main/providers/builtin/kimi.ts`
- `src/main/providers/builtin/minimax.ts`
- `src/main/store/types.ts`

Primary tests:

- `tests/tool-calling/adapter-integration.test.ts`
- `tests/tool-calling/provider-profiles.test.ts`
- `tests/tool-calling/tool-stream-parser.test.ts`
- `tests/tool-calling/managed-xml-parser-repair.test.ts`
- `tests/providers/provider-flow.test.ts`
- new provider-specific tests added by this plan

Primary probes:

- `tests/agent-capability/verify-opencode-capability.ps1`
- `tests/agent-capability/verify-opencode-long-conversation.ps1`
- `tests/agent-capability/verify-opencode-long-conversation-contamination.ps1`

## Track A — Provider Capability Matrix

### Scope

Create an explicit provider capability matrix so managed-tool behavior is not inferred from adapter presence.

### Required Changes

1. Add a provider capability record for `zai`, `kimi`, and `minimax` that captures:
   - managed tool support status: `experimental | accepted | disabled`
   - stream parsing support
   - non-stream parsing support
   - retry support
   - known transport mode
   - known provider risk-control caveats
2. Keep the matrix close to the runtime profile layer, not in docs only.
3. Surface provider capability in diagnostic logs when a managed tool plan is created.
4. Default unaccepted providers to `experimental` until OpenCode acceptance is complete.

### Tests

- Capability matrix contains `zai`, `kimi`, and `minimax`.
- Unknown providers do not silently inherit an accepted status.
- Existing GLM/Qwen/DeepSeek behavior remains unchanged.

## Track B — Deterministic Adapter Parity

### Scope

Before real OpenCode runs, prove each provider can carry the managed tool plan through request transform, stream parse, non-stream parse, retry classification, and context restoration.

### Required Changes

For each provider (`zai`, `kimi`, `minimax`), add or harden deterministic tests for:

- first turn with `tools` injects exactly one managed prompt from `ToolCallingEngine`
- second turn without `tools` restores from session catalog
- session miss restores safely from history
- valid managed XML produces OpenAI-compatible `tool_calls`
- malformed, unknown, or fenced XML-like text stays plain text or returns a classified failure
- stream parser split across provider chunks still emits one valid `delta.tool_calls`
- non-stream result returns `message.tool_calls`, `message.content: null`, `finish_reason: "tool_calls"`
- summary-contamination retry either works or returns a provider-specific classified failure

### Guardrail

The tests must include grep/source assertions that provider adapters do not import prompt injection helpers:

- `hasToolPromptInjected`
- `toolsToSystemPrompt`
- `TOOL_WRAP_HINT`
- `shouldInjectToolPrompt`

## Track C — Z.ai Real Adapter Acceptance

### Scope

Make Z.ai pass the same real OpenCode capability probe as the accepted providers, or classify exactly why it cannot be accepted.

### Known Risk

Existing tests and docs mention Z.ai captcha/risk-control behavior. This plan must not mask those as tool-calling failures.

### Required Changes

1. Verify model mapping and actual model ID used by the probe.
2. Run non-stream and stream smoke tests through `/v1/chat/completions`.
3. Run OpenCode capability probe:

```powershell
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "zai/<accepted-model-id>"
```

4. If provider risk-control blocks the run, emit a classified outcome:
   - `provider_risk_control`
   - HTTP status
   - redacted provider message
   - no retry loop
5. If tool output is malformed, classify as `malformed_tool_output` or `catalog_availability_drift` with subkind.

### Acceptance

- Three consecutive probe passes, or a documented blocked status with provider-risk evidence.
- No swallowed assistant reply.
- No leaked managed XML marker in final text.
- No summary-contamination drift.

## Track D — Kimi Real Adapter Acceptance

### Scope

Make Kimi pass real OpenCode probes across its multi-stage transport.

### Required Changes

1. Prove Kimi stream events preserve enough text ordering for `ToolStreamParser`.
2. Prove Kimi non-stream parser does not lose tool calls during multi-stage/thinking phases.
3. Confirm delete-chat cleanup does not run before OpenCode receives the final tool-call stream.
4. Run:

```powershell
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "kimi/<accepted-model-id>"
```

5. Add a Kimi-specific fixture for split managed XML across multiple provider chunks if current generic tests do not cover its event shape.

### Acceptance

- Three consecutive OpenCode capability probe passes.
- At least one post-tool-result tool call appears in raw OpenCode events.
- `dev.log` shows `toolSessionKey` and catalog reuse, not history-only degradation during normal same-session turns.

## Track E — MiniMax Real Adapter Acceptance

### Scope

Make MiniMax pass real OpenCode probes for both direct response and polling/stream response paths.

### Required Changes

1. Identify which MiniMax path the current model uses:
   - direct response
   - polling stream
   - HTTP/2 stream
2. Add deterministic coverage for the selected path and at least one regression test for the unselected path if it remains in code.
3. Ensure `toolCallingPlan` is passed to both adapter and stream handler exactly once.
4. Run:

```powershell
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "minimax/<accepted-model-id>"
```

5. If MiniMax returns empty content before tool parsing, classify it through the existing P0 empty-output diagnostic path.

### Acceptance

- Three consecutive OpenCode capability probe passes.
- Direct/polling path used in the run is recorded.
- No false pass based only on generated result JSON; event stream must prove skill and tool use.

## Track F — Probe Harness Generalization

### Scope

The existing OpenCode verifier should support provider-specific runs without one-off manual edits.

### Required Changes

1. Add a provider matrix input to the verifier or create a sibling script:

```powershell
.\tests\agent-capability\verify-opencode-provider-matrix.ps1 `
  -Models "zai/<model>","kimi/<model>","minimax/<model>" `
  -Runs 3
```

2. Save raw event files per provider/run:

```text
tests/agent-capability/results/<provider>/<timestamp-or-run-id>/
  opencode-events.ndjson
  result.json
  verifier-summary.json
  redacted-dev-log.txt
```

3. The verifier must fail unless all existing authoritative checks pass:
   - result JSON hash/length/line count matches local input
   - skill invocation exists
   - at least two non-skill tool calls exist
   - at least one tool call occurs after the first tool result
   - final assistant text contains the fixed done marker

4. Add provider-specific classified outcomes:
   - `accepted`
   - `provider_risk_control`
   - `auth_expired`
   - `model_unavailable`
   - `malformed_tool_output`
   - `catalog_availability_drift`
   - `swallowed_reply`

## Consolidated Test Gate

Deterministic:

```powershell
node --test tests/tool-calling/*.test.ts `
  tests/providers/glm-tool-calling.test.ts `
  tests/providers/context-tool-metadata.test.ts `
  tests/providers/qwen-request-routing.test.ts `
  tests/providers/provider-flow.test.ts
```

Provider-specific additions expected from this plan:

```powershell
node --test tests/providers/zai-tool-calling.test.ts `
  tests/providers/kimi-tool-calling.test.ts `
  tests/providers/minimax-tool-calling.test.ts
```

Real OpenCode:

```powershell
.\tests\agent-capability\verify-opencode-provider-matrix.ps1 `
  -Models "zai/<accepted-model-id>","kimi/<accepted-model-id>","minimax/<accepted-model-id>" `
  -Runs 3
```

## Acceptance Criteria

- Z.ai, Kimi, and MiniMax each have deterministic provider-specific coverage.
- Each provider has a real OpenCode acceptance record or a classified blocked record.
- Accepted providers pass three consecutive real OpenCode capability probes.
- Provider adapters still do not own prompt injection.
- Long-conversation summary contamination does not reappear for accepted providers.
- Docs and provider capability matrix agree on which providers are accepted vs experimental.

## Stop Conditions

Pause and return to plan owner if:

- Z.ai risk-control or captcha blocks all real runs.
- Kimi or MiniMax returns provider event shapes that cannot be safely parsed without weakening managed XML parser safety.
- Any fix requires adding adapter-level tool prompt injection.
- Any provider passes final text but fails raw event stream tool-use checks.
- Account lockout, token invalidation, or unusual risk-control appears during repeated probes.

## Acceptance Deliverables

1. Deterministic test output for the consolidated gate.
2. Three raw OpenCode probe summaries per accepted provider.
3. Provider capability matrix diff.
4. Redacted provider-specific failure classifications for any blocked provider.
5. Grep evidence for INV-001 across `src/main/proxy/adapters/`.

