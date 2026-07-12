---
name: chat2api-main-subagent-session
description: Use when one Codex session should act as the main agent for planning, writing plans, acceptance, and queue control while delegating bounded execution work to reusable subagents in the same project.
---

# Chat2API Main + Subagent Session

Use this skill when one session should keep both roles aligned:
- main agent for planning, acceptance, prioritization, and final judgment
- subagents for bounded execution work

This workflow is designed for Chat2API Manager and assumes the repository rules in `AGENTS.md` are binding.

## Recommended Setup

- Main session: `gpt-5.5` with medium reasoning effort
- Subagent: `gpt-5.4` with low reasoning effort for scoped execution
- Default pattern: main session plans and accepts, subagent executes
- Compact: after each completed round or milestone, not after every tiny action

Use compact when:
- a subtask is finished
- a review round is finished
- context has grown noticeably

Do not compact away:
- acceptance criteria
- the current writing plan
- failed attempts that explain the current approach
- open risks
- exact commands still needed for final validation

## Role Split

Main session owns:
- clarify goal
- read code before committing to a plan
- define acceptance criteria
- write the `writing plan`
- maintain the task queue
- choose scope and order
- decide tradeoffs
- delegate bounded tasks
- review results
- decide whether to continue, revise, or accept
- decide when to enter `root-cause mode`
- communicate with the user

Subagent owns:
- execute one bounded task
- inspect only needed local context
- make the smallest correct change
- run focused verification
- return a compact handoff

## Start Condition

Before the user says to start executing the plan, the main session should only:
- inspect code and local context
- define acceptance criteria
- write or refine the `writing plan`
- build or reorder the task queue

After the user says to start executing the plan, the main session enters the execution loop below.

## Planning Model

Use `superpowers`-style writing plans as the default planning method.

Always maintain two levels of planning:

- `batch plan`: the current group of tasks, priority order, what is intentionally deferred, and batch acceptance
- `task plan`: the current task's scope, root-cause hypothesis, files or modules in play, verification, and rollback or risk notes

The main session should read real code before writing or revising these plans.

## Queue Model

The main session may hold multiple queued tasks at once.

Queue rules:
- keep one current task in focus
- keep other tasks parked with priority and dependency notes
- merge duplicates when a fix covers more than one queued bug
- delete stale tasks whose repro or need no longer exists
- refresh queue order after every completed round

## Main Session Workflow

Follow this loop:

1. Read code and restate the current goal and success conditions.
2. Write or update the `batch plan` and `task plan`.
3. Select the highest-value queued task.
4. Decide whether the task should stay local or go to a subagent.
5. Execute or delegate the task.
6. Review results against acceptance criteria.
7. Compress the subagent handoff if a subagent was used.
8. Compress the main session round state.
9. Refresh the queue.
10. Continue until the current batch plan is complete.
11. Stop and wait for the user to define the next batch direction.

The main session should prefer:
- acceptance over implementation detail
- small scopes over open-ended delegation
- proof over intuition

## Execution Routing Rules

Default rule:
- execution work goes to a subagent

The main session may directly implement a task when:
- the fix is on the immediate critical path
- the change is small and can be solved immediately
- the task is tightly coupled to acceptance or planning context
- `root-cause mode` is active

Direct implementation by the main session should stay occasional, not routine.

## Delegation Rules

Use subagents only for concrete, self-contained tasks.

Good delegated tasks:
- add one targeted regression test in a named test file
- update one adapter or one parser module
- implement one bounded UI panel change
- run focused verification for one subsystem

Bad delegated tasks:
- rethink architecture
- audit the whole repo without a narrow question
- take over planning
- decide whether the feature is good enough to ship

When delegating code changes:
- assign clear file or module ownership
- remind the subagent it is not alone in the codebase
- tell it not to revert unrelated edits
- require a compact handoff with changed files and verification

## Subagent Reuse Policy

Prefer reusing an existing execution subagent instead of spawning a new one every round.

Default pattern:
- keep a small worker pool
- prefer a single reusable worker
- expand to more workers only for non-overlapping parallel tasks

Rebuild or replace a subagent only when:
- the platform cannot truly reuse the existing worker
- the worker context has become noisy or degraded
- the task type changed enough that reuse is counterproductive
- parallel execution is needed
- execution quality has clearly dropped across consecutive rounds

The main session is the only trusted long-lived memory holder.
Do not rely on subagents as the canonical source of project state.
Canonical state lives in:
- the current writing plan
- the queue state
- subagent compressions
- main-session compressions

## Subagent Execution Contract

The subagent must:
- restate the assigned task in one or two lines
- inspect only relevant files or symbols
- implement directly instead of over-planning
- preserve behavior outside the scoped task
- verify the change with the smallest useful test
- escalate back if scope or risk expands

The subagent must not:
- redefine the task
- silently broaden scope
- remove unrelated code without proof
- declare final acceptance

## Root-Cause Mode

`root-cause mode` is a temporary main-session takeover for diagnosis or repair.

Enter `root-cause mode` when:
- two rounds in a row produced no meaningful progress
- subagent output fails acceptance more than once for the same task
- the bug appears to cross module boundaries
- a core invariant from `AGENTS.md` may be at risk
- the current hypothesis is weak and needs direct code-level re-evaluation

While in `root-cause mode`, the main session should:
- inspect code directly
- challenge the current hypothesis
- narrow the true failure mechanism
- either fix the issue directly or produce a stronger task plan for the next worker round

Exit `root-cause mode` once the task is unblocked or a sharper execution task can be delegated.

## Repository-Specific Guardrails

Always preserve these invariants:
- `ToolCallingEngine` is the single owner of tool prompt injection.
- Session-dependent tool resolution must degrade through a stateless fallback path.
- Multi-turn assistant `tool_calls` and `tool_call_id` metadata must survive context processing.
- Built-in provider changes must stay synchronized between `src/main/providers/builtin/` and `src/main/store/types.ts`.

For risky deletions:
- if the original purpose cannot be proven equivalent elsewhere, keep the code and mark uncertainty explicitly

## Verification Policy

Every execution round should include verification unless truly blocked.

Preferred order:
1. targeted test
2. nearby regression
3. build or typecheck only if it adds signal

For tool-calling changes, prefer the deterministic gate first:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

For larger behavior changes, the main agent decides whether to run the final live probe:

```powershell
npm run dev:win 2>&1 | Tee-Object -FilePath .\dev.log
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "glm/GLM-5.2"
```

The main session should not accept large tool-calling changes unless both layers are accounted for.

## Compression Policy

Each completed round should produce up to two compressions:

1. `subagent compression`
   Use after a worker finishes.
   Capture what changed, what was verified, residual risk, and the exact review surface for the main session.

2. `main-session compression`
   Use after the main session finishes review for that round.
   Capture the updated queue, acceptance status, open risks, and the exact next task.

If the main session completed the task directly, only the `main-session compression` is required.

## Main-Session Compression Template

At the end of each round, compact using this shape:

```text
Goal:
- current target

Done:
- what changed

Verified:
- tests or commands run

Open:
- remaining task or risk

Next:
- exact next step for the next round
```

## Subagent Compression Template

Require subagents to return or be compressed into:

```text
Task:
- one-sentence restatement

Changed:
- files touched
- key behavior change

Verified:
- commands run
- what passed or failed

Risks:
- residual risk or `none`

Next:
- what the main agent should review or decide next
```

## One-Line Invocation Template

Use this skill as the session-level operating system. The main session uses `gpt-5.5` medium reasoning to read code, write the `writing plan`, manage the queue, accept work, and direct reusable `gpt-5.4` low-reasoning subagents for bounded execution. After each completed round, compress the subagent result, compress the main-session state, refresh the queue, and continue until the current batch plan is complete, then stop for the user's next direction.
