# Current Spec Consolidated Plan

Date: 2026-07-12
Workspace: `E:\Chat2API`
Purpose: consolidate the active Chat2API agent-tooling specs, mark stale plans, and give one execution order for the next implementation passes.

This document does not replace the older specs as evidence. It is the current index and control plan. When an older document has a newer "Acceptance Run" section, the newest acceptance section wins over the document's original snapshot table.

## Current Read

The spec set is not fully stale, but the original 2026-07-10 acceptance dossier is outdated in two important ways:

1. `2026-07-11-p0-p1-followup-plan.md` later reached **ACCEPTED** for DeepSeek swallow, Qwen intermittent malformed output, and context-management ordering/compaction.
2. `2026-07-11-p3-claude-code-compact-tool-loss-plan.md` later reached **ACCEPTED for the current Qwen scope** after the real Claude Code compact probe was stabilized.

The active unfinished work is now narrower:

1. GLM long OpenCode probe: new bucket `skill_result_then_final_marker_without_required_tools`.
2. Provider expansion: Z.ai, Kimi, MiniMax.
3. Account pool rotation.
4. Optional future broadening of P3 beyond Qwen to GLM or other models.

DeepSeek live verification is intentionally not required right now per the latest user scope.

## Spec Status Table

| Spec | Current status | How to use it now |
|---|---:|---|
| `2026-07-10-agent-tooling-stability-spec.md` | Active architecture baseline | Keep as the root invariant document for P0-P3 and provider behavior. |
| `2026-07-10-project-acceptance-dossier.md` | Partially stale | Use for historical acceptance standards only. Its snapshot predates later accepted follow-ups. |
| `2026-07-10-p0-swallowed-replies-writing-plan.md` | Closed / historical | Original P0 plan. Do not implement from it directly unless P0 is reopened. |
| `2026-07-10-p1-tool-mcp-reliability-writing-plan.md` | Closed / historical | Original P1 main plan. Superseded by v2 and follow-ups. |
| `2026-07-10-p1-tool-availability-drift-rework-plan.md` | Rejected / historical | Keep as failure evidence. Do not implement v1. |
| `2026-07-10-p1-rework-v2-plan.md` | Accepted | Prompt-embedded catalog promotion is part of the current baseline. |
| `2026-07-10-p2-angle-bracket-leakage-writing-plan.md` | Accepted | Keep regression tests and invariants; no active work. |
| `2026-07-10-p3-claude-code-compat-writing-plan.md` | Accepted for short/session basics, extended by compact plan | Use only with the compact-tool-loss follow-up for current P3 work. |
| `2026-07-11-p0-p1-followup-plan.md` | Accepted | DeepSeek/Qwen/compaction ordering follow-up is closed. Keep gates as regression baseline. |
| `2026-07-11-p0-p1-summary-contamination-plan.md` | Accepted for Qwen; GLM follow-up still open | Sanitizer, drift subkinds, and Qwen long probe are baseline. Continue only the GLM long-agent bucket. |
| `2026-07-11-p3-claude-code-compact-tool-loss-plan.md` | Accepted for current Qwen scope | Current P3 compact issue is closed for Qwen. Broader model matrix is optional future work. |
| `2026-07-11-p4-provider-expansion-writing-plan.md` | Active, not started | Next large feature track for Z.ai, Kimi, MiniMax. |
| `2026-07-11-p5-account-pool-rotation-writing-plan.md` | Active, not started | Long-term operational safety track; can start after or alongside P4 scaffolding. |

Older May/June design docs are background material:

- `2026-06-30-chat2api-tool-runtime-litellm-design.md`
- `2026-06-30-tool-availability-catalog-design.md`
- `2026-07-01-mcp-client-integration-design.md`
- `2026-07-01-mcp-client-integration-plan.md`
- `2026-07-07-qwen-tool-probe-root-cause-report.md`
- `2026-07-07-tool-calling-fix-guide.md`

Use them for architecture and root-cause context, not as the current execution queue.

## Current Baseline Invariants

These are still binding:

- INV-001 Single Ownership: `ToolCallingEngine` owns managed prompt injection. Provider adapters must not import injection helpers.
- INV-002 Stateless Fallback: catalog resolution degrades through session/request/prompt/history/safe-empty paths instead of dropping straight to empty.
- INV-003 Delete = Risk: removing tool/message processing requires purpose and coverage proof.
- INV-004 Client Quirks Matrix: real clients matter, especially OpenCode and Claude Code.
- INV-005 Config-vs-History Split: tools, MCP definitions, system prompts, and catalogs must not be summarized as narrative history.
- INV-006 Provider Parity Gate: every managed provider must prove tool use with the same real OpenCode event shape before being called compatible.
- INV-007 to INV-010 Account Pool invariants: sticky session affinity, bounded cross-account retry, secret-safe observability, and policy-respecting cooldown.
- INV-011 Anthropic Tool Catalog Continuity: Claude Code compact sessions must keep or restore an authoritative tool catalog.

## Accepted Baseline Gates

Keep these commands as regression gates for shared tool-runtime changes:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

For summary/context changes:

```powershell
node --test tests/services/*.test.ts tests/providers/deepseek-tool-calling.test.ts tests/tool-runtime/integration/deepseek-multi-turn.test.ts
```

For Claude Code Anthropic compact changes:

```powershell
node --test tests/routes/anthropic-compatibility.test.ts tests/routes/anthropic-catalog-continuity.test.ts tests/routes/anthropic-compact-tool-history.test.ts tests/tool-calling/anthropic-catalog-drift.test.ts
```

Accepted real-probe evidence already recorded:

- Qwen OpenCode long-conversation summary/compaction: accepted.
- Qwen Claude Code compact continuity: accepted for current scope.
- DeepSeek base follow-up: accepted, but latest user scope says do not continue DeepSeek verification for now.

## Active Work Item 1: GLM Long-Agent Reliability

Source: `2026-07-11-p0-p1-summary-contamination-plan.md`, section "GLM Follow-Up Re-Run: 2026-07-12".

Current state:

- GLM stream assembly bug for same `logic_id` incremental tails was fixed deterministically.
- Deterministic gates reported green:
  - `tests/providers/glm-tool-calling.test.ts`: 53/53 PASS
  - final tool-calling gate: 256/256 PASS
  - services/deepseek integration gate: 49/49 PASS
- Real GLM long OpenCode probe now fails differently:
  - skill `long-conversation-probe` loads
  - model immediately emits `LONG_CONVERSATION_PROBE_DONE`
  - no structured non-skill `read` / `bash` tool events occur
  - `.agent-probe/long-step-1.txt` is missing
- New bucket: `skill_result_then_final_marker_without_required_tools`.

Next plan:

1. Harden the long probe so the final marker literal is not visible inside the skill result before required tools run.
2. Keep verifier classification for `skill_result_then_final_marker_without_required_tools`.
3. Re-run GLM long probe once after hardening.
4. If GLM still skips required tools without seeing the literal marker, investigate managed tool-following after `skill` `tool_result`.

Acceptance:

- GLM must produce real non-skill `read` and `bash` `tool_use` / `tool_result` events after the skill result.
- Long probe must create expected `.agent-probe/long-step-*` artifacts.
- Final marker must only appear after the required sequence.
- Do not count this as summary contamination unless logs show `summary_contamination` or fabricated tool inventory leakage.

## Active Work Item 2: P4 Provider Expansion

Source: `2026-07-11-p4-provider-expansion-writing-plan.md`.

Scope:

- Z.ai
- Kimi
- MiniMax

Execution order:

1. Add provider capability matrix entries as `experimental`.
2. Add deterministic adapter parity tests per provider.
3. Add or generalize provider matrix probe:

```powershell
.\tests\agent-capability\verify-opencode-provider-matrix.ps1 `
  -Models "zai/<model>","kimi/<model>","minimax/<model>" `
  -Runs 3
```

4. Run one provider at a time. Do not mix diagnosis across providers.

Provider-specific expectations:

- Z.ai: classify captcha/risk-control as `provider_risk_control`, not tool failure.
- Kimi: verify multi-stage stream ordering and cleanup timing.
- MiniMax: identify direct vs polling/stream response path and test the selected path.

Acceptance:

- Each accepted provider has deterministic provider-specific tests.
- Each accepted provider has 3 consecutive OpenCode capability probe passes.
- Blocked providers must have a typed blocked record, not an ambiguous failure.
- No adapter-level prompt injection.

## Active Work Item 3: P5 Account Pool Rotation

Source: `2026-07-11-p5-account-pool-rotation-writing-plan.md`.

This is a long-term operational track, not a tool parser fix.

Execution order:

1. Add account-pool data model and migration.
2. Add provider-aware account failure classifier.
3. Add `AccountPoolSelector` with sticky session affinity.
4. Add bounded cross-account retry, only before bytes are streamed.
5. Add diagnostics and UI state.
6. Add real OpenCode account-pool probe.

Acceptance:

- Multiple healthy accounts distribute across independent sessions.
- One long OpenCode/tool session sticks to one account unless a classified retry occurs.
- Risk-control/captcha/auth/quota outcomes update cooldown or terminal state.
- No raw credentials appear in logs, UI payloads, or probe artifacts.

Important ordering note:

- P5 can help P4 repeated probes avoid over-concentrating traffic, but P5 must not mask provider parser failures or tool-catalog drift. Parser/model-output failures are not account-retry candidates.

## Optional Future Work: Broader P3 Matrix

Current accepted P3 scope is Qwen Claude Code compact continuity.

Only reopen P3 if the user wants broader Claude Code model coverage:

- GLM through Claude Code compact
- MiniMax/Kimi/Z.ai through Claude Code once P4 accepts them
- additional Claude Code MCP/codegraph subsets

Do not reopen P3 merely because GLM OpenCode long probe fails. That is currently tracked under GLM long-agent reliability, not Anthropic catalog continuity.

## Recommended Execution Queue

1. **GLM long-probe hardening**: hide final marker literal and re-run the GLM long probe. This is the smallest active bug bucket and blocks clean confidence in GLM long sessions.
2. **P4 scaffold**: provider capability matrix + deterministic parity for Z.ai/Kimi/MiniMax.
3. **P4 one-provider real acceptance**: start with the provider that is easiest to run locally without risk-control, then repeat.
4. **P5 account pool data model + selector**: begin once provider runs become rate/risk-control constrained, or earlier if repeated probes are already hitting limits.
5. **P3 broadening only on demand**: current Qwen compact scope is accepted.

## Stale Or Misleading Statements To Ignore

- The 2026-07-10 dossier line saying P3 is held until follow-ups close is stale. Follow-up and Qwen P3 compact evidence have since landed.
- The original P0/P1 accepted statements are historical; the stronger truth is: original P0/P1 were reopened, then the 2026-07-11 follow-up accepted them again.
- The summary-contamination plan's original DeepSeek A/B requirement was narrowed by user instruction; current accepted live scope is Qwen, while DeepSeek is not being re-verified right now.
- GLM summary-contamination failure should not be treated as contamination unless the contamination subkind appears. The latest GLM failure is an early-final long-agent bucket.

## Handoff Rules For Implementing Agents

- Start from this consolidated document, then open the source spec named under the active work item.
- Add failing deterministic tests first when changing runtime behavior.
- Run the shared deterministic gate before real probes.
- Real probe acceptance must use raw event evidence, not final assistant text or model self-report.
- Do not push or commit without explicit user request.
- Do not edit old specs to rewrite history unless the task is explicitly an acceptance dossier update.
