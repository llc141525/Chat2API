# Project Acceptance Dossier — Agent Tooling Stability

Date: 2026-07-10
Parent spec: `docs/superpowers/specs/2026-07-10-agent-tooling-stability-spec.md`
Owner role: plan + acceptance. Implementation is delegated.

## Purpose

Give the plan owner a single source of truth for what has been accepted, what has not, and exactly what gates each remaining track must pass before it is closed. This dossier replaces informal "green/red" summaries with an auditable checklist.

## Snapshot

| Track | Scope | Status | Blocker |
|-------|-------|--------|---------|
| P0 Swallowed replies | `outputInspection`, stream terminal accounting, post-tool-call locking | **ACCEPTED** | — |
| P1 Tool & MCP reliability (main plan) | Catalog fallback, schema-aware assembly, MCP names, stream/non-stream parity | **ACCEPTED** | — |
| P1 Tool availability drift (v1 rework) | Streaming drift parity, retry clarification, extra denial phrases | **REJECTED** (historical) | Superseded by v2 |
| P1 Tool availability drift (v2 rework) | Prompt-embedded catalog promotion | **ACCEPTED** | — |
| P2 Angle-bracket leakage | ToolStreamParser, StreamGate, Qwen snapshot diffing | **ACCEPTED** | — |
| P3 Claude Code Anthropic compatibility | `/v1/messages` route, tool block conversion, stream event order | **NOT STARTED** | Ready to start — P0/P1/P2 all accepted |

## What "ACCEPTED" Means Here

A track is accepted only when **all** of the following are satisfied for that track:

1. Every deterministic test named in its writing plan is passing on the current working tree.
2. Every real OpenCode probe named in its writing plan returned `CAPABILITY_PROBE_PASS`, including the multi-turn / non-skill / result.json requirements.
3. The AGENTS.md invariants INV-001 through INV-004 are not violated by any file touched for the track.
4. Diagnostics required by the spec are visible in normal logs without needing extra instrumentation.
5. The plan document has an "Acceptance Run" section that matches the current tree state.

Passing deterministic tests alone is not acceptance. Passing a probe once when it previously flaked is not acceptance.

## Track-By-Track Verdicts

### P0 — Swallowed Replies

**Accepted.**

Evidence (from `2026-07-10-p0-swallowed-replies-writing-plan.md` acceptance runs):

- Focused P0 gate: 26 tests pass, including empty non-stream `provider_empty`, whitespace-only diagnostics, missing message, streamed whitespace-only, malformed protocol classification, and post-tool-call suppression.
- Full deterministic gate: 205 → 207 tests pass across the follow-up.
- Real GLM, Qwen, and DeepSeek OpenCode probes returned `CAPABILITY_PROBE_PASS` with real skill + non-skill events and a matching `.agent-probe/result.json`.
- Original failing shape (silent empty success) is not reproduced.

Nothing to redo unless a future regression revives silent-empty acceptance.

### P1 Main Plan — Tool & MCP Reliability

**Accepted for the scope of the main P1 writing plan.**

Evidence (from `2026-07-10-p1-tool-mcp-reliability-writing-plan.md` acceptance):

- Focused deterministic gate: 107 tests pass, covering catalog fallback, session catalog reuse, schema validation, and stream parser residue suppression.
- Provider gate: 51 tests pass.
- Full deterministic gate: 207 tests pass.
- Real GLM, Qwen, DeepSeek probes: `CAPABILITY_PROBE_PASS` with multi-turn tool use after tool result.
- Same-session subset requests reuse the full catalog. History-only fallback is explicitly degraded.

This accepts multi-turn catalog preservation, MCP name survival, schema-aware assembly, and stream/non-stream parity for cases where the catalog **already exists** in `ToolCallingEngine`. It does not accept the availability drift track — see next entry.

### P1 v1 Rework — Availability Drift

**Rejected.**

Passing evidence (kept):

- Focused drift gate: 78/78.
- Full deterministic gate: 219/219.
- Chinese + English "only `open_url` available" phrases detected.
- GLM cumulative-marker split coverage added.
- Qwen and DeepSeek OpenCode probes pass.

Failing evidence (blocks acceptance):

- Repeated real GLM OpenCode probe failure.
- First turn streams `环境中唯一可用的工具是 open_url` and OpenCode later fabricates a fake `CAPABILITY_PROBE_DONE` with no real `skill` / `read` / `bash` events and no `.agent-probe/result.json`.

Root cause established and recorded in the v1 plan:

- OpenCode delivers tools inside system-prompt text (`## Available Tools`, MCP tool blocks, `<|CHAT2API|tool_calls>` protocol markers).
- `standardOpenAiToolsAdapter.normalizeRequest` reads `request.tools` only, so `clientRequest.tools = []`.
- `buildToolCallingRuntimePlan` gets `requestTools: []`, produces `catalogSnapshot: undefined`, `allowedToolNames: ∅`, `shouldInjectPrompt: false`.
- `detectAvailabilityDrift` correctly short-circuits with no authoritative catalog. The denial text streams through as ordinary content.

Conclusion: v1 tightened the guard that never got a catalog to guard. Detection strings did not fix the missing input.

### P1 v2 Rework — Prompt-Embedded Catalog Promotion

**Accepted.**

Evidence (from `2026-07-10-p1-rework-v2-plan.md` Acceptance Run):

- `promptEmbeddedToolExtractor.ts` landed and `standardOpenAiToolsAdapter` now falls back to it when `request.tools` is empty. `NormalizedClientToolRequest.toolSource` gained `'prompt_embedded'`.
- `resolveToolCatalog` accepts `promptEmbeddedTools` and produces a snapshot with `source: 'prompt_embedded'` ranked above history fallback.
- Focused P1 v2 deterministic gate: 74/74 (12 new extractor tests + 62 existing).
- Full deterministic gate: 235/235 (up from 219 pre-v2).
- Runtime integration: 2/2.
- GLM `glm/GLM-5.2` real OpenCode probe: 3 consecutive `CAPABILITY_PROBE_PASS` with real skill + read + bash events.
- Qwen and DeepSeek real OpenCode probes: `CAPABILITY_PROBE_PASS`.
- Static INV-001 check: no provider adapter imports `hasToolPromptInjected`, `toolsToSystemPrompt`, `TOOL_WRAP_HINT`, or `shouldInjectToolPrompt`. ADR reminder comments only.
- `detectAvailabilityDrift` empty-catalog guard preserved (`availabilityDrift.ts:30`). Not weakened; it now has a real catalog to compare against.
- Previously-failing GLM shape (`环境中唯一可用的工具是 open_url` → fake `CAPABILITY_PROBE_DONE`) no longer reproduces.

Track closed. Historical v1 rework record in `2026-07-10-p1-tool-availability-drift-rework-plan.md` is preserved as failure evidence and is not overwritten.

### P2 — Angle-Bracket Leakage

**Accepted.**

Evidence (from `2026-07-10-p2-angle-bracket-leakage-writing-plan.md` acceptance):

- Focused P2 gate: 98 tests pass. Ordinary XML-like text remains content, fenced examples are not parsed, CDATA preserves literal `<`/`>`, partial markers do not leak, later text after streamed tool calls is suppressed, Qwen snapshot rewrites do not emit `|tool_calls>` suffix residue.
- Full deterministic gate: 211 tests pass.
- Real Qwen probe pass. Real GLM probe pass on retry.
- The one earlier GLM failure was correctly classified as non-P2 tool-availability flakiness; that failure is now formally covered by the P1 v2 rework, not by P2.

No P2 rework required. If a future regression brings back marker leakage, treat it as a fresh P2 issue.

### P3 — Claude Code Anthropic Compatibility

**Not started. Prerequisite gates cleared.**

The parent spec explicitly gates P3 on P0-P2 being green for OpenCode. P0, P1 main, P1 v2, and P2 are all now green. P3 is unblocked and may be started per `2026-07-10-p3-claude-code-compat-writing-plan.md`.

When P1 v2 acceptance clears, follow `2026-07-10-p3-claude-code-compat-writing-plan.md` and its own acceptance gate:

- New route/converter tests for Anthropic → OpenAI request conversion, tool-use / tool-result mapping, and Anthropic stream event order.
- Full deterministic gate stays green.
- Manual Claude Code smoke with sanitized env produces either a working session or a typed selection/provider error (never a generic model-not-found placeholder).

## Test Gates Reference (Canonical)

Deterministic focused gate (P0/P1/P2):

```powershell
node --test tests/tool-calling/output-inspection.test.ts tests/tool-calling/tool-stream-parser.test.ts tests/tool-calling/catalog-fallback.test.ts tests/tool-calling/tool-catalog.test.ts tests/tool-calling/tool-engine.test.ts tests/tool-runtime/data/*.test.ts
```

Provider deterministic gate:

```powershell
node --test tests/tool-runtime/integration/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

Full deterministic gate:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

P1 v2 additional focused gate (once implemented):

```powershell
node --test tests/tool-calling/prompt-embedded-catalog.test.ts tests/tool-calling/availability-drift-retry.test.ts tests/tool-calling/tool-engine.test.ts tests/tool-calling/tool-stream-parser.test.ts
```

Real OpenCode probe gate:

```powershell
npm run dev:win 2>&1 | Tee-Object -FilePath .\dev.log
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "glm/GLM-5.2"
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "qwen/Qwen3.7-Max"
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "deepseek/deepseek-v4-pro"
1..3 | ForEach-Object { .\tests\agent-capability\verify-opencode-capability.ps1 -Model "glm/GLM-5.2" }
```

The last line is a hard requirement for P1 v2 only.

## Diagnostics Acceptance Checklist

Diagnostics are part of acceptance, not extra credit. For every strict-agent turn, logs must expose:

- `requestId`, `providerId`, `requestedModel`, `actualModel`, `clientAdapterId`, `protocol`
- `clientSignature` (from `constants/signatures.ts`)
- `catalogSource` — one of `session_catalog | openai_tools | prompt_embedded | restored_from_history | safe_empty`
- `catalogFingerprint`, `allowedToolNames`, `schemaHashes`
- `promptEmbeddedMarkers` — booleans for `availableToolsHeader`, `managedProtocolHeader`, `mcpServerBlock`
- `responseMode` — `streaming | non_streaming`
- `availabilityDriftDetected`, `deniedToolNames`, `mentionedUnavailableOnlyTools`
- `availabilityRetryResult` — `attempted | succeeded | failed | skipped | not_applicable`
- Terminal outcome from the spec's list: `content | tool_calls | provider_empty | malformed_tool_output | unknown_tool | schema_validation_failed | provider_error | selection_error | client_transform_error | availability_drift`

Safety rules still apply: no auth tokens, cookies, or full secrets in any log line. Raw provider snippets may be truncated and redacted.

## Invariant Guardrails

These are hard blockers for every track and must not be relaxed to make a probe pass:

- INV-001 Single Ownership: only `ToolCallingEngine` performs managed tool prompt injection. Provider adapters must not import `hasToolPromptInjected`, `toolsToSystemPrompt`, `TOOL_WRAP_HINT`, or `shouldInjectToolPrompt`.
- INV-002 Stateless Fallback: catalog resolution follows `Session Store → OpenAI Tools → Prompt-Embedded (v2) → History → Safe Empty`.
- INV-003 Delete = Risk: deleting existing tool/message processing code requires explicit purpose declaration and equivalent coverage.
- INV-004 Client Quirks Matrix: verify against real client quirks (OpenCode, Claude Code, Cherry Studio, Kilocode, Codex, VSCode Agent), not only OpenAI docs.

If a proposed fix requires violating any of these, escalate — do not merge.

## Non-Goals For This Acceptance Track

- Do not add provider-adapter prompt injection to force a probe green.
- Do not weaken the OpenCode probe to make GLM pass (e.g., accept a probe without real `read` / `bash` / result hash).
- Do not delete legacy tool/message processing without proving coverage.
- Do not merge fixes for P3 that shortcut through a parallel OpenAI-incompatible tool runtime.
- Do not commit real provider tokens or cookies in fixtures.

## Overall Done Criteria (Spec Level)

This dossier flips to "project accepted" only when all rows of the snapshot table read ACCEPTED. Remaining work:

1. P3 Claude Code compatibility implementation and acceptance.

P0, P1 main, P1 v2 rework, and P2 are all accepted and are no longer blockers.

## Handoff To Implementing AI

For each remaining track, the implementing AI receives:

- The relevant writing plan (P1 v2 and later P3).
- This dossier for acceptance gates.
- The parent spec for invariants and non-goals.

The implementing AI is expected to:

- Land failing deterministic tests first, then implement.
- Run the deterministic gates before any real probe.
- Report deterministic and probe results back with exact test counts and probe verdicts.
- Not push to the remote. Not create commits. Not modify unrelated files.

The plan owner (this session) will re-run acceptance from this dossier and update the snapshot only when every gate for the affected track is truly green.
