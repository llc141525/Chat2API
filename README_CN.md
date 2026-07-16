# Chat2API

<p align="center">
  <img src="build/icons.png" alt="Chat2API" width="128" height="128">
</p>

<p align="center">
  <strong>经过完全重构的 OpenAI 兼容 AI 客户端桌面网关</strong>
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="https://github.com/llc141525/Chat2API/issues">问题反馈</a> ·
  <a href="docs/providers/README.md">Provider 文档</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-33%2B-47848F?logo=electron&logoColor=white" alt="Electron 33+">
  <img src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black" alt="React 18">
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white" alt="TypeScript 5">
  <img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="GPL-3.0 license">
</p>

Chat2API 是一个跨平台 Electron 桌面应用和本地 API 网关。它把多个基于 Web 会话的 AI 服务商统一为一个 OpenAI 兼容接口，可直接连接 OpenCode、Cline、Roo Code、Cherry Studio、自定义脚本以及其他兼容客户端。

当前仓库已经完成运行时和工具调用架构的整体重构。项目围绕 Provider 隔离、显式请求契约、长会话连续性和真实故障回归测试设计，重点解决 Agent 在读文件、连续调用工具、上下文压缩和流式响应中的稳定性问题。

![Chat2API 预览](docs/screenshots/preview.png)

## 为什么要使用 Chat2API

很多 Web 会话网关只能处理单次请求；当 Agent 开始连续读文件、调用工具、压缩上下文或切换流式模式后，就容易出现工具丢失、重复调用、历史污染或响应格式异常。Chat2API 把这些流程作为核心能力处理：

- 一个本地 OpenAI 兼容 API 接入多个 Provider；
- 由统一的托管工具调用引擎负责提示词注入和解析；
- Provider 会话与客户端会话明确分离；
- 工具目录、助手工具调用、工具结果和摘要跨轮次保留；
- 请求、会话、路由和工具运行时边界可观测；
- 使用 fixtures、Provider 测试和长对话能力探针覆盖真实故障模式。

## 核心亮点

### 统一 Provider 网关

- 提供 OpenAI 兼容 Chat Completions API。
- 支持 Provider/模型映射、账户选择和故障转移策略。
- 在桌面 UI 中管理账户、凭证、API Key、代理、模型和请求日志。
- 统一处理流式和非流式响应。
- 支持通过自定义 Header 开启搜索、思考等 Provider 特有能力。
- 系统托盘应用，支持英文和简体中文界面。

### 面向 Agent 的工具调用

- 为不支持原生 OpenAI 工具调用的 Provider 提供统一托管 XML 协议。
- 只解析合法工具块，忽略普通 XML 示例、尖括号、代码围栏、损坏块和未知工具。
- 正确把流式工具块转换为 OpenAI `delta.tool_calls`。
- 正确把非流式工具块转换为 `message.tool_calls`，并设置 `finish_reason: "tool_calls"`。
- 跨轮次保留 `tool_call_id` 和助手工具调用历史。
- Session 元数据不可用时提供无状态降级路径。
- 持久化工具目录并检测工具漂移，避免长任务中工具静默丢失。

### 长上下文连续性

- 为支持的 Provider 提供会话复用，包括 GLM 和 Qwen 路径。
- 为 OpenAI 兼容路由显式规划 Session 边界。
- 提供上下文分类、Prompt 预算控制、摘要质量门禁和摘要清洗。
- 通过工作流状态摘要在压缩上下文后保留当前任务状态。
- 覆盖重复工具调用、压缩后工具丢失、摘要污染和多轮历史回归。

### 可观测性和测试体系

- 提供仪表盘、请求日志、Provider 状态、模型目录和代理状态。
- 使用可复现的 Provider fixtures 和解析器测试。
- 提供 OpenCode 风格长对话能力探针。
- CI 检查适配器边界、工具调用行为和 Provider 回归。

## 支持的 Provider

当前内置适配器包括：

| Provider | 文档 |
| --- | --- |
| DeepSeek | [使用说明](docs/providers/deepseek.md) |
| GLM | [使用说明](docs/providers/glm.md) |
| Kimi | [使用说明](docs/providers/kimi.md) |
| MiniMax | [使用说明](docs/providers/minimax.md) |
| MiMo | [使用说明](docs/providers/mimo.md) |
| Perplexity | [使用说明](docs/providers/perplexity.md) |
| Qwen | [使用说明](docs/providers/qwen.md) |
| Qwen AI | [使用说明](docs/providers/qwen-ai.md) |
| Z.ai | [使用说明](docs/providers/zai.md) |

Provider 的认证方式、可用模型和风控策略会变化，请以对应文档和应用内模型目录为准，不要在客户端配置中固定过时的模型列表。

## 安装

如果已有发布版本，请从 [GitHub Releases](https://github.com/llc141525/Chat2API/releases) 下载。当前构建目标包括 Windows x64、macOS arm64/x64，以及 Linux x64/arm64。

## 从源码构建

环境要求：Node.js 20 或更高版本、npm、Git。

~~~bash
git clone https://github.com/llc141525/Chat2API.git
cd Chat2API
npm ci
npm run dev:win       # Windows 开发环境
~~~

构建应用：

~~~bash
npm run build
npm run build:win
npm run build:mac
npm run build:linux
~~~

打包结果写入 `dist/`，该目录不会提交到 Git。

## 快速开始

1. 启动 Chat2API，在 **Provider** 页面添加账户。
2. 打开 **Proxy** 页面，设置端口和路由策略并启动本地代理。
3. 如果启用了客户端认证，在 **API Keys** 页面创建 API Key。
4. 将 OpenAI 兼容客户端指向 `http://127.0.0.1:<端口>/v1`。

OpenAI Python SDK 示例：

~~~python
from openai import OpenAI

client = OpenAI(
    api_key="your-chat2api-key",
    base_url="http://127.0.0.1:48763/v1",
)

response = client.chat.completions.create(
    model="your-provider-model",
    messages=[{"role": "user", "content": "你好，Chat2API"}],
)

print(response.choices[0].message.content)
~~~

认证、账户配置、模型映射和 Provider 特有参数请参考 [Provider 文档](docs/providers/README.md)。

## 开发和验证

运行核心回归测试：

~~~bash
npm run build
node --test tests/tool-calling/*.test.ts
node --test tests/providers/glm-tool-calling.test.ts tests/providers/context-tool-metadata.test.ts tests/providers/qwen-request-routing.test.ts
~~~

运行真实的本地代理探针：

~~~powershell
npm run dev:win 2>&1 | Tee-Object -FilePath .\dev.log
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "glm/GLM-5.2"
~~~

测试和探针关注的不只是编译成功，还包括多轮工具调用、流式转换、工具目录连续性、压缩后的工具存活、Session 身份以及 Provider 降级响应。

## 架构概览

~~~text
OpenAI 兼容客户端
        │
        ▼
Koa 代理 / 路由身份 / API Key
        │
        ▼
Forwarder + RequestAssembly + ProviderRuntime
        │
        ├── ToolCallingEngine
        │     ├── 工具目录和托管 Prompt
        │     ├── Managed XML 解析器
        │     └── OpenAI 流式/消息转换
        │
        ├── 上下文经济和 Session 边界服务
        └── Provider 适配器和 Web 会话
~~~

关键源码目录：

- `src/main/proxy/forwarder.ts`：请求路由和响应流程；
- `src/main/proxy/adapters/`：Provider 传输和格式转换；
- `src/main/proxy/toolCalling/`：工具契约、Prompt、解析和标准化；
- `src/main/proxy/services/`：Provider Runtime、Session 边界、上下文经济和摘要；
- `src/renderer/src/`：React 桌面 UI；
- `tests/`：单元、集成、fixture 和能力测试。

## 数据和安全

Chat2API 是本地网关。账户凭证和 Provider Session 数据由桌面应用管理，并存储在用户的应用数据目录中。不要在 Issue 或 Pull Request 中粘贴 Token、Cookie、Refresh Token、请求日志或 Session 导出文件；分享诊断信息前请脱敏。

Web 会话适配器依赖 Provider 的认证、可用性、速率限制和服务条款。Provider 可能随时改变 Web 界面，因此这里的支持属于兼容性支持，不等同于 Provider 官方 API 保证。

## 贡献

欢迎提交 Bug 和 Provider 回归问题。请附上操作系统、Chat2API 版本或 commit、Provider/模型、复现步骤以及脱敏后的日志片段。新增适配器前，请先参考 [Provider 文档](docs/providers/README.md) 和现有测试 fixtures。

提交 Pull Request 前运行：

~~~bash
npm run build
git diff --check
~~~

Provider 特有逻辑应保留在适配器/Profile 边界内；工具 Prompt 注入和 Managed XML 解析应由共享工具调用引擎统一负责。

## 许可证和致谢

Chat2API 使用 [GNU GPL-3.0 许可证](LICENSE)。

项目基于最初的 [xiaoY233/Chat2API](https://github.com/xiaoY233/Chat2API)，之后完成了运行时、上下文管理、工具调用、测试体系和 UI 的大规模重构。
