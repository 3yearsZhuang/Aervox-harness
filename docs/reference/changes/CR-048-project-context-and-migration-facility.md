---
id: CR-048
type: reference
scope: change
owner: maintainers
doc_status: review-candidate
decision_status: proposed
delivery_status: planned
version: 0.1.0
updated_at: 2026-09-14
reviewed_at: 2026-09-14
review_interval_days: 90
sources:
  - docs/reference/changes/CR-035-standard-workbench-mode.md
  - docs/reference/PRD.md
  - docs/reference/capability-registry.md
---

# CR-048 项目上下文绑定与会话迁移设施 (W3)

- 提出人：3yearszhuang · 2026-09-14
- 修改人：3yearszhuang · 2026-09-14

- 状态：Proposed / Planned
- 关联变更：[CR-035 标准 AI 工作台形态](CR-035-standard-workbench-mode.md) · [CR-046 标准工作台交互壳与会话侧栏](CR-046-standard-workbench-shell-and-sidebar.md) · [CR-047 模式切换器与统一任务中心](CR-047-mode-selector-and-task-center.md)
- 关联能力：`CAP-026`（收藏空间与知识库条目）、`CAP-033`（主动智能推断项目）

---

## 1. 提案范围与目标

作为 CR-035 标准工作台形态的阶段 3（W3），本提案规划项目上下文组织层与外部迁移导入设施：

1. **项目上下文绑定（Project Context）**：
   - 允许单个会话显式归属于特定项目；
   - 聚合三类核心资产：学习材料/知识条目（`CAP-026` 衔接）、该项目专属历史会话集合、主动智能推断的项目候选；
   - 确立「主动推断为候选、用户确认为项目」的单向流动流，避免概念混淆；
2. **外部客户端会话迁移设施（Migration Facility）**：
   - 针对从常见开源/商业客户端（如 ChatGPT 导出格式、LibreChat 格式）迁移而来的用户，提供单向会话导入解析器；
   - 解析层视为不可信输入：设置体积上限、字段白名单校验、敏感字符净化；
3. **全局快捷键与命令面板（Command Palette）**：
   - 强化 ⌘K / Ctrl+K 快捷呼出全局会话搜索与快速跳转面板；
   - 丰富快捷键覆盖度（⌘B 折叠侧栏、⌘/ 切换模式辅助提示）。
