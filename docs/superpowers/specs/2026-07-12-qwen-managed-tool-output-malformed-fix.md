# Qwen Managed Tool Output Malformed Fix

Date: 2026-07-12

## Problem

OpenCode session `ses_0a9bd8f64ffePz1Avje6bpBHup` could reproduce:

```text
Error: Provider returned malformed tool output without usable assistant content for managed tool turn qwen:Qwen3.7-Max
```

The failure was not caused by lost tool definitions. The logged request still contained tool names such as `bash`, `edit`, `read`, `question`, `todowrite`, and `write`. The latest regression response contained malformed managed XML for `todowrite`, with `todos` emitted as a recoverable object sequence instead of strict JSON matching the declared array parameter.

## Root Cause

Qwen can emit recoverable but non-canonical managed tool output:

- `question.questions` is emitted as one JSON object even though OpenCode declares it as an array.
- `todowrite.todos` may be emitted as a truncated array prefix, or as a bare object sequence such as `{todo1}, {todo2}, {truncated`.
- CDATA or parameter closing markers can be truncated.
- Tool XML tails can be polluted by invoke or container close markers.
- JSON payloads can be almost complete, for example stopping after an `options` array or appending closing-brace noise.

The parser previously classified these as malformed and OpenCode received neither usable assistant text nor usable `tool_calls`.

## Fix

The repair path now remains schema-gated and intentionally narrow:

- Array schema parameters may accept a singleton JSON object by wrapping it in an array.
- Recoverable JSON object prefixes are parsed for singleton array parameters.
- Recoverable JSON array prefixes keep only complete elements and discard the truncated trailing item.
- Recoverable bare object sequences for array parameters are converted into arrays of complete objects.
- Malformed managed XML extraction can recover unclosed CDATA only when the payload is JSON-like.
- Invoke and container close markers are treated as parameter boundaries during malformed-intent extraction.
- Plain string tools such as a half-written `bash` command remain malformed when the container has no close marker.
- Streaming malformed-reason logs now include the validation detail, not only the coarse failure kind.

## Acceptance

Deterministic gate:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

Result after the latest `todowrite` regression tests: `267/267` passed.

Build gate:

```powershell
npm run build
```

Result: passed.

Live evidence:

- A prior clean run against the reported OpenCode session reached a real `question` tool invocation (`message=asking`, `questions=1`) instead of returning malformed tool output.
- A rerun against `ses_0a9bd8f64ffePz1Avje6bpBHup` initially reproduced `todowrite` with `schema_validation_failed`.
- After adding `todowrite.todos` array-prefix and bare-object-sequence recovery, another `继续` run did not emit `ToolStreamParser` malformed/drop logs and OpenCode proceeded into real tool execution (`edit` permission checks and formatting of `src/renderer/src/index.css`) before exiting the loop.
- `opencode run --command undo` returned an OpenCode `UnknownError`, so CLI undo was not available during this validation.

## Residual Work

The non-Qwen OpenCode model probe matrix is not complete:

- `deepseek/deepseek-v4-flash` passed.
- `glm/GLM-5.2` reached tools but did not produce the expected result file.
- `kimi/Kimi-K2.6`, `minimax/MiniMax-M2.7`, `mimo/MiMo-V2.5-Pro`, `zai/GLM-5.1`, and `perplexity/Auto` still need provider-specific follow-up.

Temporary logs such as `部分日志.txt`, `dev.codex.log`, `.agent-probe`, and `.agent-probe-matrix` may contain provider/session data and must not be committed without review.
