---
id: ADR-003
type: reference
scope: decision
owner: maintainers
doc_status: review-candidate
decision_status: accepted
version: 0.2.0
updated_at: 2026-09-10
reviewed_at: 2026-09-10
review_interval_days: 90
---

# ADR-003 仓储抽象架构：SQLite 业务真源与 FTS5/Vector Port

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-09-11

- 状态：Accepted（经 [CR-030](../changes/CR-030-pure-local-sqlite-database.md) 修订）
- 日期：2026-08-24
- 关联：`CAP-005/015/026/027`、`DATA-MEM-001`、`NFR-SCALE-001`、`ADR-008`、`CR-030`

## Context

系统需要强事务、来源外键、记忆树递归查询、全文检索和向量召回。Aervox 已确定为本地单用户产品，数据持久层仍需要清晰的 Schema 与 Repository / Port 分层，但不再承担多租户模拟或 PostgreSQL 兼容。

## Decision drivers

- 业务数据、来源链和删除传播需要强事务与可恢复迁移；
- 记忆树需要层级递归查询（`WITH RECURSIVE`），全文与向量检索必须作为可重建的派生索引；
- 避免外部数据库基础设施阻塞桌面部署、本地开发与 CI；
- 保持 `@aervox/schema` 与 `@aervox/repositories` 边界，使业务调用方不直接依赖 DDL 和裸 SQL。

## Considered options

1. **SQLite WAL + Schema/Repository 分层 + FTS5/Vector Port**：单机零外部依赖、内置 FTS5 与递归 CTE，派生向量可重建（选定）。
2. **SQLite 单体数据库包**：减少包数量，但会撤销 W-19 已验证的边界并重新形成巨型文件，拒绝。
3. **PostgreSQL 或双真源**：引入本地产品不需要的部署、身份、RLS、同步与密钥复杂度，终止规划。

## Decision

**终态决策**：以 SQLite（LibSQL）+ Drizzle ORM 作为永久本地业务真源，保留 `@aervox/schema` + `@aervox/repositories` 双包分层；经 [CR-030](../changes/CR-030-pure-local-sqlite-database.md) 移除租户列、`TenantContext` 和 PostgreSQL 演进目标。

具体实现要点：

1. **单用户边界**：数据库归属当前操作系统用户；本机 API 默认 loopback，文件权限、应用认证和插件授权承担访问控制。
2. **递归查询**：利用 SQLite 3.8.3+ 原生 `WITH RECURSIVE` CTE 投影系统记忆树。
3. **全文与向量检索**：内置 SQLite FTS5 虚表处理全文检索；向量检索通过 `VectorSearchPort` 解耦，派生索引可随意清空或离线重建。
4. **灾备与恢复**：使用一致性本地备份、可读导出和恢复演练；删除与撤权事实源由独立的 `RecoveryControlLedger` 保障。

## Positive consequences

- 极简部署与毫秒级 In-Memory 单元/集成测试，无需 Docker 依赖；
- 业务表与派生索引生命周期清晰，向量索引重建不破坏关系数据；
- Schema、仓储实现和业务调用方边界清晰，迁移器可以复用最终 DDL 构建 staging 库。

## Negative consequences and risks

- SQLite 默认单写多读，高频超大规模并发写入需依赖应用内连接排队或 WAL 参数调优；
- 单份数据库不能安全服务多个不互信操作系统用户；非 loopback API 暴露必须强制认证并显式启用；
- 去租户化是一次破坏性 Schema 迁移，必须执行 CR-030 的备份、范围选择、staging 和原子换库协议。

## Migration / rollback

仓储层继续只向业务模块暴露领域 Repository 与 `VectorSearchPort`。去租户化不采用原地逐表 `DROP COLUMN`：迁移器从已验证备份和用户选择的数据范围构建新库，校验后原子换库。详细状态机、回滚和保留期限以 CR-030 为准。

## Verification evidence

实现 CR-030 前至少提供：

- 默认 loopback 与非 loopback 强制认证测试；
- 单范围、多范围、冲突和故障注入迁移测试；
- 来源删除后 FTS5 与向量零召回测试（`TC-PRIV-DEL-001`）；
- 记忆树递归 CTE 投影测试；
- 日记周期 CAS 乐观锁与并发 lease 测试；
- 一致性备份、原子换库与回滚恢复演练。

## 验收差距复核（2026-08-31）

- **已满足**：SQLite 真源、Schema/Repository 双包和 Repository Port 已稳定运行。
- **已终止**：PostgreSQL 双引擎、组织级 RLS 和长期租户兼容目标由 CR-030 取消。
- **待完成**：CR-030 D1～D3 的安全迁移、去租户化和回滚演练。
