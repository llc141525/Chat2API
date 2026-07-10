# P2 Angle-Bracket Leakage Writing Plan

Date: 2026-07-10
Parent spec: `docs/superpowers/specs/2026-07-10-agent-tooling-stability-spec.md`

## Objective

Stop protocol fragments and garbled angle-bracket residues from leaking to clients while preserving ordinary user/model text that legitimately contains `<` and `>`.

The goal is not to fear angle brackets. The goal is to distinguish ordinary text from managed tool protocol boundaries.

## User-Visible Symptoms

- Replies contain fragments like `|tool_calls>`.
- Replies contain chopped managed XML markers.
- Tool result content containing fake XML causes the assistant to echo protocol-looking garbage.
- Qwen emits suffix residue after provider-side cumulative snapshot rewrites.

## Scope

Primary files:

- `src/main/proxy/toolCalling/ToolStreamParser.ts`
- `src/main/proxy/toolRuntime/data/stream/StreamGate.ts`
- `src/main/proxy/toolRuntime/data/protocols/managedXmlStructure.ts`
- `src/main/proxy/toolRuntime/data/repair/StructuralRepair.ts`
- `src/main/proxy/adapters/qwen.ts`

Primary tests:

- `tests/tool-calling/tool-stream-parser.test.ts`
- `tests/tool-calling/output-inspection.test.ts`
- `tests/providers/qwen-request-routing.test.ts`
- new or existing Qwen stream fixture tests under `tests/providers/`

## Required Distinctions

Must remain content:

- `<tag>value</tag>`
- `<<<<<>>>>>`
- `fake_xml=<xml><body>test</body></xml>`
- escaped `&lt;tool_calls&gt;`
- fenced XML examples
- string parameters containing JSON-looking or XML-looking text

Must not leak:

- `<|CHAT2API|tool_calls`
- `<|CHAT2API|tool_calls>`
- `</|CHAT2API|tool_calls>`
- `|tool_calls>`
- `<tool_calls>` fragments when selected protocol has started buffering
- provider-sliced closing tags after a tool call has already emitted

## Writing Sequence

### Step 1: Inventory Marker Detection

Read the marker detection paths in:

- `ToolStreamParser`
- `StreamGate`
- `managedXmlStructure`
- `StructuralRepair`

Write down which component owns:

- detecting possible tool-call starts
- buffering partial markers
- deciding plain text vs malformed tool output
- suppressing post-tool-call content

Avoid duplicating marker rules in provider adapters unless they are provider-specific stream transport rules.

### Step 2: Add Regression Fixtures For Plain Text

Add tests proving ordinary angle-bracket text is safe:

- normal XML-looking text remains text
- escaped XML remains text
- fenced tool-call examples remain text
- CDATA argument preserves fake XML and marker-looking substrings

These tests protect against overcorrecting by suppressing all angle-bracket content.

### Step 3: Add Regression Fixtures For Partial Markers

Add tests proving incomplete protocol fragments do not leak:

- push partial start marker then flush
- push valid tool call then later closing-marker residue
- push unknown malformed tool block then flush
- split markers across chunks
- split markers across provider snapshots

Expected behavior:

- valid complete tool call emits tool call
- incomplete marker is suppressed or held until classified
- malformed protocol-like output is diagnosed, not emitted as normal assistant text

### Step 4: Fix Post-Tool-Call Locking

Once `ToolStreamParser` emits a tool call:

- no later normal content should be emitted for that assistant message
- later marker residue should be suppressed
- final finish should be `tool_calls`
- diagnostics should record suppressed malformed provider output

This is shared P0/P2 work. P0 cares that replies are not swallowed silently; P2 cares that marker residue does not leak.

### Step 5: Fix Qwen Snapshot Diffing

Replace length-only cumulative snapshot diffing with prefix-aware handling:

- If `newContent.startsWith(previousContent)`, emit only the suffix.
- If not, treat it as a rewrite.
- In managed tool mode, do not emit `newContent.substring(previousContent.length)`.
- Re-parse or gate the full new snapshot until it is safe to emit.

Add fixture tests where Qwen rewrites:

```text
previous: <|CHAT2API|tool_calls>...
new:      ...</|CHAT2API|tool_calls>
```

The adapter must not emit suffix residue such as `|tool_calls>`.

## Test Plan

Focused:

```powershell
node --test tests/tool-calling/tool-stream-parser.test.ts
```

Provider-focused:

```powershell
node --test tests/providers/qwen-request-routing.test.ts
```

Full deterministic gate:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

## OpenCode Verification

The OpenCode probe already includes edge-case input fields:

- `angle_text`
- `fake_xml`
- `chat2api_marker`

Run:

```powershell
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "glm/GLM-5.2"
```

For Qwen leakage:

```powershell
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "qwen/Qwen3.7-Max"
```

The verifier must continue checking the generated JSON and OpenCode event stream, not only final assistant text.

## Acceptance Criteria

- Ordinary angle-bracket text is preserved.
- Fenced examples are not parsed.
- CDATA preserves fake XML and marker-looking content.
- Partial protocol markers do not leak.
- Text after streamed tool calls does not leak.
- Qwen snapshot rewrites do not produce suffix residue.

## Stop Conditions

Stop and write a follow-up if:

- A provider emits transport-level fragments that cannot be reconstructed without raw event capture.
- The parser cannot distinguish a valid partial marker from ordinary text without delaying all output.
- Fixing leakage requires changing the managed XML grammar.
