# @aervox/host-agent

进程内 Agent Loop 宿主：轮询、领取、背压与排空，含 SQLite 执行存储适配。

- 只编排执行，不持有业务事实；业务状态在 `@aervox/repositories`。
- 独立应用的部署接缝见 [ADR-021](../../docs/reference/adr/ADR-021-aervox-core-standalone-package.md)。

仓库级约定见[贡献指南](../../CONTRIBUTING.md)，包间依赖方向由 `pnpm check:guards` 的架构守卫约束。
