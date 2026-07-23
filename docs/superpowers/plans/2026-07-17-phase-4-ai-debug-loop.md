# Phase 4：AI Debug 循环

> **真源**：[架构基础重构](./2026-07-17-architecture-foundation.md) §9
> **前置依赖**：Phase 1-3 完成（测试、日志、架构就位）
> **预计耗时**：持续改进，无独立大块时间
> **风险等级**：低（流程优化，不改业务逻辑）

## 目标

让 AI agent 能够在 3 轮内定位 bug、修复、验证，不出现无意义的循环探索。

## 执行步骤

### 步骤 1：创建 debug state 文件模板

在 `docs/superpowers/debug/` 下创建模板文件 `TEMPLATE.md`：

```markdown
## bug-YYYY-MM-DD-<slug>.md

### 症状
（一句话描述用户看到的现象）

### 复现条件
- 模型：
- 场景：（长对话 / compact 后 / 特定 tool / ...）
- 频率：

### 已排除的假设
- [ ] （假设）— 证据：
- [ ] （假设）— 证据：

### 关键证据
```
（粘贴日志片段，标注 sessionId 和时间线）
```

### 分析
（因果推断——为什么现象会发生）

### 已尝试的修复
1. [时间] （改了什么）— 效果：

### 下一步
（单一可执行的动作——下一步做什么）

### 验证标准
- 条件 A
- 条件 B

### 解决
（修复后填写：根因 + 修复方案 + 验证结果）
```

### 步骤 2：在首个 bug 上试用

Phase 1-3 完成后，AI 在遇到第一个 bug 时：
1. 自动创建 `docs/superpowers/debug/YYYY-MM-DD-<slug>.md`
2. 填写症状、复现条件
3. 逐步排除假设，每个假设附带证据
4. "下一步" 保持单一可执行动作
5. 修复后填写 `### 解决` 段落

### 步骤 3：根据体验迭代模板

使用 2-3 个 bug 后，根据实际使用体验调整模板。

## 快速反馈循环（Phase 1 已建立）

```
编辑代码 → npm run test:fast (< 2秒) → 通过？ → 继续
                                      → 失败？ → 看输出，修正，重跑
```

## 结构化日志辅助定位（Phase 2 已建立）

```powershell
# 按 session 过滤
Get-Content dev.log | Select-String "session=a1b2c3" | Select-Object -First 50

# 看 tool call 循环信号
Get-Content dev.log | Select-String "session=a1b2c3" | Select-String "tool:call:in|tool:result:out|compact:trigger"

# 看错误和警告
Get-Content dev.log | Select-String "session=a1b2c3" | Select-String "\[warn\]|\[error\]"
```

## 自动化回归检测（Phase 1 已建立）

```
pre-commit hook:
  npm run lint → npm run test:fast → npm test

CI:
  lint → typecheck → test:fast → test
```

## 验证标准

- [ ] Debug state 文件模板存在于 `docs/superpowers/debug/TEMPLATE.md`
- [ ] AI 在首次诊断 bug 时自动创建 debug state 文件
- [ ] Debug state 文件在 bug 修复后包含 `### 解决` 段落
- [ ] `npm run test:fast` 在 10 秒内完成（实测 < 2 秒）
- [ ] Pre-commit hook 正常运行
- [ ] CI 在 3 分钟内完成全量测试 + lint + typecheck

## 注意事项

- Debug state 文件由 AI 创建和维护，不要手动编辑
- 不要为了"写文档"而写——只在遇到需要多轮诊断的 bug 时才创建
- 每个已排除的假设必须附带具体证据（日志行号、测试结果）
- "下一步" 只写一个动作——强制 AI 聚焦，避免同时尝试多个方向
