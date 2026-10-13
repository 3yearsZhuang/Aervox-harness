---
id: CR-063
type: reference
scope: change
owner: frontend
doc_status: review-candidate
decision_status: accepted
delivery_status: implemented
version: 0.2.2
updated_at: 2026-10-13
reviewed_at: 2026-10-13
review_interval_days: 90
sources:
  - docs/reference/ARCHITECTURE.md
  - docs/reference/plugin-config-and-pages.md
  - docs/reference/capability-composition.md
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
---

# CR-063 根界面插件与薄平台宿主

## 1. 决策与范围

维护者于 2026-10-12 授权新建分支实施界面插件化。取号已核对归档目录最大编号 CR-059、主仓 CR-060/061 及并行工作中的 CR-062。本次交付首个切片：工作台和独立桌宠根界面作为随应用构建的第一方插件，由各端组合根选择并交给通用界面宿主加载。当前队列见[根计划](../../../plan.md)。

标准产品继续内置 P0 学习与陪伴能力。保持 Vue 单栈、本地 SQLite、API 与数据权利边界；保留窗口、受限 IPC、连接认证及新手引导的宿主责任。移动端复用 Web 入口，不提升原生平台交付状态。CLI 命令插件、各业务面板进一步拆分和第三方代码独立安装不属于本切片。

## 2. 行为差量

- 原 Web/桌面直接挂载共享工作台，桌宠直接挂载端内组件；改为组合根显式选择界面插件，通用宿主加载根组件。
- 新增独立 `@aervox/ui-host`：版本与平台匹配、异步加载、失败/超时提示、重试与用户触发的窗口重新加载、实例取消信号与 Vue 卸载。不依赖工作台上下文、业务组件、API 或具体插件。
- 工作台组合逻辑迁入 `plugins/workbench-ui`；桌宠根组件、快捷对话与姿态逻辑迁入 `plugins/companion-ui`。共享展示组件、工作台服务及主题继续由 `@aervox/ui` 公共出口提供。
- UI 插件定义区别于可安装的 `PluginManifest`，仅允许受信构建输入，不读取用户提供的代码 URL，不进入插件市场启停记录或声明式分发包。
- 界面卸载会中止该实例的对话订阅并清理监听和定时器；不会替用户取消已受理的服务端回合、删除数据或撤销权限。

## 3. 验证与回滚

验证替代根组件真实渲染、平台与版本不匹配拒绝、加载失败重试、加载超时、旧加载迟到、卸载取消与多窗口实例隔离；复用工作台与桌宠回归，构建 Web 与桌面产物并运行完整代码和文档门禁。共享包不得反向依赖插件或宿主，插件只使用公共包出口。

失败时保留宿主提示与重试入口，旧实例不得覆盖当前界面。回退本次代码与锁文件即可恢复原入口，无数据迁移。Vue 错误边界不承担第三方权限隔离或同步死循环防护，独立安装与升级回滚仍需后续合同。

## 4. 修订记录

### 2026-10-13 · v0.2.0 二阶段切片（ITER-055，feat/ui-surface-experience）

用户授权按迭代建议一次性完成第一波（收口与硬化）与第二波（结构深化）：

- **清单契约化**：`UISurfacePlugin` 升级为显式 `UISurfaceManifest`（`displayName`/`description`/`requires.hostApiVersion`/`requires.capabilities`），`defineUISurface()` 构建期 fail-fast；宿主装配前校验并输出结构化失败原因（`data-failure-reason`），契约类拒绝不自动重试。
- **加载体验**：宿主加载态改为结构骨架屏（遵循 `prefers-reduced-motion`）；加载失败/超时按 800ms→2400ms 退避自动重试，手动「重新打开」重置重试链；新增 `PetWithFallback` 桌宠降级链（Live2D → SpritePet（提供精灵图清单时）→ PetHero），两个根界面统一接入。
- **浏览器级 E2E**：新增 `e2e-ui/` 与 `playwright.ui.config.ts`（独立于 API 级 `playwright.config.ts`），覆盖窄屏抽屉焦点归还、跨会话草稿保留、设置弹层焦点归还三条回归（chromium，真 API + Vite dev server）。
- **集成缺口修复**：E2E 发现 `@aervox/ui/workbench` 出口未装配主题链（遮罩/抽屉/设置样式缺失），新增 `theme/workbench-all.css` 由出口统一装载。
- **面板细拆**：模型/本地模型/人格/语音/插件管理五块设置面板（22 组件 + 6 测试文件）迁入 `@aervox/plugin-panels-ui`；设置弹层改经 `settings:panel:<category>` 槽位渲染，面板由组合根以受信构建输入经 `settingsPanels` prop 显式注入，不受插件启停门控；`@aervox/ui` 不再内建具体业务面板。
- **设计令牌单源**：新增 `theme/tokens.css`（`--avx-*`，明暗双主题），六个主题文件统一消费，令牌值全部提取自既有样式，视觉零变更。
- **多根界面试验田**：`workbench-ui` 包新增 `compactSurface`（紧凑单栏变体，复用同一工作台根、`variant="compact"`）；`ui-host` 新增 `resolveSurfaceChoice()`，组合根按 `?surface=` / localStorage `aervox.surface.main` 选择根界面；设置外观区提供切换器（重载生效）。

### 2026-10-13 · v0.2.2 主动陪伴界面插件（同分支，ITER-057）

- **新界面插件 `@aervox/plugin-proactive-ui`**（方向 D）：视觉小说式对话盒（打字机呈现问候与流式回复）、两张主动建议卡（接续最近会话 / 开始专注，附推荐理由行）、输入淡化为「悄悄话」药丸（展开时建议卡让位）；默认工作台保持不变，组合根经 `resolveSurfaceChoice` 三选一，设置外观区新增「思隅陪伴」切换项。

### 2026-10-13 · v0.2.1 遗留收口（同分支）

- **设置面板按需分包**：`panels-ui` 的 `settingsPanels` 一律改为 `defineAsyncComponent`，Web 构建产物中五块面板各自成 chunk（不进工作台首包），分类首次激活时按需加载；模型面板草稿保留由 KeepAlive 继续覆盖（`plugins/panels-ui/test/lazy-panels.test.ts`）。

仍未覆盖（另立 CR-064 提案跟踪）：原生移动真机验收、界面插件独立安装与升级回滚、第三方 UI 插件信任模型。
