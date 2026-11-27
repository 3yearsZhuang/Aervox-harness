# @aervox/observability

结构化日志、指标与审计导出接口。

- 接口优先：具体后端（OpenTelemetry/Pino/Grafana/Sentry）为目标选型，尚未全部接入。
- 日志默认不含完整用户内容，字段与脱敏规则见 [运行手册](../../docs/reference/operations.md)。

仓库级约定见[贡献指南](../../CONTRIBUTING.md)，包间依赖方向由 `pnpm check:guards` 的架构守卫约束。
