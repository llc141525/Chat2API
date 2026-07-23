# Phase 0a：旧架构死代码删除

> **真源**：[架构基础重构](./2026-07-17-architecture-foundation.md) §5
> **前置依赖**：Phase 1（`npm run test:fast` 必须可用）
> **预计耗时**：1 天
> **风险等级**：低（纯删除，无逻辑变更）

## 目标

删除 ProviderRuntime + WebProviderPlugin 架构迁移后遗留的死代码。不改变任何运行时行为。

## 背景

项目在 commit `a9edc38` 重构后，旧 adapter 的 `chatCompletion()` / `chatCompletionWithAssembly()` 方法、单例导出、`ProviderRequestPreparer.ts` 等均无调用者。这些死代码造成调试干扰、重复实现和测试盲区。

**重要**：`*Adapter` 类本体保留——OAuth 流程（`oauth/adapters/index.ts`）仍需它们做 token 获取。

## 执行步骤

### 步骤 1：删除 adapter 的 chatCompletion / chatCompletionWithAssembly

每个 adapter 删除后立即跑 `npm run test:fast`。

```
adapters/deepseek.ts    L404-515   chatCompletion + chatCompletionWithAssembly
adapters/kimi.ts        L223-340   同上
adapters/mimo.ts        L423-520   同上
adapters/minimax.ts     L499-680   同上
adapters/perplexity.ts  L293-460   同上
adapters/qwen-ai.ts     L237-460   同上
adapters/zai.ts         L340-620   同上
```

**验证**：`npm run test:fast` 每步通过。

### 步骤 2：删除 qwen adapter 的旧 body 构建函数

```
adapters/qwen.ts  L169-282  buildQwenChatRequestBody() + wrapper
```

**注意**：需同步更新引用这些函数的测试文件，改为使用 `buildQwenAssemblyRequestBody` 或对应的新函数。

**验证**：`npm run test:fast` 通过。

### 步骤 3：删除 glm adapter 的测试专用函数

```
adapters/glm.ts  L145  buildGLMPromptMessagesForTest()
```

**验证**：`npm run test:fast` 通过。

### 步骤 4：删除 ProviderRequestPreparer.ts

```
adapters/ProviderRequestPreparer.ts  整个文件（27 行）
```

无任何类实现此接口，安全删除。

**验证**：`npm run build` 通过。

### 步骤 5：删除单例导出

```
adapters/index.ts  删除以下导出：
  deepSeekAdapter, glmAdapter, qwenAdapter, kimiAdapter,
  mimoAdapter, minimaxAdapter, perplexityAdapter,
  qwenAiAdapter, zaiAdapter
```

全局搜索确认无使用者后逐个删除。

**验证**：
```
git grep "deepSeekAdapter\|glmAdapter\|..." src/  返回空（或仅 barrel re-export）
npm run build 通过
```

### 步骤 6：删除 legacy session 字段

```
services/providerConversationState.ts  L14-19
  删除 qwenSessionId, qwenParentReqId, childQwenSessionId
```

**验证**：`npm run test:fast` + `npm run build` 通过。

### 步骤 7：删除 forwarder 不可达 fallback 路径

```
forwarder.ts  L634-697  通用 HTTP fallback 路径
```

仅当 `CHAT2API_DEDICATED_PROVIDER_FALLBACK` 环境变量显式设置时触发，所有 9 个 provider 已注册 ProviderRuntime plugin。

**验证**：`npm run test:fast` + `npm run build` 通过。

## 验证标准

- [ ] `npm run test:fast` 全程通过
- [ ] `npm test` 全量测试通过
- [ ] `npm run build` 通过
- [ ] `git grep "chatCompletion\|chatCompletionWithAssembly" src/main/proxy/adapters/` 返回空
- [ ] 单例导出已从 `adapters/index.ts` 移除
- [ ] `ProviderRequestPreparer.ts` 文件已删除
- [ ] `providerConversationState.ts` 中无 legacy session 字段
- [ ] `forwarder.ts` 中无不可达 fallback 路径

## 注意事项

- **每步后验证，不要批量删除后一起测**——出问题时难以定位
- **不要动 `*Adapter` 类的其他方法**（`acquireToken`, `deleteSession`, `deleteAllChats` 等）——OAuth 和 IPC handlers 还在用
- **不要动 deprecated wrapper 文件**——留给 Phase 3
- 删除 `buildQwenChatRequestBody` 时需要同步更新测试文件的 import
