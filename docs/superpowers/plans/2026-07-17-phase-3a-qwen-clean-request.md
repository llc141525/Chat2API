# Phase 3a：Qwen 翻译链简化

> **真源**：[架构基础重构](./2026-07-17-architecture-foundation.md) §6
> **前置依赖**：Phase 0a, Phase 1, Phase 2
> **后置依赖**：Phase 3b, 3c
> **预计耗时**：2-3 天
> **风险等级**：高（核心路径重构，涉及多种消息格式和 prompt refresh mode）

## 目标

将 Qwen 请求处理从 12 步减少到 6 步。引入 `CleanedRequest` 中间数据结构，通用层做清洗，Qwen 层只做渲染+解析。

同时完成 Phase 0b：将 Qwen 的 `deleteSession` 从 `QwenAdapter` 内联到 `QwenProviderPlugin`。

## 关键概念

```
之前: forwarder → buildRequestAssembly → projectForMode → plugin.buildRequest → ... (12步)
之后: forwarder → buildCleanedRequest → plugin.renderRequest → plugin.parseStream (6步)
```

`CleanedRequest` 是通用层产出、Provider 层消费的唯一接口：

```typescript
interface CleanedRequest {
  messages: ChatMessage[]
  summaryText: string | null
  infrastructurePrompt: string | null
  toolDefinitions: ToolDef[]
  activeSkillCheckpoint: string | null
  mode: PromptRefreshMode  // full | digest | tool_ready | minimal | repair
}
```

## 执行步骤

### 步骤 1：定义 CleanedRequest + requestCleaner.ts

创建 `src/main/proxy/core/requestCleaner.ts`：

从 `RequestAssembly.ts` 和 Qwen adapter 中提取并合并以下逻辑：

| 原位置 | 逻辑 | 合并后 |
|--------|------|--------|
| `RequestAssembly.ts` → `buildRequestAssembly` | 消息组装入口 | `buildCleanedRequest()` |
| `RequestAssembly.ts` → `filterProviderMessageHistory` (①) | 第一次过滤（dropRuntimeConfig） | 合并参数：dropRuntimeConfig + stripRuntimeConfig + stripToolContractHistory 全开 |
| `providerPromptProjection.ts` → `buildInfrastructurePrompt` | 基础设施提示词构建 | 只保留不截断 agent definition 的版本 |
| `adapters/qwen.ts` → `selectQwenDeltaMessages` | Delta 选择 | 通用化为 `useDeltaMessages` 选项 |
| `adapters/qwen.ts` → `filterConversationForMode` | 模式截断 | 参数化：`ModeTruncationOptions` |

```typescript
interface ModeTruncationOptions {
  maxMessages: number           // 默认 6
  preserveSystemPrompts: boolean // 默认 true
  widenForOrphanToolResults: boolean // 默认 true
}

function buildCleanedRequest(input: {
  messages: ChatMessage[]
  toolDefinitions: ToolDef[]
  sessionExists: boolean          // 用于决定是否 delta
  lastAssistantToolCallIndex?: number  // delta 起点
  mode: PromptRefreshMode
  truncation: ModeTruncationOptions
}): CleanedRequest
```

**关键原则**：
- `filterProviderMessageHistory` 只调用一次，使用最严格参数
- Mode-based truncation 只在 `requestCleaner` 中执行一次
- `buildInfrastructurePrompt` 只调用一次
- 如果某 provider 需要保留 runtime config，通过 `preserveRuntimeConfig: true` 声明

**验证**：`npm run test:fast` 通过（现有测试验证了过滤和截断逻辑）。

### 步骤 2：创建 providers/qwen/renderer.ts

从 `adapters/qwen.ts` 中提取纯渲染逻辑：

```typescript
// providers/qwen/renderer.ts
export function renderQwenRequest(input: {
  cleaned: CleanedRequest
  model: string
  stream: boolean
  enableThinking: boolean
  enableWebSearch: boolean
}): QwenWebRequest
```

渲染器 **只做以下事情**：
1. 分离 system/summary/skill buckets
2. 截断 tool result（2000 chars）
3. 调用 `renderFinalPrompt` 拼成 flat text
4. 构建 HTTP 请求 headers + body

渲染器 **不做**：
- ❌ 过滤 runtime config（CleanedRequest 已完成）
- ❌ Mode-based 截断（CleanedRequest 已完成）
- ❌ Delta 选择（CleanedRequest 已完成）
- ❌ 构建 infrastructure prompt（CleanedRequest 已完成）

**验证**：现有 Qwen 测试仍在 `npm run test:fast` 中通过（需要更新测试的 import 路径）。

### 步骤 3：创建 providers/qwen/parser.ts

从 `adapters/qwen.ts` 中提取纯解析逻辑，基本不变：

```typescript
// providers/qwen/parser.ts
export async function* parseQwenStream(input: {
  response: AxiosResponse
  model: string
  toolCallingPlan?: ToolCallingPlan
}): AsyncIterable<ProviderRuntimeEvent>

export function parseQwenNonStream(input: {
  response: AxiosResponse
  model: string
  toolCallingPlan?: ToolCallingPlan
}): ProviderRuntimeResult
```

解析器内容：解压 → event-stream 解析 → 提取 thinking → `resolveQwenContentDelta` → `ToolStreamParser` → `finalizeStream` + `outputInspection`。

### 步骤 4：重构 QwenProviderPlugin.ts

修改 `plugins/QwenProviderPlugin.ts`：

1. `buildRequest` → 委托给 `renderQwenRequest(cleaned, ...)`
2. `parseStream` → 委托给 `parseQwenStream(...)`
3. `parseNonStream` → 委托给 `parseQwenNonStream(...)`
4. **内联 `deleteSession`**（Phase 0b）：

```typescript
// 之前
async deleteSession(input) {
  const adapter = new QwenAdapter(input.provider, input.account)
  return adapter.deleteSession(input.sessionId)
}

// 之后
async deleteSession(input) {
  const headers = this.buildDeleteHeaders(input.account)
  return axios.post(`${API_BASE}/session/delete/batch`, 
    { sessionIds: [input.sessionId] }, { headers })
}
```

**验证**：
- `npm run test:fast` 通过
- Qwen plugin 不再 `import { QwenAdapter }`

### 步骤 5：更新 ProviderRuntime.ts 调用链

修改 `ProviderRuntime.ts`，将调用链改为：

```
buildCleanedRequest(...) → plugin.renderRequest(cleaned, ...) → HTTP → plugin.parseStream(...)
```

移除对 `RequestAssembly`、`projectRequestAssemblyForPromptMode`、`providerPromptProjection` 的依赖。

**验证**：`npm run test:fast` 通过。

### 步骤 6：Qwen 短 probe 验证

```powershell
# Terminal 1：启动 proxy
npm run dev:win 2>&1 | Tee-Object -FilePath .\dev.log

# Terminal 2：跑 probe
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "qwen/Qwen3.6"
```

验证点：
- 多轮 tool calling 正常
- Non-stream 转换正常
- Session 连续性（多轮不丢失上下文）
- Catalog continuity across sessions

**这是最关键的验证步骤。单元测试通过 ≠ 模型能正常 tool calling。**

## 验证标准

- [ ] `npm run test:fast` 全程通过
- [ ] Qwen plugin 不再 `import { QwenAdapter }`
- [ ] `filterProviderMessageHistory` 在整个请求生命周期中只调用一次
- [ ] `buildInfrastructurePrompt` 只调用一次
- [ ] Mode-based truncation 只在 `requestCleaner.ts` 中执行
- [ ] Qwen 短 probe 通过（多轮 tool calling、non-stream、session 连续性）
- [ ] 日志确认请求链路从 12 步减少到 6 步

## 关键文件变更

| 操作 | 文件 |
|------|------|
| 新建 | `src/main/proxy/core/requestCleaner.ts` |
| 新建 | `src/main/proxy/providers/qwen/renderer.ts` |
| 新建 | `src/main/proxy/providers/qwen/parser.ts` |
| 修改 | `src/main/proxy/plugins/QwenProviderPlugin.ts`（简化为委托 + 内联 deleteSession） |
| 修改 | `src/main/proxy/services/ProviderRuntime.ts`（简化调用链） |
| 修改 | `src/main/proxy/forwarder.ts`（移除 assembly 逻辑） |
| 保留 | `src/main/proxy/toolCalling/ToolCallingEngine.ts`（适配 CleanedRequest） |
| 保留 | `src/main/proxy/adapters/qwen.ts`（不删——Phase 3c 统一清理旧文件） |

## 注意事项

- **保留 `adapters/qwen.ts` 直到 Phase 3c**——避免提前删除导致其他代码路径断裂
- **不要同时改 `RequestAssembly.ts`**——先创建 `requestCleaner.ts`，验证通过后再在 Phase 3c 删除旧文件
- **`resolveQwenContentDelta` 的契约测试必须在步骤 1 之前写好**——这是最脆弱的环节
- **Qwen 的 `digest` 模式参数**: `{maxMessages: 4, preserveSystemPrompts: true, widenForOrphanToolResults: true}`
