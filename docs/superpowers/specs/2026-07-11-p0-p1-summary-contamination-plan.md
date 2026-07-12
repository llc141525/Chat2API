# P0 + P1 Summary Contamination Writing Plan

Date: 2026-07-11
Parent spec: `docs/superpowers/specs/2026-07-10-agent-tooling-stability-spec.md`
Companion follow-up: `docs/superpowers/specs/2026-07-11-p0-p1-followup-plan.md` (DeepSeek swallow + Qwen intermittent + compaction ordering)
Reopens: `2026-07-10-p0-swallowed-replies-writing-plan.md` and `2026-07-10-p1-tool-mcp-reliability-writing-plan.md`
Evidence file: `E:\Chat2API\opencode诊断报告.md`
Owner role: plan + acceptance. Implementation is delegated.

## Why This Follow-Up Exists

A real OpenCode + Qwen session captured in `opencode诊断报告.md` walks through a specific compounding failure mode that the companion follow-up (Track C: ordering / signatures / `toolSessionKey`) does not attack:

1. Assistant hallucinated an authoritative-sounding tool list in an earlier turn ("Bash / Filesystem / Burp Suite MCP / GitHub Integration / WebFetch / Context7 / Task Agents…").
2. `SummaryStrategy` fired and generated a summary from that turn.
3. The generated summary faithfully reproduced the hallucinated list as if it were a confirmed fact: `"Assistant correctly identified the full available toolset, including: Bash (PowerShell 7+ on Windows) / Filesystem / Burp Suite MCP / …"` and closed with `"tool context is now established"`.
4. Next turn, the model saw the summary in a `system` message + the authoritative prompt-embedded catalog in another `system` message and trusted the summary. It repeated the fabricated tool list to the user.
5. The `availabilityDrift` detector fired: `Provider refused the authoritative tool catalog for managed tool turn qwen:Qwen3.7-Max`.
6. The user diagnosed it correctly and proposed the architectural fix verbatim: **摘要不应把 tools / 系统 prompt / MCP 定义包括进去；应该在摘要后额外注入**.

This is a P0 correctness failure because it breaks every sufficiently long multi-turn tool session across every managed provider, not just Qwen. The companion follow-up covers ordering and preservation; this plan covers the deeper split: **static configuration (tools / MCP / system prompt / catalog) must not travel through the lossy summarizer at all**.

## Non-Goals

- Do not make the summarizer smarter about "guessing" what's static config. Enforce the split at the boundary — strip before, filter after.
- Do not attempt the GLM 5.2 tool-call-count limit. Explicitly out of scope per the same manual test session that produced this plan.
- Do not swallow or rename `availabilityDrift` outcomes to hide the failure. The classification stays; new subkinds and a bounded self-heal path are added around it.
- Do not commit real provider tokens, cookies, or the raw contents of `opencode诊断报告.md` into fixtures. Use redacted synthetic reproductions.
- Do not push. Local plan authorship + acceptance dossier updates only.

## Invariants Reaffirmed and Extended

Existing (all must continue to hold):

- INV-001 Single Ownership — only `ToolCallingEngine` performs managed tool prompt injection.
- INV-002 Stateless Fallback — `Session Store → OpenAI Tools → Prompt-Embedded → History → Safe Empty`.
- INV-003 Delete = Risk.
- INV-004 Client Quirks Matrix.
- `detectAvailabilityDrift`'s empty-catalog short-circuit at `availabilityDrift.ts:30`.

Extended by this plan:

- **INV-005 Config-vs-History Split** — `tools`, MCP definitions, `system` prompts describing capabilities, and prompt-embedded tool catalogs are **runtime configuration**. They are re-derived from the authoritative store on every request. They are never allowed to travel as narrated content inside `role: 'system'`/`assistant` messages produced by the summarizer or by prior model turns. The runtime is the single source of truth for what tools exist.

## Root Cause Evidence

Concrete code locations that make the failure inevitable today:

- `src/main/proxy/forwarder.ts:283-347` — `createSummaryGenerator` flattens **every** historical message (including assistant turns that listed tool names, and prior `system` messages that carried the injected tool catalog) into a single `ROLE: content` blob and sends it as the `user` message to the summarizer.
  - Line 293 `summaryPrompt` default is `"Please summarize the following conversation concisely, keeping key information and context:"` — no constraint against enumerating capabilities or repeating system directives.
  - Lines 297-306 do not filter out tool-definition segments or `<tools>` blocks. Whatever appeared in any historical `system`/`assistant` content is fair game for the summarizer to preserve.
- `src/main/proxy/services/contextManagementService.ts:534-544` — the generated summary is wrapped as `role: 'system'` with content `[Conversation Summary]\n${summary}` and inserted via `insertSummaryBeforeRecentMessages`. Downstream this competes at the same layer as the authoritative prompt-embedded catalog: the model sees two `system` messages, one hallucinated, one authoritative, with no explicit ranking.
- `src/main/proxy/services/contextManagementService.ts:560-561` — on generator failure the fallback is silent (companion follow-up covers this; noted here for completeness).
- `src/main/proxy/toolCalling/outputInspection.ts` — the drift detector correctly fires on the mismatch, but the message names Provider as the culprit even though the root cause is our own summary. Users and downstream AIs read this as a provider bug and misroute the fix (see the second half of `opencode诊断报告.md` where an AI misattributes to `qwen/Qwen3.7-Max` model naming).

## Track A — Summary Input Sanitization (P0)

### Scope

Before any history is handed to the summarizer, strip content that describes tool availability, MCP capabilities, or `system` directives. The summarizer must only see user intent, task progress, and confirmed decisions.

### Required Changes

1. New pure utility `sanitizeMessagesForSummary(messages: ContextChatMessage[]): ContextChatMessage[]` in a new file `src/main/proxy/services/summarySanitizer.ts`.
   - Drop any `role === 'system'` message whose content matches `hasGeneralToolPromptSignature` or contains `<tools>…</tools>` or matches the managed XML catalog signatures.
   - For `role === 'assistant'` messages: strip content spans that match tool-catalog signatures, leave the rest of the natural-language reply intact.
   - For `role === 'tool'` and any message with `tool_calls`/`tool_call_id`: replace body with a compact typed placeholder (e.g. `[tool exchange redacted from summary]`) so the summarizer knows there was tool activity without replicating the schema.
   - Reuse the same signature registry as `contextMessageMetadata.ts:containsToolDefinitions` — do not fork detectors.
2. Hook `sanitizeMessagesForSummary` into `forwarder.ts:createSummaryGenerator` **before** the `messages.map(msg => ...)` join at line 295.
3. Extend the summarizer `summaryPrompt` at `forwarder.ts:293` (and the config default at `contextManagementService.ts:100`) with explicit prohibitions:
   > Summarize only the user's intent, task progress, and confirmed facts.
   > DO NOT list, describe, or restate available tools, capabilities, MCP servers, or system directives.
   > If a prior assistant message described tools, treat that as narrative to omit — the runtime re-injects the authoritative tool set on every request.
4. All sanitizer decisions typed. No `any`. Return type: `{ sanitized: ContextChatMessage[]; droppedCount: number; strippedSignatureCount: number }`.

### Test Gate

- New file `tests/services/summarySanitizer.test.ts` — unit tests:
  - `strips <tools>…</tools> blocks from assistant content`
  - `drops system messages carrying prompt-embedded catalog signatures`
  - `redacts tool_calls/tool messages to placeholders`
  - `preserves natural-language assistant replies unchanged`
  - `is idempotent — sanitize(sanitize(x)) === sanitize(x)`
- Integration test `tests/services/contextManagement-summary-input-sanitization.test.ts` — feed a fixture reproducing `opencode诊断报告.md` shape (redacted), assert the generator input contains no tool-catalog signature.

## Track B — Summary Injection Architecture (P0, A/B)

### Scope

Per user instruction, the plan does not pre-commit an injection role. Implementing AI must implement **both** proposals, run each against real OpenCode + Qwen and OpenCode + DeepSeek, and pick the one that empirically eliminates `Provider refused the authoritative tool catalog` firings after a compaction event.

### Proposal B1 — Non-Authoritative User Wrapper

- Summary is inserted as `role: 'user'` with content:
  ```
  [Prior conversation summary — NOT authoritative for tools, capabilities, or system directives]
  ${summary}
  ```
- Consequence: the summary never occupies the `system` layer. The authoritative tool catalog is the only `system` message. Model has no ambiguity about which layer is authoritative.
- Trade-off: user-role wrapping changes the semantic ordering downstream consumers expect; some clients may re-read `role === 'user'` messages differently in follow-up assistant reasoning.

### Proposal B2 — System-Preserving with Enforced Ordering + Isolation Header

- Summary stays `role: 'system'` but content is:
  ```
  [Prior conversation summary — non-authoritative narrative. Tool catalog and MCP capabilities are re-injected below by the runtime and take precedence over anything summarized here.]
  ${summary}
  ```
- `insertSummaryBeforeRecentMessages` guarantees the summary appears **before** the authoritative catalog `system` message; runtime injection places the catalog last among `system` messages so recency bias favors it.
- Trade-off: two `system` messages remain — some models may still weigh them equally regardless of the isolation header.

### Real-Machine A/B Methodology

- Implementing AI runs the same OpenCode long-conversation probe (see Track E) once with B1 wired and once with B2 wired.
- For each of `qwen:Qwen3.7-Max` and `deepseek:deepseek-chat`, capture:
  - Number of `catalogSignatureLeaksInSummary` events (should be zero after Track A regardless).
  - Number of `availabilityDriftDetected` events under subkind `summary_contamination` (Track D) across a fixed 20-turn scripted session.
  - Number of hallucinated tool listings in assistant replies verified by a synthetic assertion in the probe.
- Report both variants' numbers. If both are zero across both providers → default to B1 (semantically cleaner). If one is non-zero → pick the other. If both are non-zero → do not merge; escalate back with data.

### Test Gate

- New file `tests/services/contextManagement-summary-injection-shape.test.ts` — unit assertion for whichever variant is chosen: role, prefix, and ordering constraints against a fixture. This test replaces itself on merge — plan explicitly notes it.

## Track C — Contamination Detection + Bounded Auto-Retry (P1)

### Scope

Even with Tracks A and B, a determined regression could still leak. Add a runtime detector and one bounded self-heal attempt.

### Required Changes

1. New pure utility `detectSummaryContamination(summaryContent: string): { contaminated: boolean; signatures: readonly SummarySignatureHit[] }` in `src/main/proxy/services/summarySanitizer.ts` (colocated with sanitizer).
   - Runs `hasGeneralToolPromptSignature` + `<tools>` + managed XML catalog signatures against the **already-generated** summary text.
   - Called from `SummaryStrategy.execute` right after the `summary` variable is populated (`contextManagementService.ts:525`).
2. When contaminated: mark the returned `StrategyResult` with `subkind: 'summary_contaminated'` and fall back to sliding-window immediately for this compaction round.
3. Downstream: when `availabilityDrift.ts` fires and the current turn's context includes a `subkind: 'summary_contaminated'` marker from the prior compaction (propagated via `ProxyContext`), emit subkind `summary_contamination` on the drift event (see Track D) **and** trigger one bounded retry:
   - Drop the contaminated summary from the message stack.
   - Re-run compaction using `SlidingWindowStrategy` for this request only.
   - Re-send to the provider once.
   - If the second attempt still trips drift → surface the terminal error to the client with unambiguous classification. No infinite loop, no silent hide.
4. Retry is gated by an in-request boolean (`context.summaryRetryAttempted`) — not an inter-request counter. Never retry on the same context twice.

### Test Gate

- `tests/services/contextManagement-contamination-detection.test.ts` — asserts `detectSummaryContamination` catches the exact fixture drawn from `opencode诊断报告.md`.
- `tests/services/contextManagement-bounded-retry.test.ts` — with a stub provider that:
  - Round 1: returns availability-drift-shaped response.
  - Round 2 (with clean sliding-window context): returns a valid tool response.
  Asserts that exactly two upstream calls are made and the final response is the round-2 result.
- Retry attempt count is asserted with an equality check; retry-twice must fail the test.

## Track D — Diagnostic Rename and Subkinds (P1)

### Scope

Rename the outward-facing drift message so downstream AIs and users do not misattribute the failure to the provider.

### Required Changes

1. Introduce diagnostic outcome `catalog_availability_drift` (new terminal outcome name) alongside existing `availabilityDrift`. Both are populated with structured `subkind`:
   - `subkind: 'provider_side'` — genuinely upstream (model refused despite clean context).
   - `subkind: 'summary_contamination'` — our own compaction produced a hallucinated tool listing (Track C flagged it).
   - `subkind: 'catalog_missing'` — the request left our proxy with no authoritative catalog present at all.
2. The user-facing error message becomes:
   - `provider_side`: `"Model rejected the authoritative tool catalog for managed tool turn ${turnId}"` (owns the "provider refused" naming without shifting the diagnosis).
   - `summary_contamination`: `"Compaction produced a tool description that conflicts with the authoritative catalog; a clean-context retry was attempted. Terminal outcome: ${retryOutcome}"`.
   - `catalog_missing`: `"Managed tool turn ${turnId} produced no authoritative catalog to compare against"`.
3. AGENTS.md diagnostics table updated with the three subkinds and the retry semantics.

### Test Gate

- `tests/tool-calling/catalog-drift-subkinds.test.ts` — three cases, one per subkind. Asserts the correct classification is emitted given a controlled setup.

## Track E — Long-Conversation Contamination Probe (P1)

### Scope

Add a real-provider probe that specifically exercises the summary → next-turn path with tool-shaped content in the assistant history.

### Required Changes

1. New probe fixture `tests/agent-capability/long-conversation-contamination.md` — a 20-turn scripted conversation that:
   - Contains at least one assistant turn where the assistant enumerates tool names in narrative prose (simulating the observed hallucination trigger).
   - Contains at least one legitimate tool exchange.
   - Grows past the compaction trigger threshold.
2. Extended `tests/agent-capability/verify-opencode-long-conversation.ps1` (or a sibling script) drives the fixture through OpenCode + Qwen and OpenCode + DeepSeek, then asserts:
   - `CAPABILITY_PROBE_PASS` from the OpenCode result JSON.
   - Zero `availabilityDrift` events with subkind `summary_contamination` across the run.
   - Assistant final reply does not contain any tool name outside the authoritative catalog (heuristic: string match against catalog).
3. Real-provider gate: **three consecutive runs** must pass per provider before this track counts as accepted.

## Consolidated Test Gate Command

Deterministic side (added to the companion follow-up's command):

```powershell
node --test tests/services/summarySanitizer.test.ts `
  tests/services/contextManagement-summary-input-sanitization.test.ts `
  tests/services/contextManagement-summary-injection-shape.test.ts `
  tests/services/contextManagement-contamination-detection.test.ts `
  tests/services/contextManagement-bounded-retry.test.ts `
  tests/tool-calling/catalog-drift-subkinds.test.ts
```

Real-provider side:

- `1..3` OpenCode + Qwen long-conversation-contamination probe → all `CAPABILITY_PROBE_PASS`.
- `1..3` OpenCode + DeepSeek long-conversation-contamination probe → all `CAPABILITY_PROBE_PASS`.
- Existing companion follow-up probes (`1..3` DeepSeek base, `1..5` Qwen base) still required and unchanged.

## Diagnostic Events Added

- `summarySanitizerActions` — `{ droppedMessages, strippedSignatureCount }` per compaction round.
- `summaryContaminationDetected` — `{ signatures[], summaryLength, decision: 'fallback_sliding_window' }` when Track C fires.
- `contextManagementRetryAttempted` — `{ reason: 'summary_contamination', originalStrategy, retryStrategy }` when Track C's bounded retry runs.
- `catalogDriftSubkind` — one of `provider_side | summary_contamination | catalog_missing`.

## Handoff to Implementing AI

- Implement Tracks A, C, D, E as specified. For Track B, implement **both** B1 and B2 behind a config toggle (e.g. `contextManagement.summaryInjectionShape: 'user-wrapper' | 'system-isolated'`), run the real-machine A/B, report both variants' numbers back, then remove the losing variant and the toggle before merge.
- Do not touch provider adapters for injection. Track A/B/C/D changes live in `services/`, `forwarder.ts`, `toolCalling/` inspection layer, and tests. No new adapter-level catalog code.
- Do not modify `availabilityDrift.ts:30` empty-catalog short-circuit.
- Do not remove or weaken the existing `provider_empty`, `malformed_tool_output`, or `availabilityDrift` classification. Track D **adds** subkinds; it does not replace.
- Redact all fixtures. `opencode诊断报告.md` is evidence, not fixture material — do not import its raw text into `tests/`. Extract shape (role sequence + signature-hit content) and rewrite synthetically.
- Coordinate with companion `2026-07-11-p0-p1-followup-plan.md` Track C — this plan's sanitizer must not conflict with Track C's ordering preservation. Explicit ordering: sanitizer runs first (drop tool-catalog content), then ordering strategy runs (preserve insertion order of what remains).

## Stop Conditions

Halt implementation and escalate to the plan owner if any of these occur:

- Real-machine A/B (Track B) shows both B1 and B2 non-zero on `summary_contamination` drift subkind after Track A is in place. Root cause is not what this plan modeled; new analysis is required before choosing.
- Track C bounded retry causes provider rate-limit or account-lockout on either Qwen or DeepSeek in local testing.
- Track A's `sanitizeMessagesForSummary` cannot be made idempotent without a signature-registry change — that change belongs in the companion plan, not this one.
- Track D's rename breaks an existing consumer that pattern-matches on the legacy string. Report the consumer and pause; do not silently keep the legacy string.
- Compaction remains provably broken for multi-turn tool dialogues after all five tracks are wired.

## Acceptance Deliverables from Implementing AI

For plan owner acceptance, deliver:

1. Deterministic gate output (full `node --test` summary) for the consolidated command.
2. Raw OpenCode probe result JSONs (redacted) — three per provider, six total, all `CAPABILITY_PROBE_PASS`.
3. Track B A/B numeric summary and the winning variant identified.
4. Updated `AGENTS.md` diagnostics table (Track D).
5. Confirmation that INV-001..INV-005 all hold, with grep evidence for INV-001.

## Acceptance Run: 2026-07-11

Status: **PARTIAL PASS — Qwen accepted, GLM-5.2 not accepted**.

Scope change from plan owner during acceptance: skip DeepSeek for now; validate `qwen/Qwen3.7-Max` and `glm/GLM-5.2`.

Deterministic gates:

```powershell
node --test tests/services/summarySanitizer.test.ts tests/services/contextManagement-summary-input-sanitization.test.ts tests/services/contextManagement-summary-injection-shape.test.ts tests/services/contextManagement-contamination-detection.test.ts tests/services/contextManagement-bounded-retry.test.ts tests/tool-calling/catalog-drift-subkinds.test.ts
```

Result: **PASS, 26/26**.

Additional focused regression:

```powershell
node --test tests/services/*.test.ts tests/providers/deepseek-tool-calling.test.ts tests/tool-runtime/integration/deepseek-multi-turn.test.ts
```

Result: **PASS, 49/49**.

Project final deterministic gate:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

Result: **PASS, 249/249**.

Full `node --test`:

Result: **526 pass / 11 fail / 537 total**. The remaining failures are outside this summary-contamination track and match pre-existing unrelated areas (DeepSeek alias semantics, built-in provider model-list sync, update repository target, README model list sync, Mimo flow, forwarder DI, standalone invoke, restore-tool-config).

Track B Qwen A/B closeout:

```powershell
.\tests\agent-capability\verify-opencode-long-conversation.ps1 -Model "qwen/Qwen3.7-Max" -LogPath ".\dev.log"
```

Repeated six times total:

- `system-isolated`: **3/3 PASS**, `summary_contamination` mentions `0`, fabricated tool-inventory mentions `0`
- `user-wrapper`: **3/3 PASS**, `summary_contamination` mentions `0`, fabricated tool-inventory mentions `0`

Recorded evidence: `tests/agent-capability/results/2026-07-11-qwen-summary-injection-ab.json`.

Track B decision for the narrowed acceptance scope: keep **`system-isolated`** as the winner. The two variants tied empirically on Qwen, so the implementation keeps the incumbent `system`-layer isolated narrative to avoid extra role-semantics churn and removes the `summaryInjectionShape` toggle plus the losing `user-wrapper` branch. GLM-5.2 is explicitly excluded from this winner selection because its remaining failure is a separate managed XML malformed-stream issue, not a summary-contamination outcome.

Real long-conversation contamination probes, fixed summary injection shape:

```powershell
.\tests\agent-capability\verify-opencode-long-conversation.ps1 -Model "qwen/Qwen3.7-Max" -LogPath ".\dev.log"
```

Result: **PASS, 3/3**. Each run created probe artifacts, proved a real long multi-turn tool session, showed no `summary_contamination` drift or fabricated tool inventory leakage, and found both sliding-window and summary compaction evidence in appended `dev.log`.

```powershell
.\tests\agent-capability\verify-opencode-long-conversation.ps1 -Model "glm/GLM-5.2" -LogPath ".\dev.log"
```

Result: **FAIL, 0/1**. The run loaded `long-conversation-probe`, read `tests/agent-capability/input.txt`, executed the first `bash` step and created `.agent-probe/long-step-1.txt`, then read `tests/agent-capability/long-conversation-payload.txt`. On the next required `bash` tool call, OpenCode received:

```text
Error: Provider returned malformed tool output without usable assistant content for managed tool turn glm:GLM-5.2
```

The probe failed because `.agent-probe/long-step-2.txt` was never created. This is not evidence of summary contamination; it is a GLM managed-tool stream/output failure during a long multi-turn sequence. The appended provider log showed GLM detecting a managed tool-call marker from a partial chunk beginning at `_calls><|CHAT2API|invoke name="bash"...`, consistent with malformed or partial managed XML assembly on that turn.

Acceptance conclusion:

- Track A summary input sanitization: **ACCEPTED** by deterministic tests.
- Track C contamination detection + bounded retry: **ACCEPTED at deterministic level** by `contextManagement-bounded-retry.test.ts`; no live summary-contamination drift observed in Qwen long probes.
- Track D drift subkinds: **ACCEPTED** by deterministic tests.
- Track E long-conversation probe: **ACCEPTED for Qwen, NOT ACCEPTED for GLM-5.2**.
- Track B A/B: **ACCEPTED for the narrowed Qwen scope**. Qwen A/B tied `3/3 PASS` vs `3/3 PASS`, so `system-isolated` remains and the extra toggle/`user-wrapper` branch are removed. GLM-5.2 follow-up remains separate.

Next required GLM follow-up: isolate why GLM long-session managed XML emits a malformed/no-content turn after a successful `read` result, especially when the provider stream exposes a partial managed marker starting mid-container. Do not classify this as summary contamination unless a later run shows `summary_contamination` or fabricated tool inventory leakage.

## GLM Follow-Up Re-Run: 2026-07-12

Status: **PARTIAL PROGRESS — GLM malformed managed-XML stream assembly fixed deterministically; real long-conversation probe now fails in a new post-skill early-final bucket.**

Implemented GLM stream fix:

- `src/main/proxy/adapters/glm.ts` now distinguishes cumulative snapshot rewrites from same-`logic_id` incremental text tails.
- When GLM sends a true snapshot rewrite, the stream parser is reset and reparses the rewritten managed XML snapshot.
- When GLM sends only an incremental tail for the same `logic_id`, the tail is appended instead of replacing the earlier prefix.
- This covers the observed `_calls><|CHAT2API|invoke...` mid-container suffix shape where the prefix had been overwritten before the parser saw a complete managed XML block.

Deterministic verification:

```powershell
node --test tests/providers/glm-tool-calling.test.ts
```

Result: **PASS, 53/53**.

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

Result: **PASS, 256/256**.

```powershell
node --test tests/services/*.test.ts tests/providers/deepseek-tool-calling.test.ts tests/tool-runtime/integration/deepseek-multi-turn.test.ts
```

Result: **PASS, 49/49**.

Real GLM long-conversation probe:

- Current raw event evidence: `E:\Chat2API\.agent-probe\opencode-long-events.ndjson`.
- The run successfully loaded the `long-conversation-probe` skill.
- After the skill tool result, GLM emitted ordinary final text `LONG_CONVERSATION_PROBE_DONE`.
- No structured non-skill `read` or `bash` `tool_use` events occurred after the skill result.
- `.agent-probe/long-step-1.txt` was therefore never created.

New failure bucket:

- `skill_result_then_final_marker_without_required_tools`

This is not the previous GLM malformed managed-XML failure and should not be counted as summary contamination. The model appears to shortcut from the skill result directly to the final marker embedded in the skill instructions, skipping the required tool sequence.

Verifier update:

- `tests/agent-capability/verify-opencode-long-conversation.ps1` now classifies this exact shape before the generic artifact checks:
  - real `skill` `tool_use` for `long-conversation-probe`
  - final `LONG_CONVERSATION_PROBE_DONE` text
  - zero structured non-skill `tool_use` events
  - missing `.agent-probe/long-step-1.txt`

Next required GLM follow-up:

1. Treat `skill_result_then_final_marker_without_required_tools` as its own P1 long-agent reliability bucket.
2. Determine whether GLM is prematurely optimizing against the final marker in the skill text, or whether OpenCode/Chat2API is failing to preserve the pending tool-sequence obligation after the skill tool result.
3. Try a probe-hardening variant that withholds the final marker literal until after required files exist, or replaces it in the skill body with a placeholder that the verifier maps to the real marker externally.
4. If GLM still skips after skill without seeing the final marker literal, investigate managed tool-following after `skill` `tool_result` specifically.

## GLM Follow-Up Re-Run 2: 2026-07-12

Status: **PARTIAL PROGRESS — harness and environment noise removed; current GLM real-model failure sits at the first post-read `bash` turn, not at summary contamination.**

What was corrected before rerun:

- A fresh `npm run dev:win` instance was started and confirmed healthy before rerunning the probe. This mattered: an earlier attempt was reading from a stale `dev.log` and an older server state.
- `tests/agent-capability/verify-opencode-long-conversation.ps1` was hardened so the probe no longer depends on the caller shell having `opencode` on `PATH` in a particular way:
  - resolves the native `opencode.exe` path instead of relying on a PowerShell wrapper
  - launches OpenCode via `System.Diagnostics.ProcessStartInfo`
  - redirects stdin/stdout/stderr explicitly
  - records stderr to `.agent-probe/opencode-long-stderr.log`
  - adds in-script timeout classification instead of relying on an outer shell timeout
- The long-conversation probe content was also hardened so the final marker is no longer handed to the model as a plain literal to copy early:
  - `tests/agent-capability/long-conversation-contamination.md`
  - `.opencode/skills/long-conversation-probe/SKILL.md`
  - the final marker is now described as the underscore-joined form of `LONG`, `CONVERSATION`, `PROBE`, `DONE`

Deterministic verification after these changes:

```powershell
node --test tests/providers/glm-tool-calling.test.ts tests/services/contextManagement-skill-instruction-pinning.test.ts
```

Result: **PASS, 57/57**.

Real GLM rerun against fresh dev server:

```powershell
powershell -ExecutionPolicy Bypass -File .\tests\agent-capability\verify-opencode-long-conversation.ps1 -Model "glm/GLM-5.2" -LogPath .\dev.log -TimeoutSeconds 120
```

Observed outcomes across reruns in this tranche:

1. **Fresh-server rerun A**
   - OpenCode exited successfully.
   - The event stream showed:
     - real `skill` `tool_use`
     - real `read` `tool_use` for `tests/agent-capability/input.txt`
     - then plain assistant text instead of a real `bash` `tool_use`
   - Verifier result: missing `.agent-probe/long-step-1.txt`
   - Raw evidence: `E:\Chat2API\.agent-probe\opencode-long-events.ndjson`

2. **Fresh-server rerun B**
   - OpenCode exited successfully.
   - The event stream showed:
     - real `skill` `tool_use`
     - then immediate plain text with trailing Chat2API residue, still no `bash`
   - Verifier result: missing `.agent-probe/long-step-1.txt`

Current strongest real evidence from the most informative rerun:

- `skill` loaded successfully.
- `read` of `tests/agent-capability/input.txt` succeeded as a real tool event.
- The next turn did **not** become a real `bash` `tool_use`.
- Instead, GLM emitted plain text describing the next step and left trailing protocol residue:

```text
... Step 1 (read input.txt) is done. Now step 2: run the bash command.

<|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>
```

- The provider log simultaneously recorded:

```text
[GLM] Tool call marker detected in chunk: _calls><|CHAT2API|invoke name="bash"><|CHAT2API|parameter name="command"><![CDATA[New-Item -ItemType Directory -Force -Path .
[ToolStreamParser] Dropping tool call buffer — invalid names: [], allowed names: [bash, edit, glob, grep, question, read, skill, task, todowrite, webfetch, write], raw matches: true, malformed reason: mixed_protocol_container
```

Interpretation:

- This is **not** summary contamination.
- This is **not** the previous “skill then immediate final marker” bucket.
- This is now a more specific GLM long-session failure shape:
  - `skill` succeeds
  - first required `read` succeeds
  - first required `bash` degrades into **partial managed XML + ordinary assistant prose + trailing XML residue**
  - `ToolStreamParser` classifies that turn as `mixed_protocol_container` and suppresses it

Verifier status after hardening:

- The verifier now correctly captures environment/setup failures separately from model behavior:
  - stale/no dev server was eliminated by explicitly starting `npm run dev:win`
  - `opencode` shell-path issues were eliminated by resolving `opencode.exe`
  - wrapper launch / stdin issues were eliminated in-script
- A targeted classification for `read_succeeded_then_partial_bash_text_without_tool_use` was added to the verifier, but the latest rerun still landed in the generic missing-artifact path because the exact plain-text fragment varied between runs.

Practical handoff conclusion for the next implementer:

1. Do **not** reopen summary contamination for this GLM line; current evidence does not support that bucket.
2. Start from `src/main/proxy/adapters/glm.ts` stream/snapshot merge logic and the `mixed_protocol_container` path in `src/main/proxy/toolCalling/ToolStreamParser.ts`.
3. The concrete real-model target is: after a successful `read` turn, GLM must emit a structurally complete managed `bash` tool call instead of a hybrid text/protocol residue turn.
4. Use the current raw probe evidence in:
   - `E:\Chat2API\.agent-probe\opencode-long-events.ndjson`
   - `E:\Chat2API\dev.log`
5. Keep `npm run dev:win` freshly running before each real probe rerun; otherwise the evidence can be stale or misleading.
