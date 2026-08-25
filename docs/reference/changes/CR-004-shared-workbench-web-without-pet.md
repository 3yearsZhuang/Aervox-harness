# CR-004 共享工作台与 Web 无桌宠表现层

> 文档编号：CR-004
> 类型：Reference
> 版本：v0.1
> 更新日期：2026-08-25
> 状态：Review Candidate
> 责任角色：产品与技术负责人
> 关联：[Web 工作台实现规划](../../explanation/web-implementation.md)、[架构设计](../ARCHITECTURE.md)、[ADR-015](../adr/ADR-015-vue-full-stack.md)

- 状态：More Evidence Required
- 提出人 / 日期：Codex / 2026-08-25
- 目标版本：R1 MVP / R3 端形态扩展
- 变更原因与证据：Web 与 Electron 已出现两套不同的工作台实现，导致对话、学习工具、主题和响应式行为漂移；用户明确要求两端 UI 完全同步、优先使用同一套 UI，并要求 Web 不提供桌宠表现层。
- 关联能力与需求：`CAP-001`、`CAP-002`、`CAP-006`、`CAP-008`、`CAP-018`、`FR-UX-001`、`FR-UX-003`、`FR-UX-004`、`NFR-A11Y-001`、`NFR-COMPAT-001`、`ADR-015`、`AVX-WEB-001`
- 当前行为 / 目标行为：当前 Web 使用简化侧栏、独立聊天/学习页面和 `PetBubble` 浮层，Electron 使用另一套完整工作台。目标行为是由 `@aervox/ui` 提供共享 `AervoxWorkbench`、对话流、学习面板、工具面板、双栏设置窗口和主题令牌；Electron 通过 `platform="desktop"` 保留标题栏、桌宠区域和独立桌宠窗口，Web 通过 `platform="web"` 使用相同核心工作台但不渲染桌宠 DOM。设置分类栏位于左侧，详细设置位于右侧，主题、助手称呼、回车发送、界面密度、番茄钟时长、桌宠显示和学习提醒保存在当前设备。
- 范围外：Electron 主进程 IPC、桌宠独立窗口权限模型、Live2D 正式模型、账户登录、API/SSE 契约、学习事实数据模型。
- UX/API/数据/AI/安全/隐私影响：共享组件只负责展示和输入，继续使用 `@aervox/api-client` 的同一 Transport/Turn/SSE 逻辑；Web 不新增设备权限或常驻进程；桌宠仅为 Electron 表现层，不拥有核心数据；设置仅写入浏览器/Electron renderer 的本地偏好，不进入业务真源；共享工作台增加键盘可达、复制回答、流式/错误状态、空态和减少动画适配。
- 迁移与向后兼容：删除 Web 的 `PetBubble`、路由页面和旧桌面 story/index 样式入口，不改变公开 API；Web 根路径继续由工作台承载对话入口；Electron 保持既有窗口入口和 `pet.html`。
- 测试、埋点和验收影响：执行 `@aervox/ui`、`@aervox/web`、`@aervox/desktop` typecheck/build；补充 Web/Desktop 响应式截图、Web 无桌宠 DOM、键盘输入、复制、流式错误态和 `prefers-reduced-motion` 验证；沿用 `TC-E2E-CONV-001`、`TC-E2E-STREAM-001`、`TC-E2E-COMPAT-001`、`TC-A11Y-CORE-001`。
- 风险与成本：共享组件包含 Element Plus drawer 和 API composable，包边界更宽；桌面与 Web 的窗口壳仍需分别维护；旧端内 CSS 被删除后若第三端直接依赖旧选择器会出现视觉回归。
- 灰度、回滚和用户通知：共享组件可通过端入口回退到旧壳；不执行数据迁移；若 Web 适配出现问题，可恢复 Web 独立路由而不影响 API、Electron 或数据层。
- 决策：More Evidence Required（代码与类型检查已完成，浏览器视觉、无障碍和完整 CI 证据待补齐）。
- 批准人 / 日期：待指定
- 更新的文档和测试：`docs/explanation/web-implementation.md`、`docs/reference/ARCHITECTURE.md`、`docs/DOC_REGISTRY.md`、`packages/ui`、`apps/web`、`apps/desktop`。
- 发布后结果：待发布
