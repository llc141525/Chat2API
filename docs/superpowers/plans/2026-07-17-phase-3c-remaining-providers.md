# Phase 3c：其余 Provider + 收尾清理

> **真源**：[架构基础重构](./2026-07-17-architecture-foundation.md) §6 + §5 (Phase 0b, 0c)
> **前置依赖**：Phase 3a, Phase 3b
> **预计耗时**：1-2 天
> **风险等级**：中低（复用已验证的框架，6 个 provider 批量迁移）

## 目标

1. 迁移剩余 6 个 provider（kimi, mimo, minimax, perplexity, zai, qwen-ai）到新架构
2. 完成 Phase 0b：所有 provider 的 session 清理逻辑内联到 plugin
3. 完成 Phase 0c：合并 `buildInfrastructurePrompt` 为唯一实现
4. 删除所有旧文件
5. Qwen 长 probe 最终验证

## 步骤 1：批量迁移 6 个 provider

每个 provider 的标准迁移步骤（与 Phase 3a/3b 相同）：

1. 创建 `providers/<name>/renderer.ts`——从 adapter 提取纯渲染
2. 创建 `providers/<name>/parser.ts`——从 adapter 提取纯解析
3. 修改 `plugins/<Name>ProviderPlugin.ts`——委托给 renderer/parser + 内联 session 清理

逐个迁移，每完成一个跑 `npm run test:fast`。

| Provider | 迁移顺序 | 特殊注意事项 |
|----------|---------|-------------|
| kimi | 1 | 消息格式接近 OpenAI，渲染较简单 |
| qwen-ai | 2 | `mapModel()` 逻辑内联到 renderer |
| minimax | 3 | HTTP/2 流处理，需要保留现有 HTTP/2 逻辑 |
| zai | 4 | 自己的 auth 机制 |
| perplexity | 5 | 最接近标准 OpenAI 格式 |
| mimo | 6 | 验证最后的 provider |

### 步骤 2：完成 Phase 0b——消除所有 adapter session 依赖

验证所有 9 个 plugin 不再 `import` 对应的 `*Adapter` 类：

```bash
git grep "new QwenAdapter\|new GLMAdapter\|new DeepSeekAdapter\|new KimiAdapter\|new MimoAdapter\|new MiniMaxAdapter\|new PerplexityAdapter\|new QwenAiAdapter\|new ZaiAdapter" src/main/proxy/plugins/
# 应返回空（或仅在注释中）
```

**注意**：`oauth/adapters/index.ts` 和 `ipc/handlers.ts` 仍然可以使用 `*Adapter`——它们不属于本次重构范围。

### 步骤 3：完成 Phase 0c——合并 buildInfrastructurePrompt

将 `providerPromptProjection.ts` 的逻辑合并入 `requestCleaner.ts` 的 `buildCleanedRequest`：

1. 确认 `requestCleaner.ts` 中的 `buildInfrastructurePrompt` 使用不截断 strategy
2. 删除 `providerPromptProjection.ts`
3. 更新所有 import 路径

### 步骤 4：删除旧文件

确认无引用后删除：

```
src/main/proxy/RequestAssembly.ts
src/main/proxy/services/providerPromptProjection.ts
src/main/proxy/adapters/ProviderRequestPreparer.ts  (如 Phase 0a 未删)
```

对每个 adapter 文件，删除已被 renderer/parser 替代的部分。**保留 adapter 类中仍被 OAuth 使用的 token 获取方法。**

### 步骤 5：更新测试 import

所有测试文件如果 import 了已删除/移动的函数，更新 import 路径：

```bash
# 检查所有需要更新的 import
git grep "from.*RequestAssembly\|from.*providerPromptProjection" tests/
```

### 步骤 6：全量测试 + Qwen 长 probe

```bash
# 全量测试
npm test

# Qwen 长 probe（10+ 轮 tool calling 交互）
# Terminal 1
npm run dev:win 2>&1 | Tee-Object -FilePath .\dev.log

# Terminal 2：用 opencode 进行真实的 10+ 轮多 tool 交互
# 验证：catalog continuity、compact 后不丢 tool result、session 不丢失
```

**长 probe 是最关键的验证**——单元测试和短 probe 只能验证单次请求，长 probe 验证多轮交互中的状态持续性。

### 步骤 7：日志验证

用 `extract-session-log.ps1` 确认请求链路：

```powershell
.\scripts\extract-session-log.ps1 -LogPath .\dev.log
```

检查：
- 无 `REJ:*`（summary rejected）
- Compact 后 provider session 不变
- 无 `FALLBACK`
- 无子 session 未清理（`tool_child` 无 `del:`）

## 验证标准

- [ ] `npm test` 全量通过
- [ ] `plugin-registry.test.ts` smoke test 通过（所有 9 个 provider）
- [ ] 所有 9 个 plugin 不再 import 对应的 `*Adapter` 类（session 清理逻辑已内联）
- [ ] 只有一套 `buildInfrastructurePrompt` 实现
- [ ] 旧的 `RequestAssembly.ts` + `providerPromptProjection.ts` 已删除
- [ ] Qwen 长 probe 通过（10+ 轮多 tool 交互，compact 后不丢上下文）
- [ ] 日志确认请求链路为 6 步（无重复过滤、无重复截断、无重复 infra prompt 构建）

## 关键文件变更汇总

| 操作 | 文件 |
|------|------|
| 新建 | `providers/kimi/renderer.ts`, `parser.ts` |
| 新建 | `providers/qwen-ai/renderer.ts`, `parser.ts` |
| 新建 | `providers/minimax/renderer.ts`, `parser.ts` |
| 新建 | `providers/zai/renderer.ts`, `parser.ts` |
| 新建 | `providers/perplexity/renderer.ts`, `parser.ts` |
| 新建 | `providers/mimo/renderer.ts`, `parser.ts` |
| 修改 | 6 个 `plugins/*ProviderPlugin.ts` |
| 删除 | `RequestAssembly.ts` |
| 删除 | `providerPromptProjection.ts` |
| 删除 | `ProviderRequestPreparer.ts` |

## 注意事项

- **不要动 OAuth 对 adapter 的依赖**（`oauth/adapters/index.ts`）——OAuth 流程不是本次重构范围
- **不要动 IPC handlers 对 adapter 的依赖**（`ipc/handlers.ts` 的 `deleteAllChats`）——可留到后续重构
- 6 个 provider 逐个迁移，每完成一个验证，不要批量操作
- Minimax 的 HTTP/2 流处理是特殊路径，需要格外小心
- 长 probe 失败时，用 `extract-session-log.ps1` 分析日志，不要猜测
