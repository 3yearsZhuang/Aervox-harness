# ADR-003 PostgreSQL + FTS/pgvector

- 状态：Proposed（待技术负责人批准）
- 日期：2026-08-23
- Owner：待指定
- 关联：`CAP-005/015/026/027`、`DATA-MEM-001`、`NFR-SCALE-001`

## Context

系统需要事务、RLS、来源外键、递归树查询、全文和后续向量召回。MVP 流量与检索规模尚未证明需要独立数据库。

## Decision drivers

- 业务数据、来源链和删除传播需要强事务与 RLS 隔离；
- 记忆树需要递归查询，全文/向量检索规模在 MVP 阶段未验证；
- 减少部署与删除传播边界，避免多个数据库成为事实真源；
- 派生索引必须可重建，不能成为业务事实真源。

## Considered options

1. **PostgreSQL + FTS/pgvector**：事务/RLS/来源外键与检索同库，边界简单（选定）。
2. **PostgreSQL + 独立向量库**：大规模向量性能更强，但引入第二存储、同步与删除传播边界。
3. **Neo4j + 关系库**：图查询表达能力更强，但多一层部署和一致性/删除复杂度。
4. **本地 SQLite 首发**：交付简单，但不符合 MVP 云端多端/同步与 RLS 要求。

## Decision

PostgreSQL 17+ 作为业务真源，全文检索优先使用 PostgreSQL，P1 按需启用 pgvector。记忆树使用节点/边表和递归 CTE；Embedding 记录模型、维度和版本。MVP 不引入 Neo4j 或独立向量库。

## Positive consequences

- 减少部署和删除传播边界，事务一致性较强；
- RLS、来源外键与检索在同一数据面，权限强制一致；
- 派生索引可删除/重建而不丢业务数据。

## Negative consequences and risks

- 超大规模向量/图查询可能需要后续拆分；
- 届时派生索引仍不能成为事实真源，需保持重建能力。

## Migration / rollback

建立 `EmbeddingIndex` 和重建任务；可删除/重建所有索引而不丢业务数据。独立检索服务若未来引入，采用双读校验和可回退开关。

## Verification evidence

状态改为 `Accepted` 前至少提供：

- RLS 与递归树查询集成测试（`TC-INTEG-RLS-001`）；
- 来源删除后零召回（`TC-PRIV-DEL-001`）；
- Embedding 重嵌入、索引重建与备份恢复演练；
- 2 倍峰值压测（`TC-PERF-SCALE-001`）。
