---
id: CR-050
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
  - docs/reference/plugin-config-and-pages.md
  - docs/reference/standards/doc-standards.md
---

# CR-050 工作台 UI 插件声明式注册层与专注模式彻底解耦

- 提出人：3yearszhuang · 2026-09-15
- 修改人：3yearszhuang · 2026-09-15

- 状态：Accepted / Verified
- 关联能力：`CAP-001`（系统外观与工作台）、`CAP-002`（错题本）、`CAP-003`（学习路线）、`CAP-016`（专注伴学与苏格拉底教学）、`CAP-020`（扩展中心与插件）

---

## 1. 提案背景与改动动机

在早期实现中，专注模式（Focus Mode / Study Mode）作为系统首个业务场景，其前端控件以半内置形式与工作台宿主深度耦合：

1. **主导航菜单硬编码**：`WorkbenchNavPill.vue` 内部硬编码了“学习能力”菜单项、`GraduationCap` 图标及跳转逻辑，即使插件被禁用，菜单仍然显式存在；
2. **抽屉组件侵入宿主**：`AervoxWorkbench.vue` 显式静态 `import` 或异步引用 `LearningDrawer.vue`，并通过 `learningMounted` 守卫在根层控制其实例，违背了开放封闭原则；
3. **任务中心卡片静态绑定**：`TaskCenterDrawer.vue` 内部写死了“间隔复习与错题排期”卡片结构、文案与事件处理，使得统一任务中心无法作为通用的后台任务概览层；
4. **功能卡片强依赖**：侧边栏与小工具列表仅支持预设的核心卡片；`useWorkbenchCards.ts` 中硬编码引入了 `FocusStudyCardActions.vue` 及专属图标；
5. **设置中心缺少按需防护**：`SettingsModal.vue` 中的快捷工具栏硬编码 6 个按钮，且专注模式全局开关未绑定插件可用性状态。

为了实现真正的控制反转（IoC）与插件自治，工作台需要引入统一的 UI 声明式注册层。**核心架构铁律**：插件通过注册层声明自身贡献；若插件未声明或未启用，宿主 DOM 与代码中严禁残留任何插件专有控件；插件声明并启用后，宿主按插槽与优先级动态编排呈现。

---

## 2. 核心架构设计与改动范围

### 2.1 扩展插槽契约扩充（`packages/ui/src/registry/types.ts`）

在 `ExtensionSlotName` 契约中新增两个高层插槽：

- `workbench:drawers`：工作台顶层全局抽屉插槽，供插件按需挂载全屏/侧滑抽屉面板（如 `LearningDrawer`）；
- `taskcenter:cards`：统一任务中心业务卡片插槽，供插件向任务中心卡片网格注入自身任务状态（如复习排期）。

同时新增通用卡片贡献契约 `WorkbenchCardContribution`，支持向工作台注册功能卡片及卡片操作区组件（`extraComponent`）。

### 2.2 注册层响应式卡片管理（`packages/ui/src/registry/ui-registry.ts`）

在 `UIRegistry` 注册表中扩展卡片贡献点：

- 提供 `registerCard(card: WorkbenchCardContribution)`：自动以 `markRaw` 包装组件引用，按 `priority` 降序保序插入响应式 `cardList`，并返回注销回调；
- 提供 `unregisterCard(id: string)` 与 `getCards()`；
- `clear()` 时同步重置所有已注册卡片与插槽组件。

### 2.3 专注模式第一方插件自主装配（`packages/ui/src/plugins/focus-mode/`）

专注模式插件全面改造为基于注册层的声明式贡献模式：

1. **组件解耦与抽离**：
   - 提取 `FocusNavMenuItem.vue`：内聚主导航胶囊菜单项与 `is-active` 联动；
   - 提取 `FocusStudyCardActions.vue`：内聚「每日一题」、「开始专注」、「错题重练」专属操作按钮与专注开关状态感知；
   - 提取 `FocusTaskCenterCard.vue`：内聚「间隔复习与错题排期」卡片、复习数量徽标与跳转行为。
2. **声明式生命周期绑定 (`index.ts`)**：
   - `header:actions` → `FocusModeSwitch` (`priority: 100`)；
   - `conversation:bottom` → `FocusTermsBar` (`priority: 50`)；
   - `nav:menu-items` → `FocusNavMenuItem` (`priority: 100`)；
   - `workbench:drawers` → `LearningDrawer` (异步按需加载组件，`priority: 100`)；
   - `taskcenter:cards` → `FocusTaskCenterCard` (`priority: 100`)；
   - `registry.registerCard` → `study` (100)、`mistake` (90)、`quiz` (80)；
   - `registry.registerMessageTransformer` → 专注模式提示词前缀变换。
3. **一键注销清理**：
   - 插件清理函数完整注销上述所有插槽组件、卡片与变换器，确保插件热重载或停用后无任何状态泄漏。

### 2.4 宿主组件与组合函数彻底纯粹化

1. **`AervoxWorkbench.vue`**：
   - 彻底移除 `LearningDrawer` 异步组件引用与 `learningMounted` 懒挂载守卫；
   - 抽屉挂载区改用 `<ExtensionSlot name="workbench:drawers" />`；
   - 移除传递给 `useWorkbenchConversation` 的 `focusModeEnabled` / `studyModeEnabled` 参数。
2. **`TaskCenterDrawer.vue`**：
   - 移除硬编码的学习排期卡片与 `GraduationCap` 图标；
   - 卡片网格采用 `<ExtensionSlot name="taskcenter:cards" />` 承接插件卡片；
   - 宿主仅维护核心原生任务（日记本、番茄钟、主动智能、数据库状态真源）。
3. **`SettingsModal.vue`**：
   - 快捷工具栏由硬编码按钮升级为 `v-for="card in cards.cardCatalog.value"` 动态渲染，移除未声明图标与局部状态解构；
   - 专注模式开关设置行使用 `v-if="isFocusModeAvailable"` 保护，插件未声明或未启用时完全不渲染在 DOM 中。
4. **`useWorkbenchCards.ts`**：
   - 彻底移除对 `FocusStudyCardActions.vue` 的静态 `import` 与非核心图标引用；
   - 宿主仅保留 4 张核心原生卡片（`todo`、`timer`、`history`、`diary`），与 `registry.getCards()` 动态合并求值。
5. **`useWorkbenchConversation.ts`**：
   - 移除 `focusModeEnabled` 等冗余入参，消息前缀逻辑完全移交插件自身的拦截器。
6. **CSS 容器样式支持 (`workbench.css`)**：
   - 为抽屉插槽 `.aervox-extension-slot[data-slot-name="workbench:drawers"]` 与任务网格插槽 `.task-card-grid > .aervox-extension-slot` 配置 `display: contents`，消除包装层对 CSS Grid 网格的布局干扰。

---

## 3. 验证与交付依据

1. **单元测试全覆盖**：
   - `packages/ui/test/study-mode-plugin.test.ts`：验证所有 5 个扩展插槽与 3 张功能卡片的声明式注册与生命周期注销；
   - `packages/ui/test/components-sfc.test.ts`：验证 `FocusNavMenuItem.vue`、`FocusStudyCardActions.vue`、`FocusTaskCenterCard.vue` 与 `SettingsModal.vue` 动态卡片遍历与开关响应式显隐；
   - `packages/ui/test/standard-workbench.test.ts`：验证未注册插件时 `TaskCenterDrawer.vue` 零残留，注册插件后动态渲染且支持卸载清空；
   - `packages/ui/test/workbench-composables.test.ts`：验证 `useWorkbenchCards` 纯宿主模式与合并模式下的动态响应；
   - `@aervox/ui` 全量 9 个测试套件（60 tests）100% 通过。
2. **全仓双门禁自检**：
   - 运行 `./aervox ci`（代码门禁 `ci-code` 与文档门禁 `ci-docs`）全部通过；
   - 全 monorepo 26 个构建、类型检查与单测任务全部成功。
3. **追踪基线登记**：
   - 已在 `docs/reference/REQUIREMENTS_TRACEABILITY.md` §4.2 登记闭环。
