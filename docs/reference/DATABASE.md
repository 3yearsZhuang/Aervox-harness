---
id: AVX-DB-001
---

# Aervox｜思隅 SQLite 本地单用户数据库契约

本文规定 Aervox 持久化层的目标契约、机器事实源、关键不变量、破坏性迁移协议和发布门禁。
表结构与字段的唯一目标真源是 `packages/schema/src/*.ts`，由仓储的 Schema manifest 编译实际 SQLite 建库语句；本文不复制每张表的完整定义。历史手写 DDL 仅保留为旧库升级测试夹具，不能继续维护第二套目标结构。

> [!IMPORTANT]
> `CR-030`（已归档） 的决策为 Accepted、交付状态为
> Implemented。最终 Schema/DDL 和数据库消费者已完成去租户化；`LocalContext` 仅作为不参与持久化的
> 兼容调用参数保留，生产发布仍受迁移编排、回滚演练和完整 DSH 环境门禁约束。

## 1. 适用范围与不变量

1. **唯一业务真源**：SQLite（LibSQL）WAL 模式是永久本地业务真源，不再规划 PostgreSQL、
   RLS、pgvector 真源或双数据库切换。
2. **单用户实例**：一个数据库归属于一个操作系统用户的数据目录；不支持多个不互信用户共享。
3. **双包边界**：`@aervox/schema` 负责表结构；`@aervox/repositories` 负责连接、DDL、迁移、
   Repository Port 和 SQLite 实现。禁止恢复 `@aervox/database` 巨型兼容包。
4. **事实与派生分离**：消息、作答、来源修订和授权是事实；摘要、掌握度、记忆树、日记、FTS
   和向量索引是可追溯或可重建的派生数据。
5. **来源先行**：派生结果必须关联 `SourceArtifact`/`SourceRevision` 或类型化外键；删除或撤权后
   立即失去召回与动作资格。
6. **时间语义明确**：持久化时间点使用 UTC ISO-8601；用户日界线另存 IANA 时区快照。
7. **写者连接**：事务写、迁移、CAS 和事务后断言使用写者连接；不得依赖其它连接的即时快照刷新。
8. **迁移可恢复**：普通迁移优先兼容演进；CR-030 的删列属于批准的破坏性迁移，必须构建新库、
   校验并原子换库，禁止在活动库上循环 `DROP COLUMN`。

## 2. 机器事实源与包边界

| 事实 | 机器维护入口 | 约束 |
|---|---|---|
| Drizzle 表和字段 | `packages/schema/src/*.ts` | D2 后不得出现 `workspaceId`、`subjectUserId` 或租户复合索引 |
| SQLite 目标结构与版本 | `packages/repositories/src/schema/manifest.ts` | 从 Schema 编译新库；比对列、默认、NULL、主键、外键、唯一约束及索引的列/表达式、排序、collation 和条件，校验版本和 fingerprint。结构不一致先拒绝启动，不在活动旧库自动变更 |
| Repository Port | `packages/repositories/src/repositories/types/*.ts` | D2 后公开签名不得要求 `TenantContext` |
| SQLite Repository | `packages/repositories/src/repositories/sqlite/*.ts` | 不得绕过来源、授权、删除和幂等规则 |
| 连接与路径 | `packages/repositories/src/client.ts` | 只接受本地文件或显式内存 URL；禁止远程 LibSQL URL |
| 迁移器 | `packages/repositories/src/migration/` | CR-030 迁移状态、计划、备份与恢复逻辑的唯一代码入口 |

业务模块只消费 Repository Port，不直接导入 Drizzle 表。需要事务原子性的组合写由仓储层提供明确方法，
不得把裸连接或方言错误码泄露给 API、Worker 或 UI。

### 2.1 结构升级与逻辑恢复

新库由 `initDatabaseSchema` / `initLedgerSchema` 初始化对应故障域，并记录版本指纹。已有库在任何结构写入前检查完整等价性；缺失列、NULL 主键、默认值或索引条件等不一致返回 `SCHEMA_STAGING_MIGRATION_REQUIRED`。无版本但完全等价的库可登记当前版本；已登记版本或指纹不符必须显式迁移。不能通过刷新指纹绕过历史数据检查。

当前检查已覆盖列、主/外键和索引语义，但表级 CHECK、STRICT、WITHOUT ROWID 差量仍有漏检；版本登记不能单独证明完整结构等价。这些隔离反例继续由 [ITER-071](../../plan.md#iter-071)整改，生产迁移不能据现有检查外推验收。

`migrateDatabaseViaStaging` 是现行显式重建入口：调用者先停止全部写者与连接，验证备份，再在独立 staging 导入、校验并换库。所有数据保留原身份；未知表/列、NULL 主键、唯一冲突、外键损坏和行数变化均阻断，不删除或选择胜者。操作步骤见[迁移演练](../how-to/run-database-migration-drill.md)。失败保留源文件、备份与 staging 证据；主库、Vault、独立账本及密钥仍须作为完整回滚集合协调。

旧 journal/ALTER helper 的公共入口已移除，不提供绕过 staging 的通用原地 DDL。结构检查使用独立空库编译预期索引语义，不在被检查库创建临时结构或修复漂移；版本迁移与整体中断恢复仍按 ITER-011 验收。

逻辑导出通过 `@aervox/repositories/sync` 显式消费；不导出 FTS 虚表、shadow 表及结构版本元数据。`restoreSnapshot` 的原地删表写回接口已撤下，`restoreSnapshotToEmptyStaging` 只接受空目标，在同一事务导入并检查关系与行数。不可将它用于活动库或取代停写、备份和换库编排；派生索引由已保留的权威来源重建。

## 3. 本地存储拓扑

默认数据目录位于当前操作系统用户的应用数据目录；仓库开发模式可使用 `<repo>/data/`。路径可以配置，
但必须是本地文件系统路径。

当前仓库运行的主库缺省为 `<repo>/data/aervox.db`。显式 `aervox.db`、`./aervox.db` 及其 `file:` 形式也解析到该默认目录；其它相对文件路径按仓库根解析，与 API、Worker 或子包的启动目录无关。绝对文件路径保持原位置，`file:` URI 的编码、参数和 authority 保持 URI 语义，非法远端 authority 由本地文件校验拒绝。显式 `:memory:` 和 `file::memory:` 保持内存库，不创建持久文件。该解析不搬迁或合并已有数据库；切换已有数据的位置须显式备份并验证。

| 存储 | 用途 | 边界 |
|---|---|---|
| `aervox.db` | 普通业务事实、派生数据和 Outbox | SQLite WAL；当前操作系统用户私有 |
| proactive Vault | CAP-033 原始捕获、画像、连接凭据 | 独立加密边界，不进入普通日志/分析/远程模型 |
| RecoveryControlLedger | 删除、同意撤销、插件/外部授权撤权 | 独立凭据与故障域，只存最小 deny 证明 |
| attachments/exports | 附件、可读导出和迁移导出包 | manifest + checksum；不与数据库事务假装原子 |
| backups/ | 一致性备份与 CR-030 rollback 包 | 默认用户私有；清理受保留策略和验证门禁约束 |

POSIX 权限目标为目录 `0700`、数据库/状态清单/token `0600`；Windows 使用当前用户专属 ACL。

## 4. 领域数据模型

最终无租户 Schema 按以下领域维护；完整表清单由 `packages/schema/src` 导出与自动化测试守卫保障。

| 领域 | 关键事实 | 关键派生/控制 |
|---|---|---|
| Conversation | sessions、messages、message_versions、turns、turn_attempts | turn_stream_events、conversation_branches、tool_executions、pending_user_questions、tool_approvals、safe_segments、agent_inbox_items、subagent_runs |
| Learning | learning_goals、questions、question_attempts、knowledge_items | review_items、knowledge_relations、practice_reports、learning_plans、plan_milestones、plan_tasks、mistake_dispositions、mistake_insights、practice_sessions、study_materials |
| Memory | source_artifacts/revisions、memory_records/revisions/evidence | memory_nodes/edges、memory_embeddings、memory_compaction_markers、FTS |
| Diary | diary_schedules/revisions、diary_cycles、diary_run_attempts | diaries/versions/paragraph_sources、diary_material_buffers |
| Content | attachments、attachment_parse_results、provenance | OCR、全文与向量派生索引（embedding_indexes） |
| Plugin/Persona | plugins、plugin_grants、personas/revisions、skills、MCP | plugin_configs/secrets/pages、persona_turn_contexts、workspace_skills、mcp_tools |
| Platform | consent_grants、audit_records、deletion_requests、outbox_events | model_runs、context_manifests、notifications、llm_configs、audit_logs、llm_health_snapshots、llm_routing_events |
| Proactive | profile revisions、device/source grants、activation leases、perception events | captures、observations、claims、actions、SituationModel snapshots、consumer cursors、attention budgets/feedback/receipts |
| Project | projects（项目上下文实体） | sessions.projectId 关联 |
| Sync | 无（不承载业务事实） | sync_row_state（P2P 同步来源戳与删除墓碑，由同步触发器维护） |
| Voice | voice_configs、voice_input_configs、voice_remote_configs | 本地/远程语音转写与合成配置 |

`User` 仅表示本地用户档案，不是共享数据库认证主体。`actorId` 表示用户动作、插件、连接器或系统任务，
用于授权来源和审计，不承担行级租户隔离。

## 5. 字段与唯一性约定

### 5.1 公共字段

- 业务身份使用稳定文本 ID；不依赖 SQLite `rowid` 决定业务胜者。
- 需要审计的实体保留 `createdAt`/`updatedAt`；软删除使用 `deletedAt` 或显式状态。
- JSON 字段必须有版本或 schema 校验；无法解析的旧值在迁移时产生冲突报告，不得丢弃。
- `actorId`、deviceId、revisionId、sourceGrantId 和 policyVersion 只在对应业务需要时出现。

### 5.2 关键唯一约束

| 业务面 | 最终唯一范围 |
|---|---|
| Turn 幂等 | `idempotencyKey` 或契约规定的业务作用域 + key |
| QuestionAttempt 幂等 | question/operation scope + `idempotencyKey` |
| 自动日记 | `localDate` 且 `autoGenerated=true` |
| 活动复习项 | `knowledgeId` 的单个活动状态 |
| 插件配置 | `pluginId` |
| Persona 激活 | 单个本地活动选择 |
| 主动画像 | 单个有效 profile revision/activation epoch |
| 健康样本 | connection + metric + localDate |

如果旧库在用户选中的单一数据范围内违反最终唯一约束，CR-030 迁移必须停止并输出冲突报告。
不得自动修改幂等键、撤销授权、归档日记或删除较旧记录。

### 5.3 事实、来源与投影

`Session`、不可变 `MessageVersion` 和 `QuestionAttempt` 是学习事实；摘要、掌握度、记忆树与日记不得反向覆盖它们。压缩、纠错、合并产生新的 Memory/Diary 修订，不覆盖旧证据。来源通过 `SourceArtifact/SourceRevision` 或类型化关联表建立真实外键；`occurredAt` 用于业务窗口，`ingestedAt` 用于迟到、重放和管道审计，不能互换。`actorId` 记录动作来源，不冒充用户事实。

系统记忆只由有效长期记忆重建。用户锁定、改名和父节点调整写入 `MemoryProjectionOverride`，先重建投影，再叠加有效覆盖；算法重建不能丢弃用户操作。覆盖与已删来源或无效父节点冲突时进入用户可见的待解决状态。层级只有一个 canonical parent 且无环，跨主题关系使用独立边并继承来源可见性，证据经外键关联。

上述语义是持久化契约，不表示每个概念实体均已有物理表或完整验收；字段真源仍是 Schema，实现与限制由对应 PR 证明。召回期限与用户历史保留独立，不能用临时记忆 TTL 删除仍获保留的会话历史；分类、删除 SLA 与保留期以[隐私规范](DATA_PRIVACY.md)为准。

## 6. Repository Port 契约

Repository Port 仍可保留首参 `LocalContext`，由宿主构造；部分实现沿用 `ctx` 或 `tenant` 参数名，但这些值不参与持久化分区或数据归属判定。不得恢复 `TenantContext`、租户列或客户端身份头。以下原则保持不变：

- 读方法明确返回 `null`/空列表或领域错误；不得用租户不匹配模拟 404。
- 写方法在单个 SQLite 事务内完成事实、Outbox、CAS/fencing 和必要控制投影。
- 插件、来源、授权和删除仍由显式业务参数及 Repository 检查，不因移除 `TenantContext` 而跳过。
- 后台 Job 携带业务实体 ID、来源修订、授权版本和幂等键，不携带伪造的本地租户常量。
- `actorId` 只用于授权和审计；不能改变事实所属来源或绕过删除水位。

接口调整以当前类型声明和消费者为准；移除兼容参数不能顺带改变授权、审计或删除语义。`LocalContext` 与已移除的 `TenantContext` 不是同一合同。

SSE 传输使用独立的有界分页接口，Resume 等全历史读取保持原语义。关闭订阅时，全部 Attempt 是否终态与事件高水位由同一 SQLite 语句快照读取，防止旧终态截断已开始的审批续接；页大小、超大单事件和快照之后新续接的边界见[流式协议](STREAMING_PROTOCOL.md#22-读取事件流)。

### 6.1 CR-033 F0/F1 主动智能基础设施

`CR-033`（已归档） 当前只交付默认关闭的
F0/F1 存储底座，不改变 CR-032 生产读写路径。其 Repository 必须保持以下不变量：

- 感知事件 sequence 在单条写语句中分配；重复 event ID 或幂等键不得生成第二条事实；
- 压缩上限不得越过任何未过期消费者的最小 ACK，且消费者不存在时不自动删除；
- SituationModel 写入前校验版本、结构与大小；同 revision/sequence 不允许用不同 checksum 覆盖；
- 态势水印清理只删除目标水位之前的快照，重建时快照正文、水印、checksum 和行级字段同步推进；
- 预算反馈先写幂等账本，再与预算 CAS 更新在同一事务提交；插件预算与全局预算均通过才允许派发；
- F0/F1 表允许兼容新增，不允许仅因关闭 Feature Flag 而删表；后续运行时接线、迁移和退役旧管线须另行评审重大边界 ADR。

### 6.2 CR-034 / CR-042 本地模型路由与健康探测基础设施

`CR-034`（已归档） 与 `CR-042`（已归档） 引入本地模型三层降级（L0 / L1 / L2）与健康探测审计存储。其 Repository `IModelRoutingRepository` 遵循以下原则：

- `llm_health_snapshots` 记录端点探活快照，以 `presetId` 为主键，覆盖延迟、错误类别与时间戳；
- `llm_routing_events` 记录每次降级与切回事件，保留会话 ID、起止层级、预设、决策原因与元数据，支持按会话或时间倒序审计排查；
- 写入均通过写者连接完成，与对话回合执行解耦异步排入或事务随行，不阻塞主对话流。

### 6.3 日记周期、时区与原子发布

日记窗口及计划修订决定见 [ADR-011](adr/ADR-011-diary-cycle-schedule-revision.md#decision)。`DiaryCycle` 是窗口真源，`DiaryScheduleRevision` 是不可变计划快照，`DiaryRunAttempt` 只表示可重试执行；`Diary` 是用户可见叙事，段落保存来源修订和生成时权限快照。Buffer 关联 `cycleId`，不得用 `localDate` 替代窗口身份或被普通对话召回。

- `nextRunAt`、`lastCutoffAt` 使用 UTC，另存 IANA 时区与启用/授权提交时的 `initialWindowStart`。Scheduler 每分钟批量领取到期记录，不为每个计划注册长期 Cron；Job 携带业务实体、来源修订与幂等键，有限重试、取消和死信处理不能缺席。
- 普通窗口为 `(previousCutoffAt, cutoffAt]`，首次启用/重启为 `[initialWindowStart, cutoffAt]`；归属只按 `occurredAt`。生成前冻结窗口、来源 ID/版本、发生/入库时间与权限。自动日记每天至多一个身份，日期仅是 cutoff 的时区标签，不代表零点分片；同日标签冲突顺延到下个合法未占用标签，不覆盖旧版本或推进虚假 cursor。
- 默认迟到宽限为 **30 分钟**，`bufferClosedAt = cutoffAt + 30m`；初版不等待宽限结束，须在设定时间后 **15 分钟内发布**。宽限内入库且发生在该窗口的迟到素材仅形成用户可见补写候选，确认后生成新版本；关闭后不自动改写或生成候选。只有 `occurredAt > cutoffAt` 进入下一周期；下界之前的历史迟到仅可显式关联原周期或忽略。当前窗口已授权素材不因临时记忆 TTL 提前丢失。
- 已领取窗口冻结，计划/时区变更从下一合法 cutoff 生效，既不重叠也不留空洞；未领取窗口的 CAS 重算、同日碰撞审计和显式排除区间遵循 ADR-011。停用结束当前 epoch，重启创建新 epoch，默认不补停用期间资料。DST 缺口取下个合法时点，重复时点只执行一次并保存解析快照。
- 领取和提交检查计划版本、授权修订、cursor 与 lease/fencing。只有 `Published` 或具备原因、操作者和时间证据的 `Skipped`，才与日记引用、cursor 和 Outbox 在同一写者事务提交；失败、取消、过期 Worker 不推进 cursor。空日记若已发布仍是 `Published`，不能为疏通队列静默跳过。实际枚举以 Schema 为准，历史 ADR 的存储语法不恢复到当前 SQLite。
- 发布前验证失败须保持可见失败与重试/死信状态，不产生重复版本；保存成功才发送通知。quiet hours 只延迟或合并通知，不改变 cutoff、生成和发布 SLO。撤权使未执行任务与素材失效，账本水位未追平不能领取、读 Buffer 或发布。
- 宕机跨多个截止点时按 cutoff 从旧到新独立补跑，不合并或静默跳过；超过已批准 `maxCatchUpCycles` 转为可见待决定状态。用户编辑或确认的内容才能产生记忆候选，日记不自动写入系统记忆。

窗口链、DST/tzdata、重复任务、lease 到期、停机补跑与迟到边界均需独立验证；已有 CAS 或按需生成测试不代表完整定时调度验收。

### 6.4 CAP-033 实体准入

画像授权修订、设备/来源 Grant、激活租约、原始捕获、观察、画像声明、动作和审计均在独立本地处理边界内。来源、授权和处理边界贯穿全部派生实体，不能只保护原始捕获：普通 Outbox、远程对象存储、远程模型和分析均不得成为旁路，用户显式导出才允许数据离开。

使用前复核设备、授权 revision、来源 Grant、激活 epoch、期限与撤权状态；OS 权限回执不等于产品授权。新增来源或用途须重新确认。原始捕获按 `observedAt + 7 天` 计算保留期限，只有到期且对应记忆提炼已提交才可物理清理，保留来源哈希、授权修订与证据链；删除/撤权先立即阻断使用，传播与例外遵循[隐私规范](DATA_PRIVACY.md)。

## 7. FTS、向量与递归查询

- SQLite FTS5 只保存可重建全文索引；来源删除/撤权后立即从查询面屏蔽，并在 SLA 内重建或清除。
- 向量实现通过 `VectorSearchPort` 解耦；Embedding 记录来源修订、模型、维度和索引版本。
- 记忆树使用 `WITH RECURSIVE`；层级边必须无环，跨主题关系使用显式边。
- FTS、向量和树投影失败不得损坏事实表；降级为关系数据读取或列表检索。

### 7.1 只读向量缓存

[ADR-024](adr/ADR-024-native-runtime-boundaries.md#cr-063) 允许连续数组 Worker/Rust 实现 `VectorSearchPort`，SQLite 仍是唯一真源。只读连接打开写者确认的显式本地数据库，按模型缓存浮点向量，不复制业务正文；每次查询检查 `data_version`，其他连接提交、模型变化或文件替换均使缓存失效，新进程不复用旧缓存。

查询保持余弦、零向量、维度不匹配、阈值及同分稳定顺序；只在水位改变时重新读入与解码，查询 IPC 传向量及 top-K，不逐行调用。内存、记录数、维度、消息、并发和截止均有限额。读入中失去一致性时有界重试或明确失败，不回写业务库。

模型上下文返回前，TypeScript 宿主重新从真源检查来源、用途、授权及删除资格。原生失败可降级到权威 SQLite 查询，禁止返回旧缓存；关闭原生选择不迁移数据。每次提交导致缓存失效的实际成本、IPC 和质量差量均须纳入端到端比较，成熟索引扩展只在隔离基准库试验。操作与测量见[原生组件指南](../how-to/run-native-components.md#2-对照向量音频与插件计算)。

## 8. 删除、撤权与恢复

`RecoveryControlLedger` 是独立凭据、故障域和保留策略下的不可变 deny 事实源，只有最小假名化引用及防篡改证明，不含用户正文，不能与业务 SQLite 假装共享事务。业务投影不得反向覆盖账本。

1. 删除、Consent 撤销、插件及外部授权撤权先用确定性 `eventId/idempotencyKey` 追加账本并取得 durable ack。
2. 业务库再幂等提交 deny 投影、`DeletionRequest`、Targets 与 Outbox；账本成功而业务失败由 reconciler 按单调 sequence 重放，不制造第二次撤权事实。
3. 账本不可用、完整性/签名错误、sequence 缺口或应用水位未追平时，受影响来源 fail closed，不确认操作完成或开放相关写流量。
4. 来源失效立即停止模型召回、FTS/向量、日记派生、插件读取和主动动作；物理清理/重建依[隐私规范](DATA_PRIVACY.md)执行。可保留无正文的 tombstone 证明传播，不得用于恢复、推断或展示已删内容。
5. 备份恢复进入维护/全局 deny，验证账本完整性及水位、幂等重放并重建派生数据；零召回/零越权验证通过后才恢复流量。

Memory 本地删除切片的完成验证必须重新核对正文、关键词及来源引用已清空，修订和证据已处理，摘要墓碑、审计原因、FTS、向量与压缩 Outbox 均符合清理条件。Outbox 仅保留 `memoryId`、可选字符串/空值 `snapshotId` 和布尔 `deleted: true`，状态为 `published`，不得保留其他载荷字段或 `last_error`；畸形嵌套 `snapshotId` 在清理时置空。清理与验证均拒绝未经所属生命周期处理的共享投影。

Memory 压缩事件的失败/死信回写必须在同一原子 UPDATE 中确认事件未标记删除且对应来源存在、未删除，防止已读取的正文通过错误文本重新持久化。该检查不改变其他类型事件的失败处理。记忆修订、证据和事件的新增在同一写者事务内检查所属 Memory 尚未删除；当前修订引用通过单条带存活及归属条件的 UPDATE 写入。子记忆、树边证据及 Skill 候选也不得向已存在的删除墓碑新增关联；已有共享投影继续要求其所属生命周期清理，不由此切片级联删除。

完成证明版本由[共享常量](../../packages/repositories/src/memory-deletion-protocol.ts)定义为 `memory-local-v3`，清理验证器、未验证请求判据及 Worker 审计共用该值。旧版（包括 `memory-local-v2`）completed 证明继续阻断使用，并由 Worker 重新选择全部显式 targets，逐一重新清理、独立验证后更新证明；失败保留关闭状态并可重试。请求和目标身份保留，目标旧证明在重新执行时被替换，既有审计记录不删除。此机制不代表已经对真实用户库运行重验；备份及物理页擦除仍需独立验收。有限实验与复现方法见[归档的记忆删除研究包](https://github.com/3yearsZhuang/Aervox-docs-archive/tree/main/memory-deletion-study)。

### 8.1 P2P 同步行状态与删除墓碑

主库、Vault 和 P2P 身份共享仓库根 `data/` 的默认路径解析器。P2P 首次身份写入 `data/p2p-device-identity.json`；若只有历史 `packages/data/p2p-device-identity.json`，继续原地读取该身份，不自动复制或更换设备。两处同时存在时拒绝默认选择，需用 `AERVOX_P2P_IDENTITY_PATH` 显式指定。自定义路径优先于环境变量；文件保持既有 0600 创建与独占写入规则。

`sync_row_state` 是纯本地 P2P 加密同步（CAP-018 / CAP-027）的元数据表，不是业务事实：

| 字段 | 类型 | 约束 | 语义 |
|---|---|---|---|
| `table_name` | TEXT | 非空，复合主键之一 | 被同步的业务表名（必须属于同步白名单） |
| `primary_key` | TEXT | 非空，复合主键之一 | 该行业务主键的文本形式 |
| `origin_device_id` | TEXT | 非空 | 该行最近一次权威写入的设备 ID（LWW Tiebreaker 依据） |
| `origin_timestamp` | TEXT | 非空 | 该行最近一次权威写入的 UTC ISO-8601 时间戳（LWW 比较依据） |
| `deleted_at` | TEXT | 可空 | 非空即删除墓碑；与 `origin_timestamp` 一起构成删除的比较时钟 |
| `updated_at` | TEXT | 非空 | 元数据自身最后一次写入时间（仅供诊断，不参与裁决） |

不变量：

1. 主键为 `(table_name, primary_key)`；同一业务行在整库只有一条来源记录。
2. LWW 只比较持久化的 `(origin_timestamp, origin_device_id)`，绝不比较本次中继设备，因此结果与同步拓扑、同步次数无关（重复同步为零写入）。
3. 写入与删除**共用同一条裁决规则**：行的比较时钟取 `origin_timestamp`，墓碑的比较时钟取 `MAX(origin_timestamp, deleted_at)`；时间戳大者胜，时间戳相等时来源设备 ID 字典序大者胜，两者都相等则幂等跳过。因此删除只能被**严格更新**的写入撤销，更旧的远端写入绝不复活更新的本地墓碑。
4. 该表由 `installSyncTriggers` 安装的 `AFTER INSERT/UPDATE/DELETE` 触发器维护；`initDatabaseSchema` 只建表，**不自动安装触发器**，调用方必须显式 opt-in。
5. 触发器登记本机写入；远端合并必须在写业务行的**同一事务内最后**写入权威来源，覆盖本机章（顺序不可颠倒）。
6. 表内数据可重建（未安装触发器期间的历史行按行时间戳惰性播种），不属于不可再生事实源。
7. 合并端只接受本地同步白名单内的表，且只使用**本地**表定义（主键、策略、时间列）；对端声明的表身份或列元数据与本地不符时整表拒绝并计入 `rejectedTables`，绝不按对端元数据写入。

## 9. CR-030 破坏性迁移

迁移实现必须逐项遵守 `CR-030 §4`（已归档）：

```text
planned -> quiesced -> backup_verified -> scope_selected
        -> staging_built -> validated -> swapped -> completed
```

核心规则：

- 停止 API 写入口、Worker 和后台 Host，取得独占锁；
- 备份业务库、Vault、恢复账本和相关状态，记录 SHA-256、Schema 版本和逐表行数；
- 零/单数据范围可按规则自动选择；多范围必须由用户明确选择并确认破坏性结果；
- 未选范围只留在已验证备份/导出包，不进入新活动数据库；
- 使用最终 DDL 创建同文件系统 staging 库，按外键拓扑复制选中范围；
- 冲突、损坏 JSON、孤儿外键、行数不符和未知消费者全部 fail closed；
- 完成 integrity/foreign-key/row-count/index/FTS 校验后关闭句柄并原子换库；
- 新库首次开放写流量前完成只读验证；rollback 包至少保留 30 天或 10 次成功启动。

迁移状态清单位于业务数据库之外。中断重启只能继续已证明安全的阶段或恢复原库，不能因为迁移 journal
缺失而把半成品标记为完成。

## 10. 消费者与 unknown-consumer 风险

| 消费者 | 允许入口 | 禁止 |
|---|---|---|
| `apps/api` | 领域 Repository、事务组合方法 | 业务路由直接导入 Schema/Drizzle |
| `apps/worker` | 领域 Repository、Outbox/lease 接口 | 裸 SQL 绕过授权、来源或删除状态 |
| `packages/host-agent`/`diary` | 专用 Port | 依赖数据库方言或文件路径 |
| Web/Desktop/Mobile | OpenAPI/API client | 直接打开 SQLite 文件 |
| 插件/MCP | Host Bridge、ToolPolicy、Grant | 直接数据库、任意文件或网络访问 |

引入新的数据库消费者必须更新导入边界测试、迁移消费者清单与数据责任。CR-030 D1 在开始
备份前扫描已知进程/锁；无法证明消费者已停写时拒绝迁移。

## 11. 测试与发布门禁

| 测试 ID | 必须证明 |
|---|---|
| `TC-MIG-CR030-SINGLE-001` | 单范围旧库完整复制，最终无租户列，逐表行数和来源关系一致 |
| `TC-MIG-CR030-MULTI-001` | 多范围无选择拒绝；明确选择后未选范围仍存在于可验证备份/导出 |
| `TC-MIG-CR030-CRASH-001` | 每个状态转换和文件操作点崩溃后不丢原库、不误报完成 |
| `TC-MIG-CR030-CONFLICT-001` | 重复业务键、孤儿外键、损坏 JSON 输出报告并保持原库不变 |
| `TC-SEC-LOCAL-API-001` | 默认 loopback；open auth + 非 loopback 启动失败 |
| `TC-SEC-LOCAL-FS-001` | 数据、备份、状态和 token 默认仅当前操作系统用户可读 |
| `TC-PRIV-DEL-001` | 删除后 API、FTS、向量、缓存和恢复路径零召回 |
| `TC-RES-LEDGER-001` | 账本失败/重复/乱序/缺口/PITR 水位均 fail closed |

D1～D3 每阶段都必须运行 `mise tasks run ci-code` 与 `mise tasks run ci-docs`，并把实现位置、夹具和执行证据
登记到 `REQUIREMENTS_TRACEABILITY.md`。CR-030 当前已达到 `implemented`；完整运行编排和发布演练通过后才能改为
`released`。

## 12. 兼容、回滚与未来变更

- 普通新增可空列/索引可以采用兼容迁移；删除字段、修改唯一性或改变数据用途须在 PR 中评审迁移；改变数据责任或不可逆边界时记录 ADR。
- CR-030 的旧二进制回滚必须同时恢复迁移前备份；新库产生写入后不得自动降级旧 Schema。
- 备份和导出格式必须可读并带 manifest/checksum，不得要求专有云服务才能恢复。
- 若未来重新引入多人协作、远程同步或 PostgreSQL，必须从身份、冲突、加密、审计和迁移重新设计，
  不得恢复 `workspace_id`/`subject_user_id` 即宣称满足安全要求。

## 13. 当前交付状态

CR-030 的迁移器、无租户 Schema/Repository 和消费者适配已实现，阶段证据统一见[追踪基线](REQUIREMENTS_TRACEABILITY.md)。完整运行编排、停写证明、故障注入及回滚保留仍按发布门禁独立验收；实现完成不等于已迁移真实用户库或正式发布。

## CR-056 插件实现可用性

`plugins.availability` 为非空文本，默认 `available`，允许写入 `available/missing/invalid/unreadable`。由启动清单扫描写入，独立于用户的 `enabled`、配置/Secret、授权及页面数据。旧库通过幂等新增列兼容，保留原记录，不换库、不清理历史表。未知可用性值按不可执行处理。实现缺席时工具执行/导出、Skill 运行时导出、会话插件切面与 Worker 主动规则均须检查该状态；管理读取和显式数据清理继续可用。

恢复有效包只恢复可用性，不重建撤销的授权或启用用户关闭的插件。旧应用不识别该列，不能直接作为缺包保护的回滚版本；回滚须保留等价门控。元数据与 DDL 同步，验证见 CR-056（已归档至 Aervox-docs-archive）。

## ORM 错误边界

Drizzle 0.45 将驱动错误包装在 `cause` 中。锁竞争、连接污染与约束冲突识别从驱动原因读取，不能把 SQL 或绑定参数中的文字当作错误类型。事务回滚测试同时断言原因与回滚后的数据状态。

锁定的 Drizzle 版本应用[错误脱敏补丁](../../patches/drizzle-orm@0.45.4.patch)：错误文案固定为 `Database query failed`，SQL 与绑定值保留为不可枚举诊断属性，避免 API 响应、普通日志和 JSON 序列化携带密钥或正文；底层 `cause` 保留用于内部分类。升级 Drizzle 时必须复查补丁与 ESM/CJS 回归，不能静默丢失此边界。
