# @aervox/process-coordination

API 与 Worker 之间的跨进程协调：Domain Socket IPC、唤醒合并与写入压力信号。

- 只承载协调信号，不承载业务事实；业务状态仍在主库与 Outbox。
- IPC 不可用时调用方必须回退为轮询，不能因此丢失任务。

仓库级约定见[贡献指南](../../CONTRIBUTING.md)，包间依赖方向由 `pnpm check:guards` 的架构守卫约束。
