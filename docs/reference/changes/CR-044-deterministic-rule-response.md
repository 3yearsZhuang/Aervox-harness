---
id: CR-044
type: reference
scope: change
owner: maintainers
doc_status: review-candidate
decision_status: accepted
delivery_status: verified
version: 1.0.0
updated_at: 2026-09-16
reviewed_at: 2026-09-16
review_interval_days: 90
sources:
  - docs/reference/changes/CR-034-local-model-fallback-ladder.md
  - docs/reference/changes/CR-042-local-model-routing-and-fallback.md
  - docs/reference/changes/CR-033-proactive-endgame-situation-core-and-budgeted-intervention.md
---

# CR-044 对话侧 L2 确定性规则回应通道

- 提出人：3yearszhuang · 2026-09-14
- 修改人：3yearszhuang · 2026-09-16

- 状态：Accepted / Verified
- 关联能力：`CAP-013/009/019`

## 1. 变更与边界

本 CR 为 CR-034 的 N2b 切片，补齐对话主链路在完全无可用模型（L0 与 L1 皆不可达）时的兜底通道，实现「断网不哑火」承诺：

1. **规则回应 Provider**：建立独立 `RuleResponseProvider` 实现 `ModelProviderPort`，覆盖问候语句、系统状态查询、帮助与能力引导及通用未知问题兜底；
2. **人格与运行原因透传**：支持传入激活人格名称与降级具体原因（如云端超时、本地未启动），提供自然融洽的用户提示；
3. **诚实离线标识**：输出明确带有确定性规则与离线状态标记，不产生幻觉伪造，并附带权威 `routingSnapshot` 元数据；
4. **统一特性开关**：受 `rule_response` 特性开关受控管控，默认开启。

## 2. 落地实现与验证

- **核心实现**：`apps/api/src/modules/companion/conversation/rule-response-provider.ts`（`RuleResponseProvider`）；
- **执行集成**：`apps/api/src/modules/companion/conversation/agent-executor.ts`（在 L2 或模型端点不可用时无缝降级至规则通道）；
- **自动化测试验证**：`apps/api/test/rule-response.test.ts` 5/5 单测全部通过，验证流式输出、问候、状态说明与元数据。
