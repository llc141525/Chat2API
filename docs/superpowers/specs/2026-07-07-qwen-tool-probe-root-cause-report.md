# Qwen Tool Calling Probe Root Cause Report

Date: 2026-07-07
Workspace: `E:\Chat2API`

## Executive Summary

The latest fixes are effective for GLM and DeepSeek, but not for Qwen domestic models.

Confirmed passing real probes:

- `glm/GLM-5.2`
- `glm/GLM-5.1`
- `deepseek/deepseek-v4-flash`
- `deepseek/deepseek-v4-pro`

Confirmed failing real probes:

- `qwen/Qwen3.6`
- `qwen/Qwen3-Max`
- `qwen/Qwen3.7-Max`
- `qwen/Qwen3-Coder`
- `qwen/Qwen3.5-Flash`
- `qwen-ai/Qwen3.7-Max`

The Qwen domestic failures are not caused by the tool schema validation fixes being ineffective. They are caused by Qwen-specific streaming and prompt-history boundary problems around the managed XML protocol. Qwen AI international failed earlier, at provider/server level, and should be investigated separately.

## Evidence From Real Probe

The verifier requires the sequence:

```text
skill -> read -> bash -> final text CAPABILITY_PROBE_DONE
```

DeepSeek and GLM satisfy this with real OpenCode events.

Qwen domestic does not.

Observed `qwen/Qwen3.6` event behavior:

- A text chunk containing only whitespace appears before the `skill` tool call.
- After the `read` result, the assistant emits ordinary text:

```text
I'll execute the capability probe exactly as instructed.

_result tool_call_id="call_1"><![CDATA[angle_text=<<<<<>>>>>
fake_xml=<xml><body>test</body></xml>
chat2api_marker=2API|tool_calls>

CAPABILITY_PROBE_DONE
```

- It then calls `bash`, and finally outputs `CAPABILITY_PROBE_DONE`.

Observed `qwen/Qwen3-Max` event behavior:

- The first tool call is `read`, not `skill`.
- The same assistant message also emits leaked text:

```text
|tool_calls>
```

This means Qwen can still produce correct files by luck, but it does not preserve the strict tool protocol contract.

## Root Cause 1: Qwen Stream Handler Uses Length-Only Diffs On Cumulative Provider Snapshots

File: `src/main/proxy/adapters/qwen.ts`

Relevant logic:

```ts
if (newContent.length > this.content.length) {
  const chunk = newContent.substring(this.content.length)
  this.content = newContent
  const outputChunks = this.toolStreamParser?.push(chunk, baseChunk, !this.sentRole) ?? [...]
}
```

Qwen web responses are treated as cumulative snapshots. The adapter assumes every later `msg.content` is the previous content plus an appended suffix.

That assumption is unsafe. Live Qwen events show symptoms of rewritten or non-prefix content: the client receives isolated residue such as `|tool_calls>`. A length-only substring cannot safely derive a delta if the provider revises earlier text, switches between `text/plain` and `multi_load/iframe`, emits partial protocol text, or sends a different cumulative view.

Impact:

- Partial managed XML markers can be sliced into meaningless suffixes.
- Residual protocol fragments can be emitted as assistant text.
- The client can see text and tool calls in the same assistant turn, violating OpenAI tool-call semantics.

Why tests missed it:

- Existing Qwen stream tests only feed one complete `multi_load/iframe` event containing a full valid XML tool call.
- They do not simulate cumulative snapshots, rewritten prefixes, mixed `text/plain` and `multi_load/iframe`, or protocol markers split across provider-level snapshots.

## Root Cause 2: Stream Parser Does Not Lock The Output After A Tool Call

File: `src/main/proxy/toolCalling/ToolStreamParser.ts`

After a valid managed tool call is emitted, the parser clears the buffer and returns to normal content mode:

```ts
this.emittedToolCall = true
this.isBufferingToolCall = false
this.buffer = ''
return chunks
```

If a later provider chunk contains leftover text, for example a closing marker fragment or model commentary, the next `push()` call can emit it as ordinary content because `isBufferingToolCall` is false.

This is incompatible with OpenAI tool-call streaming semantics. Once an assistant message emits `delta.tool_calls`, subsequent normal `delta.content` in the same message should be suppressed or treated as malformed provider output.

Impact:

- Tool call plus ordinary text can appear in one assistant message.
- Residual protocol fragments such as `|tool_calls>` can leak after a tool call.
- Probe evidence becomes invalid even if the requested file is eventually produced.

Why tests missed it:

- There is a test for text after a tool call in the same buffer.
- There is no test for text or closing-marker residue arriving in a later stream chunk after a tool call was already emitted.

## Root Cause 3: Qwen Prompt/History Formatting Collapses Role Boundaries Into One User Text

File: `src/main/proxy/adapters/qwen.ts`

The Qwen request builder flattens all messages into one `text/plain` user message:

```ts
const userContent = conversationParts.join('\n\n')
const finalContent = systemPrompt
  ? `${systemPrompt}\n\nUser: ${userContent}`
  : userContent

messages: [
  {
    content: finalContent,
    mime_type: 'text/plain',
    meta_data: {
      ori_query: lastUserText || userContent || finalContent,
    },
  },
]
```

Assistant tool calls and tool results are rendered as managed XML text inside this single user message.

This makes Qwen more likely to treat tool-call history, tool results, and XML-like file content as ordinary prompt text. The real probe shows exactly that: Qwen emits a fake `_result tool_call_id=...` text block after seeing the file content instead of staying in the tool-call protocol.

This is not the only cause because GLM also flattens some prompt content and still passes. But Qwen's web API route is more sensitive to this flattening, especially because `ori_query` is set to the last user text rather than the full injected contract/history.

Impact:

- The model can skip the mandatory `skill` call and jump to `read`.
- Tool result text can be imitated as assistant text.
- XML-like data from tool output can re-enter the assistant response as protocol-looking residue.

Why tests missed it:

- Current deterministic tests validate that metadata survives before provider formatting.
- They do not assert the exact Qwen provider payload preserves enough role/history boundaries for multi-turn tool contracts.
- They do not verify live event order against the actual OpenCode `skill -> read -> bash` contract for Qwen.

## Root Cause 4: Qwen AI International Fails Before Tool Semantics Can Be Judged

Provider: `qwen-ai/Qwen3.7-Max`

Observed event:

```json
{"type":"error","error":{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details."}}}
```

This is not the same class of failure as Qwen domestic.

Likely areas to inspect:

- `src/main/proxy/adapters/qwen-ai.ts` request payload and headers.
- Account token/cookie validity.
- Provider API compatibility with the current hard-coded `Version`, `bx-*` headers, and `output_schema`.
- Forwarder retry path bugs where retry handlers pass `retryResponse.data` instead of `retryResponse.response.data`.

Until server logs are captured for this provider, do not classify Qwen AI as a managed XML parser failure.

## Most Important Missing Tests

Add deterministic regression tests before fixing implementation:

1. Qwen cumulative snapshot rewrite

Simulate provider events where the second `msg.content` is not a strict prefix extension of the first. The adapter must not emit a substring residue like `|tool_calls>`.

2. Qwen tool call followed by later text chunk

After `ToolStreamParser` emits one tool call, feed another chunk containing plain text or `</|CHAT2API|tool_calls>` residue. Expected result: no `delta.content` escapes.

3. Partial marker flush

Push a partial managed XML marker and then `flush()`. Expected result: do not release the partial marker as client-visible text.

4. Realistic Qwen event sequence

Use multiple SSE events with `text/plain` and `multi_load/iframe`, cumulative content, status transitions, and split managed XML markers.

5. Qwen provider payload contract

Given OpenCode messages containing assistant `tool_calls` and tool results, assert the Qwen request payload preserves:

- the managed tool contract,
- the assistant tool-call XML,
- the matching tool-result XML,
- clear separators preventing tool results from looking like assistant text,
- no duplicate or stale tool catalog.

## Fix Direction

Recommended fix order:

1. Harden `ToolStreamParser` first.

Once any `tool_calls` delta has been emitted for a managed response, suppress all later normal content in that assistant message. Record diagnostics instead of leaking it.

2. Change Qwen streaming from length-only diff to prefix-aware handling.

If `newContent.startsWith(this.content)`, emit the suffix. If not, treat the provider snapshot as a rewrite:

- in managed tool mode, buffer until completion and parse the full final content, or
- run a stream gate that never releases marker-like residue until the structure is known.

3. Add Qwen-specific realistic stream tests.

The current test with one complete XML event is insufficient.

4. Rework Qwen prompt/history formatting.

Do not rely only on one flattened `User:` block for multi-turn tool state. At minimum, add strong delimiters around:

- current system/tool contract,
- prior assistant tool calls,
- tool results,
- latest user instruction.

If Qwen's API supports any richer role/message structure, use it instead of collapsing everything into one `text/plain` payload.

5. Capture server logs for Qwen AI.

Handle Qwen AI as an API/provider failure until the 500 source is visible.

## Final Verdict

The project is currently safe to say:

- GLM tool-calling fix works under deterministic and real probe evidence.
- DeepSeek tool-calling fix works under real probe evidence.
- Qwen domestic still has a real multi-turn protocol reliability bug.
- Qwen AI international is blocked by a provider/server error and needs separate logging.

The root is not the schema validator alone. The remaining Qwen failure is primarily a streaming boundary and provider formatting problem: Qwen receives flattened history, returns cumulative or rewritten text snapshots, and the current stream parser allows post-tool-call residue to escape.
