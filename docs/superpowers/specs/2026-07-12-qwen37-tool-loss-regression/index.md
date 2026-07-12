# Qwen 3.7 Tool Loss Regression Batch Plan

Date: 2026-07-12
Workspace: `E:\Chat2API`
Main-session role: plan, queue, acceptance, and compaction
Execution role: reusable subagent worker
Source documents:
- `docs/superpowers/specs/2026-07-12-current-spec-consolidated-plan.md`
- `docs/superpowers/specs/2026-07-11-p0-p1-summary-contamination-plan.md`

## Why This Batch Exists

The previous Qwen summary-contamination scope had been treated as accepted, but manual OpenCode testing with `qwen/Qwen3.7-Max` found a regression: tools work early, then after several turns the model claims it only has a current-time tool and cannot execute commands. The user's hypothesis is that the failure still correlates with context management thresholds. The requested reproduction threshold is intentionally low:

- context max messages: `4`
- summary keep recent messages: `3`

Acceptance must rely on real tool execution evidence, not assistant self-report. A run where the model says it can execute is not sufficient; raw OpenCode events must contain real non-skill `tool_use` / `tool_result` activity after the threshold is crossed.

## Current Evidence

Round 0 happened before the main/subagent workflow was corrected. It is preserved as work-in-progress and must be reviewed rather than silently trusted.

Observed implementation hypothesis:
- `ToolCallingEngine` did inject the managed tool prompt.
- Qwen request assembly previously collapsed multiple `system` messages using last-system-wins behavior.
- When summary/context messages came after the injected tool contract, the final Qwen request could lose the authoritative tool contract.
- This matches the reported symptom: later turns behave as if only a residual tool description survived.

Round 0 local changes already present:
- `src/main/proxy/toolCalling/ToolCallingEngine.ts`
- `src/main/proxy/adapters/qwen.ts`
- `src/main/proxy/services/contextManagementService.ts`
- `src/main/proxy/forwarder.ts`
- `tests/providers/qwen-request-routing.test.ts`
- `tests/agent-capability/verify-opencode-long-conversation.ps1`

Round 0 verification already reported:
- `node --test tests/providers/qwen-request-routing.test.ts` passed.
- `node --test tests/tool-calling/tool-engine.test.ts tests/providers/context-tool-metadata.test.ts` passed.
- Full deterministic tool-calling gate passed: `260/260`.
- A low-threshold live Qwen long run produced real `read` and `bash` tool events, but did not prove post-summary-compaction behavior because most messages were protected tool exchanges and the context service reported `summary_not_needed`.

## Batch Acceptance

This batch is accepted only when all are true:

1. Diagnostic trace logs exist for the key flows without dumping prompt bodies, secrets, cookies, or raw request/response bodies.
2. Deterministic Qwen regression coverage proves multiple `system` messages preserve both summary and authoritative managed tool contract under low-threshold context processing.
3. The live OpenCode probe can force an actual context compaction/summary event at low thresholds (`4` and `3`), then prove real non-skill tool execution still occurs afterward.
4. Final gates are recorded in the spec with exact commands and outcomes.
5. Subagent handoff and main-session compression are recorded after each completed step.

## Queue

| Step | File | Status | Owner |
|---|---|---:|---|
| 01 | `step-01-log-and-request-assembly-traces.md` | Accepted | Main acceptance |
| 02 | `step-02-qwen-system-message-preservation.md` | Accepted | Main acceptance |
| 03 | `step-03-low-threshold-live-compaction-probe.md` | Accepted | Reusable worker |
| 04 | `step-04-final-acceptance-and-compaction.md` | Accepted | Main acceptance |

## Deferred

- Redacting pre-existing verbose Qwen logs that dump serialized message details or response headers is a P2 follow-up unless it blocks this batch's safe trace requirement.
- GLM long-agent reliability remains in the consolidated plan but is not part of this Qwen regression batch.
- Provider expansion and account pool work stay parked until this batch is accepted or explicitly paused.

## Environment Notes

- `AGENTS.md` says CodeGraph should be preferred for structural queries, but this session currently has no exposed `codegraph_*` tools. The main session must not pretend CodeGraph was used.
- Existing subagent `Ampere` is the preferred reusable worker for Step 03.
- Existing explorer `Confucius` completed the log safety review and can be closed after its result is compressed.

## Subagent Compressions

### Confucius: Step 01 Log Safety Review

Task:
- Review newly added trace logs for safety and usefulness.

Changed:
- No files changed by the explorer.

Verified:
- New trace logs are metadata-only and do not print raw prompt bodies, credentials, cookies, tokens, authorization headers, or full request/response bodies.
- Trace coverage is sufficient to correlate Qwen compaction behavior with tool-contract presence.

Risks:
- Pre-existing Qwen diagnostics may still log serialized message detail, thinking snippets, parse-error snippets, or wholesale response headers. This is a P2 follow-up unless it blocks the current batch.

Next:
- Main session can accept Step 01 after checking it against the batch acceptance criteria.

### Ampere: Step 03 Low-Threshold Live Compaction Probe

Task:
- Strengthen the live OpenCode long-conversation probe so it forces same-session low-threshold compaction before requiring real non-skill tool use.

Changed:
- `tests/agent-capability/verify-opencode-long-conversation.ps1`
- Added same-session warmup turns using OpenCode `--session`.
- Added combined events and final-run-only events artifacts.
- Final tool validation now uses `.agent-probe/opencode-long-final-events.ndjson`.
- Probe fails before the final tool run if no compaction evidence appears.

Verified:
- PowerShell parse OK.
- Live command passed:

```powershell
powershell -ExecutionPolicy Bypass -File .\tests\agent-capability\verify-opencode-long-conversation.ps1 -Model "qwen/Qwen3.7-Max" -LogPath .\dev.log -TimeoutSeconds 240 -ContextMaxMessages 4 -SummaryKeepRecentMessages 3
```

- Output markers: `CAPABILITY_PROBE_PASS`, `LONG_CONVERSATION_PROBE_PASS`.
- Event counts: combined events `51`, final events `33`, final `tool_use` `10`, final non-skill `tool_use` `9`.
- Final tool distribution: `skill=1`, `read=3`, `bash=6`.
- `dev.log` includes `Strategy summary trimmed`, `Strategy slidingWindow trimmed 5 -> 4 messages`, `Forwarder Context management applied`, and Qwen request assembly with `"hasManagedToolContract":true` plus `"hasSummaryIsolationHeader":true`.

Risks:
- The live probe is slower because it adds warmup model calls and depends on OpenCode `--session` continuation behavior.

Next:
- Main session accepted the worker result and recorded the final batch status.

## Main-Session Compression

Goal:
- Fix and verify Qwen 3.7 OpenCode tool-loss regression after low-threshold context management.

Done:
- Added trace coverage for context management, tool transform planning, Qwen request assembly, and runtime injection decisions.
- Changed Qwen request assembly to preserve multiple `system` messages instead of keeping only the last one.
- Changed managed prompt injection to append the authoritative tool contract to the last string `system` message.
- Added deterministic Qwen low-threshold summary regression tests.
- Hardened the live OpenCode long-conversation probe to force same-session compaction before requiring final real tool execution.
- Registered this regression batch in the consolidated active plan.

Verified:
- `node --test tests/providers/qwen-request-routing.test.ts` passed in Round 0.
- `node --test tests/tool-calling/tool-engine.test.ts tests/providers/context-tool-metadata.test.ts` passed in Round 0.
- Full deterministic gate passed in main acceptance: `260/260`.
- Live Qwen low-threshold probe passed with context max messages `4` and summary keep recent messages `3`.
- Final raw OpenCode events contain real non-skill tool use: `read=3`, `bash=6`.

Open:
- P2 follow-up: review pre-existing verbose Qwen logs for raw message/header leakage.
- Runtime risk: live probe is provider-dependent and slower due to warmup turns.

Next:
- Return to the user with the accepted batch summary, then wait for the next batch direction.
