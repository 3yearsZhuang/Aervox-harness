---
id: CR-047
type: reference
scope: change
owner: maintainers
doc_status: review-candidate
decision_status: accepted
delivery_status: verified
version: 1.0.0
updated_at: 2026-09-14
reviewed_at: 2026-09-14
review_interval_days: 90
sources:
  - docs/reference/changes/CR-035-standard-workbench-mode.md
  - docs/reference/PRD.md
  - docs/reference/capability-registry.md
---

# CR-047 模式切换器与统一任务中心 (W2)

- 提出人：3yearszhuang · 2026-09-14
- 修改人：3yearszhuang · 2026-09-14

- 状态：Accepted / Verified
- 关联变更：[CR-035 标准 AI 工作台形态](CR-035-standard-workbench-mode.md) · [CR-046 标准工作台交互壳与会话侧栏](CR-046-standard-workbench-shell-and-sidebar.md)
- 关联能力：`CAP-002`（错题本）、`CAP-010`（日记本）、`CAP-019`（桌宠交互）、`CAP-033`（主动智能）

---

## 1. 提案范围与目标

作为 CR-035 标准工作台形态的阶段 2（W2），本提案交付模式切换入口与聚合只读任务中心：

1. **交互形态切换器（Mode Selector）**：
   - 在设置中心「外观」分区新增「交互模式」分段控件（标准工作台 ↔ 桌宠陪伴）；
   - 在侧边栏底部提供「切换至桌宠陪伴模式」快捷切换按钮；
   - 在标准工作台顶栏右侧提供「切换桌宠模式」醒目标志，确保用户在任何状态下均能一键切换，降低认知试错成本；
2. **统一任务中心只读抽屉 (`TaskCenterDrawer.vue`)**：
   - 解决定时后台能力分散（日记提炼、复习排期、番茄钟、主动规则）的痛点，提供聚合概览卡片；
   - 遵循「只读透传 + 深链跳转」原则，严禁在任务中心重造独立的调度语义或状态真源；
   - 任务中心提供直达错题本、学习规划、日记本、专注计时器和主动智能画像分区的动作入口；
   - 底部常态化展示系统健康状态：纯本地单库 SQLite WAL 模式、去租户化单用户真源、Outbox 事务调度正常；
3. **状态透传与快捷指令**：
   - `useWorkbenchLayout` 暴露 `taskCenterOpen`、`openTaskCenter()`、`closeTaskCenter()`、`toggleTaskCenter()`；
   - `layout.openTool('task_center')` 统一纳管至任务中心，兼容既有工具导航机制。

---

## 2. 验证与落地依据

- `@aervox/ui`：交付 `TaskCenterDrawer.vue`、`SettingsModal.vue` 交互模式切换器、`standard-workbench.test.ts` 自动化单元测试；
- Web 应用打包：`apps/web` 独立构建将 `TaskCenterDrawer` 拆分为动态按需 chunk，首屏零冗余加载；
- 行为审计验证：模式切换与任务中心展开均向主动智能运行时记录结构化审计事件（`workbench.mode_switched` 与 `workbench.task_center_opened`）。
