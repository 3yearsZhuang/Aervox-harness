---
id: AVX-EXPL-001
type: explanation
scope: baseline
owner: maintainers
doc_status: review-candidate
decision_status: not-applicable
delivery_status: not-applicable
version: 0.2.0
updated_at: 2026-09-10
reviewed_at: 2026-09-10
review_interval_days: 90
---

# 数据流总览：一次对话如何流动

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-09-11

关联：[架构设计](../reference/ARCHITECTURE.md)、[流式协议契约](../reference/STREAMING_PROTOCOL.md)、[数据库契约](../reference/DATABASE.md)

本文讲解"消息从发出到落库、再到异步产物（提醒/日记/删除）如何流动"，只讲因果与权衡；需要精确字段与状态机时跳到对应契约。

## 一句话模型

Aervox 是一条"先写后投递"的单向管道：客户端把输入按幂等 Turn 写入 SQLite 真源并同时入 Outbox；Worker 轮询 Outbox 与业务周期表，分批完成复习提醒、日记生成、删除传播等异步工作；对话积累的记忆与知识由 API 侧模块按需写入，供后续召回。

## 概念地图

| 环节 | 位置 | 职责 |
|---|---|---|
| API 模块化单体 | `apps/api/src/modules/` | conversation / memory / knowledge / learning / diary / branch 等自包含模块（[ADR-014](../reference/adr/ADR-014-modular-monolith-structure.md)） |
| Worker | `apps/worker/src/` | outbox / review-notifier / diary-generator / deletion 四个轮询循环 |
| 数据库 | `packages/database/src/schema/` | conversations / memories / learning / ledger / outbox / privacy 等表族（[数据库契约](../reference/DATABASE.md)） |
| 契约 | `docs/reference/` | 事件 envelope 与状态机（[流式协议](../reference/STREAMING_PROTOCOL.md)）、Schema 生成的 OpenAPI |

## 端到端视角

1. 客户端提交输入 → `POST /v1/sessions/{sessionId}/turns` 幂等创建 Turn（同一请求键重放返回同一 Turn），并在同一事务内原子写入 Outbox 记录（[ADR-004](../reference/adr/ADR-004-outbox-idempotent-jobs.md)）。
2. 客户端用 `GET /v1/turns/{turnId}/events` 以 SSE 消费事件流；断线时用 `Last-Event-ID` 重连，服务端去重（[流式协议](../reference/STREAMING_PROTOCOL.md)）。
3. Worker 每个 tick（默认 5 秒，见 `WORKER_TICK_MS`）执行：
   - outbox 循环消费待投递事件：写审计记录并标记发布，失败的转 retry/dead_letter（下游投递按 eventType 逐步扩展，[ADR-004](../reference/adr/ADR-004-outbox-idempotent-jobs.md)）；
   - review-notifier 把到期复习的会话生成提醒，并关联 `knowledge_relations` 中的相关知识（对应复习排期，PRD CAP-006）；
   - diary-generator 按日记周期生成日记（[ADR-011](../reference/adr/ADR-011-diary-cycle-schedule-revision.md)）；
   - deletion 循环按删除请求逐 target 清除并验证（[PRD §8 数据模型](../reference/PRD.md#8-数据模型) 的 DeletionRequest/DeletionTarget + [数据库契约 §8](../reference/DATABASE.md#8-删除撤权与恢复)）。
4. 会话中的记忆节点与知识关系由 memory / knowledge 模块维护（如 `POST /v1/memory/nodes`），供召回与分支查询（[ADR-007](../reference/adr/ADR-007-memory-tree-projection.md)）。

## 设计权衡

- **为什么先写后投递**：用户请求只做一次落盘，慢副作用交给 Worker；代价是至少一次语义，因此必须配幂等键（[ADR-004](../reference/adr/ADR-004-outbox-idempotent-jobs.md)）。
- **为什么模块化单体**：1~2 人团队在运维成本与数据一致性间取平衡（[ADR-014](../reference/adr/ADR-014-modular-monolith-structure.md)）；模块只依赖 Port，不跨模块直写表。
- **为什么 SQLite 是永久真源**：本地单用户产品需要单机一致性、可读备份和零外部数据库运维；PostgreSQL 与多租户切换规划已由 [CR-030](../reference/changes/CR-030-pure-local-sqlite-database.md) 终止。

## 演进方向

- CR-030：停写并备份旧库，显式选择数据范围，在 staging 新库中去租户化并校验后原子换库；
- Web 工作台与移动壳复用同一数据层（[ADR-015](../reference/adr/ADR-015-vue-full-stack.md)）；
- 插件与本地优先能力进入后，本管道增加新的投递目标（[ADR-009](../reference/adr/ADR-009-electron-plugin-sandbox.md)、[ADR-010](../reference/adr/ADR-010-dsh-pi-adapters.md)）。
