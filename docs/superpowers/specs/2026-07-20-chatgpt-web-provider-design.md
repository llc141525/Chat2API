# ChatGPT Web Provider 设计规格

## 1. 目标

为 Chat2API 增加一个 ChatGPT 网页端 Provider，使 OpenAI 兼容客户端能够通过已登录的 ChatGPT Free 网页账号调用 `chatgpt.com` 网页会话接口。

本功能复用 ChatGPT 网页账号本身的免费额度，不使用 Platform API、Codex OAuth 或 ChatGPT Plus 额度。

## 2. 已确认的网页流程

根据已登录 Free 账号的实际网页请求，核心请求链为：

```text
登录后的浏览器 session
  -> GET /backend-api/accounts/optimized/check
  -> GET /backend-api/accounts/check/...
  -> POST /backend-api/sentinel/chat-requirements/prepare
  -> GET /backend-api/models
  -> POST /backend-api/conversation/init
  -> POST /backend-api/f/conversation/prepare
  -> POST /backend-api/sentinel/chat-requirements/finalize
  -> POST /backend-api/f/conversation (SSE)
```

实际网页请求使用 `/backend-api/f/conversation`，不是旧设计中假设的 `/backend-api/conversation`。

当前抓包确认的 SSE 事件包括：

- `delta_encoding`
- `delta`
- `resume_conversation_token`
- `input_message`
- `message_marker`
- `title_generation`
- `server_ste_metadata`
- `message_stream_complete`

Sentinel prepare/finalize 返回的短期令牌、网页生成的 `conduit_token` 和浏览器上下文属于运行时数据，不得持久化到普通日志或 Provider 配置。

## 3. 范围

### 第一阶段包含

- Electron 内嵌网页登录；
- 完整 Cookie session 收集和加密保存；
- ChatGPT Web Provider 注册；
- 获取可用模型列表；
- 单轮纯文本请求；
- 流式文本响应转换为 OpenAI SSE；
- 多轮文本会话；
- `conversation_id` 和 `parent_message_id` 管理；
- Cookie 失效、网页限流、模型不可用和 Sentinel 失败的错误分类；
- Free 账号限制的可观察性。

### 第一阶段不包含

- OAuth PKCE、`auth.openai.com/oauth/token`；
- Platform API；
- Codex Responses API 或 Responses WebSocket；
- 文件上传、图片输入、图片生成；
- 联网搜索、深度研究、GPTs；
- OpenAI tool calling；
- Cloudflare/Turnstile 自动绕过；
- 多账号共享同一个网页 session；
- 自动购买或绕过账号额度。

## 4. 认证与会话设计

### 4.1 登录

使用现有 `inAppLoginManager` 的 Cookie 型登录模式：

1. 使用独立持久化 Electron session 打开 `https://chatgpt.com`；
2. 用户在内嵌窗口中完成登录、验证码或浏览器验证；
3. 监听 Cookie 变化和 `Set-Cookie`；
4. 收集 ChatGPT 相关域的完整 Cookie Jar；
5. 使用当前浏览器 session 发起轻量校验请求；
6. 校验通过后保存账号凭据并关闭登录窗口。

不能只保存单个 `session-token`。凭据应包含完整 Cookie Jar，并保留请求所需的 User-Agent、设备标识和必要的域信息。

建议凭据模型：

```typescript
interface ChatGPTWebCredentials {
  cookies: Record<string, string>
  userAgent?: string
  deviceId?: string
  accountId?: string
  expiresAt?: number
}
```

Cookie 值必须经过现有凭据加密存储；禁止写入日志、测试快照、错误消息或 HAR。

### 4.2 运行时 session

认证 Cookie 不等于对话 session。每个 Chat2API account 应维护独立的网页请求上下文，并限制同一账号并发请求数为 1，首版不实现并发复用。

每个 Chat2API proxy session 至少保存：

```typescript
interface ChatGPTWebConversationState {
  conversationId?: string
  parentMessageId: string
  lastAssistantMessageId?: string
}
```

Sentinel prepare token、finalize token、`conduit_token` 和 resume token 只在单次请求或短期会话内存中存在，不能写入长期 session store。

## 5. Provider 与模块边界

建议新增：

```text
src/main/oauth/adapters/chatgpt-web.ts
src/main/providers/builtin/chatgpt-web.ts
src/main/proxy/plugins/ChatGPTWebProviderPlugin.ts
src/main/proxy/adapters/chatgpt-web.ts
src/main/proxy/adapters/chatgpt-web-stream.ts
src/main/proxy/providers/chatgpt-web/renderer.ts
src/main/proxy/providers/chatgpt-web/parser.ts
```

可以复用：

- `src/main/oauth/inAppLogin.ts` 的 Cookie 捕获和独立 session；
- `src/main/oauth/manager.ts` 的登录生命周期；
- Perplexity 的 Cookie adapter 结构；
- `WebProviderPlugin` 的 Provider plugin contract；
- `sessionManager` 的 Chat2API session 生命周期；
- 现有 OpenAI SSE 输出和错误归一化逻辑。

ChatGPT Web adapter 只负责网页协议转换，不负责工具 prompt 注入。第一阶段完全关闭工具调用能力，避免违反 ToolCallingEngine 的单一所有权约束。

## 6. 请求流程

### 6.1 请求准备

每次发送消息时：

1. 验证 Provider account 凭据；
2. 从 Chat2API session 取得 `conversationId` 和 `parentMessageId`；
3. 根据客户端模型映射选择网页可用模型；
4. 请求 `/backend-api/f/conversation/prepare`；
5. 请求 Sentinel `chat-requirements/prepare`；
6. 请求 Sentinel `chat-requirements/finalize`；
7. 组合网页请求头、请求体和短期运行时令牌；
8. POST `/backend-api/f/conversation`。

如果是新会话，应先调用 `/backend-api/conversation/init`，并使用返回的会话元数据初始化本地状态。

### 6.2 请求体

第一阶段只生成纯文本消息，保留网页协议要求的字段：

- `action: "next"`；
- `messages`；
- `parent_message_id`；
- `conversation_id`（多轮时）；
- `model`；
- `conversation_mode`；
- `timezone_offset_min`；
- 网页要求的 client context；
- prepare/finalize 生成的短期字段。

不透传未知的 OpenAI 参数，尤其是不把 `tools`、`response_format`、API 专属 reasoning 字段直接发送到网页接口。

## 7. SSE 转换

解析器必须按 SSE event 和 JSON `type` 双层识别，不得把所有 `data:` 内容当作文本。

映射规则：

- `delta` 中的文本内容 -> OpenAI `choices[].delta.content`；
- `input_message`、`message_marker`、metadata -> 更新内部状态，不直接输出为文本；
- `resume_conversation_token` -> 请求级内存状态；
- `message_stream_complete` -> 输出 `finish_reason: "stop"` 和 `[DONE]`；
- 上游错误或连接中断 -> 输出安全错误并关闭流。

网页端可能发送累计文本或不同编码版本，因此 parser 必须支持按消息 id/事件顺序去重，并避免重复输出文本。

非流式请求暂不作为第一阶段的首要路径；若现有 runtime 要求非流式能力，则由同一 parser 聚合完整文本后返回标准 Chat Completions message。

## 8. 错误与失效处理

错误分类至少包括：

- `AUTH_EXPIRED`：Cookie/session 失效，要求重新登录；
- `SENTINEL_REJECTED`：prepare/finalize 或网页验证失败；
- `MODEL_UNAVAILABLE`：Free 账号不可用或模型超出权限；
- `RATE_LIMITED`：网页账号达到速率或额度限制；
- `UPSTREAM_TIMEOUT`：网页请求超时；
- `UPSTREAM_PROTOCOL_CHANGED`：响应结构无法识别。

面向 UI 的消息不得暴露 Cookie、令牌、完整请求体或上游敏感响应。服务端日志只记录请求阶段、状态码、事件类型、耗时和脱敏后的 account/session 标识。

同一账号出现认证失败时，应标记 account 为需要重新登录；不得无限重试，也不得自动切换到其他账号，除非后续明确设计账号池策略。

## 9. 安全要求

- 不读取或输出浏览器 Cookie 原值；
- 不在 HAR、日志、测试快照中保存认证材料；
- 凭据使用现有 store 加密机制；
- 发送给上游的请求必须限制在 ChatGPT 相关域；
- 不实现 CAPTCHA、Cloudflare 或 Turnstile 绕过；
- 用户主动关闭登录窗口时，必须清理临时 session 和事件监听；
- 退出账号时删除本地 Cookie 凭据和对应网页会话；
- 仅允许用户明确配置的本地客户端访问该 Provider。

## 10. 测试与验收

### 单元测试

- Cookie 配置和凭据校验；
- 新会话/多轮会话请求体；
- `/f/conversation/prepare` 响应提取；
- SSE event/type 解析；
- 累计文本去重；
- `message_stream_complete` 完成处理；
- malformed JSON、未知事件和上游错误；
- Cookie 失效、Sentinel 失败、限流错误分类；
- 不发送 tools 和未支持 OpenAI 参数。

### 集成验收

使用 Free 账号完成：

1. 内嵌登录；
2. 单轮纯文本流式请求；
3. 同一 session 的第二轮请求；
4. 手动删除/失效凭据后收到重新登录提示；
5. 模型不可用或额度限制时收到安全错误。

验收标准：

- 客户端收到标准 OpenAI SSE；
- 文本不重复、不丢失；
- 第二轮能沿同一网页会话继续；
- 认证材料不出现在日志；
- 不调用 Platform API 或 Codex endpoint；
- 现有其他 Provider 测试不受影响。

## 11. 未来扩展

只有第一阶段稳定后，才考虑：

- 非流式请求；
- 文件和图片；
- 联网搜索；
- 网页工具调用；
- 多账号轮询；
- 更可靠的浏览器 session 池；
- 网页协议变更探测与兼容层。

这些扩展不能通过简单透传字段实现，应分别补充抓包样本、请求转换规则、权限限制和回归测试。
