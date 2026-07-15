# 2026-07-15 Session Export and GLM Fix Acceptance Report

## Inputs

User supplied three Qianwen / ChatGLM exported JSON files. Correct mapping:

- Tool-call session: `E:\下载\You are opencod...-20260715132324.json`
- Main session: `E:\下载\排查Chat2API工具调用问...-20260715132340.json`
- Summary session: `E:\下载\GLM摘要问题：RC1已证实，...-20260715132307.json`

These were treated as authoritative browser-side evidence because direct local-browser automation could not safely continue.

## Export Evidence

### Tool-Call Session Export

- Messages: 2
- Total text size: 103,988 chars
- First user message size: 103,095 chars
- Contains:
  - `You are opencode`: 1
  - `## Available Tools`: 1
  - `<|CHAT2API|tool_calls>`: 14
  - `<|CHAT2API|tool_result`: 4
  - `superpowers`: 47
  - `No conversation to summarize`: 9
  - `summary_fallback_local`: 4

Interpretation:

Even the isolated tool-call session is not lightweight. It is a two-message provider conversation, but the first user payload is already 103KB and includes runtime instructions, tool information, prior diagnostic text, and compact/summary discussion.

### Main Session Export

- Messages: 52
- Total text size: 2,423,441 chars
- Role shape: 26 user / 26 assistant
- Contains:
  - `You are opencode`: 26
  - `## Available Tools`: 26
  - `<|CHAT2API|tool_calls>`: 349
  - `<|CHAT2API|tool_result`: 99
  - `superpowers`: 1,147
  - `runtime generated this checkpoint`: 26
  - `summary_fallback_local`: 27

Interpretation:

The main session is definitively not compacting from the website's perspective. It repeatedly receives full OpenCode/system/tool configuration. This explains the user's observation that the Qianwen web context keeps growing even while OpenCode can continue running long tasks.

### Summary Session Export

- Messages: 2
- Total text size: 15,406 chars
- First user message starts with:

  ```text
  Summarize the earlier conversation as procedural state for an in-progress tool workflow...
  ```

- Contains:
  - `No conversation to summarize`: 3
  - `superpowers`: 8
  - `SUBAGENT-STOP`: 2
  - `summary_fallback_local`: 2
  - `RC1`: 3
  - `RC2`: 4
  - `RC3`: 3

Interpretation:

The summary request still receives procedural / skill / superpowers content. This is not the clean "task progress and confirmed facts only" summary input we want.

## Problem 1: Qwen Compact / Session Boundary

### User Observation

After compact, the main Qwen page did not switch to a new web session. The website-side context kept growing, although OpenCode could still run the long task.

### Acceptance Result

Not accepted.

### Why

The code has internal session-boundary primitives:

- `forkProviderConversationContext(... reason: 'server_summary')`
- provider keys like `...:server_summary:<hash>`
- tests proving internal provider keys change

But the corrected main-session export is 52 turns and 2.42MB. It contains `You are opencode` and `## Available Tools` 26 times each. That means internal key changes are not enough as acceptance evidence. We need to verify the actual provider `session_id` / Qianwen chat URL changes on compact, and also verify that post-compact prompts stop resending full static runtime configuration.

### Most Likely Technical Gap

`ProviderRuntime.forward()` passes prior state into the provider plugin by reading:

```ts
priorState?.qwenSessionId ?? priorState?.conversationId ?? priorState?.parentMessageId
```

For a `server_summary` fork this should usually be empty if the fork key is genuinely new. If the website still shows the same main session, then one of these is happening:

1. The real request is not using the runtime path that the tests exercise.
2. The compact boundary is not being triggered when expected.
3. The provider plugin is still sending a parent `sessionId`.
4. The main page is the original parent session receiving repeated large rehydration prompts.
5. The architecture creates a new internal key but still sends a large compressed prompt to the same visible provider conversation.

### Required Next Test

Add a true provider-request-shape test for Qwen compact:

- seed parent state with an existing `qwenSessionId`,
- trigger `summary_fallback_local` or `summary_success`,
- assert runtime plugin `buildRequest()` receives `sessionId === undefined` for `server_summary`,
- assert generated Qwen request body uses a fresh `sessionId`, not the parent one,
- assert final prompt length is bounded and does not contain repeated `You are opencode` / `## Available Tools`.

Then run a real Qwen probe and record:

- parent Qianwen URL,
- summary Qianwen URL,
- tool-child Qianwen URL,
- server-summary Qianwen URL after compact.

## Problem 2: GLM Summary Fix

### Qwen's Code Changes Found

Current diff shows only two relevant code changes:

1. `src/main/proxy/forwarder.ts`

   ```ts
   if (message.role === 'tool') return false
   if (message.role === 'assistant' && !getSummaryTextContent(message.content).trim() && (message as any).tool_calls?.length) return false
   ```

2. `src/main/proxy/adapters/glm.ts`

   ```ts
   conversation_id: request.conversationId || '',
   ```

### Deterministic Tests Run

Command:

```powershell
node --test tests/services/contextManagement-summary-failure-diagnostic.test.ts tests/services/contextManagement-summary-input-sanitization.test.ts tests/providers/provider-runtime-main-path.test.ts tests/providers/glm-tool-calling.test.ts
```

Result:

- 83 tests passed
- 0 failed

### Acceptance Result

Partially fixed, not fully accepted.

### Why The Fix Is Partial

The first change skips raw `tool` messages and raw assistant messages with empty content plus `tool_calls`. But summary generation calls:

```ts
sanitizeMessagesForSummary(messages)
```

before `hasSummarizableSummaryInput()`.

The sanitizer converts assistant tool calls into textual placeholders:

```text
[tool calls summarized for workflow continuity] ...
```

After that conversion, `hasSummarizableSummaryInput()` sees non-empty assistant text and still allows an external provider summary request. This means the real RC1 shape, "tool-only / placeholder-only old history", is not fully blocked.

The GLM summary export confirms this class of problem: the summary request can contain procedural / tool-workflow / superpowers content rather than clean task facts.

### RC3 Reassessment

The `glm.ts` adapter now accepts `request.conversationId`, but the old dedicated `forwardGLM()` assembly branch still does not pass `convState?.conversationId` into `chatCompletionWithAssembly()`.

This matters only if GLM actually runs on the dedicated adapter path. The current code defaults `DEFAULT_PROVIDER_RUNTIME_PILOT_PROVIDERS = new Set(['qwen', 'glm'])`, so default pilot mode should route GLM through `ProviderRuntime`, where `sessionId` is passed to `GLMProviderPlugin`.

Therefore:

- If runtime pilot is active: RC3 is probably not the active failure.
- If runtime pilot is disabled: the adapter change alone is insufficient because the call site still does not pass `conversationId`.

### Missing Tests

Still missing:

1. `createSummaryGenerator()` skips provider calls for sanitized placeholder-only history.
2. GLM runtime prompt shape after `summary_fallback_local`.
3. GLM real short probe after the fix.
4. Dedicated `forwardGLM()` session continuation when runtime pilot is explicitly disabled.

## Bottom Line

The Qwen-generated fix is not enough to call the GLM problem solved.

It improves the empty-summary guard and all currently selected deterministic tests pass, but the exported JSON shows the real system still sends large procedural/tool/skill content into provider conversations. The main architecture issue remains:

Runtime configuration, tool definitions, skill documents, and tool-result payloads are still traveling as provider-visible conversation text too often.

## Recommended Next Patch

1. Add `isLowValueSummaryInput()` after sanitization:
   - reject system-only,
   - reject tool-only,
   - reject assistant-tool-placeholder-only,
   - reject content dominated by skill/tool/system prompt markers.

2. Add tests using realistic sanitized messages:
   - assistant `tool_calls` + tool result only,
   - active skill checkpoint only,
   - superpowers / skill document contamination,
   - real user task facts mixed with tool placeholders.

3. Add Qwen provider request-shape test proving `server_summary` does not reuse parent `sessionId`.

4. Only after deterministic coverage, run real probes:
   - Qwen long compact probe with exported URL/session evidence,
   - GLM short probe.
