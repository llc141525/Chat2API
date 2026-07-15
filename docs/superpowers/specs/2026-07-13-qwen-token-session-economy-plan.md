# Qwen/GLM Token and Web Session Economy Plan

Date: 2026-07-13
Scope: Chat2API long-context provider-session architecture

## Purpose

This document defines a practical compromise for reducing prompt tokens and reducing disturbance to provider web sessions while preserving tool reliability.

The goal is not to minimize tokens at all costs. The goal is to keep long agent tasks stable:

- main conversation stays coherent
- provider web sessions are not created for every sentence
- tool definitions do not disappear
- compact really reduces context
- tool and subagent work does not flood the parent session

## Problem Summary

The old architecture effectively paid the highest cost in both directions:

- each request could create or behave like a fresh provider session
- every turn had to resend system prompt, tool definitions, skill instructions, and long history
- tool results were carried inside the main conversation
- compact could summarize text but raw tool history still came back
- provider website history could accumulate many noisy sessions

The desired architecture is a middle path:

- reuse stable main sessions for ordinary conversation
- fork provider sessions only at meaningful boundaries
- run tool/subagent work in bounded child sessions
- return compact typed handoff artifacts to the parent session
- refresh full tool contracts only when necessary

## Session Types

### Main Session

Use for normal user conversation and high-level task decisions.

Expected behavior:

- reuse the same provider conversation identity during ordinary continuation
- do not create a new provider session for every user message
- after compact, fork to a new provider session seeded with summary
- keep the same logical tool catalog identity across compact

Benefit:

- avoids website-side session explosion
- preserves provider memory for normal dialogue
- avoids resending unnecessary history on every turn

Risk:

- if the main session keeps raw tool transcripts, it still grows too large

### Compact Session

Use when context is summarized.

Expected behavior:

- produce a bounded summary
- fork a new provider conversation session
- send the summary into the new provider session
- preserve the same tool catalog key
- refresh the full tool contract on the first request after compact

Benefit:

- compact becomes real compression, not just a prompt rewrite
- old provider memory stops influencing the new turn

Cost:

- creates one new provider-side web session per compact epoch
- first post-compact request is more expensive because it should refresh contract material

### Tool Child Session

Use for tool-heavy workflows.

Expected behavior:

- do not create a new child session for every single tool result
- create or reuse one tool child session per contiguous tool workflow
- the child session may see raw read/grep/bash/tool outputs
- the parent session receives only a compact typed handoff
- the tool catalog key remains the same as the parent logical task

Recommended grouping:

- one child session for a chain such as `read -> grep -> bash -> read`
- end the child session when a settled assistant answer or parent decision is reached
- avoid one provider session per individual `tool` message

Benefit:

- parent prompt stays small
- raw tool output does not contaminate main provider memory
- provider-side single-conversation tool-call limits are less likely to be hit

Cost:

- creates extra provider sessions during tool-heavy tasks
- child session cleanup or expiry policy becomes important
- child handoff must be accurate enough for the parent to continue

### Subagent Child Session

Use for delegated task/subagent work.

Expected behavior:

- one provider child session per subagent run
- child does its own exploration and tool use
- parent receives a typed handoff, not the raw transcript
- child provider session may be deleted or left to expire after handoff

Benefit:

- parent does not inherit child grep/read/bash noise
- child failures can be summarized instead of poisoning parent context

Cost:

- each subagent run may create a provider web session
- handoff quality becomes a correctness boundary

## Prompt Refresh Modes

Use these modes to balance speed, token cost, and reliability.

### Full

Send:

- base system prompt
- full active tool contract
- active skill instructions if required
- current summary or compact state
- recent user/task context

Use when:

- new provider session
- after compact
- tool child starts
- subagent child starts
- account/model/provider changed
- tool catalog fingerprint changed
- recent malformed tool call or schema failure occurred

Benefit:

- highest reliability
- prevents tool definition loss

Cost:

- slowest and largest prompt

### Tool Ready

Send:

- compact current task context
- authoritative active tool contract
- current assistant tool call and matching tool result boundary
- only recent handoff summaries for completed old tool exchanges

Use when:

- the latest turn contains tool results
- previous assistant turn had tool calls
- a managed tool-capable turn is active

Benefit:

- preserves tool correctness without resending all raw history

Cost:

- still includes tool definitions, so not minimal

### Digest

Send:

- stable fingerprints for tool catalog or skill package
- summary of task state
- no full raw tool schema unless needed

Use when:

- same provider session continues normally
- tool catalog fingerprint is unchanged
- no active tool loop is in progress
- no recent tool/schema failure exists

Benefit:

- faster ordinary continuation
- less repeated prompt material

Cost:

- risky if provider forgets tool rules or if fingerprint semantics are not implemented carefully

### Minimal

Send:

- only the new user turn and small task state

Use when:

- stable normal conversation
- no active tools
- no skill procedure
- no recent failure

Benefit:

- lowest token cost
- least disturbance to provider session

Cost:

- should not be used for active tool workflows

### Repair

Send:

- full tool contract
- explicit correction instruction
- minimal recent failing output

Use when:

- malformed tool XML/output occurred
- unknown tool was requested
- required schema was missing
- provider generated plain text where a tool call was required

Benefit:

- recovers reliability after drift

Cost:

- intentionally expensive

## Recommended Decision Table

| Situation | Provider Session | Prompt Mode | Web Session Impact |
|---|---|---|---|
| Ordinary user follow-up | reuse main | minimal or digest | no new session |
| First request after compact | fork main compact session | full | one new session |
| Active tool result turn | reuse tool workflow child if possible | tool_ready | no per-tool new session if grouped |
| New tool workflow | fork or reuse tool child for workflow | full then tool_ready | one child session per workflow |
| Subagent run starts | fork subagent child | full | one child session per run |
| Subagent reports back | reuse parent main | digest or tool_ready depending state | no raw child transcript |
| Tool/schema failure | same relevant session or repair fork | repair | possible extra request, not necessarily new session |

## Key Tradeoffs

### Fewer Web Sessions vs Cleaner Context

Reusing one provider session forever reduces website-side session count, but old memory can contaminate long tasks.

Forking too often keeps context clean, but creates many website-side records.

Recommended compromise:

- reuse main session for normal conversation
- fork main session only on compact
- group tool calls into workflow child sessions
- use one subagent child session per subagent run
- avoid one provider session per message or per individual tool result

### Fewer Tokens vs Tool Reliability

Sending full system/tools/skill every turn is slow.

Sending them only once is unsafe because providers forget or drift.

Recommended compromise:

- full refresh at every new/forked/repair boundary
- tool_ready refresh during active tool loops
- digest/minimal only during stable non-tool continuation
- repair mode after any tool/schema failure

### Parent Simplicity vs Handoff Risk

Raw child transcripts make the parent context too large and confusing.

Compact handoffs keep the parent clean, but a bad handoff can lose facts.

Recommended compromise:

- handoff must be typed and bounded
- include conclusion, evidence, artifact paths, status, and next action
- never include raw full tool output unless explicitly requested

## Required Handoff Shape

Tool and subagent child sessions should return this kind of artifact to the parent:

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

Rules:

- `summary` must be short and task-state focused.
- `evidence` should contain exact file paths, command names, ids, or compact facts.
- `artifacts` should reference files instead of embedding large contents.
- `errorClass` should classify provider/tool/schema errors without dumping raw logs.

## Web Session Hygiene Policy

Implement explicit provider-session hygiene so child sessions do not become a new nuisance.

Recommended policy:

- keep main provider sessions
- keep compact sessions unless user cleanup is enabled
- delete or expire successful tool child sessions after handoff when provider supports deletion
- delete or expire successful subagent child sessions after handoff when provider supports deletion
- keep failed child sessions only when debug mode is enabled
- log child session creation/deletion with reason and parent key

Do not run broad delete-all cleanup automatically.

## Acceptance Criteria

### Token/Prompt Behavior

- Stable non-tool continuation does not resend full tool schemas every turn.
- Active tool turns still receive authoritative tool definitions.
- New/forked sessions always receive full contract refresh at least once.
- Repair mode restores full contract after malformed tool output.

### Web Session Behavior

- Ordinary user turns do not create a new provider session each time.
- Compact creates one new provider session per compact epoch.
- A contiguous tool workflow creates at most one tool child provider session.
- A subagent run creates at most one subagent child provider session.
- Child sessions can be deleted or expired after compact handoff.

### Reliability Behavior

- Tool definitions do not disappear across compact, tool child, or subagent child boundaries.
- Active `assistant.tool_calls` and matching `tool.tool_call_id` survive until the tool exchange is complete.
- Completed old tool exchanges are represented by bounded handoff summaries, not raw output.
- Parent session never receives raw child transcript by default.

## Suggested Implementation Order

1. Add diagnostics only.
   - Log session boundary, prompt refresh mode, provider session key, tool catalog key, and reason codes.
   - Do not change prompt rendering yet.

2. Implement completed tool exchange handoff.
   - Replace old completed raw tool exchanges with bounded summaries.
   - Preserve latest active tool boundary exactly.

3. Group tool child sessions by workflow.
   - Avoid one provider session per tool result.
   - Reuse the child for a contiguous tool chain.

4. Implement subagent child handoff.
   - One child provider session per subagent run.
   - Parent receives typed handoff only.

5. Enable prompt refresh modes.
   - Start with full/tool_ready only.
   - Enable digest/minimal after no-loss tests and live probes pass.

6. Add child session cleanup policy.
   - Delete successful child sessions if configured.
   - Keep failed child sessions only for debug.

## Tests and Probes

Deterministic tests should cover:

- normal continuation reuses provider session identity
- compact forks provider session but keeps tool catalog identity
- tool child keeps tool catalog identity but forks provider identity
- grouped tool workflow does not fork per individual tool result
- subagent child forks provider identity once per run
- active tool metadata survives compaction
- old completed tool output is bounded
- tool definitions survive omitted-tools follow-up turns

Live probes should measure:

- provider session count per task
- prompt refresh mode distribution
- total prompt size trend over long tasks
- tool-call success rate after 10, 20, 50 tool steps
- website-side session record growth

## Non-Goals

- Do not remove full refresh entirely.
- Do not rely on provider memory alone for tool definitions.
- Do not put prompt injection into provider adapters.
- Do not infer continuity for identity-free, history-free requests.
- Do not optimize tokens before tool-definition no-loss tests are green.

## Summary

The correct compromise is not "always reuse one session" and not "always create a new session".

Use this rule:

- main session: stable and reused
- compact: fork only at summary boundary
- tool child: one child per contiguous workflow
- subagent child: one child per subagent run
- prompt: full at boundaries, tool_ready during tool loops, digest/minimal only for stable non-tool continuation
- handoff: compact typed artifact, never raw child transcript by default

This should reduce token cost, reduce website-side session spam, and improve long-tool-task stability without reintroducing tool-definition loss.
