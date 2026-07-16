# Step 03: Low-Threshold Live Compaction Probe

Status: Accepted
Owner: reusable worker

## Goal

Strengthen the live OpenCode probe so it actually crosses low context-management thresholds and proves real tool execution after compaction/summary, not merely long tool use with protected messages.

## Problem With Current Evidence

The current low-threshold run with `ContextMaxMessages=4` and `SummaryKeepRecentMessages=3` produced real tool calls, but the context logs showed summary was not needed. Most messages were protected tool exchanges, so the run did not prove the bug is fixed after summary compaction.

## Files In Scope

Preferred:
- `tests/agent-capability/verify-opencode-long-conversation.ps1`
- `tests/agent-capability/long-conversation-prompt.md` or the nearest existing long-probe prompt/fixture files

Allowed if needed:
- `.opencode/skills/long-conversation-probe/SKILL.md`
- nearby probe fixture files under `tests/agent-capability/`

Do not edit runtime production code in this step unless the probe exposes a fresh implementation defect. Escalate first if production changes appear necessary.

## Required Probe Behavior

The probe must:

1. Run with `ContextMaxMessages=4` and `SummaryKeepRecentMessages=3`.
2. Force enough non-protected conversational turns to trigger an actual summary or sliding-window trim event.
3. Continue the same OpenCode session after that event.
4. Require a real non-skill tool call after the compaction evidence appears.
5. Save raw OpenCode events and local artifacts.
6. Fail if it only sees assistant self-report without real `tool_use` and `tool_result`.
7. Fail if logs do not show compaction/summary evidence for the probe request.

## Acceptance

- The updated probe fails clearly when no actual compaction/summary evidence appears.
- The updated probe passes only when raw event evidence includes real post-compaction non-skill tool use.
- The worker records exact commands, event counts, artifact paths, and the relevant `dev.log` trace evidence.
- If the live run cannot be completed due to provider/network instability, the worker must still land deterministic probe-logic changes and return the blocker separately.

## Handoff Required

Return a compact handoff:

```text
Task:
- ...

Changed:
- ...

Verified:
- ...

Risks:
- ...

Next:
- ...
```

## Accepted Evidence

Live command:

```powershell
powershell -ExecutionPolicy Bypass -File .\tests\agent-capability\verify-opencode-long-conversation.ps1 -Model "qwen/Qwen3.7-Max" -LogPath .\dev.log -TimeoutSeconds 240 -ContextMaxMessages 4 -SummaryKeepRecentMessages 3
```

Result:
- `CAPABILITY_PROBE_PASS`
- `LONG_CONVERSATION_PROBE_PASS`

Raw event evidence:
- `.agent-probe/opencode-long-events.ndjson`: combined warmup + final events
- `.agent-probe/opencode-long-final-events.ndjson`: final tool probe events only
- Final events: `33`
- Final `tool_use`: `10`
- Final non-skill `tool_use`: `9`
- Tool distribution: `skill=1`, `read=3`, `bash=6`

Log evidence:
- `Strategy summary trimmed`
- `Strategy slidingWindow trimmed 5 -> 4 messages`
- `Forwarder Context management applied`
- Qwen request assembly trace with `"hasManagedToolContract":true`
- Qwen request assembly trace with `"hasSummaryIsolationHeader":true`
