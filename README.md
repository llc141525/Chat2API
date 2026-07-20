# Chat2API

<p align="center">
  <img src="build/icons.png" alt="Chat2API" width="128" height="128">
</p>

<p align="center">
  <strong>A rebuilt desktop gateway for OpenAI-compatible AI clients</strong>
</p>

<p align="center">
  <a href="README_CN.md">中文</a> ·
  <a href="https://github.com/llc141525/Chat2API/issues">Issues</a> ·
  <a href="docs/providers/README.md">Provider guides</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-33%2B-47848F?logo=electron&logoColor=white" alt="Electron 33+">
  <img src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black" alt="React 18">
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white" alt="TypeScript 5">
  <img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="GPL-3.0 license">
</p>

Chat2API is a cross-platform Electron application and local API gateway. It turns several web-based AI providers into one OpenAI-compatible endpoint that can be used by OpenCode, Cline, Roo Code, Cherry Studio, custom scripts, and other clients.

This repository is the result of a complete runtime and tool-calling refactor. The project is designed around provider isolation, explicit request contracts, long-session continuity, and regression tests for the failure modes that matter in agent workflows.

![Chat2API preview](docs/screenshots/preview.png)

## Why this project

Most web-session gateways work for a single request, then become unreliable when an agent starts reading files, invoking tools, compacting context, or switching between streaming and non-streaming responses. Chat2API treats those flows as first-class behavior:

- one local OpenAI-compatible API for multiple providers;
- a single managed tool-calling engine instead of provider-specific prompt injection;
- provider sessions and client sessions kept separate and explicit;
- tool catalogs, assistant tool calls, tool results, and summaries preserved across turns;
- observable request, session, routing, and tool-runtime boundaries;
- deterministic fixtures, provider tests, and long-conversation capability probes.

## Highlights

### Provider gateway

- OpenAI-compatible Chat Completions API.
- Provider and model mapping with account selection and failover strategies.
- Built-in account, credential, API key, proxy, model, and request-log management.
- Streaming and non-streaming response normalization.
- Optional custom headers for provider-specific capabilities such as search or thinking modes.
- System-tray desktop application with English and Simplified Chinese UI.

### Agent-grade tool calling

- Canonical managed XML protocol for providers without native OpenAI tool calls.
- Strict parsing of valid tool blocks while ignoring ordinary XML examples, angle brackets, fenced code, malformed blocks, and unknown tools.
- Correct OpenAI `tool_calls` conversion for both streaming deltas and non-streaming messages.
- Preservation of `tool_call_id` and assistant tool-call history on later turns.
- Stateless fallbacks when session metadata is unavailable.
- Tool catalog persistence and drift detection to prevent a long-running agent from silently losing tools.

### Long-context continuity

- Provider session reuse for supported providers, including GLM and Qwen paths.
- Explicit session-boundary planning for OpenAI-compatible routes.
- Context classification, prompt-budget control, summary quality gates, and summary sanitization.
- Workflow state digests so compaction reduces context without erasing the current task.
- Regression coverage for repeated tool calls, tool loss after compaction, summary contamination, and multi-turn history.

### Built-in observability and testing

- Dashboard, request logs, provider health, model catalog, and proxy status in the desktop UI.
- Reproducible provider fixtures and parser-level tests.
- Capability probes for OpenCode-style long conversations.
- CI checks for adapter boundaries, tool-calling behavior, and provider regressions.

## Supported providers

The built-in provider adapters currently cover:

| Provider | Default models | Guide |
| --- | --- | --- |
| DeepSeek | deepseek-v4-flash, deepseek-v4-pro | [Guide](docs/providers/deepseek.md) |
| GLM | GLM-5.2, GLM-5.1 | [Guide](docs/providers/glm.md) |
| Kimi | Kimi-K3, Kimi-K2.6 | [Guide](docs/providers/kimi.md) |
| MiniMax | MiniMax-M2.7 | [Guide](docs/providers/minimax.md) |
| Mimo | MiMo-V2.5-Pro-UltraSpeed, MiMo-V2.5-Pro, MiMo-V2.5, MiMo-V2-Flash | [Guide](docs/providers/mimo.md) |
| Perplexity | Auto | [Guide](docs/providers/perplexity.md) |
| Qwen | Qwen3.6, Qwen3.7-Max, Qwen3.5-Flash, Qwen3-Max, Qwen3-Max-Thinking-Preview, Qwen3-Coder | [Guide](docs/providers/qwen.md) |
| Qwen AI | Qwen3.7-Max, Qwen3.6-Plus, Qwen3.6-35B-A3B, Qwen3.6-27B, Qwen3-Coder | [Guide](docs/providers/qwen-ai.md) |
| Z.ai | Temporarily unavailable due to frontend captcha risk control | [Guide](docs/providers/zai.md) |

Provider authentication methods and available model names change over time. Check the individual guide and the in-app provider catalog instead of hard-coding a model list in client configuration.

## Install

Download a packaged build from [GitHub Releases](https://github.com/llc141525/Chat2API/releases) when releases are available. Supported build targets are Windows x64, macOS arm64/x64, and Linux x64/arm64.

## Build from source

Requirements: Node.js 20 or newer, npm, and Git.

~~~bash
git clone https://github.com/llc141525/Chat2API.git
cd Chat2API
npm ci
npm run dev:win       # Windows development
~~~

Build the application:

~~~bash
npm run build
npm run build:win
npm run build:mac
npm run build:linux
~~~

The packaged artifacts are written to `dist/` and are intentionally ignored by Git.

## Quick start

1. Start Chat2API and add a provider account from the **Providers** page.
2. Open **Proxy**, choose a port and routing strategy, then start the local proxy.
3. Create an API key if client authentication is enabled.
4. Point an OpenAI-compatible client at `http://127.0.0.1:<port>/v1`.

Example with the OpenAI Python SDK:

~~~python
from openai import OpenAI

client = OpenAI(
    api_key="your-chat2api-key",
    base_url="http://127.0.0.1:48763/v1",
)

response = client.chat.completions.create(
    model="your-provider-model",
    messages=[{"role": "user", "content": "Hello from Chat2API"}],
)

print(response.choices[0].message.content)
~~~

Use the provider guides for authentication, account setup, model mapping, and provider-specific options.

## Development and verification

Run the focused regression suites:

~~~bash
npm run build
node --test tests/tool-calling/*.test.ts
node --test tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
~~~

For a real local proxy probe, start the development server and run the capability script:

~~~powershell
npm run dev:win 2>&1 | Tee-Object -FilePath .\dev.log
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "glm/GLM-5.2"
~~~

The test and probe suites are intentionally focused on behavior, not only compilation: multi-turn tool calls, streaming conversion, catalog continuity, compaction survival, session identity, and degraded provider responses.

## Architecture

~~~text
OpenAI-compatible client
          │
          ▼
Koa proxy / route identity / API keys
          │
          ▼
Forwarder + RequestAssembly + ProviderRuntime
          │
          ├── ToolCallingEngine
          │     ├── tool catalog and managed prompt
          │     ├── managed XML parser
          │     └── OpenAI stream/message conversion
          │
          ├── context economy and session boundary services
          └── provider adapters and web sessions
~~~

Important source areas:

- `src/main/proxy/forwarder.ts` — request routing and response flow;
- `src/main/proxy/adapters/` — provider-specific transport and conversion;
- `src/main/proxy/toolCalling/` — tool contracts, prompt injection, parsing, and normalization;
- `src/main/proxy/services/` — provider runtime, session boundaries, context economy, and summaries;
- `src/renderer/src/` — the React desktop UI;
- `tests/` — unit, integration, fixture, and capability tests.

## Data and security

Chat2API is a local gateway. Account credentials and provider session data are managed by the desktop app and stored in the user's application data directory. Do not paste tokens, cookies, refresh tokens, request logs, or provider session exports into issues or pull requests. Redact secrets before sharing diagnostics.

Web-session adapters depend on provider-side authentication, availability, rate limits, and terms of service. A provider may change its web interface without notice; provider support should therefore be treated as compatibility support, not an official provider API guarantee.

## Contributing

Bug reports and provider regressions are welcome. Please include the operating system, Chat2API version or commit, provider/model, reproduction steps, and a redacted log excerpt. Start with [provider guides](docs/providers/README.md) and the existing test fixtures before adding a new adapter.

Before opening a pull request:

~~~bash
npm run build
git diff --check
~~~

Keep provider-specific behavior inside the adapter/profile boundary. Tool prompt injection and managed XML parsing belong to the shared tool-calling engine.

## License and attribution

Chat2API is released under the [GNU GPL-3.0 license](LICENSE).

The project builds on the original [xiaoY233/Chat2API](https://github.com/xiaoY233/Chat2API) and has since undergone a substantial runtime, context-management, tool-calling, testing, and UI refactor.
