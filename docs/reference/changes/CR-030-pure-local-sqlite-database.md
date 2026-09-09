# CR-030 确立 SQLite 为永久纯本地真源，废弃 PostgreSQL 支持并移除多租户结构

- 提出人：3yearszhuang · 2026-09-10
- 修改人：linge · 2026-09-10

> 文档编号：CR-030
> 类型：Reference
> 版本：v0.1
> 更新日期：2026-09-10
> 状态：Approved
> 关联：[需求追踪基线](../REQUIREMENTS_TRACEABILITY.md)、[ADR-003 仓储抽象架构](../adr/ADR-003-postgres-retrieval.md)、[CR-003 采用 SQLite 真源](../changes/CR-003-sqlite-primary-pg-compat.md)、[数据库设计与契约](../DATABASE.md)、[架构总览](../ARCHITECTURE.md)

- 决策状态：Accepted
- 提出人 / 日期：3yearszhuang / 2026-09-10
- 目标版本：当前开发阶段（架构精简与本地化收敛）
- 变更原因与证据：
  1. Aervox 核心定位明确为「桌宠 + 视觉小说 + 工作台」双形态的纯本地、个人专属主动智能 Agent，属于 100% 客户端 / 本地优先单机软件；
  2. 原规划中的 PostgreSQL 生产真源（CR-003 / ADR-003 / 云端多租户 RLS / users / workspaces 注册体系）从未在生产中接入，其保留的抽象造成代码库膨胀（多租户复合索引、冗余租户首参、应用层 RLS 模拟）；
  3. 通过彻底移除 PostgreSQL 双引擎切换规划，消除所有业务表上的 `workspace_id` 与 `subject_user_id` 列，将持久层彻底精简为单用户本地 SQLite (LibSQL) 架构。
- 关联能力与需求：`CAP-027`、`ADR-003`、`ADR-014`、`ADR-016`、`CR-003`、`NFR-SCALE-001`、`NFR-SEC-001`
- 当前行为 / 目标行为：
  - 当前行为：所有表携带 `(workspace_id, subject_user_id)` 复合租户列，仓储层所有方法强制传入 `tenant: TenantContext` 并注入复合过滤，文档维持 SQLite / PostgreSQL 双引擎切换计划；
  - 目标行为：
    1. 废弃 PostgreSQL 支持与未来切换计划，明确 SQLite (LibSQL) WAL 模式为唯一、永久的数据真源；
    2. 从所有 Drizzle Schema 表定义、DDL `init.ts` 与 FTS 虚表中剔除 `workspace_id` 与 `subject_user_id` 列及租户索引；
    3. 仓储层所有接口与方法签名彻底移除 `tenant: TenantContext` 首参，SQL 查询移除租户条件；
    4. 持久层重构合并为单一精简包 `@aervox/database`，API 与工作线程以本地单机单用户形态运行。
- 范围外：云端多用户 SaaS 部署、跨用户组织协作（本项目非多租户企业级系统，纯单机本地优先）。
- UX/API/数据/AI/安全/隐私影响：
  - 数据：SQLite 表结构瘦身，复合唯一键降为业务键唯一（如 `turns.idempotency_key`，`diaries.local_date`）；
  - API：不再强制要求客户端传入 `x-workspace-id` / `x-user-id` 头，`resolveTenant` 回退为静态本地单机默认；
  - 安全与隐私：数据完全物理驻留于用户本地 SQLite 文件中（`<repo>/data/aervox.db` 与 Local Vault），消除伪多租户越权攻击面。
- 迁移与向后兼容：
  - 仓储层直接暴露无租户接口；
  - 既有单元测试中测试「跨租户隔离不可见」的用例下线或调整为单用户数据读写断言。
- 决策：Accepted
- 更新的文档和测试：`docs/reference/DATABASE.md`、`docs/reference/ARCHITECTURE.md`、`docs/reference/adr/ADR-003-postgres-retrieval.md`、`docs/reference/changes/CR-003-sqlite-primary-pg-compat.md`、`docs/DOC_REGISTRY.md`、`docs/README.md`、`AGENTS.md`、`docs/reference/REQUIREMENTS_TRACEABILITY.md`。
