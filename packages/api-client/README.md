# @aervox/api-client

桌面端、Web 与移动 Web 共用的 API 传输层与 Vue composable。

- 传输实现（含 SSE 帧解析）是唯一真源，消费端不得自建流式解析。
- 所有 DTO 类型从 `@aervox/contracts` 导入，不在本包重复声明。

仓库级约定见[贡献指南](../../CONTRIBUTING.md)，包间依赖方向由 `pnpm check:guards` 的架构守卫约束。
