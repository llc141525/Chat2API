# AGENTS.md

## Project Understanding

Chat2API Manager is an Electron desktop app that exposes an OpenAI-compatible API proxy for multiple web AI providers. The main process owns provider credentials, OAuth/login flows, persistent store, request forwarding, session management, and tool-call conversion. The renderer is a React/Tailwind UI for providers, accounts, proxy settings, models, logs, and app settings.

Key paths:
- `src/main/proxy/forwarder.ts` routes OpenAI-compatible requests to provider adapters.
- `src/main/proxy/adapters/` converts provider-specific request/response formats.
- `src/main/proxy/toolCalling/` normalizes OpenAI/OpenCode tools, injects managed prompts, parses model-produced tool calls, and converts them back to OpenAI `tool_calls`.
- `src/main/proxy/sessionManager.ts` manages single-turn and multi-turn provider context.
- `src/main/store/types.ts` and `src/main/providers/builtin/` both define built-in provider configuration; keep model lists synchronized in both places.
- `src/renderer/src/` contains the React UI and Zustand stores.

## Commands

```powershell
npm run dev:win
npm run build
npm run preview
```

For Windows development logs:

```powershell
npm run dev:win 2>&1 | Tee-Object -FilePath .\dev.log
```

## Coding Rules

- Preserve immutability: create new objects/arrays instead of mutating existing state.
- Validate input at system boundaries: API requests, provider responses, IPC payloads, file/import data, and user-entered credentials.
- Never silently swallow errors. Log server-side detail and return UI-safe messages at user-facing boundaries.
- Treat external provider responses and model output as untrusted data.
- Do not remove unrelated user changes in the worktree.
- When adding or updating a built-in provider, update both `src/main/providers/builtin/<provider>.ts` and the matching entry in `src/main/store/types.ts`.

## Tool Calling Requirements

Chat2API must support OpenCode-style tool use through providers that do not expose native OpenAI tool calling.

Required behavior:
- `ToolCallingEngine` is the single owner of managed tool prompt injection and response parsing decisions.
- Provider adapters must not add a second legacy tool prompt when the forwarder already transformed the request.
- Managed XML is the canonical prompt/history/parse format for GLM, Qwen, and Qwen AI unless a provider profile explicitly says otherwise.
- Streaming responses must convert valid managed tool-call blocks to OpenAI `delta.tool_calls` and end with `finish_reason: "tool_calls"`.
- Non-streaming responses must convert valid managed tool-call blocks to `message.tool_calls`, set `message.content` to `null`, and set `finish_reason: "tool_calls"`.
- Multi-turn requests must preserve assistant `tool_calls` and tool `tool_call_id`; otherwise later turns can look like plain text and stop using tools.
- Ordinary model text containing angle brackets, XML examples, escaped tags, malformed tool blocks, unknown tool names, or fenced examples must not become tool calls.

## Final Test

After any large feature or behavior change, run the final gate. This gate has two layers: deterministic local regression tests first, then a real OpenCode model probe. The final gate passes only when both layers pass.

### 1. Deterministic Regression Layer

Run these tests before the model probe:

```powershell
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
```

These tests must cover the protocol edges that real models can hide by luck:
- Valid managed XML emits OpenAI tool calls.
- Bracket-format output is ignored when the selected plan expects managed XML.
- Stream parsing handles protocol markers split across chunks without leaking partial markers.
- Non-stream responses are parsed and converted to `message.tool_calls`.
- Fenced examples and ordinary angle-bracket text remain plain content.
- Unknown, malformed, or incomplete tool blocks do not emit tool calls.
- CDATA/tool arguments preserve literal text containing `<`, `>`, XML-like strings, JSON, and newlines.
- GLM, Qwen, and Qwen AI use `transformRequestForPromptToolUse` and apply non-stream tool parsing.
- Multi-turn assistant `tool_calls` and tool `tool_call_id` metadata survive context processing.

If a bug is found in any of these areas, add or update a deterministic test first, verify it fails for the bug, then fix the implementation.

### 2. OpenCode Model Probe Layer

Start the app and keep it running:

```powershell
npm run dev:win 2>&1 | Tee-Object -FilePath .\dev.log
```

Then run the OpenCode probe with the model under test:

```powershell
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "GLM-5.2"
```

The probe files live in:

```text
tests/agent-capability/
  input.txt
  prompt.md
  verify-opencode-capability.ps1
.opencode/skills/agent-capability-probe/SKILL.md
```

The verifier must save raw OpenCode JSON events to `.agent-probe/opencode-events.ndjson` and must fail unless all of these are true:
- `.agent-probe/result.json` exactly matches locally computed SHA-256, byte length, line count, and fixed edge-case echo fields from `tests/agent-capability/input.txt`.
- The OpenCode event stream contains a real `agent-capability-probe` skill invocation.
- The event stream contains at least two non-skill tool calls.
- At least one tool call happens after the first tool result/observation event, proving multi-turn tool use rather than single-turn-only behavior.
- The final assistant text contains `CAPABILITY_PROBE_DONE`.

Do not accept a test that only checks the assistant's final text or a generated JSON file. The authoritative evidence is the generated JSON plus OpenCode's recorded skill/tool event stream.

The probe must remain deterministic: fixed local input, no network dependency, no time-based expected values, no randomness, and no open-ended grading by the model.
