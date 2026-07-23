# GLM DeepSeek Single Parser Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optimize GLM 5.2 and DeepSeek tool behavior against the Qwen3.7-Max baseline by enforcing one non-stream parser owner and adding provider output diagnostics for empty or swallowed DeepSeek responses.

**Architecture:** Provider adapters may collect and normalize provider transport output, but non-stream tool parsing belongs only to `ToolCallingEngine.applyNonStreamResponse`. GLM and DeepSeek non-stream handlers must return raw assistant content for managed tool markup, while streaming can continue using `ToolStreamParser` because streaming needs incremental buffering. Diagnostics record structure facts only: provider id, model, response mode, fragment/content lengths, whether upstream DONE was seen, and finish reason.

**Tech Stack:** TypeScript, Electron main process proxy adapters, Node.js built-in test runner (`node --test`), existing Chat2API tool runtime and diagnostics store.

---

## Phase Isolation Rule

- This plan only covers GLM/DeepSeek single-parser boundaries and DeepSeek output diagnostics.
- Do not modify Qwen or Qwen AI adapter implementation files in this phase.
- Do not change provider profile protocol selection in `src/main/proxy/toolCalling/providerProfiles.ts`.
- Do not introduce semantic repair, parser fallback, or tool-call reconstruction from model text.
- If existing working-tree changes touch structural repair or validator files, leave them to their own validation unless a test in this phase depends on them.

## File Structure

- Modify: `tests/providers/glm-tool-calling.test.ts`
  - Tighten GLM non-stream expectation so the adapter leaves managed XML as raw content for `ToolCallingEngine`.
- Modify: `tests/providers/deepseek-stream.test.ts`
  - Tighten DeepSeek non-stream expectation so the adapter leaves managed XML as raw content for `ToolCallingEngine`.
  - Add DeepSeek diagnostics tests for empty content and thinking/content split facts.
- Modify: `src/main/proxy/adapters/glm.ts`
  - Remove non-stream direct tool parsing from `GLMStreamHandler.handleNonStream`.
  - Keep streaming `ToolStreamParser` unchanged.
- Modify: `src/main/proxy/adapters/deepseek-stream.ts`
  - Remove non-stream direct tool parsing from `DeepSeekStreamHandler.handleNonStream`.
  - Add provider output diagnostics recording.
  - Keep streaming `ToolStreamParser` unchanged.
- Modify: `src/main/proxy/toolCalling/diagnostics.ts`
  - Extend diagnostic events with provider output structure fields only.

---

### Task 1: Lock GLM Non-Stream to ToolCallingEngine Parsing

**Files:**
- Modify: `tests/providers/glm-tool-calling.test.ts`
- Modify: `src/main/proxy/adapters/glm.ts`

- [ ] **Step 1: Write the failing GLM boundary test**

In `tests/providers/glm-tool-calling.test.ts`, replace the flexible assertion inside `GLM non-stream leaves managed XML for ToolCallingEngine to convert`:

```ts
  // Non-stream handlers may preserve managed XML text or already convert to tool_calls.
  const initialMessage = result.choices?.[0]?.message
  if (typeof initialMessage?.content === 'string') {
    assert.match(initialMessage.content, /<\|CHAT2API\|tool_calls>/)
  } else {
    assert.ok(Array.isArray(initialMessage?.tool_calls))
    assert.equal(initialMessage?.tool_calls?.[0]?.function?.name, 'default_api:read_file')
  }
```

with:

```ts
  const initialMessage = result.choices?.[0]?.message
  assert.equal(initialMessage?.tool_calls, undefined)
  assert.equal(result.choices?.[0]?.finish_reason, 'stop')
  assert.match(initialMessage?.content, /<\|CHAT2API\|tool_calls>/)
```

- [ ] **Step 2: Run the failing GLM test**

Run:

```powershell
node --test tests/providers/glm-tool-calling.test.ts
```

Expected: FAIL if `GLMStreamHandler.handleNonStream` still pre-converts managed XML into `message.tool_calls`.

- [ ] **Step 3: Remove GLM non-stream direct tool parsing**

Modify `src/main/proxy/adapters/glm.ts`.

Change this import:

```ts
import { parseToolCallsFromText, type ParsedToolCall } from '../utils/toolParser.ts'
```

to:

```ts
import { parseToolCallsFromText } from '../utils/toolParser.ts'
```

If `parseToolCallsFromText` is no longer used after the following edit, remove that import completely.

Remove this non-stream parsing block from `GLMStreamHandler.handleNonStream`:

```ts
              let cleanContent: string
              let toolCalls: ParsedToolCall[]
              if (this.toolCallingPlan?.shouldParseResponse) {
                const protocol = getToolProtocol(this.toolCallingPlan.protocol)
                const parsed = protocol.parse(fullText, { tools: this.toolCallingPlan.tools, protocol: this.toolCallingPlan.protocol })
                cleanContent = parsed.content || fullText
                toolCalls = parsed.toolCalls || []
              } else {
                const result = parseToolCallsFromText(fullText, 'glm')
                cleanContent = result.content
                toolCalls = result.toolCalls
              }
```

Replace the response message construction with raw collected content:

```ts
              const cleanContent = fullText.trim()

              resolve({
                id: this.conversationId,
                model: this.model,
                object: 'chat.completion',
                choices: [
                  {
                    index: 0,
                    message: {
                      role: 'assistant',
                      content: cleanContent,
                      reasoning_content: fullReasoning || null,
                    },
                    finish_reason: 'stop',
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                created: Math.floor(Date.now() / 1000),
              })
```

Do not change `GLMStreamHandler.handleStream`; streaming may continue to use `ToolStreamParser`.

- [ ] **Step 4: Run the GLM focused tests**

Run:

```powershell
node --test tests/providers/glm-tool-calling.test.ts
```

Expected: PASS.

---

### Task 2: Lock DeepSeek Non-Stream to ToolCallingEngine Parsing

**Files:**
- Modify: `tests/providers/deepseek-stream.test.ts`
- Modify: `src/main/proxy/adapters/deepseek-stream.ts`

- [ ] **Step 1: Add the failing DeepSeek managed XML boundary test**

Add this test to `tests/providers/deepseek-stream.test.ts`:

```ts
test('DeepSeek non-stream leaves managed XML for ToolCallingEngine to convert', async () => {
  const managedXmlToolCall = '<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="filePath"><![CDATA[/tmp/a]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>'
  const handler = new DeepSeekStreamHandler('deepseek-v4-pro', 'session-managed-xml', undefined, false)
  const response: any = await handler.handleNonStream(sse([
    {
      v: {
        response: {
          thinking_enabled: false,
          fragments: [{ type: 'RESPONSE', content: managedXmlToolCall }],
        },
      },
    },
  ]))

  assert.equal(response.choices[0].message.tool_calls, undefined)
  assert.equal(response.choices[0].finish_reason, 'stop')
  assert.match(response.choices[0].message.content, /<\|CHAT2API\|tool_calls>/)
})
```

- [ ] **Step 2: Update the existing bracket-format DeepSeek test**

Replace `DeepSeek non-stream keeps tool call content null when citations are present` with a boundary test that proves legacy bracket output is no longer parsed in the adapter:

```ts
test('DeepSeek non-stream preserves bracket tool-like text as content for the engine boundary', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-flash-search', 'session-tool-citation', undefined, true)
  const source = sse([
    { response_message_id: '2', model_type: 'default' },
    { p: 'response/search_results', v: [{
      url: 'https://example.com/tool',
      title: '工具引用',
      cite_index: 1,
    }] },
    {
      p: 'response/fragments',
      o: 'APPEND',
      v: [{
        id: 11,
        type: 'RESPONSE',
        content: '[function_calls][call:get_weather]{"city":"北京"}[/call][/function_calls]',
      }],
    },
  ])

  const response: any = await handler.handleNonStream(source)

  assert.equal(response.choices[0].message.tool_calls, undefined)
  assert.equal(response.choices[0].finish_reason, 'stop')
  assert.match(response.choices[0].message.content, /\[function_calls\]/)
  assert.match(response.choices[0].message.content, /\[1\]: \[工具引用\]/)
})
```

- [ ] **Step 3: Run the failing DeepSeek tests**

Run:

```powershell
node --test tests/providers/deepseek-stream.test.ts
```

Expected: FAIL if `DeepSeekStreamHandler.handleNonStream` still pre-converts tool-like text into `message.tool_calls`.

- [ ] **Step 4: Remove DeepSeek non-stream direct tool parsing**

Modify `src/main/proxy/adapters/deepseek-stream.ts`.

Remove these imports if they become unused:

```ts
import { parseToolCallsFromText } from '../utils/toolParser.ts'
import { getToolProtocol } from '../toolCalling/protocols/index.ts'
```

Replace the parse block in `handleNonStream`:

```ts
        let cleanContent: string
        let toolCalls: any[]
        if (this.toolCallingPlan?.shouldParseResponse) {
          const protocol = getToolProtocol(this.toolCallingPlan.protocol)
          const parsed = protocol.parse(accumulatedContent, { tools: this.toolCallingPlan.tools, protocol: this.toolCallingPlan.protocol })
          cleanContent = parsed.content || accumulatedContent
          toolCalls = parsed.toolCalls || []
        } else {
          const result = parseToolCallsFromText(accumulatedContent)
          cleanContent = result.content
          toolCalls = result.toolCalls
        }
```

with:

```ts
        const cleanContent = accumulatedContent
```

Then replace message construction:

```ts
          content: toolCalls.length > 0 ? null : contentWithCitations,
```

with:

```ts
          content: contentWithCitations,
```

Remove:

```ts
        if (toolCalls.length > 0) {
          message.tool_calls = toolCalls
        }
```

Replace:

```ts
            finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
```

with:

```ts
            finish_reason: 'stop',
```

Do not change `DeepSeekStreamHandler.handleStream`; streaming may continue to use `ToolStreamParser`.

- [ ] **Step 5: Run DeepSeek focused tests**

Run:

```powershell
node --test tests/providers/deepseek-stream.test.ts
```

Expected: PASS.

---

### Task 3: Add DeepSeek Provider Output Diagnostics

**Files:**
- Modify: `src/main/proxy/toolCalling/diagnostics.ts`
- Modify: `src/main/proxy/adapters/deepseek-stream.ts`
- Modify: `tests/providers/deepseek-stream.test.ts`

- [ ] **Step 1: Add failing diagnostics tests**

Add imports to `tests/providers/deepseek-stream.test.ts`:

```ts
import {
  clearToolDiagnosticEvents,
  getToolDiagnosticEvents,
} from '../../src/main/proxy/toolCalling/diagnostics.ts'
```

Add these tests:

```ts
test('DeepSeek non-stream records provider output diagnostics for empty assistant output', async () => {
  clearToolDiagnosticEvents()
  const handler = new DeepSeekStreamHandler('deepseek-v4-pro', 'session-empty-diagnostics', undefined, false)

  await handler.handleNonStream(sse([
    { response_message_id: 'msg-empty', model_type: 'default' },
  ]))

  const events = getToolDiagnosticEvents().filter((event) => event.type === 'provider_empty_output')
  assert.equal(events.length, 1)
  assert.equal(events[0].providerId, 'deepseek')
  assert.equal(events[0].model, 'deepseek-v4-pro')
  assert.equal(events[0].responseMode, 'non_streaming')
  assert.equal((events[0] as any).contentLength, 0)
  assert.equal((events[0] as any).reasoningLength, 0)
  assert.equal((events[0] as any).upstreamDoneSeen, false)
})

test('DeepSeek non-stream records provider output stats without prompt or arguments', async () => {
  clearToolDiagnosticEvents()
  const handler = new DeepSeekStreamHandler('DeepSeek-R1', 'session-stats-diagnostics', undefined, false)

  await handler.handleNonStream(sse([
    { response_message_id: 'msg-stats', model_type: 'default' },
    {
      v: {
        response: {
          thinking_enabled: true,
          fragments: [{ type: 'THINK', content: 'reasoning text' }],
        },
      },
    },
    {
      p: 'response/fragments',
      o: 'APPEND',
      v: [{ id: 1, type: 'RESPONSE', content: 'answer text' }],
    },
    '[DONE]' as any,
  ]))

  const events = getToolDiagnosticEvents().filter((event) => event.type === 'provider_output_observed')
  assert.equal(events.length, 1)
  assert.equal((events[0] as any).contentLength, 'answer text'.length)
  assert.equal((events[0] as any).reasoningLength, 'reasoning text'.length)
  assert.equal((events[0] as any).fragmentTypes.includes('THINK'), true)
  assert.equal((events[0] as any).fragmentTypes.includes('RESPONSE'), true)
  assert.equal((events[0] as any).prompt, undefined)
  assert.equal((events[0] as any).argumentsText, undefined)
})
```

If the helper `sse()` cannot encode `[DONE]` as a raw SSE line, add a separate helper:

```ts
function rawSse(lines: string[]): Readable {
  return Readable.from(lines.map(line => `${line}\n\n`))
}
```

and use:

```ts
const source = rawSse([
  `data: ${JSON.stringify({ response_message_id: 'msg-stats', model_type: 'default' })}`,
  `data: ${JSON.stringify({ v: { response: { thinking_enabled: true, fragments: [{ type: 'THINK', content: 'reasoning text' }] } } })}`,
  `data: ${JSON.stringify({ p: 'response/fragments', o: 'APPEND', v: [{ id: 1, type: 'RESPONSE', content: 'answer text' }] })}`,
  'data: [DONE]',
])
```

- [ ] **Step 2: Run failing diagnostics tests**

Run:

```powershell
node --test tests/providers/deepseek-stream.test.ts
```

Expected: FAIL because diagnostics do not yet expose `provider_output_observed` or provider output structure fields.

- [ ] **Step 3: Extend diagnostic event structure facts**

Modify `src/main/proxy/toolCalling/diagnostics.ts`.

Extend `ToolDiagnosticEventType`:

```ts
export type ToolDiagnosticEventType =
  | 'tool_catalog_resolved'
  | 'tool_catalog_drift_detected'
  | 'tool_contract_injected'
  | 'tool_availability_drift_detected'
  | 'tool_availability_retry_result'
  | 'provider_empty_output'
  | 'provider_output_observed'
```

Add these optional fields to `ToolDiagnosticEvent`:

```ts
  contentLength?: number
  reasoningLength?: number
  fragmentTypes?: string[]
  upstreamDoneSeen?: boolean
  finishReason?: string
```

Copy only these fields in `recordToolDiagnosticEvent`:

```ts
    contentLength: event.contentLength,
    reasoningLength: event.reasoningLength,
    fragmentTypes: event.fragmentTypes ? [...event.fragmentTypes] : undefined,
    upstreamDoneSeen: event.upstreamDoneSeen,
    finishReason: event.finishReason,
```

Copy `fragmentTypes` in `getToolDiagnosticEvents`:

```ts
    fragmentTypes: event.fragmentTypes ? [...event.fragmentTypes] : undefined,
```

Do not add fields for raw prompt text, model output text, tool arguments, or full schemas.

- [ ] **Step 4: Record DeepSeek output diagnostics**

Modify `src/main/proxy/adapters/deepseek-stream.ts`.

Add import:

```ts
import { recordToolDiagnosticEvent } from '../toolCalling/diagnostics.ts'
```

Inside `handleNonStream`, add local state near the existing accumulators:

```ts
    const fragmentTypes = new Set<string>()
    let upstreamDoneSeen = false
```

Whenever a provider fragment has a string `type`, record it:

```ts
if (typeof fragment.type === 'string') {
  fragmentTypes.add(fragment.type)
}
```

When processing SSE data:

```ts
if (data === '[DONE]') {
  upstreamDoneSeen = true
  return
}
```

Before resolving the final response, compute:

```ts
        const finalContentLength = contentWithCitations.length
        const finalReasoningLength = accumulatedThinkingContent.trim().length
        const diagnosticBase = {
          providerId: 'deepseek',
          model: this.model,
          responseMode: 'non_streaming' as const,
          contentLength: finalContentLength,
          reasoningLength: finalReasoningLength,
          fragmentTypes: [...fragmentTypes].sort(),
          upstreamDoneSeen,
          finishReason: 'stop',
        }

        recordToolDiagnosticEvent({
          type: finalContentLength === 0 && finalReasoningLength === 0
            ? 'provider_empty_output'
            : 'provider_output_observed',
          ...diagnosticBase,
        })
```

This diagnostic must not inspect tool names, parse model text, or infer missing tool calls.

- [ ] **Step 5: Run DeepSeek diagnostics tests**

Run:

```powershell
node --test tests/providers/deepseek-stream.test.ts
```

Expected: PASS.

---

### Task 4: Regression Gate and Isolation Review

**Files:**
- No new implementation files.
- Verify only files listed in this plan changed, except pre-existing working-tree changes already present before execution.

- [ ] **Step 1: Run focused provider tests**

Run:

```powershell
node --test tests/providers/glm-tool-calling.test.ts tests/providers/deepseek-stream.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run deterministic tool-calling regression layer**

Run:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

Expected: PASS. This protects Qwen baseline behavior without changing Qwen files.

- [ ] **Step 3: Search for forbidden non-stream parser ownership**

Run:

```powershell
rg -n "protocol\\.parse\\(|parseToolCallsFromText|message\\.tool_calls|finish_reason: 'tool_calls'|finish_reason: \"tool_calls\"" src/main/proxy/adapters/glm.ts src/main/proxy/adapters/deepseek-stream.ts
```

Expected:

- `src/main/proxy/adapters/glm.ts` may still contain `ToolStreamParser` streaming references.
- `src/main/proxy/adapters/deepseek-stream.ts` may still contain streaming `ToolStreamParser` references.
- There must be no non-stream `protocol.parse(...)` call.
- There must be no non-stream `parseToolCallsFromText(...)` call.
- There must be no non-stream assignment that creates `message.tool_calls`.

- [ ] **Step 4: Confirm Qwen implementation files were not modified**

Run:

```powershell
git diff --name-only -- src/main/proxy/adapters/qwen.ts src/main/proxy/adapters/qwen-ai.ts src/main/proxy/toolCalling/providerProfiles.ts
```

Expected: no output.

- [ ] **Step 5: Review changed files**

Run:

```powershell
git diff -- src/main/proxy/adapters/glm.ts src/main/proxy/adapters/deepseek-stream.ts src/main/proxy/toolCalling/diagnostics.ts tests/providers/glm-tool-calling.test.ts tests/providers/deepseek-stream.test.ts
```

Expected:

- Adapter non-stream handlers preserve raw collected assistant text.
- Streaming handlers still use `ToolStreamParser`.
- Diagnostics store only structure facts and lengths.
- No prompt text, raw output text, tool argument text, or schema body is stored in diagnostics.

- [ ] **Step 6: Commit the phase**

Only after all checks pass, run:

```powershell
git add src/main/proxy/adapters/glm.ts src/main/proxy/adapters/deepseek-stream.ts src/main/proxy/toolCalling/diagnostics.ts tests/providers/glm-tool-calling.test.ts tests/providers/deepseek-stream.test.ts
git commit -m "fix: enforce provider single parser boundary"
```

---

## Validation Logic for Reviewers

Use this checklist when validating an implementation of this plan:

- GLM/DeepSeek non-stream adapters do not emit OpenAI `tool_calls`.
- GLM/DeepSeek non-stream adapters do not call legacy parser utilities.
- `ToolCallingEngine.applyNonStreamResponse` remains the only non-stream owner that can turn managed XML into OpenAI `tool_calls`.
- Streaming parser behavior is intentionally unchanged.
- DeepSeek empty output becomes observable via diagnostics, not hidden behind an empty assistant response.
- Diagnostics are structural and bounded: lengths, fragment type names, DONE flag, finish reason.
- No Qwen adapter/profile files are touched.
- No parser fallback is introduced from managed XML to bracket/OpenCode/legacy formats.
- No structural repair or validator changes are required by this plan.

## Expected Outcome

After this phase, Qwen remains the working baseline, GLM non-stream behavior becomes easier to reason about, and DeepSeek swallowed-output cases become diagnosable. This phase does not promise that GLM5.2 or DeepSeek will match Qwen3.7-Max tool reliability by itself; it removes two architecture-level sources of instability before provider-specific prompt/profile tuning.

