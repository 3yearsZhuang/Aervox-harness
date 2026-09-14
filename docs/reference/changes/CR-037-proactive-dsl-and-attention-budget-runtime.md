---
id: CR-037
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
review_triggers:
  - apps/worker/src/proactive-dsl-engine.ts
  - apps/worker/src/proactive-budget-gate.ts
  - packages/repositories/src/repositories/sqlite/proactive-budget-repository.ts
  - packages/contracts/src/plugin-config-schemas.ts
sources:
  - docs/reference/changes/CR-033-proactive-endgame-situation-core-and-budgeted-intervention.md
  - docs/reference/changes/CR-036-situation-model-shadow-projection.md
---

# CR-037 受限 DSL 与注意力预算接入裁决链

- 提出人：3yearszhuang · 2026-09-14
- 修改人：3yearszhuang · 2026-09-14

- 状态：Accepted / Verified
- 关联能力：`CAP-020/030/033`

## 变更与边界

`proactive_dsl` 仅在 SituationModel 开启后生效。插件安装期使用共享白名单和硬配额做静态检查；运行期遇到未知字段、非法节点或资源超限均不命中。没有 DSL 的存量插件继续走 CR-032 兼容求值。

`attention_budget` 在静态授权、冷却、静音和每小时硬上限之后叠加。全局与插件预算以同一 SQLite 写者事务完成双行 CAS 预留；任一行失败则整体回滚。派发失败走双行原子退款，抑制与派发均写幂等回执。插件不能直接修改预算。

## 验收与回滚

- DSL 安装期和运行期 fail-closed；
- CR-032 静态约束始终优先且不能由预算绕过；
- 全局与插件预算不会部分扣减或并发超发；
- 反馈和回执按幂等键只生效一次；
- 关闭两个开关按 `attention_budget` → `proactive_dsl` 顺序回退，恢复 CR-032 规则与静态裁决。

验证：DSL、预算纯函数、原子双预算、插件安装和 Worker 集成测试，以及全量双门禁。
