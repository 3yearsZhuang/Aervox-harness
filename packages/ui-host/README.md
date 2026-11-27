# @aervox/ui-host

受信根界面表面的加载器与恢复壳。

- 按 `plugins/surfaces/*` 的声明装配表面，加载失败走降级而不是白屏。
- 表面契约见 [ADR-025](../../docs/reference/adr/ADR-025-ui-surface-hosts.md)。

仓库级约定见[贡献指南](../../CONTRIBUTING.md)，包间依赖方向由 `pnpm check:guards` 的架构守卫约束。
