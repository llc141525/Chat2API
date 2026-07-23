# Phase 1：测试基础设施

> **真源**：[架构基础重构](./2026-07-17-architecture-foundation.md) §8
> **前置依赖**：无（优先执行）
> **后置依赖**：Phase 0a, Phase 2, Phase 3 均依赖本阶段
> **预计耗时**：2-3 天
> **风险等级**：低（不影响生产代码）

## 目标

建立分层测试体系：10 秒快速回归、一键全量测试、CI 自动运行、pre-commit hook。

## 执行步骤

### 步骤 1：添加 npm scripts

在 `package.json` 的 `scripts` 中添加：

```json
{
  "test": "node --test tests/",
  "test:fast": "node --test tests/providers/qwen-session-continuity.test.ts tests/providers/glm-tool-calling.test.ts tests/services/summarySanitizer.test.ts tests/services/requestAssembly-context-economy.test.ts tests/tool-calling/tool-manifest.test.ts tests/tool-calling/tool-stream-parser.test.ts tests/services/promptBudget-context-economy.test.ts tests/providers/plugin-registry.test.ts",
  "test:ci": "node --test tests/",
  "test:coverage": "node --experimental-test-coverage --test tests/"
}
```

**验证**：`npm run test:fast` 在 2 秒内完成，全部通过。

### 步骤 2：创建共享测试工具

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

从现有测试文件中提取重复的工厂函数，统一到此文件。

**验证**：`npm run test:fast` 仍通过。

### 步骤 3：新增 plugin-registry smoke test

创建 `tests/providers/plugin-registry.test.ts`：

验证所有 9 个 provider plugin：
1. 可正常实例化
2. `capabilities` 字段存在且有效
3. `buildRequest`（或 `renderRequest`）方法存在
4. `parseStream` 方法存在

**这是 Phase 0 删除 adapter 方法时的关键安全网**——因为 Qwen/GLM 之外的 7 个 provider 当前无任何测试覆盖。

**验证**：`npm run test:fast` 通过（此文件已在 test:fast 套件中）。

### 步骤 4：扩展 CI 配置

更新 `.github/workflows/ci.yml`（如不存在则创建）：

```yaml
jobs:
  lint:
    - npx eslint src/main/proxy/    # 扩展 lint 范围到整个 proxy
  typecheck:
    - npx tsc -p tsconfig.node.json --noEmit
  test-fast:
    - npm run test:fast
  test-full:
    - npm run test:ci
    - continue-on-error: false
```

关键变更：
- lint 范围从 `adapters/` 扩展到 `src/main/proxy/`
- typecheck 去掉 grep 过滤，检查全部
- 全量测试 `continue-on-error: false`（必须通过）

### 步骤 5：添加 pre-commit hook

使用 husky（如果项目未安装则先安装）：

```bash
npx husky add .husky/pre-commit "npm run test:fast && npm run lint"
```

如果没有 husky，手动创建 `.husky/pre-commit`。

**验证**：`git commit` 时 hook 触发。

### 步骤 6：为核心模块写契约测试

为以下 5 个核心模块各写 1 个契约测试（输入→输出映射）：

| 模块 | 测试文件 | 关键契约 |
|------|---------|---------|
| `resolveQwenContentDelta` | `tests/contracts/resolveQwenContentDelta.test.ts` | 增量追加、快照变短不崩溃、managed tool rewrite 检测 |
| `filterProviderMessageHistory` | `tests/contracts/filterProviderMessageHistory.test.ts` | runtime config 过滤、system prompt 保留 |
| `summarySanitizer` | 已有 `tests/services/summarySanitizer.test.ts` | 复用现有 |
| `ToolStreamParser` | `tests/contracts/tool-stream-parser.test.ts` | 完整 tool call 块解析、跨 chunk 解析、非 tool 文本不误判 |
| `buildInfrastructurePrompt` | `tests/contracts/buildInfrastructurePrompt.test.ts` | agent definition 合并、workflow step 提取 |

## 验证标准

- [ ] `npm test` 一键运行所有测试
- [ ] `npm run test:fast` 在 10 秒内完成（实测 < 2 秒）
- [ ] CI 运行全量测试 + lint（覆盖全部 `src/main/proxy/`）+ typecheck
- [ ] 每个核心模块有契约测试
- [ ] 测试工具函数在 `tests/helpers/testUtils.ts` 中共享
- [ ] Pre-commit hook 跑 `test:fast` + `lint`
- [ ] `plugin-registry.test.ts` 覆盖全部 9 个 provider

## 注意事项

- 契约测试只需验证核心输入→输出映射，不测实现细节
- `testUtils.ts` 从现有测试文件中提取时保持函数签名不变
- CI 配置如果项目已有 `.github/workflows/`，merge 而非覆盖
