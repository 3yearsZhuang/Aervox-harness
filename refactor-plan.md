# Re-Aervox 底层重构计划：UI 组件化与插件注入替换体系

- 状态：Completed
- 提出人：linge · 2026-09-09
- 修改人：linge · 2026-09-09
- 关联：`ADR-009`、`ADR-015`、`CR-006`、`AVX-CAP-001`

---

## 一、 重构目标与核心原则

1. **目标 1：UI 全面组件化与解耦**
   - 将现有 3300+ 行的单体巨石组件 `AervoxWorkbench.vue` 彻底拆解，按领域边界拆分成高内聚、低耦合的独立 Vue 组件（输入框底座、消息对话流、侧边卡槽、顶部状态条、全局抽屉等）。
   - 启动时通过 Workbench 容器（`index.vue` / `AervoxWorkbench.vue`）以统一插槽（Slots）与动态注册表（UI Component Registry）的形式进行注入装配。
   - 抽离独立的领域状态层（Composables / Pinia Stores），解决跨组件状态共享问题，杜绝多层 Props 透传。

2. **目标 2：插件注入与替换系统（Extension Slots & Component Overrides）**
   - **插槽注入能力（Slot Injection）**：在系统核心交互区提供标准化的扩展插槽（如输入框操作条、顶部操作区、导航菜单、侧边卡槽、消息气泡菜单等），插件可声明式注入自定义 Vue 组件或按钮，支持多插件并存与优先级排序。
   - **组件替换能力（Component Overrides）**：基于强类型的策略契约（Component Contract），允许特定插件替换核心视图（如自定义聊天输入框、自定义卡片展示），宿主保证核心通信协议与生命周期不被破坏。
   - **双轨安全隔离（Security Boundaries）**：
     - *第一方 / 受信扩展*：直接注册原生 Vue 组件，享有全量上下文交互与高性能；
     - *第三方外部插件*：遵循 ADR-009 与 CR-006 规范，通过受限 iframe 沙箱 + Bridge SDK 隔离运行，防止未经审计的代码注入主应用 DOM 与执行上下文。

---

## 二、 任务拆解与推进清单

### Phase 1: 状态管理层抽离（UI 瘦身前置条件）
- [x] **1.1 抽离会话与流式状态 (`useWorkbenchConversation`)**
  - 管理 messages 列表、流式输出状态（streaming）、Turn 提交、写工具审批待决（pendingApproval）等业务逻辑。
- [x] **1.2 抽离输入与底座状态 (`useWorkbenchComposer`)**
  - 管理输入框文本（input）、IME 输入法合成中状态（isComposing）、附件上传/预览/删除队列、语音录制与转写联动。
- [x] **1.3 抽离小工具与卡片状态 (`useWorkbenchCards` & `useWorkbenchTimer`)**
  - 管理番茄钟计时器状态与 Toast 倒计时动画；
  - 管理侧边双卡槽（slotCards）、AI 提问卡临时覆盖机制（activeQuestion）、练习会话联动。
- [x] **1.4 抽离导航与布局状态 (`useWorkbenchLayout`)**
  - 管理主导航药丸胶囊状态、专注模式开关、桌面端/Web 平台适配、各大抽屉与弹窗（设置、历史、工具箱）的开关。

---

### Phase 2: UI 核心领域组件化拆分
- [x] **2.1 拆分顶部操作栏 (`WorkbenchHeader.vue`)**
  - 专注模式开关、设置入口，预留 `header:actions` 插件扩展插槽。
- [x] **2.2 拆分番茄钟浮动通知 (`PomodoroToast.vue`)**
  - 环形 SVG 进度条、倒计时渲染、快捷操作（暂停/重置）。
- [x] **2.3 拆分悬浮主导航 (`WorkbenchNavPill.vue`)**
  - 折叠展开动画、内置菜单项，预留 `nav:menu-items` 扩展插槽。
- [x] **2.4 拆分侧边卡槽容器 (`WorkbenchSideCards.vue`)**
  - 双槽卡片渲染、用户提问响应卡（User Question Card）、番茄钟快捷卡、预留 `sidecards:widgets` 插件卡片扩展点。
- [x] **2.5 拆分消息对话流平台 (`ConversationConsole.vue`)**
  - 拆分子组件：消息气泡渲染器 (`MessageBubble.vue`)、工具调用审批卡 (`ToolApprovalCard.vue`)、术语概念芯片栏 (`TermsBar.vue`)。
  - 预留 `message:bubble-actions` 插槽。
- [x] **2.6 拆分聊天输入底座 (`ComposerDock.vue`)**
  - 拆分子组件：附件管理器 (`ComposerAttachments.vue`)、文本输入区、语音交互按钮、快捷帮助提示。
  - 预留 `composer:toolbar-actions` 和 `composer:bottom-bar` 扩展插槽。
- [x] **2.7 拆分各二级抽屉与弹窗**
  - 工具抽屉 (`ToolsDrawer.vue`：代办、番茄钟全表盘、日记)；
  - 学习抽屉 (`LearningDrawer.vue`：学习计划、错题本)；
  - 历史抽屉 (`HistoryDrawer.vue`)；
  - 瘦身设置主弹窗 (`SettingsModal.vue`)。
- [x] **2.8 重构 `AervoxWorkbench.vue` (Shell 容器)**
  - 作为骨架入口，负责装配各领域组件与插槽，整体行数收敛至 300 行左右（337 行）。

---

### Phase 3: 插件注入与替换机制实现
- [x] **3.1 建立 UI 扩展点注册表 (`ui-registry.ts`)**
  - 定义 `ExtensionSlotName`（如 `header:actions`, `composer:tools`, `sidecards:widgets` 等）；
  - 实现插槽组件注册接口 `registerSlotComponent(slotName, component, options)`；
  - 实现组件替换接口 `overrideComponent(targetName, component)`。
- [x] **3.2 实现标准插槽渲染容器 (`ExtensionSlot.vue`)**
  - 支持按 priority 排序展示多个注入组件；
  - 支持将宿主上下文通过 Props / Provide 安全注入给插槽组件。
- [x] **3.3 定义核心替换组件的契约接口 (Component Contracts)**
  - 针对允许被替换的核心组件（如 `Composer`、`SideCard`），定义严格的 TypeScript Props 与 Emits 契约接口，防止替换后由于数据流断裂导致崩溃。
- [x] **3.4 第一方插件接入验证**
  - 导出 `ExtensionSlot`、`createUIRegistry`、`useUIRegistry` 并在工作台关键交互区域挂载 8 个命名扩展插槽与 `ComposerDock` 组件覆盖契约，为 `study-companion`、`term-explorer` 等插件提供即插即用的注入点。

---

### Phase 4: 安全边界与沙箱对齐
- [x] **4.1 受信与非受信双轨机制**
  - 第一方/系统级插件走直接组件注入；
  - 第三方外部插件接入 `PluginPageDialog` 沙箱，通过 Bridge SDK 间接与扩展槽通信，禁止直接向主 DOM 树挂载未经审计的代码。
- [x] **4.2 错误隔离与 ErrorBoundary**
  - 为每个扩展插槽增加 Vue `onErrorCaptured` 容错隔离，捕获子组件异常并降级渲染错误占位符，确保单个插件组件崩溃不影响主工作台的正常会话。

---

### Phase 5: 测试验证与门禁检查
- [x] **5.1 单元测试与组件测试**
  - `packages/ui` 内新增 `ui-registry.test.ts` 与 `workbench-composables.test.ts` 测试套件，16 个测试全部通过。
- [x] **5.2 契约与构建验证**
  - `@aervox/ui` 类型检查（`vue-tsc --noEmit`）零错误通过；
  - `@aervox/web` 生产构建完整通过；
  - `@aervox/desktop` 类型检查零错误通过。
