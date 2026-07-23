# Phase 3b：GLM + DeepSeek 翻译链简化

> **真源**：[架构基础重构](./2026-07-17-architecture-foundation.md) §6
> **前置依赖**：Phase 3a（CleanedRequest + requestCleaner 已就位，Qwen 已验证）
> **后置依赖**：Phase 3c
> **预计耗时**：1-2 天
> **风险等级**：中（复用 Phase 3a 的框架，但需适配各自的 wire format）

## 目标

将 GLM 和 DeepSeek 的 plugin 迁移到新的 `renderRequest` + `parseStream` 架构，内联 session 清理逻辑。

## 前提

Phase 3a 完成后，以下基础设施已就位：
- `CleanedRequest` 类型
- `core/requestCleaner.ts`（`buildCleanedRequest`）
- ProviderRuntime 已适配 `CleanedRequest` 流程
- Qwen plugin 已是 `renderRequest` + `parseStream` 模式，可作为参考

## GLM

### 步骤 1：创建 providers/glm/renderer.ts

从 `adapters/glm.ts` 中提取纯渲染逻辑：

```typescript
export function renderGLMRequest(input: {
  cleaned: CleanedRequest
  model: string
  stream: boolean
  enableThinking: boolean
  enableWebSearch: boolean
}): GLMWebRequest
```

GLM 的特殊处理：
- Managed XML 格式的 tool prompt 注入（通过 `ToolCallingEngine`）
- GLM 特定的 JSON 请求体结构
- MD5 签名（从现有 adapter 逻辑迁移）
- 思考模式参数（`thinking` type）

### 步骤 2：创建 providers/glm/parser.ts

```typescript
export async function* parseGLMStream(input: {
  response: AxiosResponse
  model: string
  toolCallingPlan?: ToolCallingPlan
}): AsyncIterable<ProviderRuntimeEvent>
```

GLM 的特殊处理：
- SSE event-stream 解析
- Managed XML tool call 块提取
- 流式和非流式两种路径

### 步骤 3：重构 GLMProviderPlugin.ts

1. `buildRequest` → 委托给 `renderGLMRequest`
2. `parseStream` → 委托给 `parseGLMStream`
3. `deleteConversation` → 内联到 plugin（从 adapter 迁移 HTTP 调用）
4. `acquireToken` → 内联到 plugin（从 adapter 迁移 token 获取）

**验证**：GLM plugin 不再 `import { GLMAdapter }`。

### 步骤 4：GLM 短 probe 验证

```powershell
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "glm/GLM-5.2"
```

## DeepSeek

### 步骤 5：创建 providers/deepseek/renderer.ts

```typescript
export function renderDeepSeekRequest(input: {
  cleaned: CleanedRequest
  model: string
  stream: boolean
  enableThinking: boolean
  enableWebSearch: boolean
}): DeepSeekWebRequest
```

DeepSeek 的特殊处理：
- Managed bracket 格式的 tool prompt
- PoW 挑战计算（`DeepSeekHashV1` + WASM）
- Session 创建（token + session + PoW + completion 四步调用）
- Messages 数组格式（与 OpenAI 类似，不需要 flat text 转换）

### 步骤 6：创建 providers/deepseek/parser.ts

```typescript
export async function* parseDeepSeekStream(input: {
  response: AxiosResponse
  model: string
  toolCallingPlan?: ToolCallingPlan
}): AsyncIterable<ProviderRuntimeEvent>
```

### 步骤 7：重构 DeepSeekProviderPlugin.ts

1. `buildRequest` → 委托给 `renderDeepSeekRequest`
2. `parseStream` → 委托给 `parseDeepSeekStream`
3. `deleteSession` → 内联到 plugin

### 步骤 8：DeepSeek 短 probe 验证

```powershell
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "deepseek/DeepSeek-V4"
```

## 验证标准

- [ ] `npm run test:fast` 全程通过
- [ ] GLM plugin 不再 `import { GLMAdapter }`
- [ ] DeepSeek plugin 不再 `import { DeepSeekAdapter }`
- [ ] GLM 短 probe 通过（多轮 tool calling）
- [ ] DeepSeek 短 probe 通过

## 关键文件变更

| 操作 | 文件 |
|------|------|
| 新建 | `src/main/proxy/providers/glm/renderer.ts` |
| 新建 | `src/main/proxy/providers/glm/parser.ts` |
| 修改 | `src/main/proxy/plugins/GLMProviderPlugin.ts` |
| 新建 | `src/main/proxy/providers/deepseek/renderer.ts` |
| 新建 | `src/main/proxy/providers/deepseek/parser.ts` |
| 修改 | `src/main/proxy/plugins/DeepSeekProviderPlugin.ts` |

## 注意事项

- **DeepSeek 的 PoW 逻辑不要简化或重写**——它已经在生产环境验证过，直接迁移即可
- **GLM 的 MD5 签名逻辑同样不要改**
- 两个 provider 的 `renderer.ts` 都只做渲染，不做过滤或截断
- 如果某个 provider 的 `enableWebSearch` 参数映射不同于 Qwen，在 renderer 中处理
