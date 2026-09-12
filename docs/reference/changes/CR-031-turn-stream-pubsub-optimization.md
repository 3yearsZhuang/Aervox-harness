---
id: CR-031
type: reference
scope: change
owner: maintainers
doc_status: review-candidate
decision_status: accepted
delivery_status: implemented
version: 0.1.0
updated_at: 2026-09-13
reviewed_at: 2026-09-13
review_interval_days: 90
---

# CR-031 Turn 实时流式推送 Pub/Sub 与轮询解耦

- 提出人：3yearszhuang · 2026-09-12
- 修改人：3yearszhuang · 2026-09-13

关联：[需求追踪基线](../REQUIREMENTS_TRACEABILITY.md)、[ADR-012 流式执行安全性与恢复](../adr/ADR-012-streaming-safety-persistence.md)、[CR-027 供应商流格式调研与设计](../changes/CR-027-turn-stream-liveness.md)

- 状态：Implemented（待发布评审）
- 提出人 / 日期：3yearszhuang / 2026-09-12
- 目标版本：当前开发阶段（核心流式链路性能优化与解耦）
- 变更原因与证据：此前 `GET /v1/turns/:turnId/events` SSE 端点在全量重放存量事件后，采用 `setInterval(400ms)` 对 SQLite WAL 持续轮询拉取增量事件（`getStreamEvents`）并检测 Attempt 终态（`listTurnAttempts`）。高并发或多连接场景下，不仅造成高达 400ms 的推流感知延迟，同时引发无谓的数据库读争用与 CPU 周期浪费。本 CR 引入进程内轻量 Pub/Sub 总线（`TurnStreamHub`），将「写库同时内存直推」与「存量历史重放 + 增量监听」无缝结合，彻底消除 400ms 数据库空轮询。
- 关联能力与需求：`CAP-001`、`CAP-002`、`NFR-PERF-001`、`ADR-012`
- 当前行为 / 目标行为：
  - 当前：SSE 活流依赖 400ms 定时轮询 SQLite，推流存在 200~400ms 感知抖动与延迟；
  - 目标：
    1. 在 `apps/api/src/modules/conversation/` 建立进程内 `TurnStreamHub` 事件总线；
    2. 执行器（`SqliteExecutionStore` 的代理包装）与协调器（`UserQuestionCoordinator`、插件切面）在写入 SQLite 的同时向总线发布事件，实现 `<10ms` 实时直推；
    3. SSE 连接生命周期升级：建立时先读取 SQLite 存量事件重放，随后挂载总线实时订阅；终态通知触发时完成缝隙排空并优雅关闭连接；
    4. 降频心跳：仅保留 15 秒一次的纯 SSE ping 保持长连接探活，不触发任何数据库读操作。
- 范围外：跨多进程的分布式 Redis/MQ 总线（Aervox 为本地单机架构，进程内 EventEmitter 即为最优解）。
- UX/API/数据/AI/安全/隐私影响：
  - API：SSE 接口契约保持 100% 向后兼容；
  - 数据：事件依然先落盘 SQLite（ACID 保证不变），总线仅作异步直推，不改变数据持久化与一致性；
  - 安全：总线监听严格按 `turnId` 通道隔离，连接关闭或终态时即时注销（`off`），无跨会话泄漏风险。
- 迁移与向后兼容：对前端及其他 API 客户端完全透明，零契约改动。
- 测试、埋点和验收影响：`apps/api/test/conversation-stream-pubsub.test.ts`（3 项集成测试，验证通道隔离、存量重放+直推衔接与终态关闭）。
- 决策：Implemented
- 更新的文档和测试：`docs/DOC_REGISTRY.md`、`docs/README.md`、`docs/reference/REQUIREMENTS_TRACEABILITY.md`（§4.2 落地登记）
