---
id: CR-039
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
  - apps/worker/src/proactive-turn-context.ts
  - apps/worker/src/proactive-composer.ts
  - packages/contracts/src/safety-classifier.ts
sources:
  - docs/reference/changes/CR-033-proactive-endgame-situation-core-and-budgeted-intervention.md
  - docs/reference/AI_QUALITY_SAFETY.md
---

# CR-039 主动回合人格、记忆与安全上下文同源

- 提出人：3yearszhuang · 2026-09-14
- 修改人：3yearszhuang · 2026-09-14

- 状态：Accepted / Verified
- 关联能力：`CAP-008/019/030/033`

## 变更与边界

`proactive_persona` 开启后，主动回合必须解析当前激活 Persona revision，只允许该 revision 声明且仍启用的技能。已验证长期记忆按引用进入上下文，并作为不可信事实数据装配。无激活 Persona 或 revision 非法时 fail-closed，不回退到插件人格。

安全分类器移至共享契约实现，由对话与主动回合同源调用。危机内容固定响应且不调用模型。插件 `SKILL.md` 默认不能开启 Persona 叠加，也不能覆盖核心身份、授权或安全策略。

## 验收与回滚

- Persona revision、技能交集、已验证记忆引用与安全策略版本可追溯；
- 未验证记忆不进入主动提示词；
- 对话侧原有安全测试全部通过，主动危机路径使用相同分类结果；
- 关闭 `AERVOX_PROACTIVE_PERSONA` 恢复 CR-032 模板/插件组合器，不改 Persona 数据。

验证：主动上下文、组合器和安全陪伴回归测试，以及全量双门禁。
