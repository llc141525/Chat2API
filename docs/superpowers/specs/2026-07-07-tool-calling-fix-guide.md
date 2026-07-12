# Tool Calling Reliability Fix Guide

Date: 2026-07-07

This document is a handoff guide for fixing the current tool-calling reliability gaps. It is written for an AI agent that will implement the fix after the investigation tests have been added.

## Goal

Fix these observed failures without weakening the existing tool-calling invariants:

- Multi-turn sessions must keep the full tool catalog when a stable session catalog exists.
- Streamed managed XML tool calls must not emit `tool_calls` when required parameters are missing.
- Non-stream managed XML validation must reject object/array parameters that are not valid JSON for their schema.
- Valid object/array parameters should be assembled into OpenAI `function.arguments` as real JSON values, not stringified JSON text.
- Ordinary angle-bracket text, fenced examples, malformed XML, unknown tools, and mixed protocol markers must remain plain text or blocked.

Keep `ToolCallingEngine` as the single owner of managed prompt injection. Do not reintroduce prompt injection in provider adapters.

## Current Evidence

The investigation added these tests:

- `tests/tool-calling/tool-stream-parser.test.ts`
  - `stream parser rejects allowed tool calls that omit required parameters`
- `tests/tool-runtime/data/validator.test.ts`
  - `object parameter with non-json text is rejected before OpenAI tool call assembly`
  - `array parameter with scalar text is rejected before OpenAI tool call assembly`
- `tests/tool-calling/catalog-fallback.test.ts`
  - `session catalog keeps full tool set even when later history only mentions one tool`
  - `history-only recovery cannot restore unobserved tools from an earlier full tool list`

Run the focused failure set first:

```powershell
node --test tests/tool-calling/tool-stream-parser.test.ts tests/tool-runtime/data/validator.test.ts tests/tool-calling/catalog-fallback.test.ts tests/tool-calling/output-inspection.test.ts
```

Expected before the fix:

- 3 failures.
- The stream parser emits a tool call even though `filePath` is missing.
- The structural validator accepts `options: "not json"` for an object parameter.
- The structural validator accepts `tags: "safe"` for an array parameter.

Run the project deterministic gate:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

Expected before the fix:

- 1 failure, the new stream missing-required-parameter test.

## Root Causes

### 1. Stream parser bypasses schema validation

File: `src/main/proxy/toolCalling/ToolStreamParser.ts`

`ToolStreamParser.push()` calls `parseBufferedToolCall()`, which currently delegates directly to `getToolProtocol(plan.protocol).parse(...)`. If the legacy parser returns any parsed tool call, the stream parser immediately emits OpenAI `delta.tool_calls`.

That path validates the tool name but not required parameters or schema shape. A model can stream:

```xml
<|CHAT2API|tool_calls><|CHAT2API|invoke name="default_api:read_file"><|CHAT2API|parameter name="path">/tmp/a</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>
```

and Chat2API will emit a `default_api:read_file` tool call even though the declared schema requires `filePath`.

### 2. Structural validator only checks presence and empty complex payloads

File: `src/main/proxy/toolRuntime/data/validation/ToolCallValidator.ts`

The validator checks:

- unknown tool name
- missing required parameters
- empty payload for object/array parameters

It does not currently validate that an object parameter contains valid JSON object text, or that an array parameter contains valid JSON array text.

### 3. Assembler preserves raw payload as string

File: `src/main/proxy/toolRuntime/data/assembly/ToolCallAssembler.ts`

`unwrapParameterPayload()` currently returns `parameter.rawPayload` for every parameter. That means:

```xml
<|CHAT2API|parameter name="options">{"mode":"safe"}</|CHAT2API|parameter>
```

becomes:

```json
{"options":"{\"mode\":\"safe\"}"}
```

For object/array schemas, it should become:

```json
{"options":{"mode":"safe"}}
```

## Recommended Fix Plan

### Step 1: Add a small schema-aware payload helper

Create a helper near the validation/assembly layer, for example:

- `src/main/proxy/toolRuntime/data/validation/schemaPayload.ts`, or
- local helpers in `ToolCallValidator.ts` plus exported helpers if assembly also needs them.

The helper should answer two questions:

- Is this raw payload valid for the schema?
- What JavaScript value should be assembled into OpenAI `function.arguments`?

Minimum behavior:

- `schema.type === 'object'`
  - raw payload must parse as a non-null JSON object and not an array.
  - assembled value should be that object.
- `schema.type === 'array'`
  - raw payload must parse as a JSON array.
  - assembled value should be that array.
- primitive schemas (`string`, `number`, `integer`, `boolean`)
  - keep current compatibility unless there is already a project convention for strict primitive validation.
  - Do not parse string payloads just because they look like JSON; a string schema should remain a string.
- missing schema
  - keep current behavior, because restored history stubs use `{ type: 'object', additionalProperties: true }` at the tool parameter root and may not have per-property schemas.

Be careful with CDATA. CDATA should preserve literal text for string schemas, including `<`, `>`, XML-like examples, JSON-looking text, and newlines.

### Step 2: Strengthen `validateToolCallStructure`

Update `src/main/proxy/toolRuntime/data/validation/ToolCallValidator.ts`.

After `missingRequiredParameters()` and before pushing `validated`, validate each present parameter against its property schema:

- Find `tool.parameters.properties[param.rawName]`.
- If the property schema is `object` or `array`, parse `param.rawPayload`.
- Return `schema_validation_failed` when the payload cannot be parsed into the required shape.
- Include the parameter name in `failure.detail`; the existing tests assert `/options/` and `/tags/`.

Add positive tests in `tests/tool-runtime/data/validator.test.ts` while fixing:

- valid object payload is accepted.
- valid array payload is accepted.
- string payload containing JSON-looking text remains valid when schema says `string`.

### Step 3: Assemble complex values as JSON values

Update `src/main/proxy/toolRuntime/data/assembly/ToolCallAssembler.ts`.

`parametersToObject()` needs access to the tool schema for the current call. Recommended shape:

- In `assembleOpenAIToolCalls()`, find the matching tool once.
- Pass that tool to `parametersToObject(call.parameters, tool)`.
- In `unwrapParameterPayload(parameter, schema)`, parse JSON for object/array schemas only.
- Keep primitive/string payload behavior unchanged.

Add tests in `tests/tool-runtime/data/assembler.test.ts` or extend an existing data-chain test:

- object parameter assembles as an object.
- array parameter assembles as an array.
- string parameter with `{"x":1}` assembles as the literal string, not an object.

### Step 4: Make stream managed XML use the same schema safety

Update `src/main/proxy/toolCalling/ToolStreamParser.ts`.

Do not blindly emit parsed tool calls from the legacy protocol parser when `plan.protocol === 'managed_xml'`.

Preferred approach:

1. Keep marker detection as-is, because it already handles partial markers and fenced ranges.
2. When a full managed XML buffer is ready, validate it before emitting.
3. For Chat2API managed XML containers, use:
   - `getStructureProtocolAdapter(plan.protocol).extractStructure(buffer)`
   - `validateToolCallStructure(...)`
   - `assembleOpenAIToolCalls(...)`
4. If validation returns `valid_structure`, emit assembled tool calls.
5. If validation returns `invalid_structure`, suppress the buffer and set `suppressedMalformedToolOutput`.
6. If validation returns `plain_text`, keep existing buffering behavior until flush or a known malformed/full legacy parse result is detected.

Important compatibility warning:

- `src/main/proxy/toolRuntime/data/protocols/registry.ts` currently only registers structural support for `managed_xml`.
- Existing tests still cover `managed_bracket` and canonical XML compatibility forms like `<tool_calls><invoke ...>`.
- Do not route `managed_bracket` through `getStructureProtocolAdapter()` unless you also implement a structural bracket adapter.
- Either keep legacy parsing for `managed_bracket`, or add structural adapters and tests for every protocol.

For canonical XML compatibility (`<tool_calls><invoke ...>`), choose one:

- Add canonical XML support to `managedXmlStructureAdapter`, then use structural validation for both Chat2API XML and canonical XML.
- Or keep a legacy parser fallback for canonical XML but run a lightweight schema validator over the resulting OpenAI-style tool call arguments before emitting.

The second option is smaller; the first option is cleaner long term.

### Step 5: Normalize stream suppression diagnostics

When a stream tool buffer is blocked because of schema validation:

- Set `suppressedMalformedToolOutput = true`.
- Use `suppressedReason = 'malformed_tool_output'`.
- Do not leak the raw malformed tool XML to the client after a previous tool call has already emitted.
- Avoid throwing from stream parsing for bad model output; this is untrusted provider output.

## Non-Goals

Do not do these in this fix:

- Do not change provider adapter prompt injection ownership.
- Do not delete legacy parser support without equivalent tests.
- Do not make history-only fallback pretend it has full tool definitions it cannot know.
- Do not reject ordinary assistant text just because it contains angle brackets.
- Do not parse fenced examples as tool calls.
- Do not run the OpenCode model probe until deterministic tests are green.

## Acceptance Checklist

The fix is ready when all of these pass:

```powershell
node --test tests/tool-calling/tool-stream-parser.test.ts tests/tool-runtime/data/validator.test.ts tests/tool-calling/catalog-fallback.test.ts tests/tool-calling/output-inspection.test.ts
```

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

Also run the relevant tool-runtime data tests:

```powershell
node --test tests/tool-runtime/data/*.test.ts
```

Only after deterministic tests pass, run the real OpenCode probe:

```powershell
npm run dev:win 2>&1 | Tee-Object -FilePath .\dev.log
```

```powershell
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "glm/GLM-5.2"
```

## Expected Final Behavior

- A streamed tool call with the wrong parameter name is suppressed, not emitted.
- A non-stream tool call with object/array parameters must use valid JSON payloads.
- Valid object/array payloads are passed to tools as object/array JSON values.
- A string parameter containing `<tag>`, `{"json":"looking"}`, or newline text stays a string.
- Same-session catalog reuse keeps complete tool descriptions and schemas.
- Session-miss history fallback remains degraded and only restores observed tool names.
