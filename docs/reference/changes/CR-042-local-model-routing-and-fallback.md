---
id: CR-042
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
review_triggers:
  - apps/api/src/modules/ecosystem/llm/health-prober.ts
  - apps/api/src/modules/ecosystem/llm/degradation-service.ts
  - packages/contracts/src/model-routing-schemas.ts
  - packages/repositories/src/repositories/sqlite/model-routing-repository.ts
sources:
  - docs/reference/changes/CR-034-local-model-fallback-ladder.md
  - docs/reference/adr/ADR-005-provider-port.md
  - docs/reference/changes/CR-015-llm-provider-config-webui.md
---

# CR-042 本地模型降级决策与健康路由运行时

- 提出人：3yearszhuang · 2026-09-14
- 修改人：3yearszhuang · 2026-09-16

- 状态：Accepted / Verified
- 关联能力：`CAP-020/013/009/033/019`

## 1. 变更与边界

本 CR 为 CR-034 的 N1 切片，落地降级阶梯的共享路由契约与健康路由决策器：

1. **共享路由契约**：在 `@aervox/contracts` 定义 `ModelRoutingSnapshot`、`HealthSnapshot`、`CapabilityTier`、`ModelRoutingEvent` 及跨模块共享端口 `ModelRoutingPort`；
2. **后台健康探测**：实现 `LlmHealthProber`，解耦手动连通性测试，以 5s 严格超时、重定向防护与错误分类进行后台轻量探活；
3. **降级决策与粘滞**：实现 `LlmDegradationService`，支持连续失败迟滞切层、会话级粘滞（避免逐回合体验抖动）及连续成功门限恢复回切；
4. **持久化与审计**：在 SQLite 主库通过 `llm_health_snapshots` 记录预设健康快照，通过 `llm_routing_events` 追加切层审计账本；
5. **本地边界防御**：在 `requireLocalOnly` 上下文（CR-023/ADR-018）严格拒绝出网，非本机回环端点一律 fail-closed。

## 2. 验收与回滚

- **Feature Flag 隔离**：由独立环境变量 `AERVOX_MODEL_ROUTING` 门控，默认关闭时 100% 保持 CR-015/029 既有激活配置读取路径；
- **健康切换与回切**：单测覆盖 L0 正常、连续 N 次失败降级 L1、L1 会话粘滞、连续 N 次成功回切 L0 及双挂降级 L2 标记；
- **协议兼容排他**：`anthropic` 预设明确不计入健康 L0 候选，避免未支持协议引发 Agent Loop 崩溃；
- **回滚语义**：关闭开关即退回既有逻辑，新增 SQLite 表结构为幂等追加，不引入破坏性 schema 回滚。
