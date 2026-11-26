# @aervox/worker — 后台任务进程

异步复习提醒、日记生成、Outbox 派发、删除推进、记忆压缩等需要「没人操作也要继续」的工作由本进程承担。对话本身默认不经过 Worker：普通请求由 API 执行，Worker 是可选的后台补充。

启动方式、端口与数据目录见[从哪开始](../../docs/getting-started.md)。开发时常用：

```sh
./aervox dev worker     # 仅 Worker
./aervox dev            # API + Web + 桌面端 + Worker（后台任务齐全）
```

`dev web` 与 `dev desktop` **不**启动 Worker，到期复习与自动日记不会自行发生。

## 调度模型

每类任务有独立节拍器，互不阻塞（实现见 [src/task-scheduling.ts](src/task-scheduling.ts) 与 [src/index.ts](src/index.ts)）：

- **独立频率**：`WORKER_INTERVAL_<NAME>_MS` 可按任务覆盖；未设置时使用任务默认频率。
- **不重叠**：上一轮未结束则跳过本轮，避免任务自堆积，而不是排队串行。
- **失败隔离**：单任务抛错只记录自身日志，不拖垮其他任务与后续轮次。

当前注册的调度：outbox、delegated-turns、review、diary、deletion、compaction、embedding、attempt-recovery、inbox-expiry、proactive-profile、proactive-intelligence。任务数量会随能力演进变化，以源码注册处为准，不在文档维护镜像清单。

## 数据与边界

- 数据真源是本地 SQLite，写入走写者连接；事务与删除规则见[数据库契约](../../docs/reference/DATABASE.md)。
- 派发、幂等与重试依据 [ADR-004](../../docs/reference/adr/ADR-004-outbox-idempotent-jobs.md)；日记周期与计划修订依据 [ADR-011](../../docs/reference/adr/ADR-011-diary-cycle-schedule-revision.md)。
- Worker 与 API 必须指向同一个库；两处分别启动时确认 `DATABASE_URL` 一致，否则会出现「任务在跑但看不到数据」。

## 开发

```sh
mise exec -- pnpm --filter @aervox/worker test
mise exec -- pnpm --filter @aervox/worker typecheck
```

工作区依赖在仓库根安装，不在本目录单独执行 `pnpm install`。
