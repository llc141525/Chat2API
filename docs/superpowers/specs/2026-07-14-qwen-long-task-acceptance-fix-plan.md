# Qwen Long Task Acceptance Fix Plan

Date: 2026-07-14
Branch: `codex/qwen-provider-session-continuity`
Owner model: main session plans/reviews; subagents execute bounded fixes.

## Current Verdict

Do not accept the current branch as complete.

The deterministic test layer is green, but the live long OpenCode probe still fails to complete the required task sequence. The provider-plugin/runtime documentation also overstates completion: plugin wrappers exist, but the main request path still uses provider-specific forwarder methods.

## Verified Baseline

Commands already run by the main session:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/*.test.ts tests/routes/*.test.ts tests/services/*.test.ts
# tests 566
# pass 566
# fail 0

& 'C:\Program Files\nodejs\npm.cmd' run build
# passed

git diff --check
# passed with CRLF / git-ignore warnings only
```

Live evidence from the latest available probe artifacts:

- `.agent-probe/opencode-long-final-events.ndjson` exists.
- `.agent-probe/long-summary.txt` does not exist.
- `.agent-probe/economy-metrics.json` does not exist.
- `dev.log` contains 62 `boundaryReason:"tool_child"` OpenAI session identity diagnostics.
- The final event stream contains `skill` and repeated `read` calls.
- The final event stream contains 0 `bash` calls.
- Therefore D3.1 boundary recognition improved, but the end-to-end long task still fails.

## Blocking Issues

### P0-1: Live Long Probe Still Loops On Read

Status: open

Evidence:

- The long probe loads `long-conversation-probe`.
- It completes the first `read tests/agent-capability/input.txt`.
- It then repeats the same `read` many times.
- It never runs the required `bash` step.
- No `long-summary.txt` is produced.

Likely contributing signal:

- Route/session identity now detects `tool_child`.
- Downstream Qwen prompt diagnostics still repeatedly show `sessionBoundaryReason:"server_summary"` and `promptRefreshMode:"full"` during the active tool loop.
- Context management keeps reducing very large histories to 11 messages, but the model still loses procedural progress.

Acceptance:

- The live long probe reaches the required bash/tool sequence and produces `.agent-probe/long-summary.txt`.
- The final assistant marker is exactly `LONG_CONVERSATION_PROBE_DONE`.
- The event stream proves the required skill invocation and multi-turn tool use.
- The event stream includes at least one `bash` call after the first `read`.
- Tool definitions remain present when tools are needed.
- Raw tool history remains bounded.

### P0-2: Prompt Budget Policy May Be Defeated By Server-Summary Forks

Status: open

Evidence:

- Logs show active tool workflow selection, but Qwen prompt budget repeatedly chooses `full` because the forwarded context is `server_summary`.
- Node E claims `tool_ready`, `digest`, and `minimal` modes are implemented, but the live active loop appears to stay on full refresh.

Acceptance:

- Deterministic tests cover a server-summary fork with active tool-child ancestry.
- Active tool workflow after summary fork receives a tool-ready contract rather than a full procedural reset unless a full refresh is explicitly required.
- Live logs explain prompt mode selection without raw content.

### P1-1: ProviderRuntime Is Still Coupled To Forwarder

Status: open

Evidence:

- `src/main/proxy/services/ProviderRuntime.ts` imports `ConversationState`, `getProviderConversationState`, `setProviderConversationState`, and `shouldUseProviderConversationFallback` from `forwarder.ts`.
- `forwarder.ts` imports `ProviderRuntime`.
- This is a circular dependency and not a true extraction of common runtime ownership.

Acceptance:

- Shared provider conversation state helpers live outside `forwarder.ts`.
- `ProviderRuntime` depends on the shared state module, not on `forwarder.ts`.
- `forwarder.ts` can use `ProviderRuntime` without cycle.
- Existing session continuity tests remain green.

### P1-2: Plugin Registry Cannot Be Dynamically Imported In Plain Node

Status: open

Evidence:

```powershell
node --input-type=module -e "await import('./src/main/proxy/plugins/registry.ts')"
```

Failed with Electron / runtime import issues, including `src/main/lib/challenge.ts` importing `{ app }` from `electron`.

Additional signal:

- Some plugin imports fail in plain Node because adapters import TypeScript-only symbols such as `Account` / `Provider` as runtime values.
- Current registry tests mostly use source-string checks, so they do not catch this.

Acceptance:

- Registry can be imported in the project test environment.
- Tests dynamically import registry and verify registered plugin ids.
- Electron-dependent plugins are lazy or guarded.
- Type-only imports are corrected where needed.

### P1-3: Qwen Delete-After-Chat Path Can Drop Parent Handoff

Status: open

Evidence:

- In `forwarder.ts`, Qwen stream and non-stream paths call `saveConversationState(..., parentHandoff)` only when `!deleteSessionCallback`.
- If delete-after-chat is enabled, the child handoff may not be persisted to parent state before the provider session is deleted.

Acceptance:

- Parent handoff is persisted regardless of delete-after-chat mode.
- Delete-after-chat still deletes provider session when configured.
- Tests cover both stream and non-stream save/delete ordering.

### P2-1: Economy Metrics Are Claimed But Missing

Status: open

Evidence:

- Master status claims `economy-metrics.json` is written.
- Latest `.agent-probe` has no `economy-metrics.json`.

Acceptance:

- The verifier writes economy metrics on both pass and fail paths.
- Metrics include boundary reason counts, prompt mode counts, context reduction events, and tool-count availability rate.

### P2-2: Plugin Tests Are Too Source-Text Heavy

Status: open

Evidence:

- `tests/providers/plugin-registry.test.ts` mostly checks file contents.
- Source checks did not catch dynamic import failure.

Acceptance:

- Keep lightweight source checks only as supplementary guards.
- Add runtime import tests for registry and safe plugins.
- Add at least one integration test proving a plugin can build/parse through real exported APIs.

### P2-3: Master Status Overstates Completion

Status: open

Evidence:

- `2026-07-13-qwen-provider-master-status.md` says `Status: COMPLETE`.
- Live probe still fails.
- Provider plugin architecture is not the main request path.

Acceptance:

- Master status reflects actual accepted vs pending nodes.
- "COMPLETE" is reserved for deterministic + live acceptance.

### P3-1: Unclassified Deleted Chinese Files Remain In Worktree

Status: open

Evidence:

- `claudecode 对话.md` is deleted.
- `部分日志.txt` is deleted.
- These were not included in the unrelated UI/icon commit.

Acceptance:

- Decide whether these deletions are intentional and relevant.
- Commit separately only if intentional, otherwise restore with user approval.

## Repair Queue

### Round R1: Stop The Live Read Loop

Priority: P0

Owner: worker subagent

Status note:

- 2026-07-14 worker patch: added deterministic coverage for `server_summary` + active tool continuation and narrowed prompt-budget policy so stable active tool chains prefer `tool_ready`, while fresh/identity/fingerprint/repair conditions still force `full` or `repair`.
- 2026-07-14 main verification: targeted tests, wide deterministic suite, and build passed, but the real Qwen long probe still failed. Evidence: `opencode-long-final-events.ndjson` shows `skill -> read -> read...` with no `bash`, and no `.agent-probe/long-step-1.txt`.
- Refined root cause: active skill handoff extracted only single numbered instruction lines. The real probe's step 2 is multiline: the numbered line says `Use the bash tool to run:` and the exact command is on the following indented code line, so the model likely sees an incomplete next step.

Hypothesis:

The model is no longer failing because tools or `tool_child` are missing. It is failing because active tool workflow progress handoff is not precise enough after compaction. In particular, multiline skill steps must be preserved as bounded instruction blocks so the next required `bash` command survives the `server_summary -> tool_ready` boundary.

Allowed write set:

- `src/main/proxy/promptBudgetPolicy.ts`
- `src/main/proxy/forwarder.ts`
- `src/main/proxy/sessionBoundary.ts`
- `src/main/proxy/services/contextManagementService.ts`
- `tests/tool-calling/prompt-budget-policy.test.ts`
- `tests/providers/qwen-session-continuity.test.ts`
- `tests/services/contextManagement-*.test.ts`
- `tests/agent-capability/verify-opencode-long-conversation.ps1` only for metrics/fail evidence, not to weaken assertions
- this document for status notes

Non-goals:

- Do not relax live probe requirements.
- Do not remove tool-definition no-loss checks.
- Do not rewrite plugin architecture in this round.
- Do not touch renderer/icon files.

Verification:

```powershell
node --test tests/tool-calling/prompt-budget-policy.test.ts tests/providers/qwen-session-continuity.test.ts tests/services/contextManagement-*.test.ts tests/providers/context-tool-metadata.test.ts
node --test tests/tool-calling/*.test.ts tests/providers/*.test.ts tests/routes/*.test.ts tests/services/*.test.ts
& 'C:\Program Files\nodejs\npm.cmd' run build
git diff --check
```

Additional R1 acceptance:

- Deterministic tests must model the real multiline step 2 shape from `long-conversation-probe`.
- The Qwen assembled prompt after a completed `read tests/agent-capability/input.txt` must include the exact next `bash` command evidence, including `.agent-probe/long-step-1.txt`.
- The handoff must remain bounded and must not copy full raw tool outputs.

Live acceptance after main review:

```powershell
npm run dev:win 2>&1 | Tee-Object -FilePath .\dev.log
.\tests\agent-capability\verify-opencode-long-conversation.ps1 -Model "qwen/Qwen3-Max" -LogPath .\dev.log
```

### Round R2: ProviderRuntime Cycle And Registry Runtime Import

Priority: P1, after R1 or in parallel only if write scopes do not overlap.

Owner: worker subagent

Scope:

- Move provider state helpers out of `forwarder.ts`.
- Remove `ProviderRuntime -> forwarder.ts` dependency.
- Make registry dynamically importable in Node tests.
- Replace source-only plugin registry tests with runtime import coverage where safe.

### Round R3: Qwen Handoff Save/Delete Ordering

Priority: P1

Owner: worker subagent

Scope:

- Persist handoff regardless of delete-after-chat callback.
- Preserve deletion behavior.
- Add stream and non-stream tests.

### Round R4: Economy Metrics And Documentation Truthfulness

Priority: P2

Owner: worker subagent or main direct doc update.

Scope:

- Ensure metrics are written on pass and fail.
- Update master status from COMPLETE to actual current status until live probe passes.

## Main-Session Acceptance Rules

The main session must not accept completion until all are true:

- Deterministic regression suite passes.
- Build passes.
- `git diff --check` passes.
- Live long probe passes and produces required artifacts.
- Plugin/runtime claims in docs match actual architecture.
- No unrelated dirty files are mixed into the architecture commit.
