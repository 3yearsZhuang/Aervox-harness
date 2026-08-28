---
id: CR-019
type: reference
scope: change
owner: maintainers
doc_status: review-candidate
decision_status: proposed
delivery_status: implemented
version: 0.1.0
updated_at: 2026-08-28
reviewed_at: 2026-08-28
review_interval_days: 90
review_triggers:
  - docs/reference/capability-registry.md
  - docs/reference/capability-composition.md
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
sources:
  - docs/reference/capability-registry.md
  - docs/reference/capability-composition.md
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
---

# CR-019 能力注册表状态同步：CAP-010~019 主仓交付裁定

- 提出人：3yearszhuang · 2026-08-28
- 修改人：3yearszhuang · 2026-08-28

关联：[能力注册表](../capability-registry.md)、[能力组合规范](../capability-composition.md)、[需求追踪基线](../REQUIREMENTS_TRACEABILITY.md)、[生命周期登记表](../../DOC_REGISTRY.md)

## 变更原因

CAP-010~019 已于 PR #64 在主仓实现并交付（见[追踪基线 §4.2](../REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)：层级对话与会话地图 CAP-014、思维宇宙 CAP-015、自适应刷题与报告 CAP-016、考试日计划 CAP-017、多人格模板 CAP-019）。而[能力注册表](../capability-registry.md) P1 表仍把 CAP-014/015/016/017/019 标记为「候选/远期」的自选机制候选项，与[能力组合 · 模块化交付不变量](../capability-composition.md#交付载体与自选机制必选)冲突——该不变量规定：被判定纳入自选机制的非核心功能必须在独立 submodule 仓库开发，禁止在主仓 `packages/` 内维护「可选却同仓开发」的平行实现。这些能力已按主仓方式交付使用，其「自选候选」表述不再成立，需要裁定并同步。

## 目标行为

- 将 CAP-014/015/016/017/019 从能力注册表 P1 自选候选中移除，裁定为**主仓交付**；
- 能力注册表补充「已转主仓交付」说明，含未来重新纳入自选的边界判定与 `CR-*` 要求；
- 同步文档索引、生命周期登记表与根 README 的 CR-019 条目与引用；
- 在追踪基线 §4.2 登记本 CR 的落地。

## 范围外

- 不改变 CAP-014~019 的功能、路由、数据或验收口径（以追踪基线为准）；
- 不处置 CAP-018（桌面化 + Live2D，保留构建时自选候选，关联 CR-002）；
- 不影响 CR-018（错题错因记录工作流，独立变更）；
- 不为这些能力引入新的自选载体或 submodule。

## 兼容与迁移

- 注册表仅移除候选标记并补充说明，不涉及任何代码、schema 或数据交互；
- 若未来要把其中某个能力重新纳入自选机制，须重新通过[边界判定](../capability-composition.md#核心与可选的边界判定)并另建 `CR-*` 登记。

## 验证与回滚

- 验证：`mise tasks run ci-docs`（markdownlint + Vale + `docs-validate`：无重复 ID、登记路径与索引一致）；`git diff --check`；
- 回滚：恢复能力注册表 P1 原候选行并删除说明段，撤除本 CR 的登记与引用；
- 数据影响：无数据库、API、用户数据或运行时迁移；
- 安全影响：无权限、凭据或信任边界变化（纯文档治理同步）。
