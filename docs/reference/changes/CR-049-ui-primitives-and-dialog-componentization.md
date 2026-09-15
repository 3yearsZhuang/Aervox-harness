---
id: CR-049
type: reference
scope: change
owner: maintainers
doc_status: review-candidate
decision_status: accepted
delivery_status: verified
version: 1.0.0
updated_at: 2026-09-15
reviewed_at: 2026-09-15
review_interval_days: 90
sources:
  - docs/reference/PRD.md
  - docs/reference/ARCHITECTURE.md
  - docs/reference/standards/doc-standards.md
---

# CR-049 UI 基础控件库与全量弹窗控件化

- 提出人：3yearszhuang · 2026-09-15
- 修改人：3yearszhuang · 2026-09-15

- 状态：Accepted / Verified
- 关联能力：`CAP-001`（系统外观与工作台）、`CAP-002`（错题本）、`CAP-019`（桌宠与人设）、`CAP-020`（扩展中心与插件）、`CAP-033`（主动智能模式）

---

## 1. 提案背景与改动动机

随着 Aervox 工作台功能的快速迭代，界面层存在显著的 UI 模式分化与维护性隐患：

1. **模态与弹窗重复实现**：各业务功能（插件安装/配置/页面、MCP 注册/预设、人设编辑、专注与学习模式术语探索、历史回看、任务中心、工具箱、学习规划、设置与主动智能授权）直接调用裸 `el-dialog` 或自行手写 `Teleport` 遮罩，模板碎片化严重；
2. **样式穿透与代码异味**：大量组件充斥着深层样式穿透（`:deep(.el-dialog__header)`、`:deep(.el-dialog__body)`），头部结构（如 `.heading-icon-wrap`、标题与关闭按钮）多处重复拷贝，缺乏统一规范与无障碍设计；
3. **主线程阻塞风险**：多个组件与 Composable 依然使用原生的 `window.confirm()` 进行关键动作二次确认（如插件卸载、学习规划归档、画像数据导出、主动智能撤销），这在 Electron 桌面端和 Web 端会冻结主线程渲染循环与 Live2D 动画帧，交互体验突兀且无法自定义视觉样式；
4. **组件底座缺失**：`@aervox/ui` 包缺乏原子化的基础控件层（Primitives），导致新功能开发时必须重复手写弹窗结构与按钮样式。

---

## 2. 核心改动范围与技术方案

在 `packages/ui/src/primitives` 模块下建立原子化 UI 基础控件体系，并对全仓存量视图进行端到端重构替换：

### 2.1 统一 UI Primitives 基础控件库

1. **`AervoxButton.vue`**：
   - 统一全仓按钮基底，支持 `primary`、`secondary`、`danger`、`ghost` 视觉变体；
   - 支持 `sm`、`md`、`lg` 三种尺寸，内置 Loading 旋转动画态与 Lucide 图标前缀插槽；
2. **`AervoxDialogHeader.vue`**：
   - 标准化弹窗头部规范，集成渐变图标胶囊容器（`.heading-icon-wrap`）、主标题、副标题、右侧自定义操作插槽与优雅关闭按钮；
3. **`AervoxDialog.vue`**：
   - 封装 `ElDialog` 底座，提供 `sm`（480px）、`md`（640px）、`lg`（860px）、`xl`（1020px）响应式尺寸断层；
   - 规范 `showHeader`、`showClose`、`bodyMaxHeight` 滚动受控容器与 Escape 键盘无障碍关闭；
4. **`AervoxNavDialog.vue`**：
   - 提供标准的主从（Master-Detail）双栏导航弹窗底座，统一左侧图标导航项高亮与右侧内容容器滚动；
   - 支持移动端响应式折叠为横向滚动标签条，通过 `#nav-footer` 支持外部扩展插槽；
5. **`AervoxConfirmDialog.vue`**：
   - 统一二次确认模态框，内置风险警示图标与文案，支持 `requireAcknowledge`（必须勾选“我已了解风险”才可确认）以及两态与三态防呆；
6. **`AervoxDrawer.vue`**：
   - 规范滑出式抽屉控件，替换存量手写 Teleport 遮罩，支持侧边滑入、动画遮罩与键盘 Esc 监听；
7. **`aervoxConfirm` 交互式确认服务 (`confirm-service.ts`)**：
   - 封装 Promise 风格的非阻塞确认服务，完全淘汰阻塞主线程的 `window.confirm()`。

### 2.2 全量业务视图与组合式逻辑重构

全量重构以下组件与 Composable，实现 100% 控件化与样式穿透清零：

- **插件与工具域**：
  - `PluginConfigDialog.vue`：接入 `AervoxDialog` 与 `AervoxButton`，卸载操作切换至 `aervoxConfirm`；
  - `SkillContentDialog.vue`：接入 `AervoxDialog` 与 `AervoxButton`；
  - `McpRegisterDialog.vue`：接入 `AervoxDialog`、`AervoxDialogHeader` 与 `AervoxButton`；
  - `PluginInstallDialog.vue`：接入 `AervoxDialog` 与 `AervoxButton`；
  - `PluginPageDialog.vue`：接入 `AervoxDialog`，优化全屏展开与扩展页面展示；
  - `ToolCallDialog.vue`：接入 `AervoxDialog`，统一工具执行参数与结果展示；
  - `McpPresetServers.vue`：接入 `AervoxDialog` 与 `AervoxButton`，收敛内嵌 Token 填报弹窗；
- **人设与模式插件**：
  - `PersonaEditDialog.vue`：接入 `AervoxDialog` 与 `AervoxButton`，移除重复头部样式；
  - `focus-mode/TermExploreDialog.vue` 与 `study-mode/TermExploreDialog.vue`：接入 `AervoxDialog` 与 `AervoxButton`，移除手写 overlay 遮罩；
- **工作台抽屉与导航系统**：
  - `HistoryDrawer.vue`：基于 `AervoxDrawer` 重构，移除手写 Teleport；
  - `TaskCenterDrawer.vue`：基于 `AervoxDialog` 重构；
  - `ToolsDrawer.vue`：基于 `AervoxNavDialog` 重构待办、番茄钟、对话回看与日记子面板；
  - `LearningDrawer.vue`：基于 `AervoxNavDialog` 重构 AI 规划与错题靶向练习；
  - `SettingsModal.vue`：基于 `AervoxNavDialog` 重构系统设置与思隅面板，其“完全访问确认”升级为 `AervoxConfirmDialog`，“主动智能授权向导”升级为 `AervoxDialog` 与 `AervoxButton`；
- **非阻塞确认彻底收口**：
  - `useWorkbenchCards.ts`：学习规划归档 (`archivePlan`) 改造为 `aervoxConfirm`；
  - `useWorkbenchProactive.ts`：外部连接撤销 (`deleteProactiveConnection`)、主动模式撤销 (`setProactiveDesiredState`)、来源删除 (`deleteProactiveSource`) 与画像导出 (`exportProactiveData`) 全部收敛至 `aervoxConfirm`。

---

## 3. 验证与交付依据

1. **专用单元测试**：在 `packages/ui/test/primitives.test.ts` 中针对 `AervoxButton`、`AervoxDialog`、`AervoxNavDialog`、`AervoxConfirmDialog`、`AervoxDrawer` 及 `aervoxConfirm` 编写完整 8 项单元测试，100% 通过；
2. **全包回归测试**：`@aervox/ui` 全量 9 个测试套件（47 tests）全部通过；
3. **全仓门禁验证**：
   - 依赖边界检查 `check:boundary` 14 项规则全过；
   - 整个 monorepo 构建与类型检查（Turbo 26 项任务）全部成功；
   - `apps/web` 独立构建打包验证通过，弹窗与抽屉按需 chunk 拆分正确；
4. **全仓代码清零审计**：
   - `git grep '<el-dialog'` 在 `packages/ui/src` 及 `apps/` 下实现 0 残留（仅 `AervoxDialog.vue` 内部作为受控底座使用一次）；
   - `git grep 'window.confirm'` 在全仓代码库中彻底归零。
