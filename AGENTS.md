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

## Tool Injection Rules

The following invariants are enforced across the codebase. Violations must be caught in code review and blocked by CI.

- INV-001 [Single Ownership]: `ToolCallingEngine` is the sole owner of tool prompt injection. Provider Adapters must never import `hasToolPromptInjected`, `toolsToSystemPrompt`, `TOOL_WRAP_HINT`, or `shouldInjectToolPrompt`.
- INV-002 [Stateless Fallback]: Any tool resolution logic depending on Session Store must have a stateless degradation path: `Session Store → Message History Extraction → Request Tools → Safe Empty`. Returning an empty tool list without fallback is forbidden.
- INV-003 [Delete = Risk]: Deleting any tool/message processing code during refactoring requires explicit declaration of original purpose and equivalent coverage proof in the PR description. Unprovable deletions must be retained with `// TODO: investigate why this exists`.
- INV-004 [Client Quirks Matrix]: All tool-calling changes must be verified against the known client behavior quirks list, not solely against OpenAI official documentation.

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

## Development Loop

Every non-trivial change follows this cycle. See `CLAUDE.md` for full details.

```
探索 → 定计划 → 改代码 → 本地测试 → Probe 测试 → 日志汇总分析
  ↑                                                           │
  └──────────────── 发现问题，回到探索 ────────────────────────┘
```

### 1. 本地测试 (Local Regression)

```powershell
# 核心
node --test tests/tool-calling/*.test.ts tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts tests/services/summarySanitizer.test.ts tests/services/contextManagement-summary-input-sanitization.test.ts tests/services/contextPayloadClassifier.test.ts

# 按改动范围追加
node --test tests/providers/multi-turn-conversation.test.ts
node --test tests/providers/provider-flow.test.ts
node --test tests/services/promptBudget-context-economy.test.ts
```

Covers: managed XML emit, bracket ignore, split-chunk parsing, non-stream parsing, fenced examples, CDATA, multi-turn tool_call_id preservation, summary sanitization, payload classification.

### 2. Probe 测试 (Model Probe)

```powershell
# Terminal 1: 启动 proxy，保留日志
npm run dev:win 2>&1 | Tee-Object -FilePath .\dev.log

# Terminal 2: 跑 probe
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "glm/GLM-5.2"
```

Probe 验证: multi-turn tool calling, non-stream conversion, catalog continuity across sessions, tool survival after compact.

### 3. 日志汇总分析

```powershell
.\scripts\extract-session-log.ps1 -LogPath .\dev.log
```

输出 session 时间线表格。关注: `REJ:*` (summary rejected)、compact 后 provider session 不变、`FALLBACK`、ctx 缩减但无 summary、子 session 未清理 (`tool_child` 无 `del:`)。

发现异常 → 回到探索步骤。
