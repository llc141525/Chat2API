# 2026-07-15 GLM Summary Bugfix Document

## Bug Statement

`glm/GLM-5.2` now fails even short OpenCode probes in scenarios where the previous architecture did not. User screenshots show GLM can still produce managed XML tool calls, while the summary path produces `No conversation to summarize.`

Therefore the primary bug is not "GLM cannot tool call"; it is "summary / compact creates an unusable GLM provider state or prompt."

## Expected Behavior

When context management compacts a GLM task:

1. Tool definitions remain available through the current request's authoritative tool manifest.
2. Old conversational state is represented as a compact summary.
3. If external summary generation is impossible, empty, contaminated, or returns `No conversation to summarize.`, the runtime uses a local fallback summary.
4. A compact boundary starts a new provider conversation for the parent task and sends the summary into that new conversation.
5. Summary-generation child sessions do not pollute the parent provider session.

## Actual Observed Behavior

From the user's screenshots:

1. GLM can emit valid managed XML:

   ```text
   <|CHAT2API|tool_calls><|CHAT2API|invoke name="bash">...
   ```

2. Summary requests sent to ChatGLM can receive:

   ```text
   No conversation to summarize.
   ```

3. This indicates the summary child request is not receiving useful conversational substance, or GLM is being asked to summarize in a fresh provider session without enough payload.

## Current Code Facts

### Local fallback exists

`src/main/proxy/services/contextManagementService.ts` treats these summaries as unusable:

- empty string,
- `No conversation to summarize.`,
- `There is no conversation to summarize.`,
- `Nothing to summarize.`,
- Chinese equivalents such as `没有可总结的对话`.

When unusable, `SummaryStrategy` throws internally and returns `summary_fallback_local`.

### Provider-call gate exists for sanitized-empty history

`src/main/proxy/forwarder.ts:createSummaryGenerator()` sanitizes messages before summary generation. If sanitized messages contain no summarizable non-system user / assistant / tool history, it returns `''` without calling the provider.

This prevents one class of useless provider-side summary conversations, but it does not prove all GLM summary failures are fixed.

### GLM has two live paths

GLM can run through:

1. Old dedicated adapter path:
   - `forwardGLM()`
   - `GLMAdapter.chatCompletionWithAssembly()`

2. ProviderRuntime plugin path:
   - `ProviderRuntime.forward()`
   - `GLMProviderPlugin.buildRequest()`

Every real probe must state which path was used. A bugfix tested only on one path is not accepted unless that path is the path actually used by the probe.

## High-Probability Root Causes To Check

### RC1: GLM summary child request is still called with low-value input

The guard only skips when sanitized input is empty. A low-value input made only of tool-call placeholders may still be sent to GLM. GLM may reasonably answer "No conversation to summarize."

Fix direction:

- Treat tool-only / placeholder-only old history as local-fallback eligible.
- Do not open provider `summary_generator` sessions unless there is real user/assistant narrative or concrete task state worth summarizing.

This is an architecture fix, not a parser patch.

### RC2: `server_summary` creates a fresh GLM session but the summary text is not actually in the final provider prompt

`SummaryStrategy` can set `summaryGenerated=true` for `summary_fallback_local`. `forwardChatCompletion()` then forks context with `reason: 'server_summary'`.

The required invariant is:

- provider session id changes / is not reused,
- compacted summary text appears in the provider prompt,
- current tool manifest appears after the summary and remains authoritative.

If any part is missing, GLM gets a fresh provider conversation with insufficient state.

Fix direction:

- Add deterministic GLM prompt-shape tests around summary fallback + assembly path.
- Verify actual provider payload contains `[Prior conversation summary ...]` or `[Local fallback summary ...]`.

### RC3: Dedicated `forwardGLM()` reads prior state but may not pass it to the assembly path

`forwardGLM()` reads `convState` via `ProviderRuntime.readSessionState()`. In the inspected assembly branch, `GLMAdapter.chatCompletionWithAssembly()` is called without passing a prior `conversationId`; that adapter method posts `conversation_id: ''`.

For compact boundaries this may be correct because a new provider session is required. For normal multi-turn GLM tool loops, it may be wrong if it prevents GLM from continuing the existing provider conversation.

Fix direction:

- Define explicit rules:
  - `normal` boundary may reuse existing GLM conversation id.
  - `server_summary`, `client_compact`, `summary_generator`, `tool_child`, and `subagent_child` must start fresh provider sessions.
- Add tests proving the rule for both dedicated and ProviderRuntime paths.

### RC4: Active tool workflow summary skip may drop too much for GLM

`SummaryStrategy` skips external summary generation during active tool workflow and keeps structured handoff state. The screenshot shows a checkpoint message:

```text
The runtime generated this checkpoint from completed OpenCode tool events...
```

GLM then emitted a tool call, which is good. But short-probe failure may happen if the next compact loses the checkpoint or fails to turn it into the correct GLM final prompt.

Fix direction:

- Test checkpoint-to-GLM prompt shape after compact.
- Ensure active skill checkpoint and tool result handoff are never summarized away before the next required tool call.

## Required Deterministic Tests

Add or confirm tests for:

1. GLM local summary fallback prompt shape.
   Input: old messages exceed summary threshold; summary generator returns `No conversation to summarize.`
   Expected:
   - `summary_fallback_local`,
   - request context becomes `server_summary`,
   - GLM assembly prompt includes local fallback summary,
   - managed XML tool manifest is present after summary.

2. GLM sanitized-empty summary skip.
   Input: only tool catalog / system directives / empty assistant fragments.
   Expected:
   - provider summary generator is not called.

3. GLM placeholder-only summary skip.
   Input: old history only contains assistant tool calls and tool results after sanitization.
   Expected:
   - provider summary generator is not called,
   - local fallback summary is used.

4. GLM session boundary rule.
   Expected:
   - normal turn may reuse prior `conversationId`,
   - `server_summary` / `summary_generator` / `tool_child` / `subagent_child` must not reuse parent `conversationId`.

5. GLM real path trace.
   Expected `dev.log` must show whether the request used:
   - `[Forwarder] Runtime pilot request trace` and `GLMProviderPlugin`, or
   - `[GLM] Sending chat request via assembly path...`.

## Real Probe Plan

1. Start app with explicit GLM mode selected for the path being tested.
2. Run short probe:

   ```powershell
   .\tests\agent-capability\verify-opencode-capability.ps1 -Model "glm/GLM-5.2"
   ```

3. Save evidence:
   - `.agent-probe/result.json`
   - `.agent-probe/opencode-events.ndjson`
   - `dev.log` filtered for:
     - `GLM`
     - `SummaryGenerator`
     - `SummaryStrategy`
     - `ContextManagementService`
     - `Runtime pilot request trace`
     - `server_summary`
     - `summary_generator`

4. Inspect ChatGLM web UI:
   - No new useless `No conversation to summarize.` summary conversation should appear during the accepted run.

## Non-Accepted Fixes

These are not sufficient:

- Making the XML parser more permissive.
- Special-casing GLM output text after the model already got a bad summary prompt.
- Only rejecting `No conversation to summarize.` after the provider call, while still creating useless summary child conversations.
- Passing tests that never inspect the final GLM provider prompt shape.
- Passing tests without proving which GLM request path was used.

## Proposed Fix Order

1. Add GLM-specific deterministic prompt-shape tests for summary fallback and boundary behavior.
2. Add placeholder-only summary skip logic if the test proves provider summary is still called without narrative content.
3. Fix GLM session-boundary propagation in the path actually used by the short probe.
4. Run deterministic tests.
5. Run real GLM short probe.
6. Only after short probe passes, resume long-context GLM compact validation.

