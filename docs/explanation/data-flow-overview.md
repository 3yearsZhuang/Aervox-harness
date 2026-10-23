---
id: AVX-EXPL-001
---

# 数据流总览：一次对话如何流动

关联：[架构设计](../reference/ARCHITECTURE.md)、[流式协议契约](../reference/STREAMING_PROTOCOL.md)、[数据库契约](../reference/DATABASE.md)

本文讲解"消息从发出到落库、再到异步产物（提醒/日记/删除）如何流动"，只讲因果与权衡；需要精确字段与状态机时跳到对应契约。

## 一句话模型

Aervox 先持久化受理事实，再派发工作：客户端把输入按幂等 Turn 写入 SQLite 真源并同时入 Outbox；普通 Turn 默认由 API 执行，显式委托的后台 Turn 才由 Worker 通过同一产品宿主执行。Worker 另按任务独立节拍、错峰启动并跳过重叠轮次，分批完成复习提醒、日记生成、删除传播等异步工作。

## 概念地图

| 环节 | 位置 | 职责 |
|---|---|---|
| API 模块化单体 | `packages/host-runtime/src/modules/` | conversation / memory / knowledge / learning / diary / branch 等自包含模块（[ADR-014](../reference/adr/ADR-014-modular-monolith-structure.md)） |
| Worker | `apps/worker/src/` | outbox / review-notifier / diary-generator / deletion 等独立任务循环；每项任务有独立频率、错峰首轮和不重叠跳过 |
| 数据库 | `packages/schema/src/`、`packages/repositories/src/schema/ddl/` | conversations / memories / learning / ledger / outbox / privacy 等表族（[数据库契约](../reference/DATABASE.md)） |
| 契约 | `docs/reference/` | 事件 envelope 与状态机（[流式协议](../reference/STREAMING_PROTOCOL.md)）、Schema 生成的 OpenAPI |

## 端到端视角

1. 客户端提交输入 → `POST /v1/sessions/{sessionId}/turns` 幂等创建 Turn（同一请求键重放返回同一 Turn），并在同一事务内原子写入 Outbox 记录（[ADR-004](../reference/adr/ADR-004-outbox-idempotent-jobs.md)）。
2. 客户端用 `GET /v1/turns/{turnId}/events` 以 SSE 消费事件流；断线时用 `Last-Event-ID` 重连，服务端校验游标并补读，客户端按稳定事件 ID 去重（[流式协议](../reference/STREAMING_PROTOCOL.md)）。
3. Worker 按任务独立节拍处理 Outbox、复习、日记和删除，错峰启动并跳过重叠轮次。Outbox 入队后通过本地 Domain Socket IPC（`wake`）尽力唤醒 Worker；密集会话执行期间通过 `pressure` 协调后台降频，IPC 失联时由轮询兜底。频率与退避由[调度配置](../../apps/worker/src/task-scheduling.ts)决定，单轮扫描有界；失败按对应合同重试或进入死信。
4. SSE 事件先写入 `turn_stream_events`；`TurnStreamHub` 只合并唤醒，正文由 SQLite 高水位分页读取并按完整帧发送。socket 背压时停止取页并等待 drain；终态与高水位从同一 SQLite 快照判定，排空后关闭连接。断连不取消已受理 Turn，重连按游标补读。
5. 会话中的记忆节点与知识关系由 memory / knowledge 模块维护（如 `POST /v1/memory/nodes`），供召回与分支查询（[ADR-007](../reference/adr/ADR-007-memory-tree-projection.md)）。

## 设计权衡

- **为什么先写后投递**：用户请求只做一次落盘，慢副作用交给 Worker；代价是至少一次语义，因此必须配幂等键（[ADR-004](../reference/adr/ADR-004-outbox-idempotent-jobs.md)）。
- **为什么模块化单体**：1~2 人团队在运维成本与数据一致性间取平衡（[ADR-014](../reference/adr/ADR-014-modular-monolith-structure.md)）；模块只依赖 Port，不跨模块直写表。
- **为什么 SQLite 是永久真源**：本地单用户产品需要单机一致性、可读备份和零外部数据库运维；PostgreSQL 与多租户切换规划已由 `CR-030`（已归档） 终止。

## 演进方向

- 纯本地多端点对点加密同步仍是[探索切片](p2p-local-sync-exploration.md)，局域网发现与 Changeset 尚未接入产品；
- Web 工作台与移动壳复用同一数据层（[ADR-015](../reference/adr/ADR-015-vue-full-stack.md)）；
- 插件与本地优先能力进入后，本管道增加新的投递目标（[ADR-009](../reference/adr/ADR-009-electron-plugin-sandbox.md)、[ADR-010](../reference/adr/ADR-010-dsh-pi-adapters.md)）。
