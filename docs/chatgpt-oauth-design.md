# ChatGPT 接入 Chat2API — 三方案完整参考

> 基于 Burp 抓包 + sub2api (Wei-Shaw/sub2api, 32K⭐) 源码分析  
> 目标：最大化复用 ChatGPT 订阅额度，不额外付 API 费用

---

## 方案概览

```
                    ┌─ 路线 A: Codex WS ─────┐
OAuth access_token ─┤                         ├──→ 走订阅额度 ✅
(浏览器登录获取)     ├─ 路线 B: Platform API ──┤──→ 按 token 付费 ❌
                    └─ 路线 C: Web 逆向 ──────┘──→ 走订阅额度 ✅
                     (Cookie, 无需 OAuth)
```

| | 路线 A: Codex WS | 路线 B: Platform API | 路线 C: Web 逆向 |
|---|---|---|---|
| **计费** | 订阅额度 | API credits (另付费) | 订阅额度 |
| **认证** | OAuth PKCE | API Key / OAuth token | Cookie session |
| **协议** | WebSocket (Codex) | HTTP SSE (标准) | HTTP SSE (私有) |
| **复杂度** | 高 | 低 | 最高 |
| **稳定性** | sub2api 验证可行 | 官方 API 最稳 | 随时变 |
| **已有基础** | 无 | Chat2API 有 OpenAI 透传 | 无 |

---

## 路线 A: Codex CLI WebSocket（sub2api 方案，推荐）

### A.1 整体架构

```
Chat2API (Electron)
  │
  ├─ OAuth Adapter (新增)
  │   └─ PKCE → auth.openai.com → access_token + refresh_token
  │
  ├─ Token Provider (新增，参考 OpenAITokenProvider)
  │   └─ 缓存 + 锁 + 提前 3min 刷新
  │
  ├─ WS Connection Pool (新增)
  │   └─ wss://api.openai.com/v1/realtime 或 v1/responses
  │   └─ 连接复用 + prewarm + 健康检查
  │
  └─ WS ↔ SSE Bridge (新增)
      └─ Codex WS 消息 ↔ OpenAI SSE chunk
```

### A.2 OAuth 流程（与路线 B 相同）

```
Step 1: GET auth.openai.com/oauth/authorize (PKCE)
Step 2: POST auth.openai.com/oauth/token (换 token)
Step 3: 解码 ID Token JWT → email, account_id, plan_type, orgs
Step 4: POST auth.openai.com/oauth/token (refresh_token 刷新)
```

详细参数见 [§关键常量](#关键常量速查)。

### A.3 WebSocket 连接参数

```
URL:      wss://api.openai.com/v1/realtime  (推测)
          或 wss://api.openai.com/v1/responses (Codex Responses API)

Headers:
  Authorization: Bearer <access_token>
  openai-beta: responses_websockets=2026-02-06   ← 关键！
  user-agent: codex_cli_rs/0.x.x (macOS; arm64) app_term (codex_cli_rs; 0.x.x)
  originator: codex_cli_rs
  chatgpt-account-id: <account_id>
  session_id: <session_uuid>
  conversation_id: <conversation_uuid>
  x-codex-turn-state: <state>
  x-codex-turn-metadata: <metadata>
  accept-language: en-US
```

### A.4 WebSocket 协议生命周期

```
客户端 → 上游:
  1. 发送 JSON: {"type": "response.create", "model": "gpt-5", "input": [...], "stream": true, ...}
  
上游 → 客户端 (流式事件):
  response.created           ← 连接确认
  response.in_progress       ← 开始处理
  response.output_item.added  ← 新增输出块
  response.content_part.added ← 文本/工具调用部分
  response.output_text.delta  ← 文本增量
  response.output_item.done   ← 输出块完成
  response.completed          ← 整个响应完成
  rate_limits.updated         ← 速率限制更新
  error                       ← 错误
```

### A.5 转 OpenAI SSE 的映射

```
WS 事件                          →  SSE chunk
response.output_text.delta        →  {"choices":[{"delta":{"content":"..."}}]}
response.output_item.done (tool)  →  {"choices":[{"delta":{"tool_calls":[...]}}]}
response.completed                →  {"choices":[{"finish_reason":"stop"}]} + [DONE]
```

### A.6 需要新建的 Chat2API 文件

```
src/main/
├── oauth/adapters/chatgpt.ts          ← OAuth PKCE 适配器
├── providers/builtin/chatgpt.ts       ← Provider 配置
├── proxy/plugins/ChatGPTProviderPlugin.ts  ← Plugin (transport=responses_websockets_v2)
├── proxy/adapters/chatgpt-ws.ts       ← WS 连接 + 协议转换
├── proxy/adapters/chatgpt-stream.ts   ← Codex WS → OpenAI SSE 流解析
└── services/chatgpt-token-provider.ts ← Token 缓存 + 刷新
```

### A.7 速率限制

Codex WS 响应中会返回 `rate_limits.updated` 事件，包含剩余配额：
```json
{
  "type": "rate_limits.updated",
  "rate_limits": [...]
}
```

ChatGPT Plus 订阅约 **80条/3小时**（每条的 messages 数量不限），Pro 订阅更高。

---

## 路线 B: Platform API（最简，但需额外付费）

### B.1 架构

```
API Key (sk-...) 或 OAuth access_token
  │
  ▼
POST https://api.openai.com/v1/chat/completions
  Authorization: Bearer <token>
  { "model": "gpt-5", "messages": [...] }
  │
  ▼
SSE: data: {"choices":[{"delta":{"content":"..."}}]}
     data: [DONE]
```

### B.2 与 Chat2API 现有的关系

Chat2API **已有 OpenAI 兼容透传**（`transport: 'openai_chat_completions'`），只需：

1. 新增 Provider 配置 + OAuth Adapter（获取 token）
2. 在 `buildRequest` 中注入 `Authorization: Bearer <token>` header
3. **不需要**自定义 Parser（协议完全标准）

这是三种方案中**最快能跑通的**，但代价是 API credits 另计费。

### B.3 计费模型

| 模型 | 输入 $/M tokens | 输出 $/M tokens |
|------|:---:|:---:|
| gpt-5 | $1.25 | $10.00 |
| gpt-5-2 | $2.50 | $20.00 |
| gpt-4.1 | $2.00 | $8.00 |
| o4-mini | $1.10 | $4.40 |

ChatGPT Plus 订阅 **不包含** API credits，需要单独充值。

### B.4 需要新建的文件

```
src/main/
├── oauth/adapters/chatgpt.ts              ← 与路线 A 共用 OAuth
├── providers/builtin/chatgpt.ts           ← apiEndpoint + chatPath + headers
└── proxy/plugins/ChatGPTProviderPlugin.ts ← transport='openai_chat_completions'
```

---

## 路线 C: chatgpt.com Web 逆向（最深，不推荐）

### C.1 认证方式

直接使用 `chatgpt.com` 的 Cookie session，不需要 OAuth。

```
浏览器登录 chatgpt.com
  │
  ▼
Cookie: __Secure-next-auth.session-token=<JWE encrypted>
  │
  ▼
POST https://chatgpt.com/backend-api/conversation
```

**关键 Cookie**（从 Burp 抓包提取）：

| Cookie 名 | 作用 |
|---|---|
| `__Secure-next-auth.session-token` | **主 session token**（JWE 加密） |
| `__Secure-next-auth.csrf-token` | CSRF 防护 |
| `cf_clearance` | Cloudflare 人机验证 |
| `__cf_bm` | Cloudflare Bot 管理 |
| `oai-client-auth-info` | 客户端身份信息 |
| `oai-sc` | Session 安全令牌 |
| `_puid` | 用户持久 ID |
| `_account` | 账号 ID |

### C.2 核心端点

#### 初始化对话
```
POST https://chatgpt.com/backend-api/conversation/init
→ { "conversation_id": "xxx", "message_id": "yyy" }
```

#### 发送消息 / 接收回复（SSE 流式）
```
POST https://chatgpt.com/backend-api/conversation

Payload:
{
  "action": "next",
  "messages": [
    {
      "id": "<uuid>",
      "author": { "role": "user" },
      "content": {
        "content_type": "text",
        "parts": ["Hello"]
      }
    }
  ],
  "model": "gpt-5-6-thinking",
  "conversation_id": "<from init>",
  "parent_message_id": "<last message id>",
  "timezone_offset_min": -480,
  "history_and_training_disabled": false,
  "force_paragen": false,
  "force_paragen_model_slug": "",
  "force_nulligen": false,
  "force_use_sse": true
}
```

#### 前置检查
```
POST /backend-api/sentinel/chat-requirements/prepare
POST /backend-api/f/conversation/prepare
```

#### 模型列表
```
GET /backend-api/models?iim=false&is_gizmo=false&supports_model_picker_upgrade_presets=true
```

### C.3 SSE 响应格式

ChatGPT SSE 返回的是**整块 JSON**（非增量 delta），格式：

```json
{
  "message": {
    "id": "msg_xxx",
    "author": { "role": "assistant" },
    "content": {
      "content_type": "text",
      "parts": ["完整文本..."]   ← 每次都返回全部已生成内容
    },
    "metadata": {
      "model_slug": "gpt-5-6-thinking",
      "finish_details": { "type": "stop" }
    }
  },
  "conversation_id": "xxx"
}
```

**关键挑战**：不是 delta 增量，而是每次返回已生成的**全部文本**，需要做 diff：
```typescript
function extractDelta(prevText: string, newText: string): string {
  if (newText.startsWith(prevText)) {
    return newText.slice(prevText.length)
  }
  return newText // fallback: 返回全部
}
```

### C.4 消息树结构

ChatGPT 使用**树形对话结构**，每条消息有 `id` + `parent_message_id`：

```
root
├── user_msg_1
│   └── assistant_msg_1
│       └── user_msg_2
│           └── assistant_msg_2
└── (可分支，如用户编辑了某条消息)
```

转换为 OpenAI 线性 `messages[]` 时需要沿树向上遍历。

### C.5 Cloudflare 问题

`chatgpt.com` 全站 Cloudflare 保护。需要：
- `cf_clearance` Cookie（有效期较短）
- `__cf_bm` Cookie（Bot 管理）
- 不能直接 curl，需要浏览器环境或完整的 Cookie 链条
- `User-Agent` 必须是真实浏览器

### C.6 需要新建的文件

```
src/main/
├── providers/builtin/chatgpt-web.ts       ← apiEndpoint='https://chatgpt.com'
├── proxy/plugins/ChatGPTWebPlugin.ts      ← transport='provider_chat_api'
├── proxy/adapters/chatgpt-web-render.ts   ← OpenAI messages → ChatGPT tree 格式
├── proxy/adapters/chatgpt-web-stream.ts   ← ChatGPT SSE → OpenAI chunk 解析
└── oauth/adapters/chatgpt-web.ts          ← Cookie 提取（in-app login / HAR import）
```

---

## 关键常量速查

### OpenAI OAuth

```
CLIENT_ID:     app_EMoamEEZ73f0CkXaXp7hrann
AUTHORIZE_URL: https://auth.openai.com/oauth/authorize
TOKEN_URL:     https://auth.openai.com/oauth/token
REDIRECT_URI:  http://localhost:1455/auth/callback
SCOPES:        openid profile email offline_access
CHALLENGE:     S256 (SHA256 → base64url without padding)

CODE_VERIFIER: crypto.randomBytes(64).toString('hex')  → 128 hex chars
CODE_CHALLENGE: base64URLEncode(sha256(verifier))
STATE:         crypto.randomBytes(32).toString('hex')   → 64 hex chars
```

### Token 刷新策略 (sub2api 经验值)

```
REFRESH_SKEW:        3 min       ← 到期前多久触发刷新
CACHE_TTL:           expires_in - 5 min
FAILURE_CACHE_TTL:   1 min       ← 刷新失败时的短缓存
SESSION_TTL:         30 min      ← OAuth state 有效期
LOCK_INITIAL_WAIT:   20 ms
LOCK_MAX_WAIT:       120 ms
LOCK_MAX_ATTEMPTS:   5
```

### ID Token 提取信息

```json
// JWT payload 中的关键字段
{
  "email": "user@example.com",
  "https://api.openai.com/auth": {
    "chatgpt_account_id": "uuid",
    "chatgpt_user_id": "uuid",
    "chatgpt_plan_type": "plus",
    "user_id": "uuid",
    "poid": "org_id",
    "organizations": [{ "id": "org_id", "role": "account_owner", "is_default": true }]
  }
}
```

---

## 实施建议

### 短期（先跑通）

**路线 B**（Platform API）最快：
- Chat2API 已有 OpenAI 标准 SSE 处理
- 只需加 OAuth Adapter + Bearer token header
- 缺点：API credits 另付费

### 中期（降低费用）

**路线 A**（Codex WS）最理想：
- sub2api 已证明可行（32K⭐）
- 走订阅额度，不额外付费
- 需要实现 WS 连接池 + 协议转换
- 与路线 B **共用 OAuth Adapter**

### 不推荐

**路线 C**（Web 逆向）：
- Cookie 获取困难（Cloudflare）
- SSE 格式非标准（需要 diff）
- 消息树转换复杂
- 变更风险高

---

## Chat2API 现有基础评估

| 能力 | 状态 | 路线 A | 路线 B |
|------|:---:|:---:|:---:|
| OAuth PKCE 流程 | ❌ 无 | 需要 | 需要 |
| Token 缓存+刷新 | ❌ 无（仅 manual token） | 需要 | 需要 |
| OpenAI SSE 透传 | ✅ 有 | 需适配 | ✅ 直接用 |
| WebSocket 连接池 | ❌ 无 | 需要 | 不需要 |
| Codex WS→SSE 转换 | ❌ 无 | 需要 | 不需要 |
| In-app browser login | ✅ 有 | ✅ | ✅ |
| Provider plugin 注册 | ✅ 有 | ✅ | ✅ |

---

## 参考资料

- sub2api (Wei-Shaw/sub2api): `/backend/internal/pkg/openai/oauth.go`
- sub2api: `/backend/internal/service/openai_ws_v2/`
- sub2api: `/backend/internal/service/openai_token_provider.go`
- sub2api: `/backend/internal/service/openai_ws_forwarder_v2.go`
- Burp: `chatgpt.com` proxy history (2026-07-19)
- Chat2API: `src/main/oauth/adapters/` (现有模式)
- Chat2API: `src/main/proxy/plugins/` (现有模式)

---

*文档生成: 2026-07-19*
