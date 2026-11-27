# @aervox/host-plugin-api

第一方插件与宿主之间的唯一装配契约：回合切面、工具与 HTTP 端点的窄端口。

- 只含类型与接口，零运行时依赖——插件不得从这里拿到数据库或模型客户端。
- 宿主实现在 `apps/api` 的组合根，插件只在启用时装配贡献。
- 契约内容见 [AVX-PLUG-001](../../docs/reference/plugin-config-and-pages.md)。

仓库级约定见[贡献指南](../../CONTRIBUTING.md)，包间依赖方向由 `pnpm check:guards` 的架构守卫约束。
