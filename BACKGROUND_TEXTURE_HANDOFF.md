# 背景纹理修复交接文档

## 目标
为应用添加可见的羊皮纸（parchment）背景纹理效果，亮色模式和暗色模式分别使用不同透明度的纹理。

## 当前状态：代码已改但视觉上不可见

所有 CSS 和组件修改已完成，但用户反馈刷新后仍然看不到纹理效果。需要接手人排查**为什么纹理在运行时不可见**。

---

## 涉及文件

### 1. `src/renderer/src/index.css`

#### 纹理变量定义（第 126-128 行，在 `[data-theme="light"]` 块内）

- `--paper-texture`：暗色模式用，opacity 0.18
- `--paper-texture-light`：亮色模式用，opacity 0.10
- 两者都是内联 SVG feTurbulence fractalNoise，400x400 尺寸

#### `.main-layout-bg` 样式（第 163-175 行）


#### `.bokeh-bg` 相关样式
- **第 177 行** `[data-theme="dark"] .bokeh-bg`：纯色 `#0a0a0f`，无纹理
- **第 205 行** `[data-theme="light"] .bokeh-bg`：使用 `var(--paper-texture-light)` + 渐变
- **第 254 行** `.bokeh-bg` 基础样式：`position: fixed; inset: 0; z-index: 0;`
- **第 1117-1120 行**：再次设置 `z-index: 0`（冗余，可清理）

#### 其他可能遮挡的层
- **`.mica-overlay`**（第 326 行）：`z-index: 0`，暗色模式下有 `background: rgba(10, 10, 15, 0.65)` + `backdrop-filter: blur(30px)`。亮色模式下 `display: none`
- **`.noise-texture`**（第 340 行）：`z-index: 1`，全屏覆盖，opacity 极低（0.035/0.025），不太可能是问题

### 2. `src/renderer/src/components/layout/MainLayout.tsx`



DOM 层级（从底到顶）：
1. `.main-layout-bg`（根 div，承载纹理 background-image）
2. `.bokeh-bg`（z-index: 0，fixed 全屏）
3. `.mica-overlay`（z-index: 0，fixed 全屏，暗色模式有半透明背景+模糊）
4. `.noise-texture`（z-index: 1，fixed 全屏，极低透明度）
5. 内容区（z-index: 10）

---

## 已尝试过的修复及结果

| 尝试 | 结果 |
|------|------|
| 提高 SVG opacity（0.08->0.18, 0.04->0.10） | 无效 |
| 修复亮色模式用错变量（`--paper-texture` -> `--paper-texture-light`） | 无效 |
| 将 MainLayout 根元素从 `bg-[var(--bg-primary)]` 改为 `.main-layout-bg` class | 无效 |
| 将 `.bokeh-bg` z-index 从 -1 改为 0 | 无效 |

---

## 可能的根因方向（待排查）

1. **Electron/Chromium 对内联 SVG data URI 的 background-image 支持问题**
   - feTurbulence filter 在某些 Electron 版本中可能不渲染
   - 验证方法：在浏览器 DevTools 中检查 `.main-layout-bg` 的 computed background-image 是否有值；或将纹理换成一张普通 PNG 图片测试是否可见

2. **`.bokeh-bg` 或 `.mica-overlay` 遮挡**
   - `.bokeh-bg` 是 `position: fixed; inset: 0; z-index: 0`，与 `.main-layout-bg` 的 background-image 在同一层叠上下文
   - `.mica-overlay` 在暗色模式下有 `rgba(10,10,15,0.65)` 半透明背景 + `backdrop-filter: blur(30px)`，可能模糊掉纹理
   - 验证方法：临时在 DevTools 中隐藏 `.bokeh-bg`、`.mica-overlay`、`.noise-texture`，看纹理是否出现

3. **CSS 变量作用域问题**
   - `--paper-texture` 和 `--paper-texture-light` 定义在 `[data-theme="light"]` 选择器块内（第 78-150 行）
   - 但 `[data-theme="dark"] .main-layout-bg` 引用了 `var(--paper-texture)`，该变量在 dark 主题下可能未定义
   - 验证方法：检查 `html[data-theme="dark"]` 块（第 18-76 行）是否也定义了这两个变量

4. **Tailwind/CSS 构建管线问题**
   - 修改可能未被 Vite/PostCSS 正确处理
   - 验证方法：检查构建产物中是否包含 `.main-layout-bg` 相关规则

5. **HMR 缓存**
   - Electron + Vite HMR 有时不会正确更新 CSS
   - 验证方法：完全关闭应用重新启动（不是刷新）

---

## 建议的下一步

1. **打开 Electron DevTools**（Ctrl+Shift+I），在 Elements 面板检查 `.main-layout-bg` 元素：
   - Computed Styles 中 `background-image` 是否有值
   - 是否有其他元素的 background 覆盖了它
2. **临时禁用所有遮挡层**（DevTools 中取消勾选 `.bokeh-bg`、`.mica-overlay`、`.noise-texture` 的 display），确认纹理本身是否能渲染
3. **如果纹理变量在 dark 模式下未定义**，将 `--paper-texture` 移到 `:root` 或 `html[data-theme="dark"]` 块中
4. **如果内联 SVG 不渲染**，尝试替换为外部 PNG 纹理文件或使用 CSS `conic-gradient` 模拟噪点
5. **清理冗余**：第 1117-1120 行的 z-index 覆盖规则与第 254 行重复，可删除

## 注意事项
- 项目使用 Electron + React + Tailwind CSS + Vite
- 主题切换通过 `html[data-theme="dark"|"light"]` 属性控制
- 纹理必须是纯 CSS/SVG 实现，不能有网络请求
- 暗色模式底色 `#0a0a0f`，亮色模式底色 `#f5f0e6`
