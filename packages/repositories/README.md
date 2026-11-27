# @aervox/repositories

数据访问层：仓储接口、SQLite/PostgreSQL 实现与数据库基础设施。

- 表结构由 `@aervox/schema` 提供；本包只做查询与事务编排，不复制 Schema。
- SQLite 写入走写者连接，禁止嵌套事务与事务内耗时 I/O；规则见 [数据库契约](../../docs/reference/DATABASE.md)。
- 默认数据目录恒为 `<repo>/data`，由 `src/data-directory.ts` 单点决定。

仓库级约定见[贡献指南](../../CONTRIBUTING.md)，包间依赖方向由 `pnpm check:guards` 的架构守卫约束。
