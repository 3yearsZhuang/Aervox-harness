# @aervox/config

运行时配置：类型化的环境变量解析、集中默认值与启动校验。

- 每个键的默认值只在本包出现一次；API/Worker 不再直读 `process.env`。
- 非法值在启动时 fail-fast，不静默回退到默认。
- 面向用户的键在 [.env.example](../../.env.example) 有说明；内部开关不进模板。

仓库级约定见[贡献指南](../../CONTRIBUTING.md)，包间依赖方向由 `pnpm check:guards` 的架构守卫约束。
