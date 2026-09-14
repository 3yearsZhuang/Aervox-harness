---
id: CR-036
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
  - apps/worker/src/proactive-situation-projector.ts
  - packages/contracts/src/situation-model-schemas.ts
  - packages/repositories/src/repositories/sqlite/proactive-situation-repository.ts
sources:
  - docs/reference/changes/CR-033-proactive-endgame-situation-core-and-budgeted-intervention.md
  - docs/reference/srs-proactive-intelligence.md
---

# CR-036 SituationModel 影子投影与内置规则数据化

- 提出人：3yearszhuang · 2026-09-14
- 修改人：3yearszhuang · 2026-09-14

- 状态：Accepted / Verified
- 关联能力：`CAP-030/033`

## 变更与边界

Worker 在 `situation_projection` 开关下，把 CR-032 的注意力、近期承诺、漂移、场景、连接、在场状态与健康摘要归约为 `situation_model_v1`。投影只含白名单字段与来源摘要，是可删除、可重建的派生物；开关关闭时，CR-032 行为不变。

低睡眠规则要求可验证的健康输入，因此本 CR 为投影补充 `health.sleepMinutes` 与 `health.dailySteps`，不携带原始健康样本或连接凭据。四条内置规则以受限 DSL 数据声明保存；影子期仍由旧逻辑派发，新求值只记录差异。

## 验收与回滚

- 同一事实 epoch 不重复写快照，事实变化才推进影子序列；
- 四条内置规则新旧命中对照为零差异；
- 撤销来源时删除对应 revision 投影，事件重建使用明确 watermark；
- 关闭 `AERVOX_PROACTIVE_SITUATION_PROJECTION` 即退回 CR-032，快照表保留用于审计，不需要删除。

验证：Worker 投影、DSL 对照与 Repository 删除/重建测试，以及全量代码和文档门禁。
