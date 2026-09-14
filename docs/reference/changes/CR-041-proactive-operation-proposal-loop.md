---
id: CR-041
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
  - docs/reference/changes/CR-033-proactive-endgame-situation-core-and-budgeted-intervention.md
  - docs/reference/changes/CR-037-proactive-dsl-and-attention-budget-runtime.md
  - docs/reference/changes/CR-040-structured-operation-domain.md
---

# CR-041 主动操作提议、确认、执行与回执闭环

- 提出人：3yearszhuang · 2026-09-14
- 修改人：3yearszhuang · 2026-09-14

- 状态：Proposed / Planned
- 关联能力：`CAP-002/019/030/033`

## 提案范围

在 CR-040 获批并验证后，允许主动内核从操作目录产生 `proactive_actions` 待决提议。提议必须展示工具、参数摘要、可逆性、外部影响和证据；桌宠确认与标准审批语义完全等价。执行时重新校验工具启用状态、白名单、授权 revision 与参数，不信任创建提议时的旧快照。

拒绝、超时、执行成功和执行失败均写回动作账本与预算反馈。不可逆操作不得批量确认或自动执行。批准前必须完成端到端安全评审、重放语义与结果未知恢复演练。

回滚总开关为 `operation_proposals`；它必须依赖 `operation_catalog` 与 `attention_budget`，关闭后所有未执行提议转为 revoked，不能静默续跑。
