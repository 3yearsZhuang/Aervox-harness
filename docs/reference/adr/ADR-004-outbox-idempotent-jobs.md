# ADR-004 业务状态 + Outbox + 幂等队列

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-08-31

- 状态：Proposed
- 日期：2026-08-23
- 关联：`NFR-REL-001`、`OPS-QUEUE-001`、`CAP-005/009/013`

> 更新日期：2026-08-31

## Context

记忆、日记、OCR、Embedding、通知和删除任务允许异步，但必须不丢、不重复，并能在 Redis 丢失或 Worker 重启后重建。

## Decision drivers

- 异步任务至少一次投递，业务结果不丢、不重复；
- Redis/BullMQ 是传输层，不能作为业务事实真源；
- Worker 重启或队列丢失后必须可从数据库重建；
- 领域事件与业务状态需要在同一事务提交。

## Considered options

1. **业务状态 + Outbox + 幂等队列**：事务内发事件，消费端幂等（选定）。
2. **全系统 Event Sourcing**：完整事件溯源能力更强，但迁移/删除/查询复杂度高，超出 MVP 需要。
3. **直接投递/纯内存队列**：实现简单，但 Redis 丢失或崩溃时无法可靠重建。

## Decision

业务变更与 `OutboxEvent` 在同一 SQLite 事务提交；Worker 至少一次消费，使用 `ScheduledJob.idempotencyKey`、状态机、重试/退避和 DLQ。Redis/BullMQ 是传输和短暂调度，不是事实源；重建以 Outbox/ScheduledJob 为准。

## Positive consequences

- 业务状态与 Outbox 原子提交，不会丢事件；
- 换队列实现不改变领域事件和业务状态；
- Worker 重启/Redis 丢失后可按水位线重建。

## Negative consequences and risks

- 需要清理已消费 Outbox、监控积压；
- 每个消费者都要编写幂等处理器，防止重复业务结果。

## Migration / rollback

先写 Outbox 再投递，支持旧消费者；新增事件向后兼容。队列故障时暂停消费者、恢复 Redis 后按水位线重放；禁止从消息体覆盖更新事实。

## Verification evidence

状态改为 `Accepted` 前至少提供：

- 事务提交/回滚与 Outbox 原子性测试（`TC-INTEG-JOB-001`）；
- 重复投递、崩溃恢复与 DLQ 重放测试（`TC-RES-QUEUE-001`）；
- Redis 丢失重建与删除任务幂等测试（`TC-PRIV-DEL-001`）。

## 验收差距复核（2026-08-31）

- **已满足**：Outbox/幂等作业已落地（`outbox-worker`、`diary.published` 等；#124 登记）。
- **未满足**：`TC-INTEG-JOB-001`/`TC-RES-QUEUE-001` 自动化缺失（`apps/worker` 无 outbox 专项测试）；Redis 丢失重建与删除任务幂等演练未执行。
- **推进路径**：补 outbox 原子性/重复投递/DLQ 重放专项测试后走 G2 评审。
