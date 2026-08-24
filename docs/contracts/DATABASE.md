# Aervox｜思隅 数据库契约（DB）

> 文档编号：AVX-DB-001  
> 版本：v0.1（评审候选）  
> 更新日期：2026-08-24  
> 状态：Review Candidate  
> 关联：`ADR-003`、`ADR-004`、`ADR-007`、`ADR-011`、`ADR-012`、`ADR-013`、`AVX-SPC-001`、`AVX-DATA-001`、`NFR-SEC-001`

本文是 `@aervox/database`（SQLite 业务真源）的可执行契约。产品数据模型事实源是 [PRD §8 数据模型](../PRD.md#8-数据模型)，本文件规定仓储抽象、表结构、租户隔离、事务/Outbox、检索、删除传播与迁移的实现级规则。实现必须从同一份 `packages/database/src/schema` 生成 DDL 与仓储类型，不能只依赖本文件中的示例；任何绕过仓储直接写表或执行裸 SQL 的代码都违反本契约。

## 1. 适用范围与不变量

- 当前开发阶段（MVP 前，本地开发 / 集成测试优先）以 **SQLite（LibSQL）+ Drizzle ORM** 为业务真源；完成全部设计目标后再评估启用 PostgreSQL，兼容边界见 [ADR-003](../architecture/adr/ADR-003-postgres-retrieval.md) 与 [CR-003](../changes/CR-003-sqlite-primary-pg-compat.md)。
- 所有业务数据访问必须通过 `@aervox/database` 的仓储（Repository）/Port 接口。**禁止跨模块直接写表、禁止在业务代码中执行未经仓储封装的裸 SQL**（[ARCHITECTURE.md](../ARCHITECTURE.md) Database 行）。
- 每张业务表都必须携带 `(workspaceId, subjectUserId)` 租户列，且每次读写强制注入 `TenantContext`（见 §4）。
- 用户可见结果的事实源是持久化行（`TurnStreamEvent`、`MessageVersion`、`MemoryRecord` 等），不是内存缓冲、Redis 或客户端缓存（对齐 `AVX-SPC-001`）。
- 派生索引（FTS5 全文、向量）可以随意清空或离线重建，**永远不能成为业务事实真源**。
- 删除传播、同意撤销和撤权后的零召回是硬性约束；来源删除后只保留最少 tombstone，不保留已删正文（对齐 `AVX-DATA-001`）。

## 2. 连接与运行时配置

`@aervox/database` 通过 `createDatabase(config)` 建立连接，默认 `url = DATABASE_URL ?? "file:aervox.db"`。对 `file:` 或非 `http(s)://` 的本地模式必须执行以下 PRAGMA：

| PRAGMA | 值 | 作用 |
|---|---|---|
| `foreign_keys` | `ON` | 强制外键约束（引用完整性） |
| `busy_timeout` | `5000`（可配置） | 写锁等待，避免立即 SQLITE_BUSY |
| `journal_mode` | `WAL` | 读写并发与崩溃恢复 |
| `synchronous` | `NORMAL` | 平衡持久性与性能 |

- 测试必须使用 `createInMemoryDatabase()`（临时文件数据库，随 `cleanup()` 删除 `-wal/-shm`），不得污染真实数据文件。
- 连接 `authToken` 只用于远程 LibSQL/Turso；本地 `file:` 模式不得要求凭据。
- 任何新的持久化包接入数据库时，都必须复用本客户端与 PRAGMA 配置，不得各自建立连接。

## 3. Schema 与命名约定

### 3.1 表清单（当前实现）

业务表（Drizzle schema 为迁移源，`initDatabaseSchema` 负责幂等建表）：

| 表 | 用途 | 依据 |
|---|---|---|
| `sessions` | 会话身份（`id` 全局唯一主键） | PRD §8 `Session` |
| `turns` | 一次对话请求的持久化身份（幂等键） | PRD §8 `Turn` / `AVX-SPC-001` |
| `message_versions` | 消息可编辑/审计版本（`role/version/content`） | PRD §8 `MessageVersion` |
| `turn_stream_events` | 流事件（传输/恢复数据，非长期会话副本） | PRD §8 `TurnStreamEvent` / `AVX-SPC-001` |
| `memory_records` | 四段记忆记录（ephemeral/short_term/long_term/system） | PRD §8 `MemoryRecord` / ADR-007 |
| `memory_edges` | 记忆关系有向边（parent_child/cross_topic/causal/contrast） | PRD §8 `MemoryEdge` |
| `memory_projection_overrides` | 用户对记忆树投影的覆盖（rename/reparent/lock） | PRD §8 `MemoryProjectionOverride` |
| `diaries` | 用户可见日记身份（`local_date` 日期标签） | PRD §8 `Diary` / ADR-011 |
| `diary_cycles` | 不可变滚动窗口（`fencing_token` CAS） | PRD §8 `DiaryCycle` / ADR-011 |
| `diary_schedule_revisions` | 计划不可变修订（`revision` 版本） | PRD §8 `DiaryScheduleRevision` |
| `diary_run_attempts` | Worker 执行尝试（lease 过期） | PRD §8 `DiaryRunAttempt` / ADR-011 |
| `outbox_events` | 事务 Outbox（`pending→published/failed`） | PRD §8 `OutboxEvent` / ADR-004 |
| `messages_fts` / `memories_fts` | FTS5 派生全文虚表（可重建） | ADR-003 |

### 3.2 命名规则

- 表名与列名使用 `snake_case`；Drizzle 字段名使用 `camelCase` 并显式映射列名。
- 主键 `id TEXT PRIMARY KEY`，建议业务前缀（`ses_`/`turn_`/`msg_`/`mem_`/`dia_`/`outbox_`/`tev_`），保证跨域可读。
- 时间一律 `TEXT` ISO8601 UTC 字符串，列名以 `_at` 结尾（`created_at`/`updated_at`/`occurred_at`…）。
- 布尔一律 `INTEGER` 0/1（如 `is_deleted`/`is_redacted`/`auto_generated`），不使用原生布尔列。
- JSON 载荷用 `text(mode: "json")`（如 `error`、`payload`），不得以多列拼装可变结构。
- 每张业务表通过 `tenantColumns`（`workspace_id`/`subject_user_id`）与 `timestampColumns`（`created_at`/`updated_at`）复用公共列定义（[common.ts](../../packages/database/src/schema/common.ts)）。

### 3.3 外键与唯一约束

- 外键一律带 `ON DELETE CASCADE`：`turns.session_id → sessions.id`、`message_versions.turn_id → turns.id`、`turn_stream_events.turn_id → turns.id`、`memory_edges.* → memory_records.id`、`memory_projection_overrides.memory_record_id → memory_records.id`、`diary_run_attempts.cycle_id → diary_cycles.id`。
- 唯一约束（同一 `(workspaceId, subjectUserId)` 租户内有效）：
  - `turns(workspace_id, subject_user_id, idempotency_key)` —— 幂等键；
  - `message_versions(turn_id, version)` —— 版本号唯一；
  - `turn_stream_events(turn_id, sequence)` —— sequence 单调唯一；
  - `diaries(workspace_id, subject_user_id, local_date) WHERE auto_generated = 1` —— 每日期标签至多一份自动日记；
  - `diary_schedule_revisions(workspace_id, subject_user_id, revision)`；
  - `outbox_events(workspace_id, subject_user_id, idempotency_key)`。
- 新增表必须声明租户索引（以 `workspace_id, subject_user_id` 开头），并明确外键级联语义。

## 4. 租户隔离

- 所有仓储方法**强制**要求 `TenantContext`（`workspaceId` + `subjectUserId`，可带 `actorId`），并先调用 `assertTenantContext` 校验非空合法（[tenant.ts](../../packages/database/src/tenant.ts)）。
- 每次 `SELECT/UPDATE/DELETE` 都必须在 where 条件中注入 `(workspace_id, subject_user_id)`；`INSERT` 必须携带租户列。**不得存在不带租户过滤的跨租户读取路径**。
- 跨租户访问通过 `assertEntityBelongsToTenant` 显式拒绝；返回给调用方的"不存在"不得泄露其他租户资源是否存在（对齐 `AVX-SPC-001` 错误语义）。
- 多租户隔离是仓储层应用约束 + 唯一索引兜底，不依赖数据库 RLS（SQLite 无原生 RLS）；因此必须严格防范绕过仓储的裸 SQL。
- 说明：`sessions.id` 为全局唯一主键，多租户调用方应自行提供租户限定的 `sessionId`（见 `getOrCreateSession` 注释）。

## 5. 仓储与事务边界

- 仓储接口（`IConversationRepository`、`IMemoryRepository`、`IDiaryRepository`、`IOutboxRepository`、`IVectorSearchPort`）是上层唯一数据访问面；SQLite 实现位于 `repositories/sqlite/*`，未来 PG 适配器替换同接口（ADR-003）。
- 多表写必须落在单个 `db.transaction` 内。典型契约：`createTurnWithOutbox` 在同一事务写入 `Turn` + 用户 `MessageVersion` + `OutboxEvent`，再返回成功；任一失败整体回滚（对齐 `AVX-SPC-001` §2.1）。
- 创建 Turn 前必须确保 `Session` 存在：使用 `getOrCreateSession(tenant, sessionId, title?)`（不存在则创建），否则 `turns.session_id` 外键违约（`foreign_keys=ON`）。
- 幂等：`getTurnByIdempotencyKey` 在事务外先查；命中则直接返回原资源，不得再次调用模型；同一幂等作用域/键/摘要必须返回同一 Turn。
- 取消/状态变更使用 compare-and-set（`updateTurnStatus` 带状态与 `lastSequence`）；旧 Worker 不得晚提交（fencing/lease 语义见 ADR-011/013）。
- `MessageVersion` 采用不可变追加：编辑生成新版本，不物理覆盖旧版本；`turn_stream_events` 只追加、不改写。

## 6. Outbox 与幂等

- `outbox_events` 与业务变更同事务提交，`status` 由 `pending → published | failed`，`retry_count`/`last_error` 记录重试状态（ADR-004）。
- 消费端必须以事件 `idempotency_key` 幂等去重；同 `(workspaceId, subjectUserId, idempotencyKey)` 全局唯一，重复投递不得产生重复副作用。
- 事件载荷（`payload`）只含引用与必要字段，不复制完整敏感正文；涉及删除/撤权的控制事件关联 `RecoveryControlLedger`（ADR-013）。
- 当前实现仅提供仓储写入与 `fetchPendingEvents/markPublished/markFailed`，**Dispatcher 尚未接线**；接入时不得绕过本契约另建消费表。

## 7. 全文与向量检索

- 全文检索使用 SQLite **FTS5** 虚表（`unicode61`），由 `initFtsTables` 创建，`indexMessageFts/deleteMessageFts` 同步维护（[fts.ts](../../packages/database/src/search/fts.ts)）。
- FTS 虚表是**派生索引**：内容来源删除后必须立即删除对应索引（删除即零召回，`TC-PRIV-DEL-001`）；可清空重建而不影响业务表。
- 向量检索通过 `IVectorSearchPort` 解耦（[vector-port.ts](../../packages/database/src/search/vector-port.ts)）；当前提供内存适配器 `InMemoryVectorSearchAdapter`，记录 embedding 模型/维度/版本，离线重建不破坏关系数据。
- 任何检索路径都必须带租户过滤；禁止跨租户召回。

## 8. 删除、保留与安全

- 删除传播：来源/会话删除通过外键级联 + 明确传播清单逐下游清理；已删来源保持 deny（ADR-013 恢复账本、`AVX-DATA-001`）。
- 来源删除、同意撤销或权限变化后，正文不得再被召回/重放；已持久化事件不可改写，只允许追加 `redacted` 状态（对齐 `AVX-SPC-001` §4.5）。
- 在线事件正文保留窗口默认 24 小时，且不得超过 `MessageVersion` 可见保留、有效同意与来源可用期三者中最短者；窗口结束后仅保留不含正文的元数据/tombstone（`AVX-SPC-001` §5）。
- 脱敏：`message_versions.is_redacted` 标记替代正文；不得把 Restricted 原文写入普通日志或分析明细。

## 9. 迁移与 PostgreSQL 兼容

- **迁移源是 Drizzle schema**：表结构变更先改 `packages/database/src/schema/*`，再 `drizzle-kit generate` / `migrate`；禁止直接手工改生产 DDL 而不同步 schema。
- 迁移采用 **expand/contract**：先加列/表（向后兼容），确认无读路径依赖旧结构后再删（对齐 PRD §8 版本策略）。
- 启用 PostgreSQL 前（ADR-003/CR-003）必须补齐：PG 驱动适配器（Drizzle 多方言）、RLS 与 `WITH RECURSIVE` 等价实现、pgvector 适配、CI/本地可复现的 PG 测试环境；切换不改变上层业务逻辑，提供双读校验与可回退开关。
- 仓储接口与 `TenantContext` 语义在切换时保持不变；切换属重大架构变更，必须先走 `CR-*`。

## 10. 测试与门禁

进入 `Ready` 前至少具备以下集成测试（`packages/database/test/`，vitest）：

| 测试 | 覆盖 | 状态 |
|---|---|---|
| `tenant-isolation.test.ts` | `TC-SEC-TENANT-001` 多租户隔离 + 非法租户拒绝 | 已实现 |
| `deletion-zero-recall.test.ts` | `TC-PRIV-DEL-001` 来源删除后零召回 | 已实现 |
| `memory-tree-recursive.test.ts` | 记忆树递归 CTE 投影 | 已实现 |
| `diary-cas.test.ts` | 日记周期 CAS 乐观锁与并发 lease | 已实现 |
| `outbox-transaction.test.ts` | 事务 Outbox 原子性与状态机 | 已实现 |
| `session-upsert.test.ts` | `TC-CONV-SESSION-001` 会话 upsert 与外键依赖 | 已实现 |

- 本地/CI 必须可重复运行 `pnpm test`（无需 Docker/外部服务）。
- CI 当前仅执行 build/typecheck；将数据库测试纳入 CI 门禁为待办，纳入前不得把"已跑测试"当作 CI 通过证据。

## 11. 兼容与变更

- 新增表/列必须向后兼容并走 `CR-*` + 迁移；删除或改变列语义必须更新本文件、`PRD §8`（如涉及）与变更请求。
- 派生索引（FTS5/向量）可重建，不视为业务兼容面。
- 替换 SQLite 驱动、Drizzle 版本或检索实现不得改变表结构与仓储接口语义。
- 修改本文件必须先登记 [DOC_REGISTRY](../DOC_REGISTRY.md)（AVX-DB-001）并同步文档索引。
