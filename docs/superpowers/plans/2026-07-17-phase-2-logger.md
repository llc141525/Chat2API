# Phase 2：日志系统重构

> **真源**：[架构基础重构](./2026-07-17-architecture-foundation.md) §7
> **前置依赖**：Phase 1（`npm run test:fast` 可用）
> **后置依赖**：Phase 3 调试依赖结构化日志
> **预计耗时**：2-3 天（第一波）+ 1 天（第二波，Phase 3 后）
> **风险等级**：中（改变日志行为，但不改业务逻辑）

## 目标

将两个互不通信的日志系统（UI 日志 + 终端 console.log）统一为结构化、可过滤、按会话关联的日志系统。双出口（UI + NDJSON 文件），三级过滤（debug/info/warn/error），自动凭证脱敏。

## 第一波：关键路径迁移（Phase 2 主体）

### 步骤 1：实现 Logger 类

创建 `src/main/proxy/shared/logger.ts`：

```typescript
type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogEvent {
  ts: number
  level: LogLevel
  tag: string           // 'qwen:renderer', 'forwarder:compact'
  msg: string
  sessionId?: string
  data?: Record<string, unknown>
  err?: { message: string, stack?: string }
}

interface Logger {
  debug(tag: string, msg: string, data?: Record<string, unknown>): void
  info(tag: string, msg: string, data?: Record<string, unknown>): void
  warn(tag: string, msg: string, data?: Record<string, unknown>): void
  error(tag: string, msg: string, err?: Error, data?: Record<string, unknown>): void
}

// 全局实例
const logger: Logger & {
  setLevel(level: LogLevel): void
  child(sessionId: string): Logger
}
```

核心功能：
- **双出口**：`info/warn/error` → UI（storeManager）+ NDJSON；`debug` → NDJSON only
- **级别过滤**：`CHAT2API_LOG_LEVEL` 环境变量控制（默认 `info`）
- **凭证脱敏**：自动替换 `token`、`apiKey`、`cookie` 等敏感字段为 `[REDACTED]`
- **子 logger**：`logger.child(sessionId)` 创建绑定 sessionId 的 logger

**验证**：单元测试覆盖日志写入、级别过滤、脱敏。

### 步骤 2：添加 console.log 劫持（过渡期）

在 logger 初始化时劫持全局 `console.log`，将旧代码的输出自动转为 `logger.debug('legacy:console', msg)`：

```typescript
const originalLog = console.log
console.log = (...args: unknown[]) => {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
  logger.debug('legacy:console', msg)
  originalLog(...args)
}
```

**验证**：启动 proxy，`console.log('[Qwen] something')` 同时出现在终端和 NDJSON 文件中。

### 步骤 3：迁移 forwarder.ts

替换 `forwarder.ts` 中的所有 `console.log` 为 `logger.info/warn/error/debug`。

Tag 命名：
- `forwarder:compact:trigger` — compact 触发
- `forwarder:compact:summary` — summary 生成
- `forwarder:retry:attempt` — 重试
- `forwarder:request:start` — 请求开始，带 sessionId
- `forwarder:request:end` — 请求结束

**验证**：`npm run test:fast` + 启动 proxy 发一个请求，确认日志出现在 UI 和 NDJSON。

### 步骤 4：迁移 ProviderRuntime.ts

替换 `ProviderRuntime.ts` 中的 `console.log`。

Tag 命名：
- `runtime:forward:start` — 转发开始
- `runtime:forward:end` — 转发结束
- `runtime:session:create` — 创建 session
- `runtime:session:reuse` — 复用 session

**验证**：同上。

### 步骤 5：迁移 adapters/qwen.ts

替换 `adapters/qwen.ts` 中的 `console.log`。

Tag 命名：
- `qwen:renderer:build` — 构建请求
- `qwen:parser:delta` — delta 计算
- `qwen:parser:tool` — tool call 解析
- `qwen:session:delete` — 删除 session

**验证**：同上。

### 步骤 6：迁移 adapters/glm.ts

替换 `adapters/glm.ts` 中的 `console.log`。

Tag 命名：
- `glm:renderer:build`
- `glm:parser:tool`
- `glm:session:delete`

**验证**：同上。

### 步骤 7：更新 extract-session-log.ps1

更新 `scripts/extract-session-log.ps1` 以解析新的 NDJSON 格式：

```powershell
# 新格式：每行一个 JSON 对象
Get-Content $LogPath | ForEach-Object {
  $event = $_ | ConvertFrom-Json
  # 按 sessionId 过滤、按 tag 过滤、按 level 过滤
}
```

新增功能：
- `-SessionId` 参数过滤特定会话
- `-Tag` 参数过滤特定模块（如 `qwen:parser*`）
- `-Level` 参数过滤级别（`warn`, `error`）

**验证**：用新格式日志测试脚本。

### 步骤 8：添加 lint 规则

在 `.eslintrc` 或 `eslint.config.js` 中添加规则，禁止 `src/main/proxy/` 下使用 `console.log`：

```javascript
// 方案 A：no-restricted-syntax
rules: {
  'no-restricted-syntax': ['error', {
    selector: 'CallExpression[callee.object.name="console"][callee.property.name="log"]',
    message: 'Use logger.info/debug/warn/error instead of console.log'
  }]
}
```

如果 ESLint 不支持全局路径过滤，则使用 `overrides` 只对 `src/main/proxy/**` 生效。

**验证**：在 `forwarder.ts` 中加一行 `console.log('test')`，lint 报错。

## 第二波：全量补齐（Phase 3 完成后执行）

### 步骤 9：迁移其余 7 个 adapter

Phase 3 完成后，所有 plugin 已被重写为 renderer/parser。此时迁移：

- `adapters/deepseek.ts`
- `adapters/kimi.ts`
- `adapters/mimo.ts`
- `adapters/minimax.ts`
- `adapters/perplexity.ts`
- `adapters/qwen-ai.ts`
- `adapters/zai.ts`

每个 adapter 迁移后跑 `npm run test:fast`。

### 步骤 10：移除过渡代码

删除步骤 2 的 `console.log` 劫持代码。

### 步骤 11：全量验证

```bash
git grep "console\.log" src/main/proxy/   # 应返回空
npm run test:fast
npm test
```

## Tag 命名总览

```
格式: {module}:{submodule}:{action}

forwarder:compact:trigger    compact 触发
forwarder:compact:reject     compact 摘要被拒绝
forwarder:retry:attempt      重试
runtime:forward:start        转发开始
runtime:session:create       创建 session
runtime:session:delete       删除 session
qwen:renderer:build          Qwen 渲染器构建
qwen:parser:delta            Qwen delta 计算
qwen:parser:tool             Qwen tool call 解析
glm:renderer:build           GLM 渲染器构建
glm:parser:tool              GLM tool call 解析
tool:call:in                 收到 tool call
tool:result:out              tool result 返回
tool:loop:detect             tool call 循环检测
gate:throttle:wait           请求节流等待
```

## 验证标准

- [ ] 同一 session 的所有日志可通过 `sessionId` 关联
- [ ] `npm run dev` 终端默认只显示 warn + error
- [ ] `CHAT2API_LOG_LEVEL=debug` 开启全量日志
- [ ] UI 日志页面显示代理核心日志
- [ ] `extract-session-log.ps1` 可解析新 NDJSON 格式
- [ ] 日志无明文凭证
- [ ] Lint 禁止 `src/main/proxy/` 下的 `console.log`
- [ ] （第二波后）`git grep "console\.log" src/main/proxy/` 返回空

## 注意事项

- **不要在日志中打印完整的请求/响应 body**（即使脱敏）——用 debug 级别 + 截断到 500 chars
- **sessionId 对于代理请求必填**——调用 `logger.child(sessionId)` 确保关联
- **错误日志必须带 `err` 参数**（含 stack trace），不要只传字符串
- 暂不迁移 `oauth/` 和 `ipc/` 目录的日志——它们用不同的生命周期
