# UI 自适应与布局修正计划

## Summary

处理沉浸式工作台 UI 的 5 项需求：全组件自适应防重叠、Live2D 下移（大小不变）、移除输入框上方四个模式按钮、移除 desktop 端右侧设置按钮（保留 web 端）、主页卡片固定尺寸（切换卡片不变形）。

**关键现状**：工作区已存在一批未提交改动（上一会话实施），经 diff 审计已覆盖全部 5 项需求的主体实现。本计划重点为：审计补齐 → 浏览器多尺寸实测验证（未解决则持续修改）→ 门禁 → 文档登记核对 → 分支提交。

## Current State Analysis

已探索的关键文件与现状：

| 文件 | 现状 |
| --- | --- |
| [AervoxWorkbench.vue](file:///c:/Users/MoeNeko/WebstormProjects/Aervox-harness/packages/ui/src/components/AervoxWorkbench.vue) | 已删除 `companionModes` 四模式系统（陪学讲解/快问快答/深度拆解/自由聊天）及 `[模式：xxx]` 前缀逻辑、`aervox-composer-mode` localStorage；悬浮设置按钮已加 `v-if="isWeb"`（L717-720） |
| [workbench.css](file:///c:/Users/MoeNeko/WebstormProjects/Aervox-harness/packages/ui/src/theme/workbench.css) | 工作台已改网格布局 `grid-template-rows: minmax(0,1fr) auto`（L25-26）；`.immersive-pet` 已加 `transform: translateY(clamp(8px, 2vh, 22px))` 下移（L81）；`.side-cards` 改为网格上行子项 + 固定高度公式 `min(100%, calc(clamp(150px,19vh,236px)*2 + gap))`（L240-254）；`.immersive-console` 改网格下行子项（L426-431）；模式按钮样式已删；880px/620px/640px 断点已同步调整 |
| [layout.ts](file:///c:/Users/MoeNeko/WebstormProjects/Aervox-harness/packages/ui/src/live2d/layout.ts) | Live2D 高度驱动缩放 + 实际像素底边对齐（alpha≥40），无需改动 |
| [REQUIREMENTS_TRACEABILITY.md](file:///c:/Users/MoeNeko/WebstormProjects/Aervox-harness/docs/reference/REQUIREMENTS_TRACEABILITY.md) | §4.2 沉浸式工作台登记条目已更新（L228），描述了网格化布局、固定卡片、模式按钮移除、设置按钮仅 Web 等全部改动 |
| git 状态 | main 分支（领先 upstream 2 个合并提交）；未提交改动 3 个文件 + `packages/contracts/openapi.json`（仅 CRLF 行尾噪声，无实质 diff） |

用户需求与现状映射：

1. **自适应防重叠** — 主体已实现（网格化布局），需实测验证小窗口下 menu-pill（absolute 左上）、floating-settings（absolute 右上，仅 web）与卡片/控制台是否仍有边缘重叠。
2. **Live2D 下移、大小不变** — 已实现（translateY，不影响缩放）。
3. **移除四个模式按钮** — 已实现（模板 + 逻辑 + 样式 + localStorage 全清理）。
4. **desktop 右侧设置按钮去除、保留 web** — 已实现（`v-if="isWeb"`；desktop 仍保留标题栏设置按钮与菜单胶囊"设置"项作为入口）。
5. **卡片固定大小** — 已实现（固定高度公式 + 摘要 3 行截断 + 槽位 grid 均分），需实测验证切换不同卡片时尺寸恒定。

## Proposed Changes

### 1. 审计与清理

- `git restore packages/contracts/openapi.json` 还原行尾噪声（无实质变更）。
- 核对 `is-compact`（紧凑模式）与 `has-companion` 类下的布局规则与新网格布局兼容。
- 检查是否有残留的 `composer-mode` / `aervox-composer-mode` 引用（Grep 全仓确认零残留）。

### 2. 浏览器多尺寸实测（核心验证环，未解决则持续修改）

启动 web dev server（`./aervox dev` 或单起 web :5173），用 TRAE-browseruse 技能在以下视口逐一验证：

- 1920×1080（常规）、1280×800、1024×768
- 880×600（断点1）、620×700（断点2）、480×640（极窄）
- 400×300（极小窗口）

验证清单（每项不通过即回到代码修改后重测，直到全部通过）：

- [ ] 任意尺寸下：菜单胶囊、悬浮设置按钮（web）、功能卡片、消息面板、输入框互不重叠
- [ ] 切换/更换/清空卡片（8 种功能卡 + 占位卡）时卡片区域尺寸恒定
- [ ] 输入框上方无模式按钮；展开/收起正常
- [ ] Live2D 模型整体下移且大小不变，底边略探出视口
- [ ] 消息面板文字不溢出、输入框可正常聚焦输入

如发现问题的修正方向（按需，不预先实施）：

- absolute 元素（menu-pill / floating-settings）与网格行的间距冲突 → 调整 `.side-cards` 的 margin-top clamp 或给断点加保护
- 极小高度下卡片溢出 → 收紧 `height: min(100%, ...)` 公式或断点高度上限
- console 过高挤压卡片区 → 调低 `.message-panel` max-height clamp

### 3. 门禁

- `mise tasks run ci-code`（install + build + typecheck + test）
- `mise tasks run ci-docs`（Markdown lint + Vale + docs-validate）

### 4. 文档登记核对

- 检查 [REQUIREMENTS_TRACEABILITY.md](file:///c:/Users/MoeNeko/WebstormProjects/Aervox-harness/docs/reference/REQUIREMENTS_TRACEABILITY.md) 文档头"修改人"签名与日期是否符合硬约束（每次改动须更新）；若浏览器实测阶段产生代码修正，同步更新 §4.2 登记描述与验证列。

### 5. 提交

- 按仓库硬约束（禁止直接向 main 提交）：从当前 HEAD 创建分支 `fix/ui-adaptive-layout`，提交全部改动（AervoxWorkbench.vue、workbench.css、REQUIREMENTS_TRACEABILITY.md）。
- 不主动推送；推送与 PR 创建等用户确认。

## Assumptions & Decisions

- "desktop 右侧设置按钮"指工作台右上悬浮设置按钮（与 web 同款），非标题栏窗口控件中的设置按钮——desktop 保留标题栏 + 菜单胶囊两个设置入口，web 保留悬浮按钮入口。
- "Live2D 往下挪一点"以现有 `translateY(clamp(8px, 2vh, 22px))` 为准（约 8~22px），不改缩放。
- 卡片"大小固定"指卡片槽位区域尺寸恒定（内容摘要截断），不是放弃响应式——小窗口仍按断点收缩。
- 不改桌宠独立窗口（PetWindow）与本任务无关的部分。
- 遵循 AGENTS.md：`mise x --` 环境内跑命令、文档改动过 ci-docs、功能分支提交。

## Verification Steps

1. 浏览器多尺寸截图核对（上述验证清单全部通过）。
2. `mise tasks run ci-code` 全绿。
3. `mise tasks run ci-docs` 全绿。
4. `git status` 干净（openapi.json 已还原），改动都在 `fix/ui-adaptive-layout` 分支的单个提交中。
