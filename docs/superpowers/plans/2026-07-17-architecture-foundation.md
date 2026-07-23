# Chat2API 架构基础重构 — 真源文档

> **用途**：本文档是 Chat2API 后续重构的唯一真源。所有实现计划、代码审查、测试设计均以此文档为基准。
> **读者**：后续执行重构的 AI agent（零上下文启动）。
> **维护**：架构决策变更时更新本文档，实现细节变更时更新对应的实现计划文档。

**创建日期**：2026-07-17
**状态**：已定稿
**最后修订**：2026-07-17（代码验证 + 执行计划细化）

---

## 实现文档索引

> 本文档定义架构决策和设计。具体执行步骤见以下实现计划文档。每份实现文档自包含——AI agent 零上下文启动可执行。

| Phase | 实现文档 | 依赖 | 状态 |
|-------|---------|------|------|
| 0a | [旧架构死代码删除](./2026-07-17-phase-0a-dead-code-removal.md) | Phase 1 | 📋 待执行 |
| 1 | [测试基础设施](./2026-07-17-phase-1-test-infrastructure.md) | 无 | 📋 待执行 |
| 2 | [日志系统重构](./2026-07-17-phase-2-logger.md) | Phase 1 | 📋 待执行 |
| 3a | [Qwen 翻译链简化](./2026-07-17-phase-3a-qwen-clean-request.md) | Phase 0a, 1, 2 | 📋 待执行 |
| 3b | [GLM + DeepSeek 翻译链简化](./2026-07-17-phase-3b-glm-deepseek.md) | Phase 3a | 📋 待执行 |
| 3c | [其余 Provider + 收尾清理](./2026-07-17-phase-3c-remaining-providers.md) | Phase 3b | 📋 待执行 |
| 4 | [AI Debug 循环](./2026-07-17-phase-4-ai-debug-loop.md) | Phase 1-3 | 📋 待执行 |

**执行顺序**：Phase 1 → Phase 0a → Phase 2 → Phase 3a → Phase 3b → Phase 3c → Phase 4

---

## 目录

1. [项目本质](#1-项目本质)
2. [当前架构评估](#2-当前架构评估)
3. [根因分析](#3-根因分析)
4. [目标架构](#4-目标架构)
5. [Phase 0：旧架构残留清理](#5-phase-0旧架构残留清理)
6. [改进领域一：翻译链简化](#6-改进领域一翻译链简化)
7. [改进领域二：日志系统重构](#7-改进领域二日志系统重构)
8. [改进领域三：测试基础设施](#8-改进领域三测试基础设施)
9. [改进领域四：AI Debug 循环](#9-改进领域四ai-debug-循环)
10. [实施路线图](#10-实施路线图)
11. [附录](#11-附录)

---

## 1. 项目本质

Chat2API 是一个 **LLM API 协议转译代理**。它接收 OpenAI 格式的 Chat Completion 请求（来自 Claude Code、OpenCode 等客户端），将其翻译为目标模型的原生 API 格式，再将响应翻译回 OpenAI SSE 格式。

### 1.1 为什么不能简单透传

不同 LLM 提供商的 API 在以下维度上不可互换：

| 维度 | Claude API | Qwen Web API | GLM Web API | DeepSeek Web API |
|------|-----------|-------------|------------|-----------------|
| 消息格式 | messages 数组 | 单段 flat text | 特定 JSON 结构 | messages 数组 |
| Tool call | tool_use XML | 文本中嵌入 function call | 文本中嵌入 | 文本中嵌入 |
| 流式协议 | SSE | 自有的 event-stream | SSE | SSE |
| 上下文压缩 | 服务端自动 compact | 无 | 无 | 无 |
| 会话管理 | 无状态 | session_id + parent_req_id | conversation_id | session_id |
| 反自动化 | 无 | 无 | MD5 签名 | PoW 挑战 |

### 1.2 必须自己做的三件事

1. **协议转译**：OpenAI tool_calls ↔ 各模型的文本嵌入格式
2. **上下文管理**：国产模型 API 不做 compact，proxy 必须在超窗口前主动压缩
3. **会话连续性**：维护 provider session 生命周期，确保多轮对话不丢失上下文

### 1.3 关键术语

| 术语 | 含义 |
|------|------|
| CC | Claude Code，Anthropic 的 CLI agent 工具 |
| Provider | 上游模型 API（Qwen/GLM/DeepSeek 等） |
| Compact | 上下文压缩——将长对话历史总结成摘要 |
| Runtime config | CC 注入的工具定义、superpowers 指令、工作流标记等 |
| Infrastructure prompt | agent 角色定义 + skill workflow 步骤 |
| Delta messages | 仅发送自上次请求以来的增量消息，而非全量历史 |
| Managed protocol | 将 native tool_call 转为文本嵌入（managed_xml 或 managed_bracket） |

---

## 2. 当前架构评估

### 2.1 请求处理完整链路（12 步）

一次 Qwen 请求的实际执行路径：

```
1. forwardChatCompletion()
     → contextManagement (summary 生成/compact)
2.   → doForward
3.     → prepareRequest
4.       → ToolCallingEngine.transformRequest       ① 工具定义转换
5.       → buildRequestAssembly
6.         → filterProviderMessageHistory            ② 过滤 runtime config (dropRuntimeConfig)
7.         → buildInfrastructurePrompt              ③ 构建基础设施提示词
8.     → computeQwenPromptBudgetDiagnostics          ④ 决定 prompt refresh mode
9.     → providerRuntime.forward
10.      → projectRequestAssemblyForPromptMode       ⑤ 模式截断 + ③' 二次构建基础设施
11.      → plugin.buildRequest
12.        → selectProviderMessagesForAssembly       ⑥ 二次过滤 (stripRuntimeConfig+stripToolContract+dropRuntimeConfig)
13.        → selectQwenDeltaMessages                 ⑦ delta 选择
14.        → filterConversationForMode               ⑧ 模式截断 again
15.        → 分离 system/summary/skill buckets
16.        → 截断 tool result (2000 chars)
17.        → renderFinalPrompt                       ⑨ 拼成最终 flat text
18.      → HTTP transport
19.      → plugin.parseStream
20.        → 解压 → event-stream 解析 → 提取 thinking
21.        → resolveQwenContentDelta                 ⑩ delta 计算
22.        → ToolStreamParser                        ⑪ 工具调用解析
23.        → finalizeStream + outputInspection       ⑫ 终结 + 输出检查
```

### 2.2 发现的冗余

| 冗余 | 位置 | 说明 |
|------|------|------|
| 重复过滤 | ② + ⑥ | `filterProviderMessageHistory` 被调用两次，第二次比第一次参数更严格 |
| 重复基础设施构建 | ③ + ③' | 两套 `buildInfrastructurePrompt` 实现，逻辑类似但不完全相同 |
| 重复模式截断 | ⑤ + ⑧ | 通用层和 Qwen 专用层各做一次 mode-based truncation |
| 过度参数传递 | ProviderRuntime.forward | 同时传入 `assembly`、`transformed`、`request.messages` 三份消息数据 |

### 2.3 当前代码统计

| 模块 | 文件数 | 关键文件 |
|------|--------|---------|
| 路由 | ~8 | `routes/chat.ts`, `routes/anthropic.ts`, `routes/openaiSession.ts` |
| 转发 | 1 | `forwarder.ts` (~930 行) |
| 适配器 | 10 | `adapters/qwen.ts` (~1540 行), `adapters/deepseek.ts`, `adapters/glm.ts` 等 |
| 插件 | 9 | `plugins/QwenProviderPlugin.ts`, `plugins/GLMProviderPlugin.ts` 等 |
| 服务 | ~10 | `services/ProviderRuntime.ts` (~610 行), `services/summarySanitizer.ts`, `services/providerRequestGate.ts` 等 |
| 工具调用 | ~15 | `toolCalling/ToolCallingEngine.ts`, `toolCalling/outputInspection.ts` 等 |
| 测试 | 62 | 11 个子目录，覆盖不均 |

---

## 3. 根因分析

### 3.1 Qwen 适配器的 Bug 不是 API 变动导致的

**错误判断**：Qwen 频繁更改 API 导致适配器 Bug。

**实际情况**：所有 Qwen Bug 的修复集中在 2026-07-10 至 2026-07-17（一周内）。这些是实现的边界条件 Bug，不是 API 协议变动：

| Bug 类别 | 根因 | 修复提交 |
|---------|------|---------|
| 双重流终结 | `transStream.end()` 被多个代码路径调用 | `ef2d8e1`, `475fce3` |
| 思考内容重复 | `deep_think` 和 `multimodal_chat_think` 两个来源被同时消费 | `eb95a9a` |
| 工具调用丢失 | Qwen 用快照替换而非增量更新，delta 计算在快照变短时出错 | `475fce3` |
| MIME 类型过滤 | `isAnswerMessage()` 过滤太严格，静默丢弃新格式响应 | `eb95a9a` |
| 会话状态丢失 | 多轮 tool 跟进使用不同 session key，回退逻辑缺失 | `475fce3` |
| 运行时配置泄漏 | `selectProviderMessagesForAssembly` 初始版本未过滤 runtime config 标记 | `6559497` |
| 空输出静默 | 模型返回空或拒绝 tool catalog 时，适配器发出正常的 `finish_reason: 'stop'` | `475fce3` |

**真实根因**：翻译链的 12 个环节，每个环节单独正确但组合起来边界条件太多。Bug 出现在环节之间的"阻抗不匹配"——上游环节的输出是下游的输入，但下游没考虑上游的所有可能输出形态。

### 3.2 DeepSeek 封号分析（仅记录，不在本次重构范围）

DeepSeek 封号与 Qwen/GLM 不封号的差异，根因在于 DeepSeek 部署了 PoW（Proof-of-Work）反自动化系统：

| 因素 | DeepSeek | Qwen | GLM |
|------|---------|------|-----|
| PoW 挑战 | 有 (`DeepSeekHashV1` + WASM) | 无 | 无 |
| 追踪 cookie | 每次请求生成新的 `_frid`/`_fr_ssid`/`_fr_pvid` | 仅 `tongyi_sso_ticket` | 无追踪 cookie |
| 每补全 HTTP 调用数 | 3-4 次（token + session + PoW + completion） | 1 次 | 1 次 |
| 请求节流 | 未配置 | 未配置 | `minIntervalMs: 2000` |
| Claude Code header 泄露 | 不会——所有 adapter 从头构建 headers | 同 | 同 |

**结论**：Claude Code 的 header 毒化不是封号因素（proxy 不会转发 CC 的原始 headers）。流量模式（高频 agentic loop × 3x HTTP 调用 × 无节流）配合 PoW 系统是决定性因素。

### 3.3 AI Debug 循环效率低下的根因

| 堵点 | 症状 | 影响 |
|------|------|------|
| 反馈周期太长 | 改代码→构建→启动→probe→读日志→分析 一轮 3-4 分钟 | AI 真正思考的时间不到 30% |
| 日志无结构化 | 600+ 条 console.log，无级别，无 sessionId 关联 | 无法快速定位问题 |
| 无 debug state 持久化 | AI 每轮从零探索，重复已验证的路径 | 大量 token 浪费在重复探索上 |
| 无快速回归套件 | 每次验证需跑全量 probe | 反馈延迟高 |
| CI 不跑全量测试 | 回归 bug 发现太晚 | 修复一个 bug 引入另一个 |

---

## 4. 目标架构

### 4.1 核心设计原则

1. **通用层做清洗（what to remove），Provider 层做渲染（how to render）**
2. **一个日志系统，两个出口（UI + 文件），三级过滤（debug/info/warn/error）**
3. **每步编辑后 10 秒内得到测试反馈**
4. **AI 可无状态恢复 debug 上下文**

### 4.2 目标请求链路（6 步）

```
forwardChatCompletion
  → contextManagement              // 跨 provider 通用，保留
  → doForward
    → ToolCallingEngine.transformRequest    // 工具定义转换
    → buildCleanedRequest(最严格过滤)        // 合并了 ②+⑥+③+⑤+⑦+⑧
      → filterProviderMessageHistory (strict)
      → mode-based truncation
      → delta selection (if session exists)
      → buildInfrastructurePrompt (once)
    → plugin.renderRequest(cleaned, mode)   // 纯渲染，合并了 ⑨
    → HTTP transport
    → plugin.parseStream(response)          // ⑩⑪⑫，provider 专用
```

从 **12 步 → 6 步**。每个 provider plugin 只做两件事：`renderRequest` + `parseStream`。

### 4.3 中间数据结构：CleanedRequest

这是通用层产出、Provider 层消费的唯一接口：

```typescript
interface CleanedRequest {
  messages: ChatMessage[]           // 已过滤 runtime config，已按 mode 截断
  summaryText: string | null        // compact 产生的 conversation summary
  infrastructurePrompt: string | null  // agent role definition + skill workflow steps
  toolDefinitions: ToolDef[]        // 已转换为 managed protocol 的工具定义
  activeSkillCheckpoint: string | null  // 当前 skill workflow 的执行步骤
  mode: PromptRefreshMode           // full | digest | tool_ready | minimal | repair
}
```

### 4.4 目标代码结构

```
src/main/proxy/
  server.ts                    // 代理服务器启动
  forwarder.ts                 // 请求入口 + context management 编排（<500 行）
  
  core/                        // 通用层——所有 provider 共享
    requestCleaner.ts          // filterProviderMessageHistory + mode truncation + delta + infra prompt
    contextManagement.ts       // compact/summary 逻辑
    streamNormalizer.ts        // ProviderRuntimeEvent → OpenAI SSE
    requestGate.ts             // 请求节流
    
  providers/                   // 每个 provider 一个目录——纯渲染+解析
    qwen/
      renderer.ts              // CleanedRequest → Qwen flat text
      parser.ts                // Qwen event-stream → ProviderRuntimeEvent[]
      plugin.ts                // WebProviderPlugin 包装
    glm/
      renderer.ts
      parser.ts
      plugin.ts
    deepseek/
      renderer.ts
      parser.ts
      plugin.ts
    ... (kimi, mimo, minimax, perplexity, zai, qwen-ai)
    
  shared/                      // 共享类型和工具
    types.ts                   // CleanedRequest, ProviderRuntimeEvent, etc.
    messageUtils.ts            // extractTextContent, isRuntimeConfig 等
    logger.ts                  // 统一日志系统
```

### 4.5 目标日志架构

```
                    ┌──→ UI (storeManager, 按级别过滤，人类可读)
LogEvent ──→ Logger ──┤
                    └──→ NDJSON 文件 (全量，机器可解析)
                           │
                           └──→ extract-session-log.ps1
```

```typescript
interface LogEvent {
  ts: number                    // 毫秒时间戳
  level: 'debug' | 'info' | 'warn' | 'error'
  tag: string                   // 'qwen:renderer', 'forwarder:compact', 'glm:parser'
  msg: string                   // 一句话描述
  sessionId?: string            // 关联到具体会话
  data?: Record<string, unknown> // 结构化上下文
  err?: { message: string, stack?: string }
}
```

---

## 5. Phase 0：旧架构残留清理

### 5.0 背景

项目在 commit `a9edc38`（2026-04-04，"refactor: major architecture optimization"）做了根本性重构——将请求转发从"dedicated adapter 模式"迁移到"ProviderRuntime + WebProviderPlugin 模式"。但旧架构代码从未被彻底删除，导致以下问题：

- **调试干扰**：旧代码路径和新代码路径共存，出问题时难以判断实际走了哪条路径
- **重复实现**：同一个功能在新旧架构中各有一套实现，修改时需要两边同步
- **测试盲区**：测试可能覆盖了新路径，但旧路径的死代码仍然存在且误导代码阅读
- **意外调用**：旧函数可能被非预期的代码路径调用，产生难以追踪的 bug

### 5.1 Adapter 类存活方法分析（2026-07-17 代码验证）

各 adapter 的 `*Adapter` 类目前有三类调用者：

| 调用者 | 用途 | 涉及的 adapter |
|--------|------|---------------|
| `oauth/adapters/index.ts` | OAuth 流程需要 adapter 做 token 获取 | 全部 9 个 |
| `ipc/handlers.ts` | UI 触发 `deleteAllChats()` | 全部 9 个 |
| `plugins/*ProviderPlugin.ts` | `deleteSession()` / `acquireToken()` | 全部 9 个 |

**结论**：Adapter 类不能被整体删除——OAuth 流程仍然依赖它们做 token 获取。Phase 0 只能删除 adapter 类中已确认无调用者的方法。

### 5.2 死代码清单

#### 5.2.1 完全死代码（可安全删除，无任何调用者）

| 文件 | 行号 | 内容 | 证据 |
|------|------|------|------|
| `adapters/deepseek.ts` | 404-456 | `chatCompletion()` 方法 | 全局搜索无调用 |
| `adapters/deepseek.ts` | 458-515 | `chatCompletionWithAssembly()` 方法 | 全局搜索无调用 |
| `adapters/kimi.ts` | 223-287 | `chatCompletion()` 方法 | 全局搜索无调用 |
| `adapters/kimi.ts` | 288-340 | `chatCompletionWithAssembly()` 方法 | 全局搜索无调用 |
| `adapters/mimo.ts` | 423-470 | `chatCompletion()` 方法 | 全局搜索无调用 |
| `adapters/mimo.ts` | 471-520 | `chatCompletionWithAssembly()` 方法 | 全局搜索无调用 |
| `adapters/minimax.ts` | 499-625 | `chatCompletion()` 方法 | 全局搜索无调用 |
| `adapters/minimax.ts` | 626-680 | `chatCompletionWithAssembly()` 方法 | 全局搜索无调用 |
| `adapters/perplexity.ts` | 293-404 | `chatCompletion()` 方法 | 全局搜索无调用 |
| `adapters/perplexity.ts` | 405-460 | `chatCompletionWithAssembly()` 方法 | 全局搜索无调用 |
| `adapters/qwen-ai.ts` | 237-404 | `chatCompletion()` 方法 | 全局搜索无调用 |
| `adapters/qwen-ai.ts` | 405-460 | `chatCompletionWithAssembly()` 方法 | 全局搜索无调用 |
| `adapters/zai.ts` | 340-568 | `chatCompletion()` 方法 | 全局搜索无调用 |
| `adapters/zai.ts` | 569-620 | `chatCompletionWithAssembly()` 方法 | 全局搜索无调用 |
| `adapters/qwen.ts` | 169-282 | `buildQwenChatRequestBody()` + wrapper | 仅测试文件调用，生产路径用 `buildQwenAssemblyRequestBody` |
| `adapters/glm.ts` | 145 | `buildGLMPromptMessagesForTest()` | 仅测试文件调用 |
| `adapters/ProviderRequestPreparer.ts` | 1-27 | 整个文件 | 无任何类实现此接口 |
| `adapters/index.ts` | 各处 | `deepSeekAdapter`/`glmAdapter`/`qwenAdapter` 等单例导出 | 全局搜索无使用者（仅 barrel re-export） |
| `services/providerConversationState.ts` | 14-19 | `qwenSessionId`/`qwenParentReqId`/`childQwenSessionId` 字段 | ProviderRuntime 不使用这些字段 |

#### 5.2.2 不可达代码路径

| 文件 | 行号 | 内容 | 证据 |
|------|------|------|------|
| `forwarder.ts` | 634-697 | 通用 HTTP fallback 路径 | 所有 9 个 provider 均已注册 ProviderRuntime plugin，fallback 仅当 `CHAT2API_DEDICATED_PROVIDER_FALLBACK` 环境变量显式设置时触发 |

#### 5.2.3 已标记废弃但仍被引用的代码

| 文件 | 标记 | 当前使用者 |
|------|------|-----------|
| `utils/tools.ts` | `@deprecated INV-001` | 需逐个检查调用者 |
| `utils/streamToolHandler.ts` | `@deprecated Use toolParser instead` | 需逐个检查调用者 |
| `utils/promptSignatures.ts` | `backward compatibility for existing imports` | 需逐个检查调用者 |
| `utils/toolParser.ts` | `Legacy parser path` | 需逐个检查调用者 |
| `utils/toolParser/index.ts` | `Legacy parser path` | 需逐个检查调用者 |
| `utils/unifiedToolParser.ts` | `Legacy parser path` | 需逐个检查调用者 |

#### 5.2.4 重复实现（功能重叠，需合并）

| 功能 | 文件 A | 文件 B | 差异 |
|------|--------|--------|------|
| `buildInfrastructurePrompt` | `services/providerPromptProjection.ts:56` | `RequestAssembly.ts:364` (as `buildInfrastructurePromptFromMessages`) | A 合并所有 system 消息，B 只取首条并截断到 2000 chars；A 有独立执行环境提示词构建，B 无 |

### 5.3 清理策略

#### 阶段 0a：删除完全死代码（低风险，独立执行）

直接删除所有 `chatCompletion()` 和 `chatCompletionWithAssembly()` 方法、单例导出、`ProviderRequestPreparer.ts`、legacy session 字段。

**注意**：`*Adapter` 类本体保留——OAuth 流程和 IPC handlers 仍需要通过它们做 token 获取和 `deleteAllChats()`。

**每删除一个 adapter 的方法后立即跑 `npm run test:fast` 确认无回归。**

#### 阶段 0b：将 session 清理移入 plugin + 消除 deprecated wrapper（并入 Phase 3）

当前 plugin 通过实例化 adapter 对象来调用 `deleteSession()`。目标：将清理逻辑直接移入 plugin，消除对 adapter 类的 session 清理依赖。

```typescript
// 之前：plugin 实例化 adapter 调 deleteSession
class QwenProviderPlugin {
  async deleteSession(input) {
    const adapter = new QwenAdapter(input.account)
    return adapter.deleteSession(input.sessionId)
  }
}

// 之后：plugin 自包含 deleteSession 逻辑
class QwenProviderPlugin {
  async deleteSession(input) {
    const headers = this.buildDeleteHeaders(input.account)
    return axios.post(`${API_BASE}/session/delete/batch`, { sessionIds: [input.sessionId] }, { headers })
  }
}
```

**此阶段与 Phase 3（翻译链简化）一起执行**——因为两者都涉及大幅修改 plugin 代码，合并执行避免 plugin 被连续重构两次。

#### 阶段 0c：合并重复实现（并入 Phase 3）

合并两套 `buildInfrastructurePrompt` 为统一实现，删除 `providerPromptProjection.ts` 中的独立版本（其逻辑合并入 `requestCleaner.ts`）。与 Phase 3 的 `CleanedRequest` 引入一起做。

### 5.4 验证标准

- [ ] `npm run test:fast` 全程通过
- [ ] `npm test` 全量测试通过
- [ ] `git grep "chatCompletion\|chatCompletionWithAssembly" src/main/proxy/adapters/` 返回空
- [ ] `git grep "deepSeekAdapter\|glmAdapter\|qwenAdapter\|kimiAdapter\|mimoAdapter\|minimaxAdapter\|perplexityAdapter\|qwenAiAdapter\|zaiAdapter" src/` 仅在 `adapters/index.ts` 中有重新导出（或完全消除）
- [ ] `ProviderRequestPreparer.ts` 文件已删除
- [ ] `providerConversationState.ts` 中无 `qwenSessionId`/`qwenParentReqId`/`childQwenSessionId`
- [ ] 每个 provider plugin 不再 import 其对应的 `*Adapter` 类（session 清理逻辑已内联）
- [ ] 6 个 deprecated 文件中至少 4 个已被删除（其余需有明确迁移计划）
- [ ] 只有一套 `buildInfrastructurePrompt` 实现

---

## 6. 改进领域一：翻译链简化

### 6.1 目标

将请求处理从 12 步减少到 6 步，消除所有重复操作。

### 6.2 具体变更

#### A. 消除二次过滤（② + ⑥ → 合并为一次）

**现状**：`filterProviderMessageHistory` 被调用两次——`buildRequestAssembly` 中用 `dropRuntimeConfig`，Qwen adapter 中再加 `stripRuntimeConfig` + `stripToolContractHistory`。

**改法**：在通用层一次性使用最严格参数（三个全开），不再让 provider 做二次过滤。

**影响**：如果未来某个 provider 需要保留部分 runtime config，它需要在 plugin 中声明 `preserveRuntimeConfig: true`，通用层据此调整过滤强度。这是"默认严格，特殊放行"。

#### B. 消除重复模式截断（⑤ + ⑧ → 合并为一次）

**现状**：`projectRequestAssemblyForPromptMode`（通用层）和 `filterConversationForMode`（Qwen 层）都做 mode-based truncation。

**改法**：mode-based truncation 统一在通用层完成，provider plugin 通过参数声明自己的截断偏好（保留几条消息，是否保留 system prompt），不再自行截断。

```typescript
interface ModeTruncationOptions {
  maxMessages: number           // 默认 6
  preserveSystemPrompts: boolean // 默认 true
  widenForOrphanToolResults: boolean // 默认 true
}
```

**影响**：Qwen 当前的 `digest` 模式保留 4 条，通用层的 `minimal` 也保留 4 条。统一后 Qwen 使用参数 `{maxMessages: 4}` 即可。

#### C. 消除重复基础设施提示词构建（③ + ③' → 合并为一次）

**现状**：两套 `buildInfrastructurePrompt` 实现——一套在 `RequestAssembly.ts`，一套在 `providerPromptProjection.ts`。逻辑相似但细节不同（一行截断 agent definition 到 2000 chars，另一行不截断）。

**改法**：只保留一套实现，放在通用层。所有 provider 共享同一个人 infrastructure prompt。

**影响**：需要对齐两套实现的差异。选择不截断 agent definition（当前 `providerPromptProjection.ts` 的策略），因为 2000 chars 限制可能截断关键的 tool-use 指令。

#### D. Delta 选择纳入通用层（⑦ → 合并到 mode truncation）

**现状**：`selectQwenDeltaMessages` 是 Qwen 专用逻辑——如果存在 provider session，只发送自上次 assistant tool_call 以来的增量消息。

**改法**：delta 选择变为通用 mode truncation 的一个选项。当 `useDeltaMessages=true` 时，truncation 逻辑从上次 assistant tool_call 开始切片，而非从对话开头。

**影响**：GLM 可以直接复用。如果某 provider 的 delta 判断逻辑完全不同（比如基于 `parent_req_id` 而非消息内容），可以在 provider renderer 中覆盖。

#### E. Provider plugin 接口简化

**现状 plugin 接口**（`buildRequest` 的输入参数约 15 个）：
```typescript
interface ProviderRuntimeRequest {
  provider, account, model, originalModel,
  messages, assembly, promptRefreshMode,
  sessionBoundaryReason, sessionBoundaryPlan,
  stream, temperature,
  sessionId, parentReqId,
  enableThinking, enableWebSearch
}
```

**目标 plugin 接口**（两个方法）：
```typescript
interface WebProviderPlugin {
  capabilities: ProviderPluginCapabilities

  // 渲染请求：CleanedRequest → provider 原生 HTTP 请求
  renderRequest(input: {
    cleaned: CleanedRequest
    provider: Provider
    account: Account
    model: string
    sessionId?: string
    parentReqId?: string
    stream: boolean
    temperature?: number
    enableThinking: boolean
    enableWebSearch: boolean
  }): ProviderWebRequest

  // 解析响应：provider 原生响应 → ProviderRuntimeEvent 流
  parseStream(input: {
    response: AxiosResponse
    model: string
    toolCallingPlan?: ToolCallingPlan
  }): AsyncIterable<ProviderRuntimeEvent>

  // 解析非流式响应
  parseNonStream(input: {
    response: AxiosResponse
    model: string
    toolCallingPlan?: ToolCallingPlan
  }): ProviderRuntimeResult
}
```

注意：
- `messages` 不再直接传入——已包含在 `CleanedRequest` 中
- `assembly` 不再传入——`CleanedRequest` 替代了 `RequestAssembly`
- `promptRefreshMode` 不再单独传入——在 `CleanedRequest.mode` 中
- `sessionBoundaryReason` 和 `sessionBoundaryPlan` 不再传入——通用层已据此完成了消息清理

### 6.3 不变的部分

以下组件保持不变：
- `ToolCallingEngine`（工具定义转换）——逻辑正确，只是需要适配新的 `CleanedRequest` 输入
- `contextManagement`（summary 生成）——跨 provider 通用，独立关注点
- `providerRequestGate`（请求节流）——正确实现
- `providerStreamGuard`（首事件超时）——正确实现
- `outputInspection`（空输出检测）——正确实现
- Provider 专用的 `parseStream`（响应解析）——每 provider 有自己的 wire format，无法统一

### 6.4 验证标准

- [ ] Qwen 请求从 12 步减少到 6 步（通过日志统计确认）
- [ ] 所有现有 Qwen 测试通过
- [ ] 所有现有 GLM 测试通过
- [ ] `filterProviderMessageHistory` 在整个请求生命周期中只调用一次
- [ ] `buildInfrastructurePrompt` 在整个请求生命周期中只调用一次
- [ ] Mode-based truncation 只在通用层执行一次
- [ ] 新增一个 provider（用 dummy provider 验证）只需实现 `renderRequest` + `parseStream` + `capabilities`
- [ ] Qwen probe 测试（短 probe）通过——验证真实模型 tool calling 正常
- [ ] GLM probe 测试（短 probe）通过

---

## 7. 改进领域二：日志系统重构

### 7.1 目标

将两个互不通信的日志系统统一为一个，提供结构化、可过滤、按会话关联的日志。

### 7.2 当前状态

| | System A (UI 日志) | System B (终端日志) |
|---|---|---|
| API | `storeManager.addLog()` | `console.log('[Tag] ...')` |
| 存储 | `app-logs.ndjson` | stdout → dev.log (手动重定向) |
| 级别过滤 | ✅ 有 | ❌ 无，全部输出 |
| UI 可见 | ✅ | ❌ |
| 代理核心日志 | ❌ 几乎没有 | ✅ ~600 条 |
| sessionId 关联 | 部分 | ❌ 无 |
| 结构化数据 | ✅ LogEntry 类型 | ❌ 字符串拼接 (+ 少数 JSON.stringify) |
| 凭证泄漏 | - | ❌ 有（deepseek.ts:119, loadbalancer.ts:117 等） |

### 7.3 目标实现

#### 7.3.1 Logger API

```typescript
// src/main/proxy/shared/logger.ts

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogEvent {
  ts: number
  level: LogLevel
  tag: string           // 模块标签，用冒号层级：'qwen:renderer', 'forwarder:compact'
  msg: string           // 一句话描述
  sessionId?: string    // 必填（对于代理请求）
  data?: Record<string, unknown>  // 结构化上下文
  err?: { message: string, stack?: string }
}

interface Logger {
  debug(tag: string, msg: string, data?: Record<string, unknown>): void
  info(tag: string, msg: string, data?: Record<string, unknown>): void
  warn(tag: string, msg: string, data?: Record<string, unknown>): void
  error(tag: string, msg: string, err?: Error, data?: Record<string, unknown>): void
}

// 全局 logger 实例
const logger: Logger & {
  setLevel(level: LogLevel): void
  child(sessionId: string): Logger  // 创建绑定 sessionId 的子 logger
}
```

#### 7.3.2 Tag 命名规范

```
格式: {module}:{submodule}:{action}

示例:
  qwen:renderer:build        Qwen 渲染器构建请求
  qwen:parser:delta           Qwen 解析器 delta 计算
  forwarder:compact:trigger   Forwarder 触发 compact
  forwarder:retry:attempt     Forwarder 重试
  glm:renderer:build          GLM 渲染器构建请求
  compact:summary:generate    Compact 生成摘要
  compact:summary:reject      Compact 摘要被拒绝
  tool:call:in                收到 tool call
  tool:result:out             tool result 返回
  tool:loop:detect            检测到 tool call 循环
  session:create              创建 provider session
  session:delete              删除 provider session
  gate:throttle:wait          请求节流等待
```

#### 7.3.3 日志级别使用规范

| 级别 | 用途 | 示例 |
|------|------|------|
| `error` | 请求失败、解析异常、session 状态损坏 | `logger.error('qwen:parser', 'Delta calculation failed', err, {prev, next})` |
| `warn` | 重试、降级、非预期空输出、tool 拒绝、loop 检测 | `logger.warn('tool:loop', 'Identical tool call repeated', {tool, args, count})` |
| `info` | 请求开始/结束、session 创建/销毁、compact 触发、模式切换 | `logger.info('forwarder:compact', 'Compaction triggered', {from, to, dropped})` |
| `debug` | 消息内容、delta 值、流事件详情、完整请求/响应体 | `logger.debug('qwen:parser:delta', 'Delta computed', {prev, next, delta})` |

#### 7.3.4 双出口实现

```typescript
// logger 同时写入两个出口：
// 出口 1: storeManager.addLog() — 只写 info/warn/error，到 UI
// 出口 2: NDJSON 文件 — 全量，到 app-logs.ndjson

function createLogger(config: { level: LogLevel }): Logger {
  return {
    info(tag, msg, data) {
      if (levelPriority('info') >= levelPriority(config.level)) {
        const event = { ts: Date.now(), level: 'info', tag, msg, data }
        storeManager.addLog?.({ level: 'info', message: `[${tag}] ${msg}`, data })
        appendToNdjson(event)
      }
    },
    debug(tag, msg, data) {
      if (levelPriority('debug') >= levelPriority(config.level)) {
        const event = { ts: Date.now(), level: 'debug', tag, msg, data }
        // debug 不写入 UI，只写 NDJSON
        appendToNdjson(event)
      }
    },
    // ... warn, error 同理
  }
}
```

#### 7.3.5 迁移策略（两波执行）

**第一波（Phase 2，关键路径优先）**：迁移最关键的调试路径，剩余 adapter 保持 `console.log` + 标记。

1. 实现 `Logger` 类 + 双出口
2. 迁移 `forwarder.ts`——最关键的调试路径
3. 迁移 `ProviderRuntime.ts`
4. 迁移 `adapters/qwen.ts`
5. 迁移 `adapters/glm.ts`
6. 更新 `extract-session-log.ps1` 解析新格式
7. 添加 lint 规则禁止新的 `console.log` 出现在 `src/main/proxy/` 中

**第二波（Phase 3 完成后，全量补齐）**：在翻译链简化后，所有 plugin 都已被重写为 renderer/parser，此时一次性完成剩余 adapter 的 logger 迁移。

8. 迁移 `adapters/deepseek.ts`、`kimi.ts`、`mimo.ts`、`minimax.ts`、`perplexity.ts`、`qwen-ai.ts`、`zai.ts`
9. 移除过渡期的 `console.log` 劫持代码
10. 全量验证无 `console.log` 残留

迁移辅助——兼容期让 `console.log` 同时走新旧两条路径：

```typescript
// 过渡期：劫持 console.log，自动转换为 logger.info
const originalLog = console.log
console.log = (...args: unknown[]) => {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
  logger.debug('legacy:console', msg)
  originalLog(...args)
}
```

#### 7.3.6 凭证安全

所有日志在写入前自动脱敏：

```typescript
const SENSITIVE_KEYS = ['token', 'apiKey', 'accessToken', 'refreshToken',
  'ticket', 'cookie', 'authorization', 'tongyi_sso_ticket']

function sanitize(data: Record<string, unknown>): Record<string, unknown> {
  // 递归替换敏感字段的值为 '[REDACTED]'
}
```

### 7.4 验证标准

- [ ] 同一个 session 的所有日志可通过 `sessionId` 字段关联
- [ ] `npm run dev` 时终端只显示 warn 和 error 级别（默认）
- [ ] 设置 `CHAT2API_LOG_LEVEL=debug` 环境变量可开启 debug 日志
- [ ] UI 日志页面可显示代理核心日志（不只是启动/停止事件）
- [ ] `extract-session-log.ps1` 可解析新的 NDJSON 格式
- [ ] 日志中不包含明文凭证
- [ ] 新代码无法使用 `console.log`（lint 规则强制执行）
- [ ] `src/main/proxy/` 目录下无 `console.log` 残留

---

## 8. 改进领域三：测试基础设施

### 8.1 目标

提供分层测试体系——10 秒快速回归、全量测试、CI 自动运行。

### 8.2 当前状态

| 问题 | 影响 |
|------|------|
| 无 `npm test` 命令 | 每次跑测试要手打 `node --test tests/xxx/*.test.ts` |
| CI 只跑 `tool-calling/` + 3 个文件 | 大量测试从未在 CI 运行，回归发现太晚 |
| 无测试覆盖率 | 不知道改一行代码影响哪些路径 |
| 无共享测试工具 | 每个测试文件重新发明工厂函数 |
| 无 pre-commit hook | 提交时不检查测试 |
| 无 mock HTTP 框架 | 每个测试手写 `Readable.from()` mock |
| Lint 只检查 `adapters/` | 其余代码无 lint 覆盖 |

### 8.3 目标实现

#### 8.3.1 package.json scripts

```json
{
  "scripts": {
    "test": "node --test tests/",
    "test:fast": "node --test tests/providers/qwen-session-continuity.test.ts tests/providers/glm-tool-calling.test.ts tests/services/summarySanitizer.test.ts tests/services/requestAssembly-context-economy.test.ts tests/tool-calling/tool-manifest.test.ts tests/tool-calling/tool-stream-parser.test.ts tests/services/promptBudget-context-economy.test.ts tests/providers/plugin-registry.test.ts",
    "test:ci": "node --test tests/",
    "test:coverage": "node --experimental-test-coverage --test tests/"
  }
}
```

**实测数据**（2026-07-17）：
- 5 个核心文件（4,289 行 / 128 个测试）：**0.64 秒**
- 扩展版（8 个文件 / ~170 个测试）：预估 **< 2 秒**
- 10 秒目标绰绰有余

#### 8.3.2 快速回归套件设计原则

快速回归套件（`test:fast`）覆盖以下契约：

| 测试文件 | 验证什么 | 为什么在快速套件中 | 行数 |
|---------|---------|------------------|------|
| `qwen-session-continuity.test.ts` | 会话连续性、delta 选择、mode 过滤 | Qwen 是最常用的 provider | 1835 |
| `glm-tool-calling.test.ts` | GLM 流式/非流式 tool call | GLM 是第二常用的 provider | 1760 |
| `summarySanitizer.test.ts` | 摘要输入净化、污染检测 | compact 是核心功能 | 232 |
| `requestAssembly-context-economy.test.ts` | 消息过滤、infrastructure prompt | 翻译链的核心环节 | 205 |
| `tool-manifest.test.ts` | 工具定义处理、managed protocol | tool calling 是核心功能 | 257 |
| `tool-stream-parser.test.ts` | 流式 tool call 解析 | 翻译链核心环节 | 761 |
| `promptBudget-context-economy.test.ts` | prompt 预算策略 | 上下文管理 | 92 |
| `plugin-registry.test.ts` | 所有 9 个 provider plugin 可实例化 | 防止 adapter 删除导致 plugin 崩溃 | ~30 |

**plugin-registry.test.ts（新增 smoke test）**：验证所有 9 个 provider plugin 能正常实例化，`renderRequest` 不抛异常。这是 Phase 0 删除 adapter 方法时的关键安全网——当前 Qwen/GLM 之外的 7 个 provider 没有任何测试覆盖。

#### 8.3.3 CI 配置

```yaml
# .github/workflows/ci.yml
jobs:
  lint:
    - npx eslint src/main/proxy/    # 扩展 lint 范围到整个 proxy
  typecheck:
    - npx tsc -p tsconfig.node.json --noEmit  # 去掉 grep 过滤，检查全部
  test-fast:
    - npm run test:fast              # 快速套件，必须通过
  test-full:
    - npm run test:ci                # 全量测试
    - continue-on-error: false       # 全量测试也必须通过
```

#### 8.3.4 共享测试工具

创建 `tests/helpers/testUtils.ts`：

```typescript
// 消息工厂
function makeSystemMsg(content: string): ChatMessage
function makeUserMsg(content: string): ChatMessage
function makeAssistantMsg(content: string, toolCalls?: ToolCall[]): ChatMessage
function makeToolMsg(callId: string, content: string): ChatMessage

// Tool call 工厂
function makeToolCall(id: string, name: string, args: Record<string, unknown>): ToolCall

// SSE 事件工厂
function sseEvent(data: unknown): string

// Mock HTTP 响应
function mockStreamResponse(events: string[]): Readable
function mockJsonResponse(data: unknown): { status, headers, data }

// Provider session mock
function mockSessionState(overrides?: Partial<SessionState>): SessionState
```

#### 8.3.5 契约测试

每个核心模块需要一个契约测试——验证输入→输出映射，而非实现细节：

```typescript
// tests/contracts/resolveQwenContentDelta.test.ts
test('contract: incremental append', () => {
  const result = resolveQwenContentDelta('Hello', 'Hello world')
  assert.strictEqual(result.text, ' world')
})

test('contract: snapshot replacement when shorter', () => {
  const result = resolveQwenContentDelta('Hello long text here', 'Hello short')
  // 不应崩溃、不应返回负数长度、不应丢弃内容
  assert.strictEqual(result.shouldEmit, true)
  assert.ok(result.text.length >= 0)
})

test('contract: managed tool rewrite detection', () => {
  const prev = 'Some text with <tools> block </tools>'
  const next = 'Some text with <tools> block </tools> and more'
  // 检测到 managed tool rewrite 时，应重放完整快照
  assert.strictEqual(result.shouldEmit, true)
})
```

#### 8.3.6 Pre-commit Hook

```json
// .husky/pre-commit
{
  "hooks": {
    "pre-commit": "npm run test:fast && npm run lint"
  }
}
```

### 8.4 验证标准

- [ ] `npm test` 一键运行所有测试
- [ ] `npm run test:fast` 在 10 秒内完成（实测 < 2 秒）
- [ ] CI 运行全量测试（不是只运行部分）
- [ ] CI 运行 lint（覆盖整个 `src/main/proxy/`，不只是 `adapters/`）
- [ ] 每个核心模块有契约测试
- [ ] 测试工具函数在 `tests/helpers/` 中共享
- [ ] Pre-commit hook 跑快速回归套件
- [ ] 新增 `plugin-registry.test.ts` smoke test 覆盖全部 9 个 provider

---

## 9. 改进领域四：AI Debug 循环

### 9.1 目标

让 AI agent 能够在 3 轮内定位 bug、修复、验证，不出现无意义的循环探索。

### 9.2 当前问题

AI 修 bug 的典型过程：

```
轮次 1: 读 dev.log → 猜测根因 → 改代码 → 构建 → 启动 → probe → 新的错误
轮次 2: 重新读 dev.log → 发现上次已经查到过的东西 → 改另一个地方 → 构建 → ...
轮次 3: 第一个改动引入了回归 → 不知道 → 继续改 → ...
轮次 4-N: 打转
```

每轮 3-4 分钟，50% 时间在做重复探索。

### 9.3 目标实现

#### 9.3.1 Debug State 文件

出 bug 时 AI 创建 `docs/superpowers/debug/YYYY-MM-DD-<slug>.md`：

```markdown
## bug-2026-07-17-read-loop.md

### 症状
模型连续 read 同一个文件 src/a.ts 5 次，参数完全相同

### 复现条件
- Qwen Qwen3.6 模型
- 长对话（>50 轮 tool call）
- 发生在 compact 之后

### 已排除的假设
- [x] Tool result 截断 — result 只有 800 字节，未被截断
- [x] 模型幻觉 — Qwen3.6 和 Qwen3.7 均复现
- [x] Streaming 导致 tool call 丢失 — 非流式也复现
- [ ] Compact 丢失 tool result — 待验证

### 关键证据
```
session=a1b2c3 turn=5 compact:triggered ctx:85%→28% dropped=12
session=a1b2c3 turn=6 tool:call:in tool=read args={"filePath":"src/a.ts"}
session=a1b2c3 turn=7 tool:call:in tool=read args={"filePath":"src/a.ts"}  ← 重复
```

### 分析
Turn 5 compact 后 dropped=12 条消息。如果被 drop 的消息中包含 turn 4 的 read result，
模型就会忘记已读过，从而在 turn 6-7 重复 read。

### 已尝试的修复
1. [2026-07-17 14:23] 在 compact 时保留最近 3 个 tool result — 效果：未验证

### 下一步
在 compact 前后分别打印 tool result message ID 列表，确认 turn 4 的 result 是否被 drop。

### 验证标准
- 同一 session 中同一文件被 read 不超过 2 次
- Compact 后模型记得最近一次 tool exchange 的结果
```

这个文件的规则：
- AI 创建和维护，不手动编辑
- 每个已排除的假设必须附带证据（日志行号、测试结果）
- "下一步" 必须是单一可执行的动作
- 修复后如果验证通过，文件末尾增加 `### 解决` 段落

#### 9.3.2 快速反馈循环

```
编辑代码 → npm run test:fast (< 2秒) → 通过？ → 继续
                                      → 失败？ → 看失败输出，修正，重跑
```

这是最核心的效率提升。没有快速测试反馈，AI 只能用"猜-改-等-看"循环，效率极低。

#### 9.3.3 结构化日志辅助定位

出问题时 AI 应该能通过一行命令看到完整时间线：

```powershell
# 按 session 过滤所有相关日志
Get-Content dev.log | Select-String "session=a1b2c3" | Select-Object -First 50

# 只看 tool call 循环信号
Get-Content dev.log | Select-String "session=a1b2c3" | Select-String "tool:call:in|tool:result:out|tool:loop:detect|compact:trigger"

# 看错误和警告
Get-Content dev.log | Select-String "session=a1b2c3" | Select-String "\[error\]|\[warn\]"
```

#### 9.3.4 自动化回归检测

```
pre-commit hook:
  1. npm run lint
  2. npm run test:fast     ← 如果不过，commit 被阻止
  3. npm run test (全量)    ← 如果不过，commit 被阻止
```

CI:
```
  1. lint
  2. typecheck
  3. test:fast (必须通过)
  4. test (全量，必须通过)
```

### 9.4 验证标准

- [ ] Debug state 文件模板存在于 `docs/superpowers/debug/` 目录
- [ ] AI 在首次诊断 bug 时自动创建 debug state 文件
- [ ] Debug state 文件在 bug 修复后包含 `### 解决` 段落
- [ ] `npm run test:fast` 在 10 秒内完成（实测 < 2 秒）
- [ ] Pre-commit hook 阻止不通过快速测试的提交
- [ ] CI 在 3 分钟内完成全量测试 + lint + typecheck

---

## 10. 实施路线图

### Phase 0a：旧架构死代码删除（优先，1 天）

**理由**：低风险纯删除，清理干扰为后续重构铺路。Phase 1 的快速测试套件建立后立即执行。

1. 删除所有 adapter 的 `chatCompletion()` 和 `chatCompletionWithAssembly()` 方法
2. 删除单例导出（`deepSeekAdapter` 等）
3. 删除 `ProviderRequestPreparer.ts`
4. 删除 `providerConversationState.ts` 中的 legacy session 字段
5. 删除 `forwarder.ts` 中的不可达 fallback 路径

**验证**：每删一个 adapter 的方法后跑 `npm run test:fast`。

**注意**：`*Adapter` 类本体保留——OAuth 流程仍需它们做 token 获取。

### Phase 1：测试基础设施（优先，2-3 天）

**理由**：没有快速测试反馈，任何重构都是盲飞。先建好安全网，再动代码。

1. 添加 `npm test`、`npm run test:fast`、`npm run test:ci` 命令
2. 创建 `tests/helpers/testUtils.ts` 共享测试工具
3. 新增 `tests/providers/plugin-registry.test.ts`——全 provider smoke test
4. 扩展 CI 到全量测试 + 扩展 lint 范围
5. 添加 pre-commit hook（test:fast + lint）
6. 为 5 个核心模块写契约测试

### Phase 2：日志系统（其次，2-3 天）

**理由**：没有结构化日志，出了 bug 定位太慢。Phase 1 的测试安全网已就位。

**第一波——关键路径**：
1. 实现 `Logger` 类 + 双出口 + 凭证脱敏
2. 迁移 `forwarder.ts` 到新 logger
3. 迁移 `ProviderRuntime.ts` 到新 logger
4. 迁移 `adapters/qwen.ts` 到新 logger
5. 迁移 `adapters/glm.ts` 到新 logger
6. 更新 `extract-session-log.ps1` 解析新格式
7. 添加 lint 规则禁止 `console.log`

**第二波——全量补齐**（Phase 3 完成后执行）：
8. 迁移其余 7 个 adapter 到新 logger
9. 移除 `console.log` 劫持过渡代码
10. 验证 `src/main/proxy/` 无 `console.log` 残留

### Phase 3：翻译链简化（最后，5-7 天）

**理由**：这是最大的代码变更，必须在测试和日志就位后进行。

#### Phase 3a：Qwen 先重构（2-3 天）

核心路径，最复杂。完成后用 probe 验证。

1. 定义 `CleanedRequest` 类型 + `requestCleaner.ts`
2. 从 `buildRequestAssembly` 中提取清理逻辑并去重
3. 创建 `providers/qwen/renderer.ts`——只做渲染
4. 创建 `providers/qwen/parser.ts`——只做解析
5. 重构 `QwenProviderPlugin.ts`——使用 `renderRequest` + `parseStream` + 内联 `deleteSession`
6. 将 Phase 0b（Qwen `deleteSession` 从 adapter 移到 plugin）一起做

**验证**：
- [ ] `npm run test:fast` 通过
- [ ] Qwen 短 probe 通过（`verify-opencode-capability.ps1 -Model "qwen/Qwen3.6"`）

#### Phase 3b：GLM + DeepSeek（1-2 天）

7. 创建 `providers/glm/renderer.ts` + `parser.ts`
8. 创建 `providers/deepseek/renderer.ts` + `parser.ts`
9. 重构 `GLMProviderPlugin.ts` + `DeepSeekProviderPlugin.ts`（含内联 session 清理）

**验证**：
- [ ] `npm run test:fast` 通过
- [ ] GLM 短 probe 通过
- [ ] DeepSeek 短 probe 通过

#### Phase 3c：其余 6 个 provider + 收尾（1-2 天）

10. 迁移 `kimi`、`mimo`、`minimax`、`perplexity`、`zai`、`qwen-ai`
11. 删除 `RequestAssembly.ts`、`providerPromptProjection.ts` 等旧文件
12. 删除 adapter 类中已被 plugin 替代的 session 清理方法
13. Phase 0c：合并 `buildInfrastructurePrompt` 为唯一实现

**验证**：
- [ ] `npm test` 全量通过
- [ ] `plugin-registry.test.ts` smoke test 通过
- [ ] **Qwen 长 probe**（10+ 轮 tool calling 交互）通过
- [ ] 日志确认请求链路从 12 步减少到 6 步

### Phase 4：AI Debug 循环（持续改进）

**理由**：随 Phase 1-3 完成后自然改善，不需要单独的大块时间。

1. 创建 debug state 文件模板
2. AI 在首个 bug 上试用
3. 根据使用体验迭代模板

---

## 11. 附录

### 11.1 关键文件索引

| 文件 | 行数 | 角色 | 重构影响 |
|------|------|------|---------|
| `src/main/proxy/forwarder.ts` | ~930 | 请求编排入口 | 大幅简化——移除重复的 assembly 逻辑 |
| `src/main/proxy/RequestAssembly.ts` | ~460 | 消息组装 | 重构为 `requestCleaner.ts`，逻辑去重 |
| `src/main/proxy/adapters/qwen.ts` | ~1540 | Qwen 适配器 | 拆分为 `renderer.ts` + `parser.ts`，移除所有过滤逻辑 |
| `src/main/proxy/adapters/glm.ts` | ~1200 | GLM 适配器 | 同上 |
| `src/main/proxy/services/ProviderRuntime.ts` | ~610 | Provider 运行时 | 简化——去除重复的 assembly 处理 |
| `src/main/proxy/services/providerPromptProjection.ts` | ~170 | 模式投影 | 合并入 `requestCleaner.ts` |
| `src/main/proxy/plugins/QwenProviderPlugin.ts` | ~350 | Qwen 插件包装 | 简化——去掉 body 构建，只委托给 renderer；内联 `deleteSession` |
| `src/main/proxy/plugins/GLMProviderPlugin.ts` | ~350 | GLM 插件包装 | 同上 |
| `src/main/proxy/services/summarySanitizer.ts` | ~255 | 摘要净化 | 不变 |
| `src/main/proxy/services/providerRequestGate.ts` | ~58 | 请求节流 | 不变 |
| `src/main/proxy/services/providerStreamGuard.ts` | ~53 | 流超时守卫 | 不变 |
| `src/main/proxy/toolCalling/ToolCallingEngine.ts` | - | 工具转换引擎 | 适配新的 CleanedRequest 接口 |
| `src/main/proxy/toolCalling/outputInspection.ts` | - | 输出检查 | 不变 |
| `scripts/extract-session-log.ps1` | ~560 | 日志分析 | 更新以解析新的 NDJSON 格式 |

### 11.2 测试文件索引

| 文件 | 行数 | 覆盖范围 | 快速套件 |
|------|------|---------|---------|
| `tests/providers/qwen-session-continuity.test.ts` | ~1835 | Qwen 会话生命周期 | ✅ |
| `tests/providers/glm-tool-calling.test.ts` | ~1760 | GLM 流式/非流式 tool call | ✅ |
| `tests/services/summarySanitizer.test.ts` | 232 | 摘要净化 | ✅ |
| `tests/services/requestAssembly-context-economy.test.ts` | 205 | 消息过滤 | ✅ |
| `tests/tool-calling/tool-manifest.test.ts` | 257 | 工具定义处理 | ✅ |
| `tests/tool-calling/tool-stream-parser.test.ts` | 761 | 流式 tool call 解析 | ✅ |
| `tests/services/promptBudget-context-economy.test.ts` | 92 | prompt 预算策略 | ✅ |
| `tests/providers/plugin-registry.test.ts` | (新增) | 全 provider smoke test | ✅ |
| `tests/providers/qwen-workspace-grounding.test.ts` | ~54 | Qwen 工作区锚点 | - |
| `tests/services/providerRequestGate.test.ts` | - | 请求节流 | - |
| `tests/services/providerStreamGuard.test.ts` | - | 流超时守卫 | - |
| `tests/mcp/orchestrator.test.ts` | - | Tool loop 检测 | - |
| `tests/services/contextManagement-*.test.ts` | 8 个文件 | Context compact | - |

### 11.3 不再维护的组件（重构后删除）

- `RequestAssembly.ts` → 被 `requestCleaner.ts` 取代
- `providerPromptProjection.ts` → 合并入 `requestCleaner.ts`
- `adapters/qwen.ts` 中的 `buildQwenAssemblyRequestBody`、`buildQwenChatRequestBody` → 被 `providers/qwen/renderer.ts` 取代
- `adapters/glm.ts` 中的 body 构建函数 → 被 `providers/glm/renderer.ts` 取代
- `prepareRequest()` 方法 → 逻辑上移到 `CleanedRequest` 构建中

### 11.4 术语映射（旧 → 新）

| 旧术语 | 新术语 |
|--------|--------|
| RequestAssembly | CleanedRequest |
| buildRequestAssembly | buildCleanedRequest |
| selectProviderMessagesForAssembly | (合并入 requestCleaner) |
| projectRequestAssemblyForPromptMode | (合并入 requestCleaner 的 mode truncation) |
| filterConversationForMode | (合并入 requestCleaner 的 mode truncation) |
| plugin.buildRequest | plugin.renderRequest |
| adapter/plugin 混用 | 统一为 plugin (renderRequest + parseStream) |

### 11.5 代码验证记录

以下结论基于 2026-07-17 的实际代码审查：

| 验证项 | 结论 |
|--------|------|
| `chatCompletion`/`chatCompletionWithAssembly` 是否死代码 | ✅ 确认——全局搜索无生产调用者 |
| Adapter 类能否整体删除 | ❌ 不能——OAuth 流程仍需 adapter 做 token 获取 |
| test:fast 5 文件耗时 | 0.64 秒（128 测试全部通过） |
| `new XxxAdapter()` 调用点 | 3 类：OAuth、IPC handlers、Plugin session 清理 |
| 9 个 provider 中多少个无测试覆盖 | 7 个（仅 Qwen 和 GLM 有测试） |
