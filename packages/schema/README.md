# @aervox/schema

表结构真源：Drizzle 表定义，仅依赖 `drizzle-orm`。

- DDL 初始化依赖 FTS 与搜索模块，因此位于 `@aervox/repositories` 侧，不在此导出。
- 变更表结构必须同步迁移演练与 [数据库契约](../../docs/reference/DATABASE.md)。

仓库级约定见[贡献指南](../../CONTRIBUTING.md)，包间依赖方向由 `pnpm check:guards` 的架构守卫约束。
