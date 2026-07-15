# Qwen Long-Context Session Architecture Spec

Date: 2026-07-13
Branch: codex/qwen-provider-session-continuity
Baseline commit: 3f16737 `milestone: qwen simple-context tool calling baseline`

## Purpose

Qwen can now execute simple managed-tool tasks through Chat2API, but long OpenCode-style tasks still degrade when provider-side context, compacted summaries, raw tool transcripts, and subagent/task handoffs all accumulate in the same effective conversation.

This spec is the executable contract for the next stage. It replaces the older chronological notes with a smaller decision document:

- what is already proven
- which fixes are patch-level bridge work
- which fixes are architecture-level work
- what the next worker subagent should do
- how the main agent will review and accept each node

## Operating Model

Main agent responsibilities:

- Own this spec, queue, acceptance criteria, and review.
- Use CodeGraph or focused file reads for planning and review context.
- Delegate code changes to worker subagents unless root-cause mode is explicitly needed.
- Keep unrelated dirty files untouched.
- Preserve the tool-definition no-loss invariant as a hard gate.

Worker subagent responsibilities:

- Model: `gpt-5.4`
- Reasoning effort: low
- Execute only the assigned bounded task.
- Touch only the allowed write set.
- Do not revert unrelated edits.
- Return a compact handoff: changed files, verification, residual risks, next review target.

Checkpoint policy:

- After each completed node, record a short result in this spec.
- After each major node, compact both worker and main-session state.

## Current Proven Facts

### Provider Session Continuity

Qwen web sessions can preserve memory across turns when the same provider `session_id` is reused.

Local and proxy probes proved:

- same Qwen provider `session_id` recalls prior turn facts
- new provider `session_id` does not recall those facts
- `parent_req_id` should be preserved for correct message-tree continuity
- Chat2API can reuse provider sessions when the route supplies a stable conversation identity

Implemented state fields:

- `qwenSessionId`
- `qwenParentReqId`

### Route Identity

The OpenAI chat route previously used per-request identity when clients omitted `user`, causing one Qwen website conversation record per request.

The accepted route-level fix now derives a stable provider conversation identity from explicit headers/body fields or a stable early conversation prefix when the client resends history.

This closes the default no-user route gap for clients that resend stable conversation history. It cannot infer continuity for identity-free, history-free requests.

### Context Management

Current context management now:

- forks provider context for summary generation
- forks provider context after server-side summary injection
- preserves managed-tool metadata after compaction
- pins only the most recent skill instruction exchange
- preserves tool exchanges group-wise instead of slicing through pairs
- bounds active tool workflow retention more aggressively

This is accepted as a patch/bridge layer, not the final architecture.

### Prompt Budget Diagnostics

Qwen-only diagnostics currently classify prompt refresh intent without changing prompt rendering:

- `full`
- `repair`
- `tool_ready`
- `digest`
- `minimal`

Observed live diagnostics were conservative:

- fresh sessions: `full`
- summary-generator forks: `full`
- tool-child forks: `full`
- active tool-loop turns: `tool_ready`

Prompt rendering still resends full material. Diagnostics are not yet an optimization.

### Tool Definition No-Loss Guards

The tool-definition-loss regression is a hard red line.

Current guards cover:

- context metadata preservation
- assistant `tool_calls` and `tool_call_id` retention
- managed tool contract presence after compaction
- session/catalog fallback behavior
- source-level import guard for `preserveContextManagedMessageMetadata`

Every node that touches sessions, context, tools, prompt rendering, or child handoffs must run the relevant no-loss tests.

## Current Live Failure

Latest long-conversation live probe:

```powershell
.\tests\agent-capability\verify-opencode-long-conversation.ps1 -Model "qwen/Qwen3-Max" -LogPath .\dev.log
```

Result:

- OpenCode warmups completed.
- Context management applied successfully.
- OpenCode exited successfully.
- Final verifier failed because `.agent-probe/long-summary.txt` was missing.
- Warmup turn 5 unexpectedly entered the real `long-conversation-probe` skill/tool workflow.
- Warmup turn 6 and final run then emitted `LONG_CONVERSATION_PROBE_DONE` directly.

Direct cause:

- `verify-opencode-long-conversation.ps1` invokes every warmup turn with `--agent long-conversation-probe`.
- `.opencode/agent/long-conversation-probe.md` requires the first assistant action to be the real probe skill.
- Warmup prompts say to reply with `WARMUP_ACK_n` and use no tools.
- After compaction, Qwen can recover the agent-level skill obligation and start the real probe during warmup.

Classification:

- Fixing warmup isolation is a test-harness patch.
- Preventing real child/subagent/tool transcripts from polluting parent context is architecture-level.

## Architecture Problem Statement

The original problem was framed as "compact should switch session id." That is necessary but incomplete.

The real architecture problem has four coupled parts:

1. Provider conversation session boundaries
2. Context summary and compaction semantics
3. Tool/subagent child execution isolation
4. Compact typed handoff back to the parent session

Desired behavior:

- Compact produces a summary.
- Chat2API opens a new provider conversation session for the continued main request.
- The summary is sent into that new provider session as bounded state.
- Tool calls run in child provider sessions when they would otherwise add large raw transcripts.
- Subagents/task tools also run in child provider sessions.
- Parent sessions receive only compact typed handoff artifacts, not raw child transcripts.
- Tool definitions remain available at every boundary.

## Patch vs Architecture Classification

Patch / bridge fixes:

- Import/reference fix for `preserveContextManagedMessageMetadata`.
- Stable OpenAI route identity for no-user clients with resent history.
- Bounded active tool retention in existing context management.
- Prompt budget diagnostics with no behavior change.
- Long-conversation probe warmup isolation.

Architecture-level fixes:

- Provider session boundary as a first-class state transition after compact.
- Tool execution in child provider sessions with compact result handoff.
- Subagent/task execution in child provider sessions with compact typed handoff.
- Prompt contract refresh policy using fingerprints/digests plus repair-mode refresh.
- Replacement of raw transcript preservation with bounded workflow state.

## Core Invariants

INV-001: `ToolCallingEngine` is the sole owner of managed tool prompt injection.

INV-002: Session-dependent tool resolution must degrade through:

`Session Store -> Message History Extraction -> Request Tools -> Safe Empty`

INV-003: `assistant.tool_calls` and matching `tool.tool_call_id` must survive context processing for active tool turns.

INV-004: Tool definitions must not disappear across route/session/compact boundaries.

INV-005: A provider session fork must not imply a new tool-catalog identity unless the task explicitly needs one.

INV-006: Parent sessions must not receive raw child tool transcripts once typed handoff is implemented.

## Target Architecture

### Session Boundary Types

The code should distinguish these boundaries:

- `normal_continuation`: same provider conversation session
- `server_summary`: new provider conversation session seeded with summary
- `summary_generator`: isolated provider conversation session for summary creation
- `tool_child`: isolated provider conversation session for a tool execution workflow
- `subagent_child`: isolated provider conversation session for task/subagent execution
- `repair`: full contract refresh after schema/tool failure

### Identity Split

Provider conversation identity and tool catalog identity are related but not identical.

Provider conversation identity:

- controls which web-side session/memory is used
- should fork after compact or for child execution

Tool catalog identity:

- controls access to authoritative tool definitions
- should usually remain stable across compact/fork boundaries
- must have fallback from history and request tools

### Parent/Child Handoff

Child session result shape should be bounded and typed:

```ts
type ChildSessionHandoff = {
  kind: 'tool_child' | 'subagent_child'
  status: 'ok' | 'failed' | 'needs_parent_decision'
  summary: string
  evidence: Array<{ label: string; value: string }>
  artifacts?: Array<{ path: string; purpose: string }>
  nextAction?: string
  errorClass?: string
}
```

The parent provider session should receive this compact artifact, not the raw child message history.

## Work Queue

### Node A: Rewrite Spec and Re-anchor Queue

Classification: planning/documentation

Owner: main agent

Acceptance:

- Spec is rewritten as current executable plan, not historical diary.
- Patch-level and architecture-level work are separated.
- Next node is small enough for one worker subagent.
- Tool-definition no-loss gate is explicitly preserved.

Status: accepted.

Result:

- Replaced the historical running log with this executable architecture spec.
- Separated patch/bridge fixes from architecture-level fixes.
- Re-established the main/worker split and no-loss verification gates.
- Selected Node B as the next bounded worker task.

### Node B: Long Probe Warmup Isolation

Classification: patch / test-harness

Owner: worker subagent

Problem:

The long-conversation verifier uses the real probe agent during warmup turns. This creates a contradiction between warmup prompts and agent-level first-action instructions.

Allowed write set:

- `tests/agent-capability/verify-opencode-long-conversation.ps1`
- nearby test/probe documentation only if needed

Implementation guidance:

- Add an optional agent parameter to `Invoke-OpencodeRun`.
- Warmup turns should not use `--agent long-conversation-probe`.
- Final probe turn must still use `--agent long-conversation-probe`.
- Preserve the same OpenCode session id across warmup and final probe.
- If OpenCode requires an agent argument, use a neutral/default agent only after verifying available local agent names.
- Keep event capture and artifact validation unchanged.

Acceptance:

- Warmup output cannot satisfy or trigger `long-conversation-probe` skill obligations.
- Final probe still uses the long-conversation probe agent.
- Script continues to prove compaction before the final tool probe.
- Existing artifact/event assertions stay intact.
- No production code changes.

Verification:

```powershell
git diff --check
.\tests\agent-capability\verify-opencode-long-conversation.ps1 -Model "qwen/Qwen3-Max" -LogPath .\dev.log
```

If the live probe still fails, classify the new failure by phase:

- warmup isolation failure
- provider/session failure
- tool-call parsing failure
- artifact validation failure
- child-transcript pollution failure

Status: accepted as a patch-level harness fix.

Result:

- Worker `Locke` changed only `tests/agent-capability/verify-opencode-long-conversation.ps1`.
- `Invoke-OpencodeRun` now accepts optional `AgentName`.
- Warmup turns omit `--agent`, so they use neutral/default OpenCode behavior.
- The final probe still passes `--agent long-conversation-probe`.
- Warmup and final probe continue to share the same OpenCode session id.
- Event capture, artifact validation, and compaction evidence checks remain strict.

Verification:

```powershell
git diff --check
.\tests\agent-capability\verify-opencode-long-conversation.ps1 -Model "qwen/Qwen3-Max" -LogPath .\dev.log
```

Observed:

- `git diff --check` passed, with only existing CRLF warnings.
- Warmup 1-6 returned only `WARMUP_ACK_n`.
- Warmup no longer loaded or triggered `long-conversation-probe`.
- The final probe loaded the real `long-conversation-probe` skill and executed real tools.
- The live probe still failed because `.agent-probe/long-summary.txt` was missing.

New failure classification:

- Not a warmup isolation failure.
- Not a provider startup failure.
- Not the earlier `preserveContextManagedMessageMetadata` import failure.
- The final probe reached real tool execution, then drifted from the skill contract:
  - it wrote unexpected `.agent-probe/long-step-3.txt`
  - it wrote unexpected `.agent-probe/long-step-4.txt`
  - it emitted `LONG_CONVERSATION_PROBE_DONE`
  - it skipped required `.agent-probe/long-summary.txt`
- `dev.log` showed context management applying, but each tool step still reintroduced a growing active tool transcript. Examples progressed from 16 messages with 1 tool pair to 34 messages with 10 tool pairs.

Interpretation:

- Node B removed the harness contamination.
- The remaining failure is the architecture issue: an in-progress tool workflow still keeps too much raw tool history in the parent provider session.
- The next node should not merely strengthen the probe prompt. It should introduce a bounded handoff representation for completed tool exchanges.

### Node C: Completed Tool Exchange Handoff

Classification: architecture-level

Owner: main agent for design, worker for implementation slices

Problem:

Two live observations point to the same root cause:

1. OpenCode session `ses_0a5dc051affeLRU0mtTDp1aUS5` showed:

- one `task` call
- then 10 `grep` calls and 8 `read` calls by the parent session
- task result contained useful findings plus a provider/tool-catalog error tail

2. The long probe after Node B showed:

- warmup isolation was fixed
- final probe loaded the correct skill
- the model still drifted after several tool calls
- context management preserved an ever-growing active tool transcript

Conclusion:

- Parent/subagent handoff is too raw.
- Parent/tool handoff is also too raw.
- The parent session receives or preserves too much child/tool transcript and resumes or mutates the workflow.

Design:

- Treat a completed assistant `tool_call` plus matching `role: "tool"` result as a completed tool exchange.
- For completed old exchanges, replace raw transcript with a compact typed handoff message.
- Preserve the latest unresolved or immediately active exchange exactly.
- Preserve authoritative tool definitions and active `tool_call_id` metadata.
- Do not keep every historical `skill`, `read`, `bash`, `grep`, or `task` result as raw parent context.

Handoff shape:

```ts
type CompletedToolExchangeHandoff = {
  kind: 'completed_tool_exchange'
  toolName: string
  status: 'ok' | 'failed' | 'unknown'
  callId: string
  summary: string
  evidence?: Array<{ label: string; value: string }>
  artifactPaths?: string[]
}
```

First implementation slice:

- Add a pure handoff builder for completed tool exchanges.
- Add deterministic tests for a long active workflow:
  - many completed tool pairs
  - no settled assistant answer yet
  - latest required exchange preserved exactly
  - older completed exchanges replaced by bounded handoff summaries
  - tool definitions remain untouched
- Wire it only through context management after tests prove no-loss behavior.

Allowed write set for worker:

- new helper under `src/main/proxy/` or `src/main/proxy/services/`
- `src/main/proxy/services/contextManagementService.ts`
- focused tests under `tests/services/`
- focused no-loss tests under `tests/providers/context-tool-metadata.test.ts` only if needed

Explicit non-goals:

- Do not change provider adapters.
- Do not change `ToolCallingEngine` prompt ownership.
- Do not implement prompt refresh optimization.
- Do not relax live probe assertions.
- Do not touch renderer files.

Acceptance for design:

- Define a bounded handoff schema.
- Define where handoff is generated.
- Define how raw child transcript is excluded from parent provider context.
- Define how tool catalog identity is retained while provider conversation identity forks.
- Add deterministic tests before behavior change.

Acceptance for first implementation slice:

- Synthetic long workflow compacts to a bounded message count even before a settled assistant reply exists.
- Latest active tool exchange remains exact with `assistant.tool_calls` and matching `tool.tool_call_id`.
- Older completed tool exchanges are represented by bounded handoff summaries, not raw tool output.
- Tool-definition messages are not summarized or removed.
- Existing context metadata and no-loss tests pass.

Verification:

```powershell
node --test tests/services/contextManagement-*.test.ts tests/providers/context-tool-metadata.test.ts
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts tests/providers/multi-turn-conversation.test.ts tests/providers/qwen-session-continuity.test.ts
git diff --check
```

Round 1 result:

- Worker `Hegel` added a bounded completed-tool-exchange handoff path in `src/main/proxy/services/contextManagementService.ts`.
- Added `tests/services/contextManagement-tool-handoff.test.ts`.
- Deterministic focused gate passed:

```powershell
node --test tests/services/contextManagement-*.test.ts tests/providers/context-tool-metadata.test.ts
```

- Tool/provider gate passed:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts tests/providers/multi-turn-conversation.test.ts tests/providers/qwen-session-continuity.test.ts
```

- Observed: 309 passing tests.
- Build passed:

```powershell
npm run build
```

Live probe after Round 1:

```powershell
.\tests\agent-capability\verify-opencode-long-conversation.ps1 -Model "qwen/Qwen3-Max" -LogPath .\dev.log
```

Observed:

- Warmup 1-6 stayed clean and returned `WARMUP_ACK_n`.
- Final probe loaded the correct `long-conversation-probe` skill.
- Final probe executed real tools.
- Probe still failed because `.agent-probe/long-summary.txt` was missing.
- Final events showed unexpected `.agent-probe/long-step-3.txt` and `.agent-probe/long-step-4.txt`, then early `LONG_CONVERSATION_PROBE_DONE`.
- `dev.log` still showed raw tool preservation growing under the real `summary -> slidingWindow` path:
  - examples included `20 -> 13`, `22 -> 13`, `24 -> 13`, `26 -> 15`, `28 -> 17`, `30 -> 19`
  - `preservedToolCallMessages` / `preservedToolResultMessages` still grew from 1 to 8

Interpretation:

- Round 1 proves the handoff idea in a single `slidingWindow` path.
- It does not yet cover the live shape: warmup text pairs followed by a final skill workflow under `summary -> slidingWindow`.
- The likely gap is interaction between active workflow selection, pinned skill exchange, summary recent-message selection, and replacements.

Round 2 task:

- Add a deterministic regression that mimics the live shape:
  - warmup user/assistant text pairs
  - final `skill` assistant/tool exchange
  - several completed `read`/`bash` assistant/tool exchanges
  - no settled assistant reply after the final skill workflow
  - config uses `executionOrder: ['summary', 'slidingWindow']`
- Fix the implementation so raw `assistant.tool_calls` and raw `role: "tool"` messages do not grow linearly.
- Preserve the latest active exchange exactly.
- Preserve tool definitions.
- Keep tool-definition no-loss tests green.

Round 2 result:

- Worker added a multi-strategy live-like deterministic regression.
- The new test covers warmup text pairs followed by a final skill workflow under `executionOrder: ['summary', 'slidingWindow']`.
- The deterministic fixture passes with bounded raw tool messages:
  - final message count `<= 12`
  - raw `assistant.tool_calls` `<= 2`
  - raw `role: "tool"` messages `<= 3`
  - handoff summary present
  - latest active exchange exact
  - summary system message and tool-definition message preserved
- No production code changed in Round 2.

Interpretation:

- The current implementation can compact the modeled multi-strategy shape.
- The live failure still has an unmodeled input or restore-path difference.
- The next task is diagnostic, not behavior change.

Round 3 task:

- Add structure-only diagnostics around active tool workflow selection and `preserveToolExchangePairs()`.
- Logs may include counts, booleans, and strategy names only.
- Logs must not include raw tool names, arguments, result text, schemas, or message content.
- Goal: explain whether live failure is caused by handoff not being applied, or by pair preservation restoring old raw exchanges after handoff.

Round 3 result:

- Added structure-only diagnostics around active workflow selection and pair preservation.
- Focused tests passed and guard that diagnostics do not include content-bearing fields.
- Live probe was interrupted by the outer tool timeout before the script's own timeout; the probe config was manually restored to disabled afterward.

Key live diagnostic evidence:

- Handoff selection is being applied:
  - examples: `toolWorkflowGroupCount=10`, `summarizedGroupCount=9`, `handoffApplied=true`
- But `replacementCount` stays `1`.
- Before pair preservation, raw tool messages already grow linearly:
  - examples: `beforeToolCallCount=9`, `beforeToolResultCount=10`
- Pair preservation then adds one more raw assistant call:
  - examples: `afterToolCallCount=10`, `afterToolResultCount=10`

Interpretation:

- The handoff selector identifies old completed groups, but only the first summarized assistant is replaced by the handoff anchor.
- Other summarized raw tool messages can still enter the strategy result through protected/recent paths.
- Once any summarized raw tool result remains, `preserveToolExchangePairs()` restores its matching assistant.

Round 4 task:

- Extend the selection result with an explicit summarized/drop set.
- After strategy selection and replacements, remove every summarized raw assistant/tool message except the single handoff anchor.
- Ensure no summarized raw tool result remains, otherwise pair preservation will restore the assistant.
- Keep latest active raw exchange exact.
- Keep tool-definition/system contract messages exact.
- Add deterministic tests that reproduce the C3 diagnostic shape and fail if raw tool counts grow with summarized group count.

Round 4 result:

- Worker `Hegel` extended `MessageSelection` with an explicit `droppedMessages` set.
- `collectActiveToolWorkflowMessages()` now marks every summarized raw assistant/tool message for removal, except the single bounded handoff anchor.
- `SlidingWindowStrategy`, `TokenLimitStrategy`, and `SummaryStrategy` now apply replacements first and then apply dropped-message filtering before returning.
- This prevents summarized raw tool results from surviving through protected/recent/pinned paths.
- Because those raw tool results no longer survive, `preserveToolExchangePairs()` no longer restores their matching assistant `tool_calls`.
- Added/strengthened regressions in `tests/services/contextManagement-tool-handoff.test.ts`:
  - live-like `summary -> slidingWindow` workflow remains bounded
  - summarized raw tool results such as old `read`/`bash` calls are absent
  - many completed old tool groups collapse to one handoff anchor plus the latest raw boundary
  - diagnostics remain structure-only and do not log content, arguments, schemas, outputs, or tool names

Verification:

```powershell
node --test tests/services/contextManagement-tool-handoff.test.ts tests/services/contextManagement-*.test.ts tests/providers/context-tool-metadata.test.ts
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts tests/providers/multi-turn-conversation.test.ts tests/providers/qwen-session-continuity.test.ts
npm run build
git diff --check
```

Observed:

- Focused context-management gate passed.
- Tool/provider regression gate passed with 309 tests.
- Build passed with existing warnings only.
- `git diff --check` passed with CRLF warnings only.
- In the live-like deterministic regression, the summary stage now compresses `22 -> 12`.
- Pair preservation stays bounded:
  - before preserve: `beforeToolCallCount=1`, `beforeToolResultCount=1`
  - after preserve: `afterToolCallCount=1`, `afterToolResultCount=1`

Interpretation:

- The C3 root cause is fixed in deterministic coverage.
- Node C is ready for C4 live validation.
- If the live probe still misses `.agent-probe/long-summary.txt` while raw tool counts stay bounded, the next problem is model procedure drift under compressed handoff, not raw transcript growth.

C4 live validation:

```powershell
.\tests\agent-capability\verify-opencode-long-conversation.ps1 -Model "qwen/Qwen3-Max" -LogPath .\dev.log
```

Observed:

- Warmup 1-6 completed in OpenCode session `ses_0a5727049ffeFjPLHV3D15pMA5`.
- Compaction before the final probe was proven by `dev.log`.
- The final probe loaded the real `long-conversation-probe` skill and made forward progress:
  - `.agent-probe/long-step-1.txt`
  - `.agent-probe/long-step-2.txt`
  - `.agent-probe/long-result.json`
  - `.agent-probe/long-combined.txt`
  - `.agent-probe/long-hash.txt`
  - `.agent-probe/long-verification.txt`
- The verifier failed with:

```text
opencode_turn_timeout_after_mid_probe_progress:
OpenCode reached long-step-2.txt but did not exit within 240 seconds
```

- The probe script restored the original context-management config in `finally`.

Important event evidence:

- The model did not follow the exact required probe sequence after step 5.
- It invented a combined/hash/verification path instead of the required `long-check-1`, `long-check-2`, `long-summary`, final read, final marker sequence.
- It retried a malformed verification command after a syntax error.

Important context-management evidence:

- Raw tool preservation still grows in the live path:
  - `20 -> 13`, then `22 -> 13`, `24 -> 13`, `30 -> 15`, `34 -> 23`, `36 -> 23`
  - `afterToolCallCount` and `afterToolResultCount` still rise toward `10/10`
- `handoffApplied=true` and `replacementCount=1`, but `preserveToolExchangePairs()` still restores old raw pairs after strategy processing.

Interpretation:

- C4 deterministic coverage was too optimistic.
- C4 is not accepted for live behavior.
- The remaining live root cause is inside the interaction between:
  - selected/replaced/dropped messages from context strategies
  - multi-call or partially retained assistant/tool messages
  - `preserveToolExchangePairs()` rebuilding pairs from original history

Round 5 task:

- Add a deterministic regression using the C4 live shape:
  - one assistant message may carry multiple `tool_calls`, or selected messages may retain only part of a completed exchange
  - old summarized call ids must not remain "needed" after handoff/drop
  - `preserveToolExchangePairs()` must not resurrect summarized old raw pairs
  - latest active raw boundary remains exact
- Fix the smallest boundary needed:
  - either make context-management mark suppressed tool call ids explicitly, or
  - make `preserveToolExchangePairs()` accept a suppression/represented-id set, or
  - split/clone retained assistant tool calls so only truly active ids remain in processed messages
- Do not weaken the general no-loss invariant for active tool turns.
- Do not remove pair preservation globally.
- Keep diagnostics structure-only.

Allowed write set:

- `src/main/proxy/services/contextManagementService.ts`
- `src/main/proxy/contextMessageMetadata.ts`
- `tests/services/contextManagement-tool-handoff.test.ts`
- focused metadata tests only if needed

Verification:

```powershell
node --test tests/services/contextManagement-tool-handoff.test.ts tests/services/contextManagement-*.test.ts tests/providers/context-tool-metadata.test.ts
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts tests/providers/multi-turn-conversation.test.ts tests/providers/qwen-session-continuity.test.ts
git diff --check
```

Round 5 result:

- Worker `Bacon` implemented explicit suppressed tool-call ids.
- `preserveToolExchangePairs()` now accepts `suppressedToolCallIds` and excludes those ids when deciding which original assistant/tool pairs are still required.
- `ContextManagementService` now derives suppression from active workflow selection:
  - summarized completed exchanges suppress their old call ids
  - partially retained multi-call assistant messages suppress the trimmed-out call ids
  - active retained ids remain eligible for normal no-loss preservation
- Added deterministic regression:
  - `summary then sliding window does not resurrect summarized old ids from a partially retained multi-call assistant`
- The regression models the C4 live shape where old and active tool ids can coexist in the same assistant-side workflow.

Verification:

```powershell
node --test tests/services/contextManagement-tool-handoff.test.ts tests/services/contextManagement-*.test.ts tests/providers/context-tool-metadata.test.ts
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts tests/providers/multi-turn-conversation.test.ts tests/providers/qwen-session-continuity.test.ts
npm run build
git diff --check
```

Observed:

- Focused context/service gate passed with 45 tests.
- Tool/provider gate passed with 309 tests.
- Build passed with existing warnings only.
- `git diff --check` passed with CRLF warnings only.
- The new Round 5 regression shows preservation remains bounded after `preserveToolExchangePairs()`.

Interpretation:

- The known C4 live resurrection mechanism is now covered by deterministic tests.
- C5 is ready for live validation.

C5 live validation:

```powershell
.\tests\agent-capability\verify-opencode-long-conversation.ps1 -Model "qwen/Qwen3-Max" -LogPath .\dev.log
```

Observed:

- Warmup 1-6 completed in OpenCode session `ses_0a55e83e0ffeoNgRttkhI7pHF6`.
- The final probe loaded the real `long-conversation-probe` skill.
- The final probe completed:
  - skill load
  - read `tests/agent-capability/input.txt`
  - bash write `.agent-probe/long-step-1.txt`
  - read `tests/agent-capability/long-conversation-payload.txt`
- Then it repeated the payload read until OpenCode timed out.
- The verifier failed with:

```text
opencode_turn_timeout_after_initial_tool_progress:
OpenCode reached long-step-1.txt but did not exit within 240 seconds
```

Context-management evidence:

- Raw transcript resurrection is fixed in live:
  - `20 -> 11`
  - `22 -> 11`
  - `30 -> 11`
  - `36 -> 11`
  - `42 -> 11`
- After preservation, counts stay bounded:
  - `afterToolCallCount=1`
  - `afterToolResultCount=1`
- The old C4 pattern `before 1/1 -> after 10/10` no longer appears.

Interpretation:

- C5 is accepted for the raw tool-transcript resurrection problem.
- The remaining live failure is a procedure-state loss problem.
- The likely cause is that the current workflow's `skill` instruction exchange is treated as an old completed tool exchange and summarized into a generic handoff.
- For OpenCode skills, the latest active `skill` result is not just historical evidence. It is the current procedural contract.
- If that raw skill result is removed, Qwen keeps the last observed payload/result but loses the exact next command sequence, causing repeated reads.

Round 6 task:

- Preserve the latest instruction-bearing `skill` exchange exactly while a tool workflow is still active.
- This preservation should apply even when the skill exchange is an older completed group inside the active suffix.
- Ordinary older non-skill tool exchanges should still be summarized into bounded handoff.
- Older skill exchanges before a settled assistant can still be summarized once a newer skill exchange supersedes them.
- Add deterministic coverage for the live shape:
  - skill exchange
  - read input
  - bash step 1
  - read payload
  - no settled assistant reply
  - `summary -> slidingWindow`
  - assert the raw latest skill assistant/tool result survives
  - assert old ordinary tool exchanges are summarized
  - assert raw tool counts remain bounded

Allowed write set:

- `src/main/proxy/services/contextManagementService.ts`
- `tests/services/contextManagement-tool-handoff.test.ts`
- `tests/services/contextManagement-skill-instruction-pinning.test.ts`

Verification:

```powershell
node --test tests/services/contextManagement-tool-handoff.test.ts tests/services/contextManagement-skill-instruction-pinning.test.ts tests/services/contextManagement-*.test.ts tests/providers/context-tool-metadata.test.ts
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts tests/providers/multi-turn-conversation.test.ts tests/providers/qwen-session-continuity.test.ts
npm run build
git diff --check
```

Round 6 result:

- Worker `Volta` preserved the latest instruction-bearing `skill` exchange exactly inside an active tool workflow.
- The active workflow selector now identifies the latest `skill` group and pins it before completed ordinary tool groups are summarized.
- Older ordinary tool exchanges still collapse into handoff summaries.
- Existing bounded skill-history behavior is retained:
  - only the most recent skill instruction exchange is pinned
  - older skill history is not pinned forever
- Added deterministic coverage:
  - live-shaped `skill -> read -> bash -> read` active workflow
  - latest skill assistant/tool result survives exact
  - ordinary old read/bash exchanges remain bounded
  - raw tool pair preservation stays bounded after compaction

Verification:

```powershell
node --test tests/services/contextManagement-tool-handoff.test.ts tests/services/contextManagement-skill-instruction-pinning.test.ts tests/services/contextManagement-*.test.ts tests/providers/context-tool-metadata.test.ts
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts tests/providers/multi-turn-conversation.test.ts tests/providers/qwen-session-continuity.test.ts
npm run build
git diff --check
```

Observed:

- Focused context/service gate passed with 47 tests.
- Tool/provider gate passed with 309 tests.
- Build passed with existing warnings only.
- `git diff --check` passed with CRLF warnings only.

Interpretation:

- C6 is ready for live validation.

C6 live validation:

```powershell
.\tests\agent-capability\verify-opencode-long-conversation.ps1 -Model "qwen/Qwen3-Max" -LogPath .\dev.log
```

Observed:

- Warmup 1-6 completed in OpenCode session `ses_0a548d38effeanNkS2Z6n03WyW`.
- The final probe loaded the real `long-conversation-probe` skill.
- The final probe completed:
  - skill load
  - read `tests/agent-capability/input.txt`
  - bash write `.agent-probe/long-step-1.txt`
- Then it repeated the same step-2 bash command until timeout.
- The verifier failed with:

```text
opencode_turn_timeout_after_initial_tool_progress:
OpenCode reached long-step-1.txt but did not exit within 240 seconds
```

Context-management evidence:

- The latest skill instruction exchange is now pinned in the active workflow:
  - `latestSkillInstructionGroupPinned=true`
- Context remains bounded:
  - `20 -> 12`
  - `30 -> 12`
  - `40 -> 12`
- Preservation remains bounded:
  - `afterToolCallCount=2`
  - `afterToolResultCount=2`
- This is expected: one raw pair for the latest skill contract and one raw pair for the latest active tool boundary.

Interpretation:

- C6 is accepted for preserving the active skill contract.
- The remaining live failure is procedural progress loss.
- The model can still see the exact skill instructions, but old completed ordinary exchanges have been summarized too generically for procedural execution.
- In particular, it sees the skill says "step 2: run bash" and the latest raw boundary may also be that bash, but the compact state does not strongly tell it "step 2 is complete; proceed to step 3".
- The next architecture slice should add a bounded procedural progress handoff for active skill workflows, not restore raw transcripts.

Round 7 task:

- Add a bounded active-skill workflow progress handoff.
- The handoff should be ordinary assistant/system narrative with no `tool_calls` or `tool_call_id`.
- It should be generated only when a latest active `skill` instruction exchange is pinned and older ordinary completed exchanges are summarized.
- It should include:
  - completed tool exchange names in order since the latest skill
  - compact evidence snippets or artifact paths
  - an explicit continuation cue: continue with the next not-yet-completed skill instruction
- It must not include full raw tool output.
- It must not replace the raw latest skill instruction exchange.
- It must not restore unbounded read/bash history.
- Add deterministic coverage for:
  - skill exact instructions preserved
  - completed ordinary progress handoff present
  - repeated current-step ambiguity is reduced by saying the previous bash completed
  - raw tool counts remain bounded

Allowed write set:

- `src/main/proxy/services/contextManagementService.ts`
- `tests/services/contextManagement-tool-handoff.test.ts`
- `tests/services/contextManagement-skill-instruction-pinning.test.ts`

Verification:

```powershell
node --test tests/services/contextManagement-tool-handoff.test.ts tests/services/contextManagement-skill-instruction-pinning.test.ts tests/services/contextManagement-*.test.ts tests/providers/context-tool-metadata.test.ts
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts tests/providers/multi-turn-conversation.test.ts tests/providers/qwen-session-continuity.test.ts
npm run build
git diff --check
```

Round 7 result:

- Worker: Kierkegaard.
- Status: accepted for deterministic validation.
- Implementation:
  - The latest active `skill` exchange remains pinned exactly.
  - Older ordinary completed tool exchanges are collapsed into a bounded progress handoff.
  - The progress handoff lists completed tool names in order, compact artifact/evidence hints, and an explicit cue to continue with the next not-yet-completed skill instruction.
  - Summarized old raw tool call/result IDs remain suppressed so `preserveToolExchangePairs` cannot resurrect them.
- Verification passed:

```powershell
node --test tests/services/contextManagement-tool-handoff.test.ts tests/services/contextManagement-skill-instruction-pinning.test.ts tests/services/contextManagement-*.test.ts tests/providers/context-tool-metadata.test.ts
# tests 48
# pass 48
# fail 0

node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts tests/providers/multi-turn-conversation.test.ts tests/providers/qwen-session-continuity.test.ts
# tests 309
# pass 309
# fail 0

npm run build
# passed

git diff --check
# passed with CRLF warnings only
```

Round 7 live validation task:

- Restart Chat2API cleanly.
- Run:

```powershell
.\tests\agent-capability\verify-opencode-long-conversation.ps1 -Model "qwen/Qwen3-Max" -LogPath .\dev.log
```

- If it passes, Node C is accepted and the next architecture node is Node D.
- If it fails, inspect only:
  - `.agent-probe/opencode-long-final-events.ndjson`
  - `.agent-probe/result.json`
  - `dev.log` structural context-management diagnostics
- Classify failure as one of:
  - model did not follow the active skill progress handoff
  - handoff was not injected
  - raw transcript was resurrected
  - tool definitions or skill contract were lost
  - child/parent session boundary is now the dominant blocker

Round 7 live validation result:

- Model: `qwen/Qwen3-Max`
- Log: `dev-c7.log`
- Verifier result:

```text
[PASS] Completed 6 OpenCode warmup turns in session ses_0a53346aaffeviHYb5mcVNW8mX
[PASS] dev.log proves compaction before final tool probe (summary=True sliding=False)
[FAIL] opencode_turn_timeout_after_initial_tool_progress:
OpenCode reached long-step-1.txt but did not exit within 240 seconds
```

Observed final tool sequence:

- `skill long-conversation-probe` completed.
- `read tests/agent-capability/input.txt` completed.
- `bash` created `.agent-probe/long-step-1.txt`.
- The model then repeated the same `bash` command many times until timeout.

Context-management evidence:

- `handoffApplied=true`
- `latestSkillInstructionGroupPinned=true`
- raw tool pairs stayed bounded:
  - `afterToolCallCount=2`
  - `afterToolResultCount=2`
- final context stayed bounded:
  - `28 -> 12`
  - `30 -> 12`
  - `32 -> 12`
  - `34 -> 12`
  - `36 -> 12`
- tool catalog remained available:
  - prompt budget diagnostics showed `toolCount=10`

Interpretation:

- This is not a tools-definition regression.
- This is not raw transcript resurrection.
- The likely failure is recency dominance from retaining the latest ordinary completed `bash` group as a raw boundary.
- In an active skill workflow, ordinary completed post-skill tool groups are progress, not an active pending boundary.
- Keeping the latest completed ordinary `bash` raw can make Qwen repeat it even when a progress handoff exists earlier in context.

Round 8 task:

- In active-skill workflow mode, keep the latest `skill` instruction exchange exact.
- Convert ordinary completed post-skill tool groups, including the most recent completed `read`/`bash`, into a bounded progress handoff.
- Do not leave the latest completed ordinary `bash` as the raw most-recent assistant/tool pair.
- Preserve a raw group only if it is truly partial/protocol-active, for example an assistant `tool_call` without its corresponding tool result.
- Keep summarized IDs suppressed so pair preservation cannot resurrect old ordinary tool calls.
- Add deterministic coverage that reproduces the C7 live failure shape:
  - `skill -> read input -> bash long-step-1 -> repeated bash`
  - compacted output contains a progress handoff saying the bash is already complete
  - compacted output does not retain the repeated ordinary bash as the latest raw boundary
  - latest skill contract remains exact
  - tool definition preservation still passes

Allowed write set:

- `src/main/proxy/services/contextManagementService.ts`
- `tests/services/contextManagement-tool-handoff.test.ts`
- `tests/services/contextManagement-skill-instruction-pinning.test.ts`
- This spec file for status notes only

Verification:

```powershell
node --test tests/services/contextManagement-tool-handoff.test.ts tests/services/contextManagement-skill-instruction-pinning.test.ts tests/services/contextManagement-*.test.ts tests/providers/context-tool-metadata.test.ts
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts tests/providers/multi-turn-conversation.test.ts tests/providers/qwen-session-continuity.test.ts
git diff --check
```

Round 8 result:

- Worker: Raman.
- Status: accepted for deterministic validation.
- Implementation:
  - Active-skill compaction pins the latest raw `skill` exchange.
  - Completed ordinary post-skill `read`/`bash` groups, including the most recent completed group, become bounded progress handoff.
  - Truly partial post-skill tool boundaries remain raw for protocol safety.
  - Suppressed IDs still prevent pair preservation from restoring summarized completed ordinary groups.
- Verification passed:

```powershell
node --test tests/services/contextManagement-tool-handoff.test.ts tests/services/contextManagement-skill-instruction-pinning.test.ts tests/services/contextManagement-*.test.ts tests/providers/context-tool-metadata.test.ts
# tests 50
# pass 50
# fail 0

node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts tests/providers/multi-turn-conversation.test.ts tests/providers/qwen-session-continuity.test.ts
# tests 309
# pass 309
# fail 0

npm run build
# passed

git diff --check
# passed with CRLF warnings only
```

Round 8 live validation task:

- Restart Chat2API cleanly.
- Run:

```powershell
.\tests\agent-capability\verify-opencode-long-conversation.ps1 -Model "qwen/Qwen3-Max" -LogPath .\dev-c8.log
```

- Primary acceptance signal:
  - the model does not repeat the latest completed `bash long-step-1` raw boundary
  - it advances to the next skill instruction after compaction
- If it still fails, inspect whether the progress handoff survived the second sliding-window pass.

Round 8 live validation result:

- Model: `qwen/Qwen3-Max`
- Log: `dev-c8.log`
- Verifier result:

```text
[PASS] Completed 6 OpenCode warmup turns in session ses_0a52340edffecSxzqmMD3jVWfl
[PASS] dev.log proves compaction before final tool probe (summary=True sliding=False)
[FAIL] opencode_turn_timeout_after_initial_tool_progress:
OpenCode reached long-step-1.txt but did not exit within 240 seconds
```

Observed final tool sequence:

- The model no longer repeated the same `bash long-step-1` command as the raw latest boundary.
- It loaded the skill and used tools, but the order became unstable:
  - `skill`
  - `read input`
  - `read payload`
  - `bash long-step-1`
  - repeated `read input`, `read payload`, and `read .agent-probe/long-step-1.txt`
- It still timed out without producing the final marker.

Context-management evidence:

- active-skill handoff was applied:
  - `handoffApplied=true`
  - `latestSkillInstructionGroupPinned=true`
- raw ordinary tool history stayed collapsed:
  - `preservedToolCallMessages=1`
  - `preservedToolResultMessages=1`
- final context stayed bounded:
  - `26 -> 11`
  - `28 -> 11`
  - up to `44 -> 11`
- tools remained available:
  - prompt budget diagnostics showed `toolCount=10`

Interpretation:

- Round 8 fixed the raw-boundary recurrence problem.
- The remaining failure is not tool definition loss and not raw transcript resurrection.
- The likely issue is that the active progress handoff is represented as an ordinary assistant message.
- The probe skill explicitly says there must be no ordinary assistant text between tool results and the next tool call.
- Injecting progress as assistant narrative may make the provider-side transcript look like the agent already spoke inside a strict tool chain.
- The next slice should represent active-skill progress as a system/state checkpoint, not as ordinary assistant speech.

Round 9 task:

- Change the active-skill workflow progress handoff role/shape so it is a system-level state checkpoint, not an ordinary assistant message.
- Keep non-skill completed-tool handoff behavior unchanged unless tests require a shared helper.
- The checkpoint must say:
  - the latest skill instructions remain authoritative
  - listed tool steps are already completed
  - do not repeat completed reads/bash writes
  - continue with the first not-yet-completed skill instruction
- Preserve:
  - latest raw `skill` exchange exact
  - raw partial post-skill tool boundary when present
  - bounded raw tool counts
  - tool-definition preservation
- Add deterministic coverage for:
  - active-skill handoff role is `system`
  - no active-skill progress handoff appears as ordinary assistant content
  - summary + sliding-window keeps the state checkpoint
  - non-skill completed handoff still uses the established assistant handoff shape

Allowed write set:

- `src/main/proxy/services/contextManagementService.ts`
- `tests/services/contextManagement-tool-handoff.test.ts`
- `tests/services/contextManagement-skill-instruction-pinning.test.ts`
- This spec file for status notes only

Verification:

```powershell
node --test tests/services/contextManagement-tool-handoff.test.ts tests/services/contextManagement-skill-instruction-pinning.test.ts tests/services/contextManagement-*.test.ts tests/providers/context-tool-metadata.test.ts
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts tests/providers/multi-turn-conversation.test.ts tests/providers/qwen-session-continuity.test.ts
git diff --check
```

Round 9 result:

- Worker: Boole.
- Status: accepted for deterministic validation.
- Implementation:
  - Active-skill progress handoff is now a `system` state checkpoint.
  - The checkpoint states that the latest skill instructions remain authoritative.
  - It tells the model not to repeat completed reads/bash writes and to continue with the first not-yet-completed skill instruction.
  - Non-skill completed-tool handoff remains assistant-shaped.
  - Latest raw skill exchange and raw partial post-skill boundaries remain preserved.
- Verification passed:

```powershell
node --test tests/services/contextManagement-tool-handoff.test.ts tests/services/contextManagement-skill-instruction-pinning.test.ts tests/services/contextManagement-*.test.ts tests/providers/context-tool-metadata.test.ts
# tests 50
# pass 50
# fail 0

node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts tests/providers/multi-turn-conversation.test.ts tests/providers/qwen-session-continuity.test.ts
# tests 309
# pass 309
# fail 0

npm run build
# passed

git diff --check
# passed with CRLF warnings only
```

Round 9 live validation task:

- Restart Chat2API cleanly.
- Run:

```powershell
.\tests\agent-capability\verify-opencode-long-conversation.ps1 -Model "qwen/Qwen3-Max" -LogPath .\dev-c9.log
```

- If this still fails while:
  - tool definitions are present
  - raw transcript is bounded
  - skill contract is pinned
  - system state checkpoint is present
- then Node C should be considered exhausted for prompt-shape fixes, and the next architecture node should be Node D child-session execution boundary.

Round 9 live validation result:

- Model: `qwen/Qwen3-Max`
- Log: `dev-c9b.log`
- Verifier result:

```text
[PASS] Completed 6 OpenCode warmup turns in session ses_0a4dab3b9ffelGD3QBed3p5jWA
[PASS] dev.log proves compaction before final tool probe (summary=True sliding=False)
[FAIL] opencode_turn_timeout_before_required_artifacts:
OpenCode did not exit within 240 seconds and no required probe artifacts were created
```

Observed final tool sequence:

- `skill long-conversation-probe` completed.
- `read tests/agent-capability/input.txt` completed.
- The model then repeatedly called `read tests/agent-capability/input.txt`.
- It did not create `.agent-probe/long-step-1.txt`.

Context-management evidence:

- active-skill checkpoint was applied:
  - `handoffApplied=true`
  - `latestSkillInstructionGroupPinned=true`
  - `systemMessageCount=3`
- raw transcript stayed bounded:
  - `preservedToolCallMessages=1`
  - `preservedToolResultMessages=1`
- final context stayed bounded:
  - `26 -> 11`
  - `28 -> 11`
  - up to `40 -> 11`
- tools remained available:
  - tool transform used `planMode="managed"`
  - `toolCount=10`
  - prompt refresh mode stayed `full` after server summary

Interpretation:

- Tool definitions did not regress.
- Raw old tool transcript did not resurrect.
- Latest skill contract was pinned.
- The system checkpoint survived compaction.
- Prompt-shape fixes in Node C are now exhausted: Qwen still fails to maintain procedural state inside one long provider-side execution stream.
- The next fix must be architecture-level: separate execution/child session boundaries so tool-heavy work does not keep accumulating and competing inside the parent provider conversation.

### Node D: Child Session Execution Boundary

Classification: architecture-level implementation

Owner: worker subagent after Node C is accepted

Acceptance:

- Tool-child and subagent-child requests use forked provider conversation identity.
- Parent session receives compact handoff only.
- Tool definitions remain resolvable in child and parent.
- Existing managed-tool parsing tests pass.
- Long OpenCode probe does not show parent continuing raw grep/read after a successful child handoff.

Round D1 task: boundary audit and deterministic proof

Purpose:

- Prove what is already implemented before changing architecture.
- Prevent another broad rewrite that only changes type names.

Current findings:

- `deriveOpenAISessionIdentity` already derives:
  - `client_compact`
  - `tool_child`
  - `subagent_child`
- `forwardChatCompletion` already forks provider context on `server_summary`.
- Live C9 still fails even with:
  - full prompt refresh after server summary
  - bounded raw transcript
  - pinned skill
  - system state checkpoint
  - `toolCount=10`
- Therefore the missing piece is not a single prompt line. The next proof must show where parent/child provider state still collapses or where OpenCode requests cannot express the desired child execution boundary.

Allowed write set:

- `tests/routes/openai-session-identity.test.ts`
- `tests/providers/qwen-session-continuity.test.ts`
- `src/main/proxy/routes/openaiSession.ts` only if a tested boundary derivation bug is found
- `src/main/proxy/sessionBoundary.ts` only if a tested fork bug is found
- This spec file for status notes only

Acceptance:

- Add deterministic tests for:
  - a tool-result continuation request derives `tool_child`
  - `tool_child` preserves the parent provider key separately from the tool catalog key
  - server-summary fork from a `tool_child` context keeps the parent chain inspectable and produces a fresh provider key
  - subagent child and subagent tool child do not collide
  - prompt budget policy receives the boundary reason and provider key expected by the forked context
- If the implementation already passes, do not change runtime code.
- If it fails, make the smallest fix in the allowed write set.
- Do not touch context handoff wording in Node D1.

Verification:

```powershell
node --test tests/routes/openai-session-identity.test.ts tests/providers/qwen-session-continuity.test.ts tests/providers/context-tool-metadata.test.ts
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts tests/providers/multi-turn-conversation.test.ts tests/providers/qwen-session-continuity.test.ts
git diff --check
```

Round D1 result:

- Worker: Carson.
- Status: accepted.
- Runtime code changed: no.
- D1 conclusion:
  - `tool_child`, `subagent_child`, `client_compact`, and `server_summary` provider-key derivation already work deterministically.
  - Prompt-budget policy receives the forked provider key and boundary reason.
  - The current gap is not boundary derivation.
  - The next architecture work is parent/child provider-state separation and compact child handoff behavior.
- Verification passed:

```powershell
node --test tests/routes/openai-session-identity.test.ts tests/providers/qwen-session-continuity.test.ts tests/providers/context-tool-metadata.test.ts
# tests 31
# pass 31
# fail 0

node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts tests/providers/multi-turn-conversation.test.ts tests/providers/qwen-session-continuity.test.ts
# tests 311
# pass 311
# fail 0

npm run build
# passed

git diff --check
# passed with CRLF warnings only
```

Round D2 task: parent/child provider-state split

Precondition:

- D1 accepted.

Goal:

- Introduce an explicit provider conversation state model with:
  - parent planner state
  - child execution state
  - compact child handoff returned to parent

Acceptance:

- Parent provider state is not advanced by raw child tool transcript.
- Child provider state can perform tool-heavy continuation with full tool contract.
- Parent receives only a bounded handoff summary/checkpoint.
- Existing OpenAI tool metadata and tool catalog fallback tests pass.

Round D2.1 task: deterministic provider-state contract before runtime split

Purpose:

- Add a small provider-state contract layer before changing forwarding behavior.
- Make the intended parent/child state writes explicit and testable.
- Align with the token/session economy plan: do not create one tool child provider session per individual tool result.

Allowed write set:

- `src/main/proxy/forwarder.ts`
- `src/main/proxy/routes/openaiSession.ts`
- `tests/providers/qwen-session-continuity.test.ts`
- `tests/routes/openai-session-identity.test.ts`
- optionally `src/main/proxy/sessionBoundary.ts` if a tiny helper belongs there
- This spec file for status notes only

Acceptance:

- Add/export a pure helper that decides provider conversation state write targets for a turn.
- Add or update identity tests so a contiguous tool workflow reuses one `tool_child` provider key across multiple tool-result continuations.
- The workflow child key should be based on a stable workflow anchor, not on each latest tool result content preview.
  - Good anchor candidates: parent provider key + first active assistant tool-call group after the latest settled assistant/user boundary.
  - Bad anchor: latest `tool` message content, because that creates a new child session for every tool step.
- A tool workflow ends when a settled assistant answer or parent/user decision is reached.
- Different independent tool workflows do not collide.
- Subagent tool workflows group under the subagent provider key and do not collide with main workflows.
- For normal/server-summary parent turns:
  - write to the active provider conversation key
  - mirror to fallback only when the existing fallback rule allows it
- For `tool_child` and `subagent_child`:
  - write child provider state to the child key
  - do not mirror raw child state to the parent/fallback key
  - expose the parent key separately for later compact handoff
- Deterministic tests prove:
  - normal writes may mirror as before
  - tool child writes do not update parent provider state
  - repeated tool results within one contiguous workflow reuse the same child provider state key
  - subagent child writes do not update main provider state
  - server summary from a tool child writes to the summary child key, not the parent
- Do not alter Qwen request rendering yet except where required to expose/test the helper.

Verification:

```powershell
node --test tests/providers/qwen-session-continuity.test.ts tests/routes/openai-session-identity.test.ts tests/providers/context-tool-metadata.test.ts
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts tests/providers/multi-turn-conversation.test.ts tests/providers/qwen-session-continuity.test.ts
git diff --check
```

Round D2.1 result:

- Worker: Copernicus.
- Status: accepted for deterministic validation.
- Implementation:
  - Added an explicit provider-state write-target contract in `src/main/proxy/sessionBoundary.ts`.
  - `normal` provider turns still write the active provider key and may mirror to the fallback tool key only under the existing managed-tool-history rule.
  - `tool_child` and `subagent_child` turns write only the child provider key and expose the parent provider key separately for a later compact handoff.
  - `tool_child` identity is now grouped by the first assistant tool-call group in a contiguous tool workflow, not by the latest tool-result payload.
  - A settled assistant answer or a new user/parent decision ends the tool workflow and returns identity to `normal`.
  - Subagent tool workflows fork under the subagent provider key and do not collide with main workflows.
- Scope note:
  - This round intentionally did not implement the final typed child-to-parent handoff.
  - It only makes the parent/child provider-state write target explicit and prevents raw child provider state from being mirrored into parent/fallback state.
  - Live validation should wait until D2.2 adds the bounded handoff artifact, otherwise the probe can still fail for missing parent state transfer.
- Verification passed:

```powershell
node --test tests/providers/qwen-session-continuity.test.ts tests/routes/openai-session-identity.test.ts tests/providers/context-tool-metadata.test.ts
# tests 39
# pass 39
# fail 0

node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts tests/providers/multi-turn-conversation.test.ts tests/providers/qwen-session-continuity.test.ts
# tests 316
# pass 316
# fail 0

npm run build
# passed

git diff --check
# passed with CRLF warnings only
```

Round D2.2 task: typed child handoff into parent state

Precondition:

- D2.1 accepted.

Purpose:

- Complete the missing half of parent/child state separation.
- A child provider session may carry raw tool/subagent transcript internally, but the parent provider state must receive only a bounded typed artifact.

Allowed write set:

- `src/main/proxy/sessionBoundary.ts`
- `src/main/proxy/forwarder.ts`
- `src/main/proxy/services/contextManagementService.ts` only if the handoff needs to reuse existing bounded summaries
- focused tests under `tests/providers/`, `tests/routes/`, or `tests/services/`
- this spec file for status notes only

Acceptance:

- Add/export a typed `ChildSessionHandoff` representation or equivalent pure builder.
- When a child session reaches a settled result, parent state can be updated with the typed handoff without copying raw child `assistant.tool_calls` / `tool` output.
- Child raw provider state remains on the child key.
- Parent handoff content is bounded and includes status, summary, evidence/artifact references, and next action when available.
- Tool catalog identity remains stable across child and parent.
- No-loss tests still prove tool definitions and active tool metadata survive.
- Do not optimize prompt rendering yet; keep full/tool-ready behavior conservative until live proof passes.

Verification:

```powershell
node --test tests/providers/qwen-session-continuity.test.ts tests/routes/openai-session-identity.test.ts tests/services/contextManagement-*.test.ts tests/providers/context-tool-metadata.test.ts
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts tests/providers/multi-turn-conversation.test.ts tests/providers/qwen-session-continuity.test.ts
npm run build
git diff --check
```

Round D2.2 result:

- Worker: Rawls.
- Status: accepted for deterministic validation.
- Implementation:
  - Added typed `ChildSessionHandoff` plus pure builders in `src/main/proxy/sessionBoundary.ts`.
  - Added a pure provider-state write plan so child-session primary writes, optional fallback mirroring, and parent handoff writes are explicit and testable.
  - `forwarder.ts` now stores settled child handoff artifacts on the parent provider-state key while keeping raw child provider session state on the child key.
  - Handoff evidence is structural and bounded:
    - parent session reference
    - tool call identity references
    - artifact/path references
    - optional inferred next action
  - Raw child `assistant.tool_calls` / `tool` transcript content is not copied into the parent handoff payload.
- Verification passed:

```powershell
node --test tests/providers/qwen-session-continuity.test.ts tests/routes/openai-session-identity.test.ts tests/services/contextManagement-*.test.ts tests/providers/context-tool-metadata.test.ts
# tests 86
# pass 86
# fail 0

node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts tests/providers/multi-turn-conversation.test.ts tests/providers/qwen-session-continuity.test.ts
# passed

npm run build
# passed

git diff --check
# passed with CRLF warnings only
```

- Remaining note:
  - This round wires the bounded child-to-parent state artifact but still keeps prompt refresh behavior conservative.
  - Live validation remains D3 work and should verify that the parent can actually consume the handoff well enough to avoid long-loop regressions.

Round D2.2c result:

- Worker: Rawls.
- Status: accepted for deterministic validation.
- Implementation:
  - D2.2b fixed the Qwen streaming gap by exposing a safe final assistant snapshot from `QwenStreamHandler`.
  - Qwen stream `stop` results can now produce a bounded parent handoff; stream `tool_calls` results do not produce a settled handoff.
  - `forwardQwen` now consumes stored `childSessionHandoff` on normal parent turns by injecting a bounded handoff state system message into the Qwen request path.
  - Injected parent state is restricted to typed handoff fields only: `kind`, `status`, `summary`, `evidence`, `artifacts`, `nextAction`, and `errorClass`.
  - Child `tool_child` / `subagent_child` turns do not consume the parent handoff.
  - Once a parent turn consumes the handoff, the next provider-state save clears `childSessionHandoff` to avoid repeated replay.
- Verification passed:

```powershell
node --test tests/providers/qwen-session-continuity.test.ts tests/routes/openai-session-identity.test.ts tests/services/contextManagement-*.test.ts tests/providers/context-tool-metadata.test.ts
# tests 92
# pass 92
# fail 0

node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts tests/providers/multi-turn-conversation.test.ts tests/providers/qwen-session-continuity.test.ts
# tests 325
# pass 325
# fail 0

npm run build
# passed

git diff --check
# passed with CRLF warnings only
```

Round D3 task: live probe integration

Precondition:

- D2.1 and D2.2 deterministic tests pass.

Acceptance:

- Long OpenCode probe advances past repeated read/bash loops.
- Event stream contains the required skill invocation and multi-turn tool use.
- Parent provider context remains bounded in logs.
- Tool definitions remain available in both parent and child paths.

Round D3 live result:

- Status: failed, classified.
- Command:

```powershell
.\tests\agent-capability\verify-opencode-long-conversation.ps1 -Model "qwen/Qwen3-Max" -LogPath .\dev-d3.log
```

- Probe output:
  - Warmup isolation passed.
  - Six OpenCode warmup turns completed in session `ses_0a49d0e87ffe8xId2hAtefCxvE`.
  - `dev-d3.log` proves compaction before the final tool probe with `summary=True` and `sliding=False`.
  - Final probe timed out before required artifacts: no `.agent-probe/long-step-1.txt`, no final result artifact.
- Event evidence:
  - The final probe loaded the `long-conversation-probe` skill.
  - The first `read` of `tests/agent-capability/input.txt` completed.
  - The model then repeated the same read instead of advancing to the required bash/artifact step.
- Log evidence:
  - Tool definitions did not regress: `Tool transform trace` continued to show `planMode:"managed"`, `toolCount:10`, `catalogSource:"current_request"`, and `injected:true`.
  - Raw old tool history did not obviously resurrect: context management repeatedly reduced long histories to bounded windows such as `40 -> 11`, `42 -> 11`, `44 -> 11`, `48 -> 11`; latest tool call/result preservation stayed bounded.
  - `server_summary` boundary appeared 20 times.
  - `tool_child` boundary appeared 0 times.
- Classification:
  - Not a warmup contamination failure.
  - Not a tool-definition loss failure.
  - Not a deterministic D2.2 handoff-builder failure.
  - Not evidence that child handoff is harmful.
  - The live OpenCode request shape is not being classified as `tool_child`, so the D2.1/D2.2 child-session architecture is not yet exercised in the real probe.

Round D3.1 task: OpenCode tool-child boundary diagnosis and derivation fix

Classification: architecture-level routing fix

Owner: worker subagent for implementation; main agent for review and live classification.

Purpose:

- Make the route/session layer recognize the actual OpenCode post-tool request shape.
- Ensure active tool workflows enter a grouped `tool_child` provider session instead of repeatedly using `server_summary` / parent state.
- Preserve the D2 rule: one child provider session per contiguous tool workflow, not one session per individual tool result.

Allowed write set:

- `src/main/proxy/routes/openaiSession.ts`
- `src/main/proxy/routes/chat.ts` only for structured diagnostics if needed
- `src/main/proxy/sessionBoundary.ts` only for pure helpers if the boundary contract needs them
- `tests/routes/openai-session-identity.test.ts`
- `tests/providers/qwen-session-continuity.test.ts`
- this spec document for worker status notes only

Non-goals:

- Do not change provider adapters.
- Do not change `ToolCallingEngine` prompt ownership.
- Do not tune prompt refresh speed/quality policy yet.
- Do not relax the long-conversation probe.
- Do not touch renderer/icon files.

Required diagnostics:

- Add structure-only logging around OpenAI session identity derivation.
- The log must include boundary reason, latest non-system role, tool-role count, assistant `tool_calls` count, compact/server-summary marker presence, subagent marker presence, and any recognized OpenCode/managed tool-result marker class.
- The log must not include raw message content, tool arguments, file contents, or tool output.

Required deterministic tests:

- Native OpenAI `assistant.tool_calls -> tool` history still derives grouped `tool_child`.
- Repeated tool results in the same contiguous workflow reuse the same `tool_child` identity.
- A settled assistant answer or new parent/user decision exits the tool workflow and returns to normal/server-summary behavior.
- An OpenCode-like post-tool shape that does not use native `role:"tool"` but does contain the actual recognized tool-result marker derives grouped `tool_child`.
- Tool-definition no-loss tests remain green.

Verification:

```powershell
node --test tests/providers/qwen-session-continuity.test.ts tests/routes/openai-session-identity.test.ts tests/services/contextManagement-*.test.ts tests/providers/context-tool-metadata.test.ts
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts tests/providers/multi-turn-conversation.test.ts tests/providers/qwen-session-continuity.test.ts
npm run build
git diff --check
```

Round D3.1 result:

- Worker: Codex subagent.
- Status: accepted for deterministic validation.
- Implementation:
  - Added structure-only OpenAI session-identity diagnostics in `src/main/proxy/routes/openaiSession.ts` with boundary reason, latest non-system role, native tool counts, compact/subagent marker presence, and recognized tool-result marker class.
  - Expanded grouped `tool_child` derivation so a credible OpenCode-style post-tool marker can continue the same workflow even when the latest non-system role is not native `tool`.
  - Preserved boundary priority so an active grouped tool workflow is not downgraded to `client_compact` merely because compact/summary markers are also present.
  - Tightened `decideProviderConversationStateWriteTargets` so a `server_summary` fork created from child provider ancestry keeps child write semantics and does not mirror raw child state back to fallback/main state.
- Verification passed:

```powershell
node --test tests/routes/openai-session-identity.test.ts tests/providers/qwen-session-continuity.test.ts tests/services/contextManagement-*.test.ts tests/providers/context-tool-metadata.test.ts
# tests 96
# pass 96
# fail 0

node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts tests/providers/multi-turn-conversation.test.ts tests/providers/qwen-session-continuity.test.ts
# tests 327
# pass 327
# fail 0

npm run build
# passed

git diff --check
# passed with existing CRLF warnings only
```

- Residual note:
  - Live prompt-budget diagnostics can still report `server_summary` after the forwarder summary fork because D3.1 did not broaden scope into forwarder prompt-budget classification. This round preserves child ancestry/provider-key semantics and child-only state writes for that forked path, but the main agent should still validate the live probe before claiming end-to-end success.

### Node E: Prompt Refresh Optimization

Classification: architecture-level performance/quality

Precondition:

- Node D prevents raw child transcript accumulation.

Acceptance:

- New/forked/repair/tool-active turns receive full or tool-ready contracts.
- Stable ordinary continuations may use digest/minimal prompt material.
- Prompt budget policy changes request rendering only behind tests.
- Tool-definition no-loss tests pass.
- Live logs explain every refresh mode.

## Verification Gates

Focused no-loss gate:

```powershell
node --test tests/providers/context-tool-metadata.test.ts tests/providers/qwen-session-continuity.test.ts tests/services/contextManagement-*.test.ts
```

Tool/provider regression gate:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts tests/providers/multi-turn-conversation.test.ts tests/providers/qwen-session-continuity.test.ts
```

Build gate:

```powershell
npm run build
```

Live long-context gate:

```powershell
npm run dev:win 2>&1 | Tee-Object -FilePath .\dev.log
.\tests\agent-capability\verify-opencode-long-conversation.ps1 -Model "qwen/Qwen3-Max" -LogPath .\dev.log
```

## Dirty Worktree Notes

Known unrelated dirty files to avoid:

- `src/renderer/src/index.css`
- `src/renderer/src/components/layout/MainLayout.tsx`
- `.claude/worktrees/tool-contract-refactor`

Do not stage, edit, or revert those unless the user explicitly asks.

## Current Next Step

Proceed to Node D3.1 OpenCode tool-child boundary diagnosis and derivation fix:

- D2.1 proved grouped native tool-child provider keys and child-only state writes.
- D2.2 proved typed child-to-parent handoff deterministically.
- D3 live showed `tool_child` was never selected in the actual OpenCode/Qwen long probe.
- The next worker must first make this boundary visible and testable, then implement the smallest derivation fix for the real OpenCode post-tool request shape.
- Preserve all deterministic no-loss tests, especially tool definition retention after compaction and active tool workflows.
- Keep prompt refresh optimization deferred to Node E.
