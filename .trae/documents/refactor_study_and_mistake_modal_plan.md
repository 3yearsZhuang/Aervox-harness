# 重构二级菜单下的学习功能与解耦错题本计划

## 1. 目标与需求概述

1. **学习功能弹窗化**：
   - 将原先侧边抽屉（`el-drawer`）形式的学习功能重构为与「设置」相同视觉风格的居中弹窗（`el-dialog`）。
   - 弹窗采用左侧侧边分类导航 + 右侧内容详情的双栏布局，支持在各功能模块（今日学习、待办清单、番茄钟、对话回看等）之间自由跳转与切换。
2. **错题本功能解耦**：
   - 将「错题本」从「今日学习」中完全剥离，作为独立功能模块。
   - 错题本拥有独立的管理弹窗（包含错题筛选、错因记录与编辑、掌握状态标记、单题/批量错题重练等能力）。
3. **主导航与入口调整**：
   - 在主导航胶囊菜单（`menuItems`）中增加独立「错题本」入口。
   - 依据用户要求，从导航栏胶囊菜单中移除「设置」按钮（右上角仍保留设置入口或通过快捷工具触发）。
   - 功能卡片（`cardCatalog`）中将错题本操作直接导向独立的错题本弹窗。

---

## 2. 现状分析

- **当前结构**（[AervoxWorkbench.vue](file:///Users/linge/Documents/Workspace/Aervox-harness/packages/ui/src/components/AervoxWorkbench.vue)）：
  - 学习功能目前挂载于 `studyOpen` 对应的 `el-drawer`（右侧抽屉），将「快速练习、错题本、学习目标、待复习、最近复习、学习计划、今日日记、提醒」杂糅在一个长滚动面板中。
  - 待办清单（`todoOpen`）与番茄钟（`timerOpen`）也采用 `el-drawer` 抽屉；对话回看（`historyOpen`）采用全屏遮罩居中卡片（`vn-history`）。
  - 主导航胶囊菜单项为：`['study', 'todo', 'timer', 'history', 'settings']`。
- **设置弹窗规范**（[workbench.css](file:///Users/linge/Documents/Workspace/Aervox-harness/packages/ui/src/theme/workbench.css)）：
  - 采用 `el-dialog` + `settings-layout`（左侧 `settings-categories` 210px 导航 + 右侧 `settings-detail` 滚动面板）。
  - 支持清晰的分类、图标、描述以及优雅的毛玻璃与圆角样式。

---

## 3. 重构设计方案

### 3.1 组件与功能拆分

1. **学习主弹窗（Study / Learning Dialog）**：
   - 替代原有 `studyOpen` 抽屉，使用与 `settings-dialog` 一致风格的 `workbench-dialog` / `study-dialog`。
   - 左侧侧边栏导航：
     - **今日概览 / 快速练习**（`practice`）
     - **学习目标**（`goals`）
     - **复习管理**（`review`，包含待复习与复习历史）
     - **学习计划**（`plans`）
     - **学习日记**（`diary`）
     - **跳转模块**：待办清单、番茄钟、对话回看、错题本（点击直接切换到对应弹窗或视图）。
2. **独立错题本弹窗（Mistake Book Dialog）**：
   - 新增 `mistakeOpen` 状态与独立弹窗。
   - 具备完整错题管理功能：
     - 错题状态过滤（待掌握 / 已掌握 / 已忽略 / 全部）；
     - 错因筛选（概念不清、计算失误、粗心、审题偏差、其他）；
     - 多选题目进行 1~5 题针对性重练；
     - 错因记录与说明编辑保存；
     - 标记掌握、忽略或恢复状态。
3. **主导航胶囊菜单（Menu Pill）**：
   - 更新为：
     1. 学习（`BookOpen`，打开学习主弹窗）
     2. 错题本（`Puzzle`，打开独立错题本弹窗）
     3. 待办（`ListTodo`，打开待办抽屉/弹窗）
     4. 番茄钟（`Clock3`，打开番茄钟抽屉/弹窗）
     5. 回看（`History`，打开对话回看窗口）
   - **去除原先菜单中的「设置」按钮**。
4. **快捷卡片（Card Catalog）与快捷工具（Quick Tools）**：
   - 卡片库中错题本卡片的 `action` 调整为 `openTool('mistake')`。
   - 设置中的快捷工具列表同步加入错题本入口。

---

## 4. 改动文件与具体实现步骤

1. **[packages/ui/src/components/AervoxWorkbench.vue](file:///Users/linge/Documents/Workspace/Aervox-harness/packages/ui/src/components/AervoxWorkbench.vue)**：
   - 新增 `mistakeOpen = ref(false)` 及辅助状态。
   - 新增 `studyTab = ref<'practice' | 'goals' | 'review' | 'plans' | 'diary'>('practice')` 控制学习弹窗内部标签切换。
   - 更新 `openTool(target)`：支持 `'study' | 'mistake' | 'todo' | 'timer' | 'history'`。
   - 更新 `menuItems`：加入错题本，移除设置。
   - 重构 `studyOpen` 对应结构：由 `el-drawer` 改为 `el-dialog`（采用 `settings-layout` 结构风格）。
   - 构建 `mistakeOpen` 对应独立 `el-dialog`。
2. **[packages/ui/src/theme/workbench.css](file:///Users/linge/Documents/Workspace/Aervox-harness/packages/ui/src/theme/workbench.css)**：
   - 补充弹窗通用样式类（适配学习弹窗与错题本弹窗的双栏布局与面板滚动）。
   - 调整错题本独立弹窗内的卡片列表、筛选栏与编辑器布局。
3. **验证与回归**：
   - 运行 `pnpm --filter @aervox/ui typecheck` 确保 TypeScript 类型校验通过。
   - 运行 `pnpm --filter @aervox/ui build`（如果适用）或相关前端测试，确认页面渲染无告警。

---

## 5. 验收标准

1. 学习功能从右侧抽屉完全转变为居中弹窗，视觉样式与设置弹窗风格保持一致，左侧具有分类导航及跨功能快捷切换。
2. 错题本脱离学习面板，成为独立弹窗，且主导航胶囊菜单、侧边卡片中均可正常唤起独立错题本。
3. 主导航胶囊菜单中已移除设置按钮，保留学习、错题本、待办、番茄钟、回看。
4. 错题本重练、筛选、错因编辑、掌握状态切换等全部功能完整保留且操作流畅。
