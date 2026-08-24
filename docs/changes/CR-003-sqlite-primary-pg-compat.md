# CR-003 采用 SQLite 作为当前开发阶段业务真源（保留 PostgreSQL 兼容）

- 状态：Accepted（技术负责人与原作者已对齐）
- 提出人 / 日期：KashiwagiEri233 + 技术负责人 / 2026-08-24
- 目标版本：当前开发阶段（MVP 前，本地开发 / 集成测试优先）
- 变更原因与证据：本地开发与集成测试需要零外部依赖、毫秒级 In-Memory 数据库；`@aervox/database` 以 SQLite（LibSQL）+ Drizzle + Repository Port 落地会话/日记/记忆/Outbox 持久化与租户隔离，集成测试已验证。
- 关联能力与需求：`CAP-005/015/026/027`、`DATA-MEM-001`、`NFR-SCALE-001`、`ADR-003`、`ADR-008`、`ADR-012`
- 当前行为 / 目标行为：当前开发以 SQLite 为业务真源，仓储层仅暴露 Repository / Port 接口；完成全部设计目标（多端/云端同步、组织权限与 RLS、合规边界、大规模检索）后评估启用 PostgreSQL，切换仅需新增 PG 驱动适配器。
- 范围外：PostgreSQL 生产启用、RLS/pgvector 生产配置、Litestream 云端灾备落地、用户注册 / 账号体系（注册、登录、凭据、Profile 等字段）——待 PostgreSQL 启用后正式上线。
- UX/API/数据/AI/安全/隐私影响：对外 API / 契约不变；租户隔离由仓储层 `TenantContext` 强制注入；SQLite 文件即本地数据，删除/撤权遵循同一删除传播逻辑。
- 迁移与向后兼容：`sessions/turns/messages/outbox` 等表结构经 Drizzle schema 表达，可映射 PG 方言；派生索引（FTS5/向量）可重建；不改变上层业务逻辑。
- 测试、埋点和验收影响：集成测试覆盖租户隔离、删除零召回、日记 CAS、记忆树递归、Outbox 事务与 session upsert；CI 当前仅执行 build/typecheck，测试纳入 CI 待评估。
- 风险与成本：SQLite 默认单写多读，高频超大规模并发写入需调优；多租户隔离依赖应用层强校验，需防范绕过仓储的裸 SQL 调用。
- 灰度、回滚和用户通知：开发阶段默认 SQLite；启用 PG 前提供双读校验与可回退开关；不执行不可逆数据迁移。
- 决策：技术负责人与原作者一致同意——本地开发期间先用 SQLite 做本地测试验证，保留对 PostgreSQL 的兼容性，后续完成全部设计目标再考虑启用 PG。
- 批准人 / 日期：技术负责人 / 2026-08-24
- 更新的文档和测试：`docs/architecture/adr/ADR-003-postgres-retrieval.md`、`docs/ARCHITECTURE.md`、`docs/DOC_REGISTRY.md`、`@aervox/database`（Repository Port）、`packages/database/test/session-upsert.test.ts`
- 已完成证据：`pnpm install --frozen-lockfile` / `build` / `typecheck` / `test` 通过；集成测试覆盖租户隔离、删除零召回、日记 CAS、记忆树递归、Outbox 事务与 session upsert。
- 发布后结果：待发布
