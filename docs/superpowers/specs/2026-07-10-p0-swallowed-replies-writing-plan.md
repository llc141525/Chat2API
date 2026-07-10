# P0 Swallowed Replies Writing Plan

Date: 2026-07-10
Parent spec: `docs/superpowers/specs/2026-07-10-agent-tooling-stability-spec.md`

## Objective

Make swallowed or empty assistant replies impossible to treat as successful agent responses unless the request contract explicitly allows intentional silence.

This is the first repair track because it blocks all other diagnosis: if Chat2API silently returns empty success, OpenCode and Claude Code cannot distinguish model failure, parser failure, stream failure, or tool-runtime failure.

## User-Visible Symptoms

- After a tool call, the follow-up assistant reply disappears.
- Some models return an empty first assistant reply.
- Streaming can finish without visible content and without a clear error.
- Non-streaming can return empty `content` with `finish_reason: "stop"` and be accepted as success.

## Scope

Primary files:

- `src/main/proxy/toolCalling/outputInspection.ts`
- `src/main/proxy/toolCalling/diagnostics.ts`
- `src/main/proxy/forwarder.ts`
- `src/main/proxy/toolCalling/ToolStreamParser.ts`
- `src/main/proxy/adapters/qwen.ts`
- `src/main/proxy/adapters/glm.ts`
- `src/main/proxy/adapters/qwen-ai.ts`

Primary tests:

- `tests/tool-calling/output-inspection.test.ts`
- `tests/tool-calling/tool-stream-parser.test.ts`
- provider stream tests under `tests/providers/`
- final OpenCode probe under `tests/agent-capability/`

## Writing Sequence

### Step 1: Define The Empty Output Contract

Write down the precise distinction between these outcomes:

- `content`: usable assistant text exists.
- `tool_calls`: validated tool calls exist.
- `provider_empty`: no usable text and no usable tool calls.
- `malformed_tool_output`: provider emitted protocol-like content that was blocked.
- `provider_error`: provider failed before a normalized assistant message existed.

The implementation must not rely on raw truthiness alone. It must classify empty strings, whitespace-only content, `null`, missing message, and empty choices.

### Step 2: Strengthen Non-Stream Inspection

Update `inspectNonStreamAssistantOutput` so strict contracts reject:

- `choices: []`
- missing `choices[0].message`
- `message.content === ""`
- whitespace-only `message.content`
- `message.content === null` with no `tool_calls`
- `finish_reason: "stop"` with no usable content

Keep this rule:

- `message.tool_calls.length > 0` counts as non-empty even when `content` is `null`.

### Step 3: Add Stream-Level Empty Detection

Add a stream terminal accounting path:

- Track whether any visible `delta.content` was emitted.
- Track whether any `delta.tool_calls` was emitted.
- Track whether only role, whitespace, or empty deltas were emitted.
- On finish, strict contracts must not end as success if there was no content and no tool calls.

If the current architecture cannot fail a stream after headers are sent, write a diagnostic event and emit a client-safe final error event in the stream format used by that route.

### Step 4: Protect Post-Tool-Call Turns

Once a stream emits `delta.tool_calls`, suppress later normal `delta.content` in the same assistant message. Record the suppression as `malformed_tool_output`.

This prevents provider residue from being interpreted as the assistant's final answer and prevents tool-call turns from becoming mixed content/tool turns.

### Step 5: Provider-Specific Confirmation

For Qwen and Qwen AI, inspect adapter finalization paths:

- finish chunks
- `[DONE]` handling
- provider error chunks
- status transitions
- empty provider messages

For GLM, keep current passing behavior intact.

## Test Plan

Add deterministic tests before implementation where possible:

- Non-stream empty strict output fails with `provider_empty`.
- Non-stream whitespace-only strict output fails with `provider_empty`.
- Non-stream missing message fails with `provider_empty`.
- Non-stream validated tool calls pass with `content: null`.
- Stream role-only then finish fails or emits typed diagnostic.
- Stream whitespace-only then finish fails or emits typed diagnostic.
- Stream whitespace first, real content later succeeds.
- Stream tool call followed by later text suppresses the later text.

Run:

```powershell
node --test tests/tool-calling/output-inspection.test.ts tests/tool-calling/tool-stream-parser.test.ts
```

Then run the deterministic gate:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

## OpenCode Verification

After deterministic tests pass:

```powershell
npm run dev:win 2>&1 | Tee-Object -FilePath .\dev.log
```

```powershell
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "glm/GLM-5.2"
```

For suspected Qwen-specific swallowed output:

```powershell
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "qwen/Qwen3.7-Max"
```

## Acceptance Criteria

- Empty successful assistant responses are no longer silently accepted under strict agent contracts.
- Tool calls remain valid non-empty output.
- Streamed tool-call turns cannot leak later text.
- Diagnostics classify empty failures without requiring raw log archaeology.
- GLM OpenCode probe still passes.

## Stop Conditions

Stop and write a follow-up issue if:

- A provider returns no usable raw output at all, and the adapter cannot distinguish auth failure from model failure.
- Streaming headers make it impossible to return a proper client error without route-level redesign.
- A fix would require weakening tool-call validation or prompt-injection ownership.
