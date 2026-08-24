# ADR-003 仓储抽象架构：SQLite 业务真源与 FTS5/Vector Port

- 状态：Proposed（待技术负责人批准）
- 日期：2026-08-24
- Owner：待指定
- 关联：`CAP-005/015/026/027`、`DATA-MEM-001`、`NFR-SCALE-001`、`ADR-008`

## Context

系统需要强事务、租户隔离、来源外键、记忆树递归查询、全文检索和向量召回。为了兼顾本地极简部署、测试效率与未来多引擎扩展能力，数据持久层需要具备清晰的仓储抽象（Repository / Port 模式）。

## Decision drivers

- 业务数据、来源链和删除传播需要强事务与多租户隔离保障；
- 记忆树需要层级递归查询（`WITH RECURSIVE`），全文与向量检索必须作为可重建的派生索引；
- 避免重型外部数据库基础设施（如外置 PG / Docker / Testcontainers）阻塞本地开发与 CI 流程；
- 保持仓储接口解耦，使 SQLite 与未来云端分布式引擎共享统一领域契约。

## Considered options

1. **SQLite (WAL 模式) + Repository Port + FTS5/Vector Port**：单机零外部依赖、秒级测试、内置 FTS5 与 `WITH RECURSIVE`，派生向量通过 Port 解耦（选定）。
2. **PostgreSQL 17+ 强绑定**：提供原生 RLS 和 pgvector，但本地部署和 CI 依赖外部 Docker 实例，增加单机/桌面端接入复杂度。
3. **双真源同步**：同时在端侧和云端维护两套事实库，冲突处理与密钥管理成本过高。

## Decision

**阶段化决策**：当前开发阶段（MVP 前，本地开发 / 集成测试优先）以 **SQLite (LibSQL) + Drizzle ORM** 作为业务真源与 `@aervox/database` 实现；待完成全部设计目标（多端/云端同步、组织级权限与 RLS、合规边界、大规模检索）后再评估启用 PostgreSQL。切换依赖仓储 Port 与 Drizzle 多方言，不改变上层业务逻辑（见 [CR-003](../../changes/CR-003-sqlite-primary-pg-compat.md)）。

具体实现要点：

1. **多租户隔离**：通过 `TenantContext` 在仓储层强制注入 `(workspaceId, subjectUserId)` 过滤，结合底层 SQLite 复合外键与唯一索引作为安全兜底。
2. **递归查询**：利用 SQLite 3.8.3+ 原生 `WITH RECURSIVE` CTE 投影系统记忆树。
3. **全文与向量检索**：内置 SQLite FTS5 虚表处理全文检索；向量检索通过 `VectorSearchPort` 解耦，派生索引可随意清空或离线重建。
4. **灾备与恢复**：单机通过 Litestream 实现 SQLite WAL 秒级流式备份与 PITR；删除与撤权事实源由独立的 `RecoveryControlLedger` 保障。

## Positive consequences

- 极简部署与毫秒级 In-Memory 单元/集成测试，无需 Docker 依赖；
- 业务表与派生索引生命周期清晰，向量索引重建不破坏关系数据；
- 接口抽象规范，未来云端按需接入 PostgreSQL 仅需新增适配器。

## Negative consequences and risks

- SQLite 默认单写多读，高频超大规模并发写入需依赖应用内连接排队或 WAL 参数调优；
- 多租户隔离依托应用层 `TenantContext` 强校验，需严格防范绕过仓储的裸 SQL 调用。

## Migration / rollback

仓储层对上层应用仅暴露 `IConversationRepository`、`IMemoryRepository`、`IDiaryRepository`、`IVectorSearchPort` 接口，作为未来切换到 PostgreSQL 的兼容边界。启用 PG 前需补齐：PG 驱动适配器（Drizzle 多方言）、RLS 与递归 CTE 等价实现、pgvector 适配，并在 CI/本地提供可复现的 PG 测试环境；切换不改变上层业务逻辑，派生索引可重建、业务真源可迁移，具备双读校验与可回退开关。

## Verification evidence

状态改为 `Accepted` 前至少提供：

- 租户越权防护与隔离测试（`TC-SEC-TENANT-001`）；
- 来源删除后 FTS5 与向量零召回测试（`TC-PRIV-DEL-001`）；
- 记忆树递归 CTE 投影测试；
- 日记周期 CAS 乐观锁与并发 lease 测试；
- Litestream 灾备与备份恢复演练。
