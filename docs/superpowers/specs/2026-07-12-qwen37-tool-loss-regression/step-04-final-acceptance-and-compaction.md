# Step 04: Final Acceptance And Compaction

Status: Accepted
Owner: main session

## Goal

Review the completed worker step, run or confirm final gates, update the batch spec with outcomes, and compact both subagent and main-session state.

## Acceptance Checklist

- Step 01 trace safety accepted.
- Step 02 deterministic Qwen preservation accepted.
- Step 03 live low-threshold compaction probe accepted.
- Full deterministic gate recorded: `260/260` pass.
- Live Qwen probe command recorded with `ContextMaxMessages=4` and `SummaryKeepRecentMessages=3`.
- Raw event artifact paths recorded.
- `dev.log` trace evidence recorded.
- Residual risks and deferred follow-ups recorded.

## Final Main-Session Compression Template

```text
Goal:
- current target

Done:
- what changed

Verified:
- commands or evidence

Open:
- remaining task or risk

Next:
- exact next step
```
