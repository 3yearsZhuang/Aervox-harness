# ADR-003 仓储抽象架构：SQLite 业务真源与 FTS5/Vector Port

- 提出人：3yearszhuang · 2026-08-26
- 修改人：linge · 2026-09-10

- 状态：Superseded by CR-030
- 日期：2026-08-24
- 关联：`CAP-005/015/026/027`、`DATA-MEM-001`、`NFR-SCALE-001`、`ADR-008`、`CR-030`

> 更新日期：2026-09-10

## Context

系统需要强事务、来源外键、记忆树递归查询、全文检索和向量召回。项目定位为 100% 纯本地、单用户桌面与本地运行时，不再保留云端多租户与 PostgreSQL 切换路径。

## Decision drivers

- 业务数据、来源链和删除传播需要强事务；
- 记忆树需要层级递归查询（`WITH RECURSIVE`），全文与向量检索必须作为可重建的派生索引；
- 避免外部数据库依赖，保障纯本地零依赖运行；
- 彻底移除多租户与云端 PG 抽象，简化数据模型与仓储层接口。

## Considered options

1. **SQLite (WAL 模式) 纯本地单机库**：单机零外部依赖、秒级测试、内置 FTS5 与 `WITH RECURSIVE`，派生向量通过 Port 解耦（选定 · CR-030）。
2. **PostgreSQL 17+ 强绑定**：增加单机/桌面端复杂度，已废弃。
3. **双真源同步**：维护成本过高，已废弃。

## Decision

**终态决策（CR-030）**：以 **SQLite (LibSQL) + Drizzle ORM** 作为唯一、永久的本地业务真源；废弃 PostgreSQL 切换规划，同时从表结构、DDL 与仓储接口中彻底剥离多租户（`workspace_id` / `subject_user_id`）概念。

具体实现要点：

1. **纯单用户本地数据**：去除租户隔离列与 `TenantContext` 约束，数据物理归属于本地 SQLite 文件（`<repo>/data/aervox.db` 与 Local Vault）。
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

## 验收差距复核（2026-08-31）

- **已满足**：SQLite 真源稳定运行，PG 兼容边界由 `CR-003`（Accepted）规划约束。
- **未满足**：PG 双引擎未实现；`TC-SEC-TENANT-001`/PG 侧 `TC-PRIV-DEL-001` 等自动化与 Litestream 灾备演练未执行。
- **推进路径**：PG 切换工程立项时按本清单验收。
