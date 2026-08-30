# Aervox｜思隅 数据库设计与双引擎契约（DBC）

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-08-31

> 文档编号：AVX-DB-001  
> 类型：Reference  
> 版本：v0.10（CAP-020 MCP 预设服务器接入）
> 更新日期：2026-08-31
> 状态：Review Candidate  
> 关联：`CR-003`、`CR-023`、`ADR-003`、`ADR-004`、`ADR-007`、`ADR-011`、`ADR-012`、`ADR-013`、`AVX-SPC-001`、`AVX-PRD-001`、`NFR-SCALE-001`、`NFR-SEC-001`

本文是持久化层的可执行契约：**数据真源、租户隔离边界、双引擎字段语义同构、派生索引生命周期、迁移 Expand/Contract 三阶段和删除传播不变量**。实现必须从同一份 `packages/database` Drizzle schema 生成双方言 DDL、Repository Port 类型和契约测试，不能只依赖本文件中的示例。

当前开发阶段（MVP 前，本地开发/集成测试优先）以 **SQLite (LibSQL) + WAL 模式** 为业务真源；待完成全部设计目标后评估启用 **PostgreSQL 17+** 为生产真源。切换仅需新增 PG 驱动适配器，不改变上层业务代码（见 [CR-003](changes/CR-003-sqlite-primary-pg-compat.md)）。

> 范围说明：本文档的 ERD（§3/§4/§5）只承载**当前已实现或已建模的 SQLite/PG 表**，是可执行契约；PRD §8 的全生命周期数据模型覆盖清单（含阶段与实现状态）见 [§14](#14-prd-全量数据模型覆盖清单)，未落表的实体属于规划 backlog，不代表已进入实现。

## 文档变更记录

| 版本 | 日期 | 变更摘要 |
|---|---|---|
| v0.1 | 2026-08-24 | 建立数据库设计与双引擎契约：SQLite/PG ERD、迁移映射、兼容性矩阵、迁移计划、测试门禁 |
| v0.2 | 2026-08-24 | 对齐 PRD §8 全量数据模型：新增 §14 覆盖清单，逐实体标注阶段与实现状态，明确未落表规划 backlog |
| v0.3 | 2026-08-24 | MVP（R1）优先队列 22 组实体 + 独立账本全部落表：新增 24 张表与 7 个仓储 Port；§14 状态同步为已落表/已建模，覆盖度 12→35（69%） |
| v0.4 | 2026-08-25 | 统一 API / Worker 共享 SQLite 真源路径 `<repo>/data/aervox.db`：新增 §2.1 路径约定（自动建目录 / DATABASE_URL 覆盖 / WAL 多进程并发） |
| v0.5 | 2026-08-25 | P1（R2）落表 5 张：memory_nodes 投影独立化 + memory_edges/overrides 迁移到节点级 + memory_edge_evidence + memory_algorithms + conversation_branches + knowledge_relations；§14 表格状态同步（48 张业务表已落表，覆盖除 PG 用户域外全部核心实体） |
| v0.6 | 2026-08-25 | P2/P3 扩展落表 5 张：external_sources + plugins/plugin_grants + community_contents + organizations + IExtensionRepository；§14 覆盖 48→53 张业务表，除 PG 用户域外全部落表 |
| v0.7 | 2026-08-25 | 人格插件 SQLite 落表 6 张：personas / persona_revisions / persona_selections / workspace_skills / mcp_tools / persona_turn_contexts（CAP-019/020），补 IPersonaRepository / ISkillRepository / IMcpToolRepository 与 §14 清单 |
| v0.8 | 2026-08-29 | CAP-033 主动智能模式数据面新增授权修订、来源 grant、激活租约、原始捕获、画像声明、动作和本地审计表；补七天提炼清理、local-only 边界和导出/撤权契约 |
| v0.9 | 2026-08-29 | CR-024 新增十二项主动智能派生、Home Assistant 连接/实体和小米健康每日样本共 17 张本地表；补凭据加密、白名单、同步、导出与连接级删除 |
| v0.10 | 2026-08-29 | CAP-020 MCP 预设接入：新增系统级 `mcp_servers` 连接配置表（transport/endpoint/本地 Token 不回显/同步状态）与 `IMcpServerRepository`；同步出的远程工具以 `mcp__<serverId>__<toolName>` 命名落 `tool_registrations`（PET-05 分级），预设首项为麦当劳中国官方 MCP（mcd-mcp，Streamable HTTP） |

---

## 1. 适用范围与不变量

1. **真源唯一**：业务事实源是各领域业务表（sessions/turns/message_versions/memory/diaries/outbox）。FTS 全文索引、向量索引、缓存和事件重放日志都是可重建的派生索引，不得承载不可再生的业务状态。
2. **租户隔离双保险**：所有业务表携带 `(workspace_id, subject_user_id)` 复合租户列；SQLite 阶段由仓储层 `assertTenantContext` 强制注入并配合数据库复合唯一/外键兜底；PostgreSQL 阶段额外启用原生 RLS 策略作为数据库级强制隔离。绕过仓储接口的裸 SQL 调用在任何阶段均属违规。
3. **删除即零召回**：业务删除或撤权必须在同一事务中删除事实源和派生索引（FTS、向量、缓存）；下游 Outbox 事件必须显式带上 redacted/reason 而非依赖异步清理。删除后立即不得通过搜索、推荐、记忆召回再现原文。
4. **外键级联不越过租户边界**：所有外键引用使用 `(tenant_cols + fk_col)` 语义对齐，防止跨租户的孤儿行误删。
5. **Port 接口是唯一消费边界**：应用代码只能依赖 `IConversationRepository`、`IMemoryRepository`、`IDiaryRepository`、`IOutboxRepository` 和 `IVectorSearchPort`。消费者不得引入方言特定类型、直接读/写 FTS 虚表或向量存储。
6. **字段名零重命名、语义零漂移**：SQLite → PostgreSQL 的迁移仅做**类型自然升级**（TEXT→UUID/TIMESTAMPTZ/JSONB/BOOLEAN），不做字段重命名或业务语义改写；新列必须可空或带默认；破坏性变更必须走版本号和 `CR-*`。
7. **SQLite 阶段不启用用户注册**：用户域（workspaces/users/credentials/workspace_members/user_profiles）5 张表仅在 PostgreSQL 阶段创建。SQLite 阶段 `subject_user_id` 视为本地标识字符串，不关联凭证或组织角色。
8. **CAP-033 私密数据隔离**：主动智能模式的授权、来源、捕获、画像、动作、租约和审计表必须显式带 `processing_boundary=local_only`，不写入普通远程同步/分析旁路；原始捕获按七天且完成记忆提炼后才允许清理。
9. **CAP-033 全动作授权溯源**：每个主动动作必须绑定用户确认的 `FullProfileActionGrant`、授权修订、目标 scope、设备租约和 deny 水位；数据库层不得把模型请求或普通 Turn 自动授权当作动作授权。
10. **CAP-034/035 外部连接最小化**：连接凭据与私密设置使用本地 Vault cipher；HA 实体默认禁用并保存 service 白名单；健康只保存规范化每日指标。删除连接必须同时删除凭据和对应实体缓存/健康样本。

---

## 2. 数据库选型总览与阶段策略

| 维度 | SQLite（当前真源 · CR-003） | PostgreSQL（生产真源 · 后续启用） |
|---|---|---|
| 部署形态 | 本地单文件或内存；零外部依赖 | 独立数据库实例 / 托管服务 |
| 方言驱动 | `@libsql/client` + `drizzle-orm/sqlite-core` | `pg` / `postgres.js` + `drizzle-orm/pg-core` |
| 事务 | 单写多读、WAL 模式、保存点 | MVCC、SERIALIZABLE 可选、advisory lock |
| 递归查询 | SQLite 3.8.3+ `WITH RECURSIVE` CTE | 原生 `WITH RECURSIVE`，CTE 语义等价 |
| 全文检索 | FTS5 虚表 `messages_fts` / `memories_fts`（可重建） | 原生 `tsvector + GIN`，trigger 同步 `to_tsvector('zhparser', ...)` |
| 向量检索 | `InMemoryVectorSearchAdapter`（内存 Port，零依赖，可重建） | `pgvector` 扩展 `VECTOR(n)` + HNSW / ivfflat 持久化索引 |
| 租户隔离 | 应用层 `TenantContext` 强注入 + 唯一/外键兜底 | 应用层同等校验 + 数据库原生 `ROW LEVEL SECURITY` 双保险 |
| 用户注册 | 范围外（CR-003 明确不实现） | users / credentials / workspace_members / user_profiles 5 张表上线 |
| 并发控制 | SQLite 级联 write 串行化 + lease/fencing token；Worker 竞争 | `SELECT ... FOR UPDATE SKIP LOCKED` + advisory lock；原生并发 |
| 典型部署位置 | API / Worker / 端侧共享 `<repo>/data/aervox.db`（见 §2.1） | 云端生产实例、多端共享真源 |

> 全量覆盖：上表只描述已落库/已建模表。PRD §8 全生命周期数据模型的逐实体覆盖清单（阶段 × 实现状态）见 [§14](#14-prd-全量数据模型覆盖清单)。

### 2.1 SQLite 共享真源路径约定

- **共享真源文件**：所有进程（API、Worker、未来端侧）默认使用同一文件 `<repo>/data/aervox.db`。路径由 `packages/database/src/client.ts` 的 `createDatabase` 经 `import.meta.url` 定位仓库根后计算，源码与编译产物（`dist`）均解析到同一位置，避免各包各自落库导致数据不互通。
- **自动建目录**：`createDatabase` 在 `createClient`（libsql 构造时即打开文件）之前自动 `fs.mkdirSync(data/, { recursive: true })`，首次启动无需手工创建。
- **覆盖优先级**：`config.url` > `DATABASE_URL` 环境变量 > 默认共享路径。临时隔离/测试仍可显式传 `url` 或设 `DATABASE_URL`。
- **多进程并发**：SQLite WAL 模式（`PRAGMA journal_mode=WAL; synchronous=NORMAL; busy_timeout`）支持 API / Worker 多进程同时读写同一文件；写事务由 SQLite 串行化 + 仓储层 lease/fencing（§9）兜底。
- **初始化幂等**：`initDatabaseSchema` 使用 `CREATE TABLE IF NOT EXISTS`，多进程重复初始化安全。

### 2.2 CAP-033 本地私密数据面

CAP-033 的 `proactive_*` 表是当前 SQLite 数据面中的独立逻辑域。它们可以与业务库共享 SQLite 进程，但必须由本地 Host 选择本地文件/连接、禁止远程 `DATABASE_URL`、禁止普通 Outbox/分析同步，并在每条记录上保留租户、授权修订和 `processing_boundary`。若部署无法证明本地边界，CAP-033 必须保持挂起。

当前分支已补 CAP-033 的 8 张控制/捕获表，以及 CR-024 的 17 张主动派生与连接表；已接入授权/lease、动作运行时、部分来源、Worker 提炼、十二项派生、Home Assistant 实体目录、小米健康每日指标、本地画像上下文、连接/来源级删除和导出。剩余签名 Provider 证明、未接入平台来源、生产 HA/OAuth 兼容矩阵和双引擎迁移仍属待实现。生产控制面另要求 owner-only `proactive-access.token`（私密目录 `0600`）、字面 loopback 连接和禁止 redirect；令牌与外部连接凭据不得进入日志或导出。

---

## 3. SQLite 数据库模型图（当前开发阶段 · LibSQL）

4 个业务域 · 13 张表 · FTS5 全文检索 · WAL 模式 · 租户隔离 (workspace_id, subject_user_id)。

```mermaid
erDiagram
    %% ============ ① 会话域 Conversations ============
    sessions {
        TEXT id PK "主键"
        TEXT workspace_id "租户隔离"
        TEXT subject_user_id "租户隔离"
        TEXT title "会话标题"
        TEXT created_at "ISO8601 UTC"
        TEXT updated_at "ISO8601 UTC"
    }

    turns {
        TEXT id PK "主键"
        TEXT session_id FK "→ sessions.id (CASCADE)"
        TEXT workspace_id "租户隔离"
        TEXT subject_user_id "租户隔离"
        TEXT idempotency_key "租户内唯一"
        TEXT status "Created/Streaming/Done/Error"
        INTEGER last_sequence "最后事件序号"
        TEXT error "JSON 错误体"
        TEXT created_at ""
        TEXT updated_at ""
    }

    message_versions {
        TEXT id PK "主键"
        TEXT turn_id FK "→ turns.id (CASCADE)"
        TEXT workspace_id ""
        TEXT subject_user_id ""
        TEXT role "user/assistant/system"
        INTEGER version "同一 turn 内递增"
        TEXT content "消息内容"
        INTEGER is_redacted "0/1 脱敏标记"
        TEXT created_at ""
    }

    turn_stream_events {
        TEXT id PK "主键"
        TEXT turn_id FK "→ turns.id (CASCADE)"
        TEXT workspace_id ""
        TEXT subject_user_id ""
        INTEGER sequence "租户内 turn 有序"
        TEXT event_type "message/delta/done/error/redacted"
        INTEGER payload_version "默认 1"
        TEXT data "JSON 载荷"
        TEXT occurred_at "事件发生时间"
    }

    %% ============ ② 记忆域 Memory ============
    memory_records {
        TEXT id PK "主键"
        TEXT workspace_id ""
        TEXT subject_user_id ""
        TEXT layer "四层: ephemeral/short_term/long_term/system"
        TEXT type "user_fact / user_preference / learning_event / inference"
        TEXT content "记忆正文"
        TEXT canonical_parent_id FK "自引用 → memory_records.id (记忆树父节点)"
        TEXT source_turn_id FK "来源 → turns.id"
        INTEGER version "记忆版本号"
        INTEGER is_deleted "0/1 软删除"
        TEXT created_at ""
        TEXT updated_at ""
    }

    memory_edges {
        TEXT id PK "主键"
        TEXT workspace_id ""
        TEXT subject_user_id ""
        TEXT source_id FK "→ memory_records.id (CASCADE)"
        TEXT target_id FK "→ memory_records.id (CASCADE)"
        TEXT relation_type "parent_child / cross_topic / causal / contrast"
        TEXT created_at ""
    }

    memory_projection_overrides {
        TEXT id PK "主键"
        TEXT workspace_id ""
        TEXT subject_user_id ""
        TEXT memory_record_id FK "→ memory_records.id (CASCADE)"
        TEXT override_type "rename / reparent / lock"
        TEXT custom_title "用户自定义标题"
        TEXT custom_parent_id "用户自定义父节点"
        INTEGER is_locked "0/1 锁定"
        TEXT created_at ""
        TEXT updated_at ""
    }

    %% ============ ③ 日记域 Diary ============
    diaries {
        TEXT id PK "主键"
        TEXT workspace_id ""
        TEXT subject_user_id ""
        TEXT local_date "YYYY-MM-DD 日期标签"
        INTEGER auto_generated "1=自动 / 0=手动，条件唯一索引"
        TEXT title ""
        TEXT content "日记全文"
        INTEGER version ""
        TEXT created_at ""
        TEXT updated_at ""
    }

    diary_cycles {
        TEXT id PK "主键"
        TEXT workspace_id ""
        TEXT subject_user_id ""
        TEXT schedule_epoch_id "来自 schedule_revisions"
        TEXT local_date "归属日期"
        TEXT previous_cutoff_at "前一窗口截止 (ISO)"
        TEXT cutoff_at "本窗口截止 (ISO)"
        TEXT status "Scheduled/Claimed/Generating/Validating/Published/Skipped/Failed/Cancelled"
        INTEGER schedule_version "乐观锁"
        INTEGER fencing_token "lease 栅栏令牌"
        TEXT diary_id FK "→ diaries.id (生成后回填)"
        TEXT created_at ""
        TEXT updated_at ""
    }

    diary_schedule_revisions {
        TEXT id PK "主键"
        TEXT workspace_id ""
        TEXT subject_user_id ""
        INTEGER revision "修订号递增"
        INTEGER enabled "0/1"
        TEXT cron_time "Cron 表达式"
        TEXT timezone "时区如 Asia/Shanghai"
        TEXT initial_window_start "首个窗口起始"
        TEXT created_at ""
    }

    diary_run_attempts {
        TEXT id PK "主键"
        TEXT cycle_id FK "→ diary_cycles.id (CASCADE)"
        INTEGER schedule_version "快照时版本"
        TEXT worker_id "执行 Worker ID"
        INTEGER attempt "重试次数"
        TEXT status "Claimed/Generating/..."
        TEXT lease_expires_at "lease 过期时间"
        TEXT created_at ""
    }

    %% ============ ④ Outbox + 派生索引 ============
    outbox_events {
        TEXT id PK "主键"
        TEXT workspace_id ""
        TEXT subject_user_id ""
        TEXT control_event_id "关联 RecoveryControlLedger"
        TEXT idempotency_key "租户内唯一"
        TEXT event_type ""
        TEXT payload "JSON 事件载荷"
        TEXT status "pending/published/failed/dead_letter"
        INTEGER retry_count "重试次数"
        TEXT last_error ""
        TEXT created_at ""
        TEXT published_at ""
    }

    %% 派生 FTS5 虚表（可重建，非真源）
    messages_fts {
        TEXT id UNINDEXED "FK → message_versions.id"
        TEXT workspace_id UNINDEXED
        TEXT subject_user_id UNINDEXED
        TEXT content "分词内容"
    }
    memories_fts {
        TEXT id UNINDEXED "FK → memory_records.id"
        TEXT workspace_id UNINDEXED
        TEXT subject_user_id UNINDEXED
        TEXT content "分词内容"
    }

    %% ============ ⑤ Persona / Skills / MCP / 上下文快照（CAP-019/020）============
    personas {
        TEXT id PK "主键"
        TEXT workspace_id ""
        TEXT subject_user_id ""
        TEXT name "人格名"
        TEXT description ""
        TEXT source "builtin / user_created / imported"
        TEXT status "active / archived（删除=归档）"
        TEXT current_revision_id "→ persona_revisions.id"
        TEXT created_at ""
        TEXT updated_at ""
    }

    persona_revisions {
        TEXT id PK "主键"
        TEXT persona_id FK "→ personas.id (CASCADE)"
        INTEGER revision "personaId+revision UNIQUE"
        TEXT config "PersonaRevisionConfig JSON"
        TEXT checksum "sha256"
        TEXT created_at ""
    }

    persona_selections {
        TEXT id PK "主键"
        TEXT workspace_id ""
        TEXT subject_user_id "每租户一行 UNIQUE"
        TEXT persona_id FK "→ personas.id (CASCADE)"
        TEXT revision_id "→ persona_revisions.id"
        TEXT selected_at ""
        TEXT created_at ""
        TEXT updated_at ""
    }

    workspace_skills {
        TEXT id PK "主键"
        TEXT workspace_id ""
        TEXT subject_user_id ""
        TEXT name "Skill 名（租户内唯一）"
        TEXT description ""
        TEXT license ""
        TEXT compatibility ""
        TEXT metadata "JSON"
        TEXT allowed_tools "JSON（提示性，不授权）"
        TEXT source "active / workspace / imported"
        INTEGER version ""
        TEXT checksum "sha256"
        INTEGER enabled "0/1"
        INTEGER valid "0/1"
        TEXT validation_errors "JSON"
        TEXT files_json "{path: base64}"
        TEXT skill_markdown "SKILL.md 正文"
        TEXT imported_at ""
        TEXT created_at ""
        TEXT updated_at ""
    }

    mcp_tools {
        TEXT id PK "主键 {serverId}:{toolName}"
        TEXT workspace_id ""
        TEXT subject_user_id ""
        TEXT server_id ""
        TEXT name "serverId+name 租户内唯一"
        TEXT description ""
        TEXT input_schema "JSON"
        TEXT scopes "JSON"
        INTEGER healthy "0/1"
        INTEGER authorized "0/1"
        INTEGER revoked "0/1"
        INTEGER kill_switch "0/1"
        TEXT created_at ""
        TEXT updated_at ""
    }

    mcp_servers {
        TEXT id PK "服务器标识（预设 mcd-mcp）"
        TEXT name "展示名"
        TEXT transport "streamable_http / sse（预留）"
        TEXT endpoint_url "接入端点"
        TEXT auth_type "bearer / none"
        TEXT token "本地敏感凭据，API 不回传原文"
        INTEGER enabled "0/1（断开=0）"
        INTEGER is_preset "0/1 预设档案"
        TEXT status "disconnected / connected / error"
        TEXT last_sync_at "最近同步时间"
        TEXT last_error "最近错误"
        INTEGER tool_count "最近同步工具数"
        TEXT created_at ""
        TEXT updated_at ""
    }

    persona_turn_contexts {
        TEXT id PK "主键"
        TEXT workspace_id ""
        TEXT subject_user_id ""
        TEXT turn_id "turnId 租户内唯一"
        TEXT persona_id ""
        TEXT revision_id ""
        TEXT revision_checksum ""
        TEXT prompt_checksum ""
        TEXT skill_checksums "JSON"
        TEXT mcp_tool_ids "JSON"
        TEXT voice "JSON（不含凭据）"
        TEXT created_at ""
    }

    %% ============ ⑥ CAP-033 主动智能模式本地画像 ==========
    proactive_profile_revisions {
        TEXT id PK "版本化全量画像授权"
        TEXT workspace_id "租户隔离"
        TEXT subject_user_id "租户隔离"
        TEXT profile_version "full_profile_v1"
        INTEGER revision "修订号"
        TEXT device_id "设备绑定"
        TEXT desired_state "none/enabled/paused/revoking/revoked"
        TEXT status "draft/active/superseded/revoked"
        TEXT processing_boundary "local_only"
        TEXT manifest_json "来源/动作清单"
        TEXT created_at ""
        TEXT updated_at ""
    }

    proactive_source_grants {
        TEXT id PK "来源授权"
        TEXT revision_id FK "→ proactive_profile_revisions.id"
        TEXT workspace_id "租户隔离"
        TEXT subject_user_id "租户隔离"
        TEXT source_key "来源键"
        TEXT purpose "用途"
        TEXT scope "范围"
        TEXT os_capability "OS 回执"
        TEXT state "requested/granted/denied/revoked/expired"
        INTEGER mandatory "0/1"
        TEXT processing_boundary "local_only"
        TEXT created_at ""
        TEXT updated_at ""
    }

    proactive_activation_leases {
        TEXT id PK "激活租约"
        TEXT revision_id FK "→ proactive_profile_revisions.id"
        TEXT device_id "设备绑定"
        TEXT epoch "激活 epoch"
        TEXT status "active/expired/ended/revoked"
        INTEGER local_ready "0/1"
        INTEGER full_access_snapshot "0/1"
        TEXT expires_at ""
        TEXT heartbeat_at ""
    }

    proactive_captures {
        TEXT id PK "原始捕获副本"
        TEXT revision_id FK "授权修订"
        TEXT source_grant_id FK "来源授权"
        TEXT source_key "来源键"
        TEXT content_type "内容类型"
        TEXT checksum "哈希"
        TEXT observed_at ""
        TEXT retention_until "observed_at + 7d"
        TEXT distillation_status "pending/distilled/failed/deleted"
        TEXT distilled_memory_ids_json "提炼记忆"
        TEXT deleted_at ""
    }

    proactive_observations {
        TEXT id PK "归一化行为观察"
        TEXT revision_id FK "授权修订"
        TEXT source_grant_id FK "来源授权"
        TEXT source_key "来源键"
        TEXT observation_type "观察类型"
        TEXT subject_key "主体键"
        TEXT payload_json "本地规范化载荷"
        TEXT checksum "哈希"
        TEXT processing_boundary "local_only"
        TEXT algorithm_version "算法版本"
        TEXT observed_at ""
        TEXT normalized_at ""
    }

    proactive_profile_claims {
        TEXT id PK "画像声明"
        TEXT revision_id FK "授权修订"
        TEXT claim_type "习惯/操作/兴趣"
        TEXT content "本地画像内容"
        TEXT state "observed/inferred/confirmed/rejected"
        INTEGER confidence "置信度"
        TEXT evidence_refs_json "证据链"
        TEXT processing_boundary "local_only"
    }

    proactive_actions {
        TEXT id PK "主动动作"
        TEXT revision_id FK "授权修订"
        TEXT action_type "local/external/privileged/irreversible"
        TEXT target "目标 scope"
        TEXT authorization_scope "FullProfileActionGrant"
        TEXT action_grant_revision "动作授权修订"
        TEXT state "pending/approved/running/executed/denied/failed/revoked"
        TEXT outcome_json "结果"
    }

    proactive_audit_events {
        TEXT id PK "本地审计"
        TEXT revision_id FK "授权修订"
        TEXT event_type "授权/恢复/动作/撤权/导出/删除"
        TEXT actor_id "操作者"
        TEXT resource_type "资源类型"
        TEXT resource_id "资源 ID"
        TEXT processing_boundary "local_only"
        TEXT occurred_at ""
    }

    %% ============ 关系 ============
    personas ||--o{ persona_revisions : "1:N 不可变修订 (CASCADE)"
    personas ||--o| persona_selections : "1:N 激活（每租户一行）"
    sessions ||--o{ persona_turn_contexts : "1:N Turn 快照"
    sessions ||--o{ turns : "1:N (CASCADE delete)"
    turns ||--o{ message_versions : "1:N (CASCADE)"
    turns ||--o{ turn_stream_events : "1:N (CASCADE, SSE重放)"

    memory_records ||--o{ memory_edges : "→ source (CASCADE)"
    memory_records ||--o{ memory_edges : "→ target (CASCADE)"
    memory_records ||--o{ memory_projection_overrides : "1:N 投影覆盖"
    memory_records ||--o{ memory_records : "自引用 canonical_parent_id (记忆树)"
    turns ||--o{ memory_records : "来源 source_turn_id"

    diary_schedule_revisions ||--o{ diary_cycles : "派生周期 (epoch_id)"
    diary_cycles ||--o{ diary_run_attempts : "1:N lease 尝试"
    diaries o{--|| diary_cycles : "← 生成后回填 diary_id"

    proactive_profile_revisions ||--o{ proactive_source_grants : "1:N 来源授权"
    proactive_profile_revisions ||--o{ proactive_activation_leases : "1:N 激活租约"
    proactive_profile_revisions ||--o{ proactive_captures : "1:N 原始捕获"
    proactive_profile_revisions ||--o{ proactive_observations : "1:N 行为观察"
    proactive_profile_revisions ||--o{ proactive_profile_claims : "1:N 画像声明"
    proactive_profile_revisions ||--o{ proactive_actions : "1:N 主动动作"
    proactive_profile_revisions ||--o{ proactive_audit_events : "1:N 本地审计"
    proactive_source_grants ||--o{ proactive_captures : "来源限制"
    proactive_source_grants ||--o{ proactive_observations : "来源限制"

    %% 派生索引引用
    message_versions }o--|| messages_fts : "同步/可重建虚表"
    memory_records }o--|| memories_fts : "同步/可重建虚表"
```

### 3.1 租户列与时间列约定

[schema/common.ts](../../packages/database/src/schema/common.ts#L6-L17) 定义的 `tenantColumns` 与 `timestampColumns` 通过 Drizzle 展开在所有业务表上，避免遗漏：

- `tenantColumns = (workspace_id TEXT NOT NULL, subject_user_id TEXT NOT NULL)`：每个仓储方法首个参数必须是 `TenantContext`；`assertTenantContext` 在执行 SQL 前先校验非空且格式合法。
- `timestampColumns = (created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`：全部 ISO8601 UTC 字符串，默认通过 `$defaultFn(() => new Date().toISOString())` 在 ORM 层写入；**不得使用数据库服务器 `CURRENT_TIMESTAMP`**，避免与应用时区漂移。
- 时间类字段命名规则：生成时刻用 `created_at`、修改用 `updated_at`、发生/事件时刻用 `occurred_at`、计划窗口用 `cutoff_at`、失效用 `expires_at`、发布用 `published_at`。不可混用。

### 3.2 关键索引与唯一约束清单

| 表 | 索引名称 | 构成 | 类型 | 安全作用 |
|---|---|---|---|---|
| sessions | `sessions_tenant_idx` | `(workspace_id, subject_user_id)` | 普通 | 租户列表查询加速 |
| turns | `turns_tenant_idempotency_idx` | `(workspace_id, subject_user_id, idempotency_key)` | UNIQUE | 幂等重放底线 |
| turns | `turns_session_idx` | `(session_id)` | 普通 | 会话内 Turn 列表 |
| message_versions | `message_versions_turn_ver_idx` | `(turn_id, version)` | UNIQUE | 版本递增、避免跳号 |
| message_versions | `message_versions_tenant_idx` | `(workspace_id, subject_user_id)` | 普通 | 租户消息搜索 |
| turn_stream_events | `turn_stream_events_turn_seq_idx` | `(turn_id, sequence)` | UNIQUE | 持久化顺序、SSE 重放高水位 |
| diaries | `diaries_auto_unique_idx` | `(ws, user, local_date) WHERE auto_generated = 1` | 条件 UNIQUE | 同一天只允许 1 份自动日记 |
| diary_cycles | `diary_cycles_tenant_idx` | `(ws, user, cutoff_at)` | 普通 | 周期窗口查询 |
| memory_records | `memory_records_tenant_layer_idx` | `(ws, user, layer, is_deleted)` | 普通 | 记忆分层检索 |
| outbox_events | `outbox_tenant_idempotency_idx` | `(ws, user, idempotency_key)` | UNIQUE | Outbox 幂等底线 |
| outbox_events | `outbox_status_idx` | `(status, created_at)` | 普通 | 待发布/死信扫描 |

### 3.3 SQLite 特有实现约束

1. **WAL 模式必须开启**：`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;`，防止默认 DELETE 日志的写串行化退化。
2. **FK 强制开启**：每个连接先执行 `PRAGMA foreign_keys=ON;`，否则 SQLite 默认不检查外键。
3. **单连接串行写**：`Database` 对象在 Node.js 主进程/Worker 间复用一个 `client` 并使用串行化队列，避免 `SQLITE_BUSY`；高并发写入压力时，通过 Outbox 出账再异步发布，避免业务事务过大。
4. **FTS5 删除同步**：`message_versions` / `memory_records` 的插入、更新、软删除必须在同一事务内同步 `indexMessageFts` / `deleteMessageFts`；禁止延迟异步更新，避免删除窗口期仍能被搜索召回（TC-PRIV-DEL-001）。
5. **记忆递归查询**：记忆树投影必须使用 `WITH RECURSIVE` CTE 查询 canonical_parent 层级，禁止在应用层 N+1 循环递归拼树。

---

## 4. PostgreSQL 生产数据库模型图（17+ · 含用户注册 + RLS）

5 个域 · 用户注册上线 · RLS 行级安全 · pgvector 向量 · 同构业务表 · 组织级 workspace。

```mermaid
erDiagram
    %% ============ ① 用户域 Identity（PG 阶段上线，CR-003 范围外）============
    workspaces {
        UUID id PK "组织 ID"
        TEXT name "组织名"
        TEXT slug UNIQUE "短标识"
        TEXT plan "free/pro/enterprise"
        TIMESTAMPTZ created_at ""
        TIMESTAMPTZ updated_at ""
    }

    users {
        UUID id PK "用户 ID"
        TEXT email UNIQUE "登录邮箱"
        TEXT status "active/inactive/suspended"
        BOOLEAN email_verified "邮箱验证"
        TIMESTAMPTZ last_login_at ""
        TIMESTAMPTZ created_at ""
        TIMESTAMPTZ updated_at ""
        "RLS": "subject_user_id = current_setting('app.user_id')::uuid"
    }

    user_credentials {
        UUID user_id PK,FK "→ users.id (1:1)"
        TEXT password_hash "bcrypt"
        TEXT salt "bcrypt salt"
        TEXT password_algo "bcrypt/v2"
        TIMESTAMPTZ password_changed_at ""
        TIMESTAMPTZ created_at ""
    }

    workspace_members {
        UUID id PK
        UUID workspace_id FK "→ workspaces.id"
        UUID user_id FK "→ users.id"
        TEXT role "owner/admin/member"
        TIMESTAMPTZ joined_at ""
    }

    user_profiles {
        UUID user_id PK,FK "→ users.id"
        TEXT nickname "昵称"
        TEXT avatar_url "头像"
        JSONB personality "人格问卷结果"
        JSONB preferences "偏好设置(语言/风格/通知)"
        TEXT locale "zh-CN etc"
        TEXT timezone ""
        TIMESTAMPTZ created_at ""
        TIMESTAMPTZ updated_at ""
        "RLS": "user_id = current_setting('app.user_id')::uuid"
    }

    %% ============ ② 会话域（同构 + 类型增强 + RLS）============
    sessions {
        UUID id PK
        UUID workspace_id FK "→ workspaces.id"
        UUID subject_user_id FK "→ users.id"
        TEXT title ""
        TIMESTAMPTZ created_at ""
        TIMESTAMPTZ updated_at ""
        "RLS": "workspace_id AND subject_user_id 强制匹配"
    }

    turns {
        UUID id PK
        UUID session_id FK "→ sessions.id ON DELETE CASCADE"
        UUID workspace_id ""
        UUID subject_user_id ""
        TEXT idempotency_key "租户内 UNIQUE"
        TEXT status ""
        INTEGER last_sequence ""
        JSONB error ""
        TIMESTAMPTZ created_at ""
        TIMESTAMPTZ updated_at ""
    }

    message_versions {
        UUID id PK
        UUID turn_id FK "→ turns.id CASCADE"
        UUID workspace_id ""
        UUID subject_user_id ""
        TEXT role ""
        INTEGER version "UNIQUE(turn_id, version)"
        TEXT content ""
        BOOLEAN is_redacted ""
        TIMESTAMPTZ created_at ""
    }

    turn_stream_events {
        BIGSERIAL id PK "自增替代 TEXT（分区友好）"
        UUID turn_id FK "→ turns.id CASCADE"
        UUID workspace_id ""
        UUID subject_user_id ""
        INTEGER sequence "UNIQUE(turn_id, sequence)"
        TEXT event_type ""
        INTEGER payload_version ""
        JSONB data ""
        TIMESTAMPTZ occurred_at ""
        "Partition": "BY RANGE (occurred_at)"
    }

    %% ============ ③ 记忆域（同构 + pgvector）============
    memory_records {
        UUID id PK
        UUID workspace_id ""
        UUID subject_user_id ""
        TEXT layer ""
        TEXT type ""
        TEXT content ""
        UUID canonical_parent_id FK "自引用 → memory_records.id"
        UUID source_turn_id FK "→ turns.id"
        vector embedding "pgvector(n) dim, 可空"
        INTEGER version ""
        BOOLEAN is_deleted ""
        TIMESTAMPTZ created_at ""
        TIMESTAMPTZ updated_at ""
        "Index": "USING HNSW (embedding vector_cosine_ops)"
    }

    memory_edges {
        UUID id PK
        UUID workspace_id ""
        UUID subject_user_id ""
        UUID source_id FK "→ memory_records.id CASCADE"
        UUID target_id FK "→ memory_records.id CASCADE"
        TEXT relation_type ""
        TIMESTAMPTZ created_at ""
    }

    memory_projection_overrides {
        UUID id PK
        UUID workspace_id ""
        UUID subject_user_id ""
        UUID memory_record_id FK "→ memory_records.id CASCADE"
        TEXT override_type ""
        TEXT custom_title ""
        UUID custom_parent_id ""
        BOOLEAN is_locked ""
        TIMESTAMPTZ created_at ""
        TIMESTAMPTZ updated_at ""
    }

    %% ============ ④ 日记域（同构 · SKIP LOCKED 替代 lease）============
    diaries {
        UUID id PK
        UUID workspace_id ""
        UUID subject_user_id ""
        TEXT local_date "YYYY-MM-DD"
        BOOLEAN auto_generated ""
        TEXT title ""
        TEXT content ""
        INTEGER version ""
        TIMESTAMPTZ created_at ""
        TIMESTAMPTZ updated_at ""
    }

    diary_cycles {
        UUID id PK
        UUID workspace_id ""
        UUID subject_user_id ""
        TEXT schedule_epoch_id ""
        TEXT local_date ""
        TIMESTAMPTZ previous_cutoff_at ""
        TIMESTAMPTZ cutoff_at ""
        TEXT status ""
        INTEGER schedule_version ""
        INTEGER fencing_token "advisory lock 辅助"
        UUID diary_id FK "→ diaries.id"
        TIMESTAMPTZ created_at ""
        TIMESTAMPTZ updated_at ""
    }

    diary_schedule_revisions {
        UUID id PK
        UUID workspace_id ""
        UUID subject_user_id ""
        INTEGER revision ""
        BOOLEAN enabled ""
        TEXT cron_time ""
        TEXT timezone ""
        TIMESTAMPTZ initial_window_start ""
        TIMESTAMPTZ created_at ""
    }

    diary_run_attempts {
        UUID id PK
        UUID cycle_id FK "→ diary_cycles.id CASCADE"
        INTEGER schedule_version ""
        TEXT worker_id ""
        INTEGER attempt ""
        TEXT status ""
        TIMESTAMPTZ lease_expires_at ""
        TIMESTAMPTZ created_at ""
    }

    %% ============ ⑤ Outbox + 检索层 ============
    outbox_events {
        UUID id PK
        UUID workspace_id ""
        UUID subject_user_id ""
        TEXT control_event_id ""
        TEXT idempotency_key "租户内 UNIQUE"
        TEXT event_type ""
        JSONB payload ""
        TEXT status ""
        INTEGER retry_count ""
        TEXT last_error ""
        TIMESTAMPTZ created_at ""
        TIMESTAMPTZ published_at ""
        "Trigger": "AFTER INSERT → pg_notify('outbox_new', id::text)"
    }

    %% ============ 关系 ============
    workspaces ||--o{ workspace_members : "拥有 N 成员"
    users ||--o{ workspace_members : "加入 N 组织"
    users ||--|| user_credentials : "1:1 凭证"
    users ||--|| user_profiles : "1:1 Profile"

    sessions ||--o{ turns : "1:N CASCADE"
    turns ||--o{ message_versions : "1:N"
    turns ||--o{ turn_stream_events : "1:N (分区表)"

    memory_records ||--o{ memory_edges : "→ source"
    memory_records ||--o{ memory_edges : "→ target"
    memory_records ||--o{ memory_projection_overrides : "覆盖"
    memory_records ||--o{ memory_records : "自引用 (记忆树)"
    turns ||--o{ memory_records : "来源 turn"

    diary_schedule_revisions ||--o{ diary_cycles : "派生周期"
    diary_cycles ||--o{ diary_run_attempts : "1:N lease"
    diaries o{--|| diary_cycles : "回填 diary_id"
```

### 4.1 用户域启用时机与 RLS 策略（CR-003 范围外 → PG 首启）

PostgreSQL 启用前，SQLite 阶段**不得创建**以下 5 张表以避免范围膨胀：

- `workspaces`、`users`、`user_credentials`、`workspace_members`、`user_profiles`

进入 PostgreSQL 阶段时，先运行 `0001_identity_domain.sql` 迁移脚本创建以上 5 张表，再逐条启用 RLS：

```sql
-- 示例 RLS 模板（具体以 drizzle 生成迁移为准）
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE turns    ENABLE ROW LEVEL SECURITY;

CREATE POLICY sessions_tenant_rls ON sessions
  FOR ALL USING (
    workspace_id    = current_setting('app.workspace_id', true)::uuid AND
    subject_user_id = current_setting('app.user_id',      true)::uuid
  );
```

**应用端约定**：每个 PostgreSQL 连接在获得 `TenantContext` 后必须先 `SELECT set_config('app.workspace_id', $1, true)`，再执行查询。连接归还前调用 `RESET ALL` 或释放到连接池前显式清理自定义 GUC。审计账号只读权限连接**不执行 set_config**，从而被 RLS 默认拒绝查询——用于**越权审计**。

### 4.2 pgvector 与全文 GIN 索引

- `memory_records.embedding` 列使用 `vector(1536)` 或与模型嵌入维度一致；Expand 阶段先加**可空列**，Dual-Read 阶段后台任务 batch 回填；SQLite 适配器继续使用 `InMemoryVectorSearchAdapter`，互不干扰。
- 全文检索：PG 不使用 FTS5 虚表，改用原生 `tsvector + GIN`。新增 `content_vector tsvector GENERATED ALWAYS AS (to_tsvector('zhparser', content)) STORED` 列 + GIN 索引；trigger 或生成列自动更新，等价 SQLite 的 `indexMessageFts` 手动同步。两者均在**同一事务**内随业务行提交，删除传播必须同时清理（业务行被删除时生成列/索引自动失效，需额外在 Repository 层保证 Port.delete 被同步调用）。

---

## 5. SQLite ↔ PostgreSQL 双数据库映射与迁移契约

Repository Port 解耦边界 · 字段同构映射 · Expand/Contract 三阶段迁移 · 类型自然升级 · 消费者清单。

```mermaid
flowchart TB
    subgraph CONSUMERS["上层消费者（仅依赖 Repository Port，零数据库耦合）"]
        direction LR
        API["apps/api<br/>Fastify /v1/*"]
        WEB["apps/web<br/>Next.js UI"]
        DESKTOP["apps/desktop<br/>Electron 端侧"]
        WORKERS["Workers<br/>日记/Outbox"]
        TESTS["集成/单元测试"]
    end

    subgraph PORT["Repository / Vector Search Port（契约边界 · DRI: packages/database）"]
        direction LR
        I_CONV["IConversationRepository<br/>sessions/turns/msgs/stream"]
        I_MEM["IMemoryRepository<br/>records/edges/tree"]
        I_DIARY["IDiaryRepository<br/>cycles/lease/diaries"]
        I_OUTBOX["IOutboxRepository<br/>events/retry/mark"]
        I_VEC["IVectorSearchPort<br/>upsert/search/delete"]
    end

    subgraph SQLITE_ADAPTER["SQLite 适配器 · 真源（当前 LibSQL + WAL）"]
        direction TB
        subgraph SQLITE_CORE["核心业务表（13 张，字段同构）"]
            S_CONV["会话仓储<br/>sessions/turns/msg_ver/stream_events<br/>TEXT PK · JSON 载荷 · TenantContext 注入"]
            S_MEM["记忆仓储<br/>memory_records+edges+overrides<br/>WITH RECURSIVE 记忆树"]
            S_DIA["日记仓储<br/>diary_cycles+run_attempts+diaries<br/>CAS lease + 乐观锁 version"]
            S_OUT["Outbox 事件<br/>outbox_events（事务出账）"]
        end
        subgraph SQLITE_DERIVED["派生索引（可重建 · 非真源）"]
            S_FTS["FTS5 虚表<br/>messages_fts / memories_fts"]
            S_VEC["向量：InMemoryVectorSearchAdapter<br/>内存 Map，零持久化"]
        end
        subgraph SQLITE_OUTOFSCOPE["PG 补齐（CR-003 范围外 · SQLite 不实现）"]
            direction TB
            S_NO_USER["❌ 用户注册 / 登录"]
            S_NO_WS["❌ Workspace 组织 / RBAC"]
            S_NO_PROF["❌ credentials / Profile"]
            S_NO_RLS["❌ 数据库级 RLS（仅仓储层）"]
        end
    end

    subgraph PG_ADAPTER["PostgreSQL 适配器 · 真源（生产启用 17+）"]
        direction TB
        subgraph PG_CORE["核心业务表（13 张，同构 + 类型自然升级）"]
            P_CONV["会话仓储<br/>sessions/turns UUID<br/>JSONB · BIGSERIAL 分区<br/>◉ RLS 强制"]
            P_MEM["记忆仓储<br/>memory_records + VECTOR(n) 列<br/>pgvector HNSW 索引 · WITH RECURSIVE"]
            P_DIA["日记仓储<br/>cycles/diaries/attempts<br/>advisory lock · SKIP LOCKED"]
            P_OUT["Outbox 事件<br/>JSONB + NOTIFY trigger"]
        end
        subgraph PG_DERIVED["原生检索（持久化 · 可重建）"]
            P_FTS["GIN tsvector 索引<br/>to_tsvector('zhparser', content)"]
            P_VEC["pgvector 表<br/>HNSW / ivfflat 持久化索引"]
        end
        subgraph PG_USERDOMAIN["用户域（PG 首启 · 全新 5 张表）"]
            direction TB
            P_USER["workspaces / users / credentials<br/>workspace_members RBAC<br/>user_profiles 偏好 + personality JSONB"]
            P_RLS["◉ RLS POLICY 全表使能<br/>数据库原生 (workspace_id, user_id) 隔离"]
        end
    end

    subgraph MIGRATION["迁移三阶段 · Expand/Contract（可回退，不执行不可逆迁移）"]
        direction LR
        P1["Phase 1 · Expand<br/>SQLite 主写 + PG 适配器新增 + 双方言 CI<br/>+ Drizzle pg 方言 DDL<br/>验收：同输入同字段逐值一致"]
        P2["Phase 2 · Dual-Read<br/>SQLite 写 + PG 影子读 diff 校验<br/>PG 用户域上线 + 向量索引回填<br/>验收：7 天 diff=0 · RLS 越权 0 通过率<br/>可回退开关"]
        P3["Phase 3 · Contract<br/>写/读路由切 PG · SQLite 适配器保留 30 天<br/>本地 SQLite 文件保留为备份<br/>验收：旧适配器引用 0"]
    end

    CONSUMERS -->|"仅调接口"| PORT

    PORT <-->|"仓储层解耦 · 可互换"| SQLITE_ADAPTER
    PORT <-->|"仓储层解耦 · 可互换"| PG_ADAPTER

    S_MEM -.->|"同步删除<br/>TC-PRIV-DEL-001 零召回"| S_FTS
    S_MEM -.->|"内存 upsert/search"| S_VEC
    P_MEM -.->|"RLS+GIN 触发索引"| P_FTS
    P_MEM -.->|"HNSW 持久化"| P_VEC

    P1 -->|"校验通过"| P2
    P2 -->|"验收通过"| P3
```

---

## 6. 字段兼容性矩阵（SQLite → PostgreSQL 自然升级）

| 维度 | SQLite 当前 | PostgreSQL 生产 | 兼容性分级 | 验证要点 |
|---|---|---|---|---|
| 主键 id | `TEXT` (nanoid/uuid 字符串) | `UUID` native | ✅ 兼容 (additive) | `uuid_in()` 可无损解析；SQLite id 均为 v4 格式，校验脚本对拍 |
| session_id / fk | `TEXT` | `UUID` | ✅ 兼容 | 同上 |
| created_at / 时间 | `TEXT` ISO8601 UTC | `TIMESTAMPTZ NOT NULL` | ✅ 兼容 | `to_timestamp()` 解析 UTC ISO8601 无损；所有 `_at` 均 UTC |
| error / payload / data | `TEXT JSON` | `JSONB` | ✅ 兼容 | JSONB 是 JSON 超集；语义不变、写/索引性能提升 |
| is_redacted / is_deleted / auto_generated | `INTEGER` (0/1) | `BOOLEAN` | ✅ 兼容 | SQLite 0=false 1=true；PG cast 无歧义 |
| last_sequence / version / revision / fencing_token | `INTEGER` | `INTEGER / BIGINT` | ✅ 兼容 | 32-bit 范围足够；stream_events 升 BIGSERIAL |
| layer / type / role / status / relation_type | `TEXT` enum-like | `TEXT + CHECK` | ⚠️ 条件兼容 | 建议使用 `TEXT + CHECK (col IN (...))`，避免 ENUM ALTER 锁表；当前 Drizzle schema 为 TEXT |
| tenant 列 workspace_id | `TEXT` | `UUID` | ✅ 兼容 | 与 id 同升级路径 |
| tenant 列 subject_user_id | `TEXT` | `UUID → users.id` | ✅ 兼容 | SQLite 阶段为本地标识；PG 映射 users.id，仓储层统一返回字符串，签名不变 |
| **新域：用户/凭证/Profile/Workspace/Member** | 不存在（CR-003 范围外） | 新增 5 张表 | 🆕 新增（不影响旧消费者） | SQLite 阶段完全不创建；PG 启用时 DDL migrations 补齐 |
| memory_records.embedding | 不在表（走内存向量 Port） | `VECTOR(n)` pgvector | 🆕 新增可空列 | Expand 阶段先加可空列，PG 后台回填；SQLite 适配器继续走内存 Port |
| 全文检索 | FTS5 虚表（可重建） | tsvector GIN 索引 | 🆕 派生索引（零契约影响） | 删除传播均走仓储层 API 双删；TC-PRIV-DEL-001 验证零召回 |

分级：

- ✅ **兼容**：语义不变，类型自然升级，消费者代码零改动
- ⚠️ **条件兼容**：选型影响运维，不影响读取语义
- 🆕 **新增**：仅 PG 存在，SQLite 不建，不破坏旧结构
- ❌ **破坏性**：本表零项

---

## 7. Repository / Vector Search Port 接口签名契约

严禁破坏性变更；新增参数必须带默认值，新增方法必须与旧方法共存至少一个阶段。签名定义见 [packages/database/src/repositories/types.ts](../../packages/database/src/repositories/types.ts#L1-L242)：

| Port 接口 | 关键方法 | 不变量 |
|---|---|---|
| `IConversationRepository` | `getOrCreateSession(tenant, sessionId, title?)`<br/>`createTurnWithOutbox(tenant, turn, userMsg, outboxEvent?)`<br/>`updateTurnStatus(...)`<br/>`appendStreamEvent(...)`<br/>`deleteMessage(tenant, messageId)` | 原子写 Turn 必须事务内同时写 User `MessageVersion` + Outbox（如有）；`getOrCreateSession` 幂等且不重复创建 |
| `IMemoryRepository` | `createRecord / createEdge / getTreeProjection`<br/>`softDeleteRecord` | `getTreeProjection` 使用 `WITH RECURSIVE`；软删除同步清向量索引、FTS 和下游派生 |
| `IDiaryRepository` | `createCycle / claimCycleWithLease`<br/>`publishDiaryWithCycle(..., outboxEvent?)` | `claimCycleWithLease` 通过 schedule_version CAS；发布必须同一事务更新 diary + cycle + 可选 outbox |
| `IOutboxRepository` | `insertEvent / fetchPendingEvents`<br/>`markPublished / markFailed` | fetchPending 不按租户过滤（跨租户处理），但每个 Event 自身携带 ws/user；必须重试上限后进入 dead_letter |
| `IVectorSearchPort` | `upsert / search / delete / clearTenant` | 派生索引、可重建；删除传播必须在事务外部紧随业务事务提交后显式调用，或在同一事务内同步（SQLite） |
| `IProactiveProfileRepository` | `createDraft / confirmProfile`、`getEffectiveStatus`、`createActivationLease`、`createCapture`、`createClaim`、`createAction`、`exportSnapshot`、来源级删除 | CAP-033 所有写入绑定 tenant/revision/device；必须保留 `local_only`、七天捕获提炼状态和全动作授权快照；当前分支已实现 SQLite Repository、加密字段和来源级 scrub，生产双引擎迁移仍待完成 |

---

## 8. 敏感数据与删除传播规则

| 敏感字段 | 所在表 | 处理策略 | 验证测试 |
|---|---|---|---|
| `content`（消息/记忆/日记全文） | `message_versions` / `memory_records` / `diaries` | 支持 `is_redacted` / `is_deleted`；删除时同步清 FTS + Vector Port；Outbox 事件发 redacted 而非原文 | `TC-PRIV-DEL-001` 删除后搜索/向量/API 零召回 |
| `password_hash` / `salt` | `user_credentials`（PG 新域） | bcrypt；独立表；RLS 禁止应用层 `SELECT credentials.*`；只读审计账号无 SELECT 权限 | RLS + 权限审计脚本 |
| `email` / `user_profiles` PII | `users` / `user_profiles`（PG 新域） | RLS 按 `user_id` 隔离；`status=deactivated` 触发删除账本（RecoveryControlLedger），保留最小元数据 | 合规：GDPR 删除请求 → 删除账本 + 审计导出 |
| `(workspace_id, subject_user_id)` | 所有表 | 仓储层 `assertTenantContext` 强注入 + SQLite 唯一/外键兜底 + PG RLS 双保险 | `TC-SEC-TENANT-001` 租户越权 0 通过 |
| CAP-033 原始捕获/画像/动作正文 | `proactive_captures` / `proactive_observations` / `proactive_profile_claims` / `proactive_actions` | `processing_boundary=local_only`、静态加密、grant/revision 外键；捕获按七天且完成记忆提炼后清理；动作绑定 `FullProfileActionGrant`、目标和租约；来源级删除会 scrub 捕获、删除观察/画像并撤销匹配动作 | `TC-SEC-PRO-LOCAL-001`、`TC-PRIV-PRO-RETENTION-001`、`TC-SEC-PRO-ACTION-001`、`apps/api/test/proactive.test.ts` |

---

## 9. 迁移 Expand/Contract 三阶段（可回退 + 不执行不可逆）

### Phase 1 · Expand（不切流，只加不减）

- 新增 `PostgresConversationRepository` / `PostgresMemoryRepository` / `PostgresDiaryRepository` / `PostgresOutboxRepository` / `PgVectorAdapter` 五个 PG 适配器，不替换现有 SQLite 适配器。
- 新增 Drizzle 多方言输出：`pnpm db:generate:pg` 生成 PG DDL；CI 同步跑 `typecheck` 双方言、单元测试同输入对拍（SQLite 适配器结果 vs PG 适配器结果）。
- 验收：`same_tenant_input → 100% same_field_value_match`（id 差异、时间精度差异列入 ignore 字段白名单）。

### Phase 2 · Dual-Read（影子读 + 数据校验）

- 写：SQLite 真源 → 同事务后异步选路径双写 PG；失败写 diff_log 不影响用户主链路。
- 读：SQLite 主路径返回，后台同查询跑 PG，按 tenant 记录计数 diff / MD5 diff / 抽样逐行比对。
- 用户域上线：迁移 `0001_identity_domain.sql` 创建 workspaces/users/credentials/workspace_members/user_profiles + RLS；注册/登录只在 PG 路径提供，SQLite 客户端继续沿用本地 subject_user_id。
- 向量回填：后台 Worker 按 tenant chunk 批处理 `memory_records.embedding` 可空列。
- 验收条件（触发切流前全部满足）：
  1. 连续 7 天 diff=0（按表、按 tenant 的 5% 抽样逐行一致）；
  2. `memory_records.embedding` 回填率 ≥ 99.5%；
  3. RLS 越权审计账号 100% 全表查询被拒绝（TC-SEC-TENANT-001）；
  4. 删除传播 TC-PRIV-DEL-001 双引擎同时通过。
- 回退触发器：Phase 2 内 diff > 0.1% / RLS 有通过 / PG 写入 P99 > 100ms 任一命中 → **立即回退到 Phase 1**，只读 SQLite，0 数据损失。

### Phase 3 · Contract（切流，保留适配器 30 天）

- 路由开关：全量写 + 读走 PG。
- SQLite 适配器保留 30 天，所有调用打印 `logger.warn("DEPRECATED: SQLite adapter scheduled for removal. PG is now the source of truth.")`。
- **不执行不可逆物理数据迁移**：端侧本地 `.sqlite` 文件保留作为本地备份，用户可主动导出；云端不做 SQLite 文件直接导入 PG 的强制 ETL，避免数据损失。
- 验收：`grep -r "new SqliteConversation"` = 0 生产代码引用；只读审计账号 0 越权；死信队列低于 0.01%。

---

## 10. 消费者清单与 unknown-consumer 风险

**生产者（写入侧）**：

- `apps/api` — 写 sessions/turns/messages/memory/diaries/outbox（[apps/api/src/index.ts](../../apps/api/src/index.ts#L58-L59) 已实现 `getOrCreateSession`）
- 日记 Worker — `claimCycleWithLease` / `publishDiaryWithCycle`
- apps/desktop 端侧 — 本地同仓储（Electron）

**消费者（只读侧）**：

- `apps/web` Next.js UI — 会话列表、记忆树、日记列表
- 搜索/检索管线 — 依赖 FTS5 / GIN / Vector Port 做召回（**派生索引，可重建**）
- 审计 / 合规读取器 — 依赖 message_versions 历史 + outbox_events + 红acted 标记
- BI / 报表（未来接入）— 待定，属于 unknown-consumer 中风险项

**unknown-consumer 处置**：PG 启用前在 outbox_events 新增 `recovery_event_type TEXT` 列（可空），为未来 BI + RecoveryControlLedger 删除账本预留挂钩；不阻塞当前开发。

---

## 11. 测试门禁（进入 G2 前必须完成）

| TC 编号 | 名称 | 覆盖表面 |
|---|---|---|
| `TC-SEC-TENANT-001` | 租户越权防护：跨 workspace / 跨 user 的 CURD 必须 0 命中 | 隔离、RLS、裸连接池审计 |
| `TC-PRIV-DEL-001` | 删除后 FTS + 向量 + API + 缓存 零召回 | 删除传播、派生索引同步、Outbox redacted |
| `TC-MEM-TREE-001` | 记忆树 `WITH RECURSIVE`：多层父节点、环保护、投影 override 覆盖正确 | CTE、自引用、soft delete |
| `TC-DIA-CAS-001` | 日记周期 CAS：并发 Worker 同 cycle 只有 1 个 successful claim | fence_token、SKIP LOCKED、advisory lock |
| `TC-OUT-IDEM-001` | Outbox 同 tenant 同 idempotency_key 重插入唯一冲突 & 幂等读取 | 唯一索引、重试 dead_letter |
| `TC-STOR-COMPAT-001` | SQLite ↔ PG 同输入仓储对拍，字段逐值一致 ignore_whitelist={created_at ms} | 双引擎契约 |
| `TC-INTEG-PRO-SCHEMA-001` | CAP-033 proactive_* 表初始化、租户外键/索引和 revision 关联 | Schema/DDL/Repository 类型（当前骨架） |
| `TC-PRIV-PRO-RETENTION-001` | 原始捕获七天且 distillationStatus=distilled 后才清理；pending/failed 不误删 | `proactive_captures.retention_until`、提炼状态和删除任务 |
| `TC-SEC-PRO-ACTION-001` | 全动作授权按 revision/target/lease/deny 校验，未授权不产生副作用 | `proactive_actions`、ToolPolicy 和审计 |
| `TC-SEC-PRO-AUTH-001` | proactive 控制面仅接受 `0600` owner-only token 的字面 loopback 请求，缺失/错误/redirect 均拒绝 | Vault token、Host hook 和 redirect 防线 |

---

## 12. 兼容与变更

- 新增可空列或带默认值的列视为**兼容**；只需更新 Drizzle schema 和双方言迁移，无需 `payloadVersion` 提升。
- 删除字段或改变字段语义必须**提升双方言 schema_version**，创建 `CR-*` 并走 30 天兼容窗口；窗口内新旧 Repository 同时测试通过方可 Contract。
- 替换数据库方言、切换 FTS/向量引擎不改变 Port 接口签名；不得把方言特定错误码、连接池状态、SQL 方言泄露给上层消费者。
- `TenantContext` 字段名 (`workspaceId`, `subjectUserId`) 与含义是**不可变契约**。任何阶段不得重命名或改为可选。

---

## 13. 参考与落地代码

- 真源 schema：[packages/database/src/schema/](../../packages/database/src/schema)
- CAP-033 主动智能控制/捕获 schema：[proactive.ts](../../packages/database/src/schema/proactive.ts)；CAP-033～035 派生与连接 schema：[proactive-intelligence.ts](../../packages/database/src/schema/proactive-intelligence.ts)；初始化：[init.ts](../../packages/database/src/schema/init.ts)
- 连接与共享库路径：[client.ts](../../packages/database/src/client.ts#L21-L23)（`createDatabase` 默认 `<repo>/data/aervox.db`，见 §2.1）
- 公共列定义：[common.ts](../../packages/database/src/schema/common.ts#L6-L17)
- DDL 初始化脚本：[init.ts](../../packages/database/src/schema/init.ts#L9-L219)
- Repository Port 签名：[repositories/types.ts](../../packages/database/src/repositories/types.ts#L1-L242)
- SQLite 对话仓储：[conversation-repository.ts](../../packages/database/src/repositories/sqlite/conversation-repository.ts#L59-L80)
- FTS5 集成：[search/fts.ts](../../packages/database/src/search/fts.ts#L12-L104)
- 向量检索 Port：[search/vector-port.ts](../../packages/database/src/search/vector-port.ts#L8-L109)
- 变更请求：[CR-003 SQLite 真源 + PG 兼容](changes/CR-003-sqlite-primary-pg-compat.md)
- 架构决策：[ADR-003 仓储抽象与 PostgreSQL 检索](adr/ADR-003-postgres-retrieval.md)
- Outbox 契约：[ADR-004 Outbox + 幂等作业](adr/ADR-004-outbox-idempotent-jobs.md)
- 流式协议：[STREAMING_PROTOCOL.md](STREAMING_PROTOCOL.md)
- 产品需求数据模型：[PRD §8 数据模型](PRD.md#prd-data)

---

## 14. PRD 全量数据模型覆盖清单

> 本清单以 [PRD §8](PRD.md#prd-data) 为全生命周期基线，逐实体标注**交付阶段**与**实现状态**，用于追踪数据库设计对 PRD 的覆盖。约定：
>
> - **阶段**：`MVP`（R1）/ `MVP+`（R1.5）/ `P1`（R2）/ `P2`（R4）/ `P3`（R5）/ `PG`（PostgreSQL 启用后，CR-003 范围外）。
> - **实现状态**：`已落表`（当前 SQLite schema 已有）／ `已建模`（本文档 §3/§4/§5 有规划表或规划列）／ `未落表`（仅 PRD 定义，进入规划 backlog）。
> - 当前 SQLite 真源在原有业务表基础上包含 8 张 CAP-033 控制/捕获表和 17 张主动派生/连接表（共 84 张业务表，含独立账本 recovery_control_ledger）+ 2 张 FTS5 虚表；本地 Vault、十二项派生、HA/健康连接骨架已落地，生产 OS/出网/厂商兼容门禁、双引擎迁移与完整 TC 仍待补齐，并走 `CR-*`。

### 14.1 用户域 Identity（PG 启用后 · CR-003 范围外）

| PRD 实体 | 阶段 | 实现状态 | 说明 / 对应表 |
|---|---|---|---|
| User | PG | 已建模 | §4 `users`；`subject_user_id` 在 SQLite 阶段为本地标识字符串 |
| Workspace | PG | 已建模 | §4 `workspaces`；组织级 workspace，SQLite 阶段不建 |
| WorkspaceMember | PG | 已建模 | §4 `workspace_members`；RBAC 角色边界，P3 组织模式复用 |
| ConsentGrant | MVP | 已落表 | `consent_grants`（未撤销授权条件唯一）；SQLite 阶段先建，PG 阶段升级 |
| UserPreference | PG | 未落表 | 时区/语言/人格/提醒/日记/无障碍偏好，独立可版本化；安全规则不可覆盖 |
| user_profiles | PG | 已建模 | 本文档 §4 新增规划表（PRD 无独立实体），承载人格问卷/偏好 JSONB，不与 PRD §8 冲突 |

### 14.2 会话域 Conversations

| PRD 实体 | 阶段 | 实现状态 | 说明 / 对应表 |
|---|---|---|---|
| Session | MVP | 已落表 | `sessions` |
| Message | MVP | 已落表 | `messages` 身份表（currentVersionId/label/deletedAt）；`message_versions.message_id` 已加可空列，存量数据待迁移 |
| MessageVersion | MVP | 已落表 | `message_versions`（已补 messageId/supersededAt，可空待迁移） |
| Turn | MVP | 已落表 | `turns`（缺 requestHash/acceptedAt/cancelledAt/completedAt） |
| TurnAttempt | MVP | 已落表 | `turn_attempts`（leaseId/fencingToken，turn+attempt 唯一） |
| TurnStreamEvent | MVP | 已落表 | `turn_stream_events`（已补 attemptId/safetyDecision/visibilityRevision/committedAt） |

### 14.3 学习 · 练习 · 复习域

| PRD 实体 | 阶段 | 实现状态 | 说明 / 对应表 |
|---|---|---|---|
| LearningGoal | MVP | 已落表 | `learning_goals`（topic/level/availableMinutes/status/idempotencyKey；非空幂等键按工作区/数据主体唯一，归档不删除学习事实） |
| Question | MVP | 已落表 | `questions`（sourceArtifactId 应用层维护；可选 knowledgeId 关联知识点） |
| QuestionAttempt | MVP | 已落表 | `question_attempts` 不可变事实（judgement/evidence/idempotencyKey，仅追加；非空幂等键按工作区/数据主体/题目唯一） |
| KnowledgeItem | MVP | 已落表 | `knowledge_items`（sourceStatus/masteryState、correctCount/wrongCount/correctStreak/mastery、masteryBasis） |
| ReviewItem | MVP | 已落表 | `review_items`（`schedulerVersion` 为数值，MVP 值为 `1`；活动项条件唯一，status='active'） |
| Feedback | MVP | 已落表 | `feedback`（actorId 与数据主体分离） |
| ConversationBranch | P1 | 已落表 | `conversation_branches`（parentSessionId/forkAtMessageId/childSessionId） |
| KnowledgeRelation | P1 | 已落表 | `knowledge_relations`（fromKnowledgeId/toKnowledgeId/relationType/source/confidence） |

### 14.4 记忆域 Memory

| PRD 实体 | 阶段 | 实现状态 | 说明 / 对应表 |
|---|---|---|---|
| MemoryRecord | MVP/MVP+ | 已落表 | `memory_records`（layer=ephemeral/short_term 属 MVP，long_term 属 MVP+）；已补 currentRevisionId/sensitivityClass/aiRecallUntil/userRetentionUntil/verificationStatus |
| MemoryRevision | MVP | 已落表 | `memory_revisions`（content/confidence/importance/algorithmVersion，不物理覆盖） |
| SourceArtifact / SourceRevision | MVP | 已落表 | `source_artifacts` + `source_revisions`（真实外键，occurredAt 与 ingestedAt 分离，删除保留 tombstone） |
| MemoryEvidence | MVP | 已落表 | `memory_evidence`（memoryRevision ↔ source，来源删除不级联保留 tombstone） |
| MemoryEvent | MVP | 已落表 | `memory_events`（生成/晋升/衰减/锁定/冲突/失效/删除审计） |
| MemoryNode | P1 | 已落表 | `memory_nodes` 投影节点（label/nodeType/confidence/projectionVersion），投影层与记录层分离 |
| MemoryProjectionOverride | P1 | 已落表 | `memory_projection_overrides`（已迁移到 node 级：nodeId/operation/label/parentNodeId/actorId/status） |
| MemoryEdge | P1 | 已落表 | `memory_edges`（已迁移到 node 级：fromNodeId/toNodeId/confidence/visibilityScope/status） |
| MemoryEdgeEvidence | P1 | 已落表 | `memory_edge_evidence`（edgeId ↔ memoryRevisionId 证据关联） |
| EmbeddingIndex | MVP+ | 已落表 | `embedding_indexes`（sourceArtifactId/sourceRevisionId/modelId/dimension/indexVersion） |
| MemoryAlgorithm | P1 | 已落表 | `memory_algorithms`（系统级：stage/schemaVersion/thresholds，仅 active 生效） |

### 14.5 日记域 Diary

| PRD 实体 | 阶段 | 实现状态 | 说明 / 对应表 |
|---|---|---|---|
| Diary | MVP+ | 已落表 | `diaries`（已补 cycleId/currentVersionId/status） |
| DiarySchedule | MVP+ | 已落表 | `diary_schedules` 计划主实体（scheduleEpochId/nextRunAt/lastCutoffAt/cutoffRule/bufferMinutes/contentScopes/quietHours） |
| DiaryScheduleRevision | MVP+ | 已落表 | `diary_schedule_revisions`（已补 scheduleId/contentScopes/quietHours/effectiveAt） |
| DiaryCycle | MVP+ | 已落表 | `diary_cycles`（已补 sourceWindowStart/sourceWindowEnd/timezoneSnapshot/bufferClosedAt/cursorCommittedAt） |
| DiaryRunAttempt | MVP+ | 已落表 | `diary_run_attempts`（已补 leaseId/fencingToken/idempotencyKey/errorCode） |
| DiaryVersion | MVP+ | 已落表 | `diary_versions`（perspective/content/modelRunId/supersededAt，版本不覆盖历史） |
| DiaryParagraphSource | MVP+ | 已落表 | `diary_paragraph_sources`（diaryVersionId/paragraphIndex/sourceArtifact/sourceRevision/permissionSnapshot） |
| DiaryMaterialBuffer | MVP+ | 已落表 | `diary_material_buffers`（occurredAt/ingestedAt/expiresAt/ephemeralSnapshot，不可被普通对话召回） |

### 14.6 内容 · 资源 · 生态域

| PRD 实体 | 阶段 | 实现状态 | 说明 / 对应表 |
|---|---|---|---|
| Attachment | MVP+ | 已落表 | `attachments`（objectKey/mediaType/size/scanStatus/sourceLicense，大对象存对象存储） |
| ExternalSource | P2 | 已落表 | `external_sources`（provider/externalId/permissionScope/syncState/revokedAt） |
| Plugin / PluginGrant | P2 | 已落表 | `plugins`（系统级：publisher/version/checksum/permissions/installSource）+ `plugin_grants`（未撤销授权条件唯一） |
| CommunityContent | P3 | 已落表 | `community_contents`（authorId/type/reviewState/visibility） |
| Organization | P3 | 已落表 | `organizations`（ownerId/memberScope/policyVersion） |

### 14.7 运营 · 平台域

| PRD 实体 | 阶段 | 实现状态 | 说明 / 对应表 |
|---|---|---|---|
| OutboxEvent | MVP | 已落表 | `outbox_events` |
| Notification | MVP | 已落表 | `notifications`（复习/日记/计划提醒，受免打扰与撤销约束） |
| ScheduledJob | MVP | 已落表 | `scheduled_jobs`（日记/记忆/OCR/嵌入/通知任务可见状态） |
| ModelRun | MVP | 已落表 | `model_runs`（provider/modelId/promptVersionId/contextManifestId/latency/tokenUsage/cost，不复制敏感 Prompt） |
| PromptVersion | MVP | 已落表 | `prompt_versions`（系统级无租户列，purpose+version 唯一） |
| ContextManifest | MVP | 已落表 | `context_manifests`（sourceArtifact/sourceRevision 外键 + permissionSnapshot） |
| ToolPolicy | MVP | 已落表 | `tool_policies`（系统级：purpose/toolName/approvalMode/timeoutMs/quota，purpose+toolName+version 唯一） |
| EvalSet | MVP+ | 已落表 | `eval_sets`（系统级：purpose/version/language/domain/sampleCount/annotationPolicy） |
| AnalyticsEvent | MVP | 已落表 | `analytics_events`（analyticsSubjectId 伪名化 + eventSchemaVersion + privacyClass） |
| SafetyIncident | MVP | 已落表 | `safety_incidents`（访问受限，不写入普通记忆/分析明细） |
| AuditRecord | MVP | 已落表 | `audit_records`（actorType/actorId 与数据主体分离） |
| DeletionRequest | MVP | 已落表 | `deletion_requests`（scope/idempotencyKey/ownerModule/lastVerifiedAt） |
| DeletionTarget | MVP | 已落表 | `deletion_targets`（requestId+targetType+targetId 复合主键，不含正文） |
| RecoveryControlLedger | MVP | 已落表 | `recovery_control_ledger`（独立故障域账本，独立 client/文件，sequence 单调 + idempotency 唯一） |

### 14.8 人格 · 技能 · MCP 域（CAP-019/CAP-020）

| PRD 实体 | 阶段 | 实现状态 | 说明 / 对应表 |
|---|---|---|---|
| Persona | P1 | 已落表 | `personas`（name/description/source/status/currentRevisionId，删除=归档） |
| PersonaRevision | P1 | 已落表 | `persona_revisions`（config JSON + checksum，personaId+revision 唯一，不可变修订） |
| ActivePersonaSelection | P1 | 已落表 | `persona_selections`（每租户一行条件唯一，激活 upsert） |
| WorkspaceSkill | P2 | 已落表 | `workspace_skills`（Anthropic SKILL.md 元数据 + filesJson base64 + checksum；导入不执行脚本） |
| McpTool | P2 | 已落表 | `mcp_tools`（serverId+name 租户内唯一；授权/健康/kill switch 状态） |
| McpServer（连接配置） | P2 | 已落表 | `mcp_servers`（系统级无租户列：transport/endpoint/本地 Token 与同步状态；同步出的远程工具以 `mcp__<serverId>__<toolName>` 落 `tool_registrations`，category=external；Port 为 `IMcpServerRepository`） |
| PersonaTurnContext | P1 | 已落表 | `persona_turn_contexts`（turnId 租户内唯一；revision/prompt checksum + skill/mcp 引用，不含完整 Prompt） |

领域 Port 由主仓 `apps/api/src/modules/persona` 定义（`PersonaRepository` / `SkillRepository` / `McpToolRepository`；原 `modules/persona-plugin` 子模块已于 2026-08-28 移除，去模块化收尾见 §4.2），主仓
`@aervox/database` 提供 SQLite 实现并通过 `apps/api` 适配器接入；数据库表与 Repository Port 是持久化事实源。

### 14.9 主动智能模式域（CAP-033）

| PRD 实体 | 阶段 | 实现状态 | 说明 / 对应表 |
|---|---|---|---|
| ProfileAuthorizationRevision | P3 | 已落表 | `proactive_profile_revisions`；版本化 full_profile manifest、desired/status、device 和 local-only 边界 |
| DeviceCapabilityGrant | P3 | 已落表 | `proactive_source_grants`；来源/purpose/scope/OS 回执可独立撤销 |
| LocalActivationLease | P3 | 已落表 | `proactive_activation_leases`；epoch/heartbeat/expiry/localReady/fullAccessSnapshot |
| RawCaptureSegment | P3 | 已落表 | `proactive_captures`；七天 retention + distillationStatus/记忆引用 |
| ProfileClaim | P3 | 已落表 | `proactive_profile_claims`；画像状态、置信度、证据和 grant provenance |
| BehaviorObservation | P3 | 已落表 | `proactive_observations`；来源授权、规范化载荷、算法版本和 local-only 边界 |
| ProactiveAction | P3 | 已落表 | `proactive_actions`；local/external/privileged/irreversible 动作授权与结果 |
| ProactiveAuditEvent | P3 | 已落表 | `proactive_audit_events`；授权、恢复、动作、撤权、导出和删除审计 |

上述表已在 `packages/database/src/schema/proactive.ts` 和 `schema/init.ts` 建立结构/初始化骨架；完整采集适配器、Provider 本地证明、删除 Worker 和双引擎迁移仍待实现，不能据此宣称 CAP-033 已发布。

### 14.10 主动智能派生与外部连接域（CAP-033～035）

| 逻辑实体 | 状态 | SQLite 真源与约束 |
|---|---|---|
| PersonalTimeline / Project / Relationship / Commitment | 已落表 | `proactive_timeline_events`、`proactive_projects`、`proactive_relationships`、`proactive_commitments`；正文加密，按 tenant/revision 隔离 |
| Workflow / TriggerRule / TriggerEvent | 已落表 | `proactive_workflow_templates`、`proactive_trigger_rules`、`proactive_trigger_events`；触发原因本地加密，事件 ID 去重 |
| ActionVerification / ClaimConflict / PreparationBundle | 已落表 | `proactive_action_verifications`、`proactive_claim_conflicts`、`proactive_preparation_bundles`；关联动作、声明、项目或承诺 |
| AttentionState / DriftSignal / SceneSnapshot / ReviewReport | 已落表 | `proactive_attention_states`、`proactive_drift_signals`、`proactive_scene_snapshots`、`proactive_review_reports`；支持小时窗口和日/周周期幂等 |
| ExternalConnection | 已落表 | `proactive_external_connections`；provider/endpoint/scopes 明文最小化，display/settings/error/credential 使用 Vault cipher，API 不回显 credential |
| HomeEntity | 已落表 | `proactive_home_entities`；`connectionId+entityId` 唯一，默认 `enabled=false`，保存 service 白名单与受限状态属性 |
| HealthSample | 已落表 | `proactive_health_samples`；`tenant+connection+metric+localDate` 唯一，只保存步数、睡眠分钟、静息心率和最小元数据 |

实现真源：[proactive-intelligence.ts](../../packages/database/src/schema/proactive-intelligence.ts)、[proactive-intelligence-repository.ts](../../packages/database/src/repositories/sqlite/proactive-intelligence-repository.ts) 与 [init.ts](../../packages/database/src/schema/init.ts)。连接删除先停止运行时，再删除 `proactive_external_connections` 及对应 HA 实体/健康样本；导出不包含连接凭据。

### 14.10 未覆盖结论与下一步

- 当前已落表 **85 张业务表** + 2 张 FTS5 虚表（含独立账本 recovery_control_ledger、CAP-033 八张控制/捕获表和 CR-024 十七张派生/连接表），覆盖 PRD §8 除 PG 用户域外的**全部核心与扩展实体**；未落表仅剩：`UserPreference`（PG 级）与 PG 用户域（User/Workspace/WorkspaceMember/user_profiles，CR-003 范围外）。CAP-033～035 的本地 Vault、十二项派生、HA/健康连接、来源/连接级删除和导出已落地；生产 OS/出网/厂商兼容与双引擎迁移仍待完成。
- **MVP（R1）+ MVP+（R1.5）优先队列已完成**：学习/反馈/会话补齐/溯源/记忆/平台/安全/隐私/埋点/内容/日记域实体全部落表（含 ToolPolicy/AnalyticsEvent/EvalSet、DiarySchedule 等日记域补表、Attachment/EmbeddingIndex、Persona/Skills/MCP 6 张人格域表）。
- **P1（R2）已完成**：`MemoryNode`/`MemoryEdgeEvidence`/`MemoryAlgorithm`（记忆树投影独立化，memory_edges/overrides 已迁移到节点级）、`ConversationBranch`、`KnowledgeRelation` 已全部落表。
- **P2/P3 扩展已完成**：`ExternalSource`、`Plugin`/`PluginGrant`、`CommunityContent`、`Organization` 已全部落表（为生态/社区功能预留）。
- 每张新表上线前必须在 [schema/](../../packages/database/src/schema) 建表、在 [repositories/types.ts](../../packages/database/src/repositories/types.ts) 补 Port 签名、在 §11 登记 TC，并同步更新本文档 ERD 与本文清单状态。
