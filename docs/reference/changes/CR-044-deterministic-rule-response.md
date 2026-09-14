---
id: CR-044
type: reference
scope: change
owner: maintainers
doc_status: review-candidate
decision_status: accepted
delivery_status: planned
version: 0.1.0
updated_at: 2026-09-14
reviewed_at: 2026-09-14
review_interval_days: 90
sources:
  - docs/reference/changes/CR-034-local-model-fallback-ladder.md
  - docs/reference/changes/CR-042-local-model-routing-and-fallback.md
  - docs/reference/changes/CR-033-proactive-endgame-situation-core-and-budgeted-intervention.md
---

# CR-044 对话侧 L2 确定性规则回应通道

- 提出人：3yearszhuang · 2026-09-14
- 修改人：3yearszhuang · 2026-09-14

- 状态：Accepted / Planned
- 关联能力：`CAP-013/009/019`

## 1. 变更与边界

本 CR 为 CR-034 的 N2b 切片，补齐对话主链路在完全无可用模型（L0 与 L1 皆不可达）时的兜底通道，实现「断网不哑火」承诺：

1. **规则回应通道**：建立独立 `RuleResponsePort`，覆盖通用问候、陪聊骨架、主动事件播报与固定安全响应；
2. **人格一致性**：规则回应话术模板纳入 Persona 管线统一管理，避免出现割裂的「第二人格」；
3. **诚实离线标识**：规则回应明确标记 `source=rule/offline`，不进入普通模型事实或长期记忆，UI 诚实提示离线模式。

## 2. 验收与回滚

- **Feature Flag 隔离**：由独立环境变量 `AERVOX_RULE_RESPONSE` 门控；
- **全链路零模型测试**：模拟全无网络与本地模型时，Turn 正常以离线规则文本输出并完成收口；
- **回滚语义**：关闭开关退回明确的失败报错语义。
