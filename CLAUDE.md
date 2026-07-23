# Chat2API Development Workflow

## The Loop

```
探索 ──→ 定计划 ──→ 改代码 ──→ 本地测试 ──→ Probe 测试 ──→ 日志汇总分析
  ↑                                                              │
  └──────────────────── 发现问题，回到探索 ───────────────────────┘
```

每个阶段都有明确的入口和出口，不跳步。

---

## 1. 探索 (Explore)

**目标**：理解现状，定位根因。

- 用 `codegraph_context` + `codegraph_trace` 追踪代码路径
- 阅读相关源文件，确认实际行为与预期行为的差异
- 如果是 bug，定位到具体行号和条件
- 如果有 dev.log，用 `scripts/extract-session-log.ps1` 先看时间线

**出口**：能一句话描述根因 + 影响范围。

---

## 2. 定计划 (Plan)

**目标**：确定修什么、怎么修、不改什么。

- 最小改动原则 — 只改必须改的
- 明确修改的文件和具体位置
- 明确不改的边界（相关但不属于本次范围）
- 如果涉及多个方案，先列出 trade-off

**出口**：改动清单（文件:行号 + 改什么）。

---

## 3. 改代码 (Code)

**目标**：实现计划。

- 先读要改的文件（Read），再编辑（Edit）
- 每次改动聚焦一个问题
- 不改无关代码
- 不改日志格式（除非本次目标是改进日志）

**出口**：diff 完成，无 lint 错误。

---

## 4. 本地测试 (Local Tests)

**目标**：验证改动不破坏现有行为。

```powershell
# 核心测试套件
node --test `
  tests/tool-calling/*.test.ts `
  tests/providers/glm-tool-calling.test.ts `
  tests/providers/context-tool-metadata.test.ts `
  tests/providers/qwen-request-routing.test.ts `
  tests/services/contextManagement-summary-input-sanitization.test.ts `
  tests/services/summarySanitizer.test.ts `
  tests/services/contextPayloadClassifier.test.ts

# 根据改动范围追加
node --test tests/providers/multi-turn-conversation.test.ts
node --test tests/providers/provider-flow.test.ts
node --test tests/services/promptBudget-context-economy.test.ts
```

- 全部通过才能进入下一步
- 如有失败，先确认是测试需要更新还是实现有问题
- 如果加了新行为，同时加新测试

**出口**：全部通过，覆盖率不降。

---

## 5. Probe 测试 (Probe Tests)

**目标**：用真实模型验证端到端行为。

```powershell
# 1. 启动 proxy（保留日志）
npm run dev:win 2>&1 | Tee-Object -FilePath .\dev.log

# 2. 另开终端，跑 probe
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "glm/GLM-5.2"
```

Probe 验证项：
- 多轮 tool call 正常（assistant tool_calls → tool result → 新一轮 tool_calls）
- 非 streaming 响应正确转换
- 跨 session 的工具目录连续性
- 上下文 compact 后工具调用不丢失

**出口**：probe 通过，dev.log 完整。

---

## 6. 日志汇总分析 (Log Analysis)

**目标**：从 dev.log 提取时间线，检查是否有隐藏问题。

```powershell
.\scripts\extract-session-log.ps1 -LogPath .\dev.log
```

输出一张表格，每行一个 session：

```
 ID   TYPE         PROVIDER   REFRESH  PLAN/CATALOG  PROVIDER_SESSION         EVENTS
--- - ----------- ---------- -------- ------------- ------------------------- ------
  1 # main        glm        digest   -/-           a1b2c3d4...              -
  2 * tool        glm        -        xml/session   -                         -
  3 @ tool_child  glm        -        -/-           9f8e7d6c...              -
  4 ~ compact     glm        full     -/-           a1b2c3d4...              summ=1234ch ctx:50->30
  5 # main        glm        full     -/-           a1b2c3d4...              -
```

**关注点**：

| 信号 | 含义 |
|------|------|
| `REJ:no_text` | sanitizer 把有效的 tool history 标成了空 → summary guard 有 bug |
| compact 后 provider session 不变 | 可能没新建 session，上下文可能过期 |
| `FALLBACK` | 走了 emergency path，provider runtime 被绕过 |
| `ctx:50->30` 但无 `summ=` | 截断但没有 compact，上下文可能丢失 |
| `tool_child` 无 `del:` | 子 session 没清理 |
| `ERRxN` | 有 N 个错误，查看详情 |

如果发现异常 → 回到第 1 步（探索），形成闭环。

**出口**：时间线清晰，无意外信号，或意外信号已被解释/修复。

---

## 7. 循环

上述 1-6 不是一次性的。每次 probe 后分析日志，发现问题就回到探索 → 计划 → 改代码 → 测试 → probe → 分析，直到：

- 本地测试全部通过
- Probe 测试全部通过
- 日志时间线无异常信号（session 类型正确、summary 成功、无 fallback、子 session 清理干净）

---

## 常用命令速查

```powershell
# 开发
npm run dev:win 2>&1 | Tee-Object -FilePath .\dev.log

# 单测
node --test tests/<path>.test.ts

# Probe
.\tests\agent-capability\verify-opencode-capability.ps1 -Model "glm/GLM-5.2"

# 日志分析
.\scripts\extract-session-log.ps1 -LogPath .\dev.log
```
