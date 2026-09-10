---
id: AVX-DB-002
type: reference
scope: baseline
owner: maintainers
doc_status: review-candidate
decision_status: not-applicable
delivery_status: not-applicable
version: 0.2.0
updated_at: 2026-09-10
reviewed_at: 2026-09-10
review_interval_days: 90
sources:
  - docs/reference/DATABASE.md
  - docs/reference/PRD.md
---

# Aervox｜思隅 数据库数据模型覆盖矩阵（Database Coverage Matrix）

- 提出人：3yearszhuang · 2026-09-10
- 修改人：3yearszhuang · 2026-09-11

关联：[SQLite 本地单用户数据库契约](DATABASE.md)（AVX-DB-001）、[产品需求文档 PRD §8](PRD.md#prd-data)（AVX-PRD-001）、[CR-030](changes/CR-030-pure-local-sqlite-database.md)

本文从 [SQLite 本地单用户数据库契约](DATABASE.md) 拆分而来，作为 PRD 全量数据模型在数据库落表状态的完整附录清单。

## PRD 全量数据模型覆盖清单

> 本清单以 [PRD §8](PRD.md#prd-data) 为全生命周期基线，逐实体标注**交付阶段**与**实现状态**，用于追踪数据库设计对 PRD 的覆盖。约定：
>
> - **阶段**：`MVP`（R1）/ `MVP+`（R1.5）/ `P1`（R2）/ `P2`（R4）/ `P3`（R5）；不再包含 PostgreSQL 启用阶段。
> - **实现状态**：`已落表`（当前 SQLite schema 已有）／ `已建模`（本文档 §3/§4/§5 有规划表或规划列）／ `未落表`（仅 PRD 定义，进入规划 backlog）。
> - CR-030 的目标 Schema 是本地单用户、无租户列的 SQLite；当前代码在 D2 前仍保留旧租户字段。本地 Vault、十二项派生、HA/健康连接骨架已落地，生产 OS/出网/厂商兼容门禁和 CR-030 迁移 TC 仍待补齐。

### 14.1 本地用户档案与同意

| PRD 实体 | 阶段 | 实现状态 | 说明 / 对应表 |
|---|---|---|---|
| User | P2 | 未落表 | 可选本地用户档案，不作为共享数据库认证主体 |
| ConsentGrant | MVP | 已落表 | `consent_grants`（未撤销授权条件唯一）；D2 移除租户列后按 purpose/scope/version 约束 |
| UserPreference | MVP | 已落表 | 本地时区、语言、人格、提醒、日记和无障碍偏好；安全规则不可覆盖 |

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
| PromptVersion | MVP | 已落表 | `prompt_versions`（purpose+version 唯一） |
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
| ActivePersonaSelection | P1 | 已落表 | `persona_selections`（本地单一活动选择，激活 upsert） |
| WorkspaceSkill | P2 | 已落表 | `workspace_skills`（Anthropic SKILL.md 元数据 + filesJson base64 + checksum；导入不执行脚本） |
| McpTool | P2 | 已落表 | `mcp_tools`（serverId+name 唯一；授权/健康/kill switch 状态） |
| McpServer（连接配置） | P2 | 已落表 | `mcp_servers`（transport/endpoint/本地 Token 与同步状态；同步出的远程工具以 `mcp__<serverId>__<toolName>` 落 `tool_registrations`，category=external；Port 为 `IMcpServerRepository`） |
| PersonaTurnContext | P1 | 已落表 | `persona_turn_contexts`（turnId 唯一；revision/prompt checksum + skill/mcp 引用，不含完整 Prompt） |

领域 Port 由主仓 `apps/api/src/modules/persona` 定义（`PersonaRepository` / `SkillRepository` / `McpToolRepository`；原 `modules/persona-plugin` 子模块已于 2026-08-28 移除，去模块化收尾见 §4.2），主仓
`@aervox/schema` 提供表结构，`@aervox/repositories` 提供 SQLite 实现并通过 `apps/api` 适配器接入；数据库表与 Repository Port 是持久化事实源。

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

上述表已在 `packages/schema/src/proactive.ts` 和 `packages/repositories/src/schema/ddl/index.ts` 建立结构/初始化骨架；完整采集适配器、Provider 本地证明、删除 Worker 和 CR-030 破坏性迁移仍待实现，不能据此宣称 CAP-033 已发布。

### 14.10 主动智能派生与外部连接域（CAP-033～035）

| 逻辑实体 | 状态 | SQLite 真源与约束 |
|---|---|---|
| PersonalTimeline / Project / Relationship / Commitment | 已落表 | `proactive_timeline_events`、`proactive_projects`、`proactive_relationships`、`proactive_commitments`；正文加密，D2 后按 revision/source 关联 |
| Workflow / TriggerRule / TriggerEvent | 已落表 | `proactive_workflow_templates`、`proactive_trigger_rules`、`proactive_trigger_events`；触发原因本地加密，事件 ID 去重 |
| ActionVerification / ClaimConflict / PreparationBundle | 已落表 | `proactive_action_verifications`、`proactive_claim_conflicts`、`proactive_preparation_bundles`；关联动作、声明、项目或承诺 |
| AttentionState / DriftSignal / SceneSnapshot / ReviewReport | 已落表 | `proactive_attention_states`、`proactive_drift_signals`、`proactive_scene_snapshots`、`proactive_review_reports`；支持小时窗口和日/周周期幂等 |
| ExternalConnection | 已落表 | `proactive_external_connections`；provider/endpoint/scopes 明文最小化，display/settings/error/credential 使用 Vault cipher，API 不回显 credential |
| HomeEntity | 已落表 | `proactive_home_entities`；`connectionId+entityId` 唯一，默认 `enabled=false`，保存 service 白名单与受限状态属性 |
| HealthSample | 已落表 | `proactive_health_samples`；`connection+metric+localDate` 唯一，只保存步数、睡眠分钟、静息心率和最小元数据 |

实现真源：[proactive-intelligence.ts](../../packages/schema/src/proactive-intelligence.ts)、[proactive-intelligence-repository.ts](../../packages/repositories/src/repositories/sqlite/proactive-intelligence-repository.ts) 与 [init.ts](../../packages/repositories/src/schema/ddl/index.ts)。连接删除先停止运行时，再删除 `proactive_external_connections` 及对应 HA 实体/健康样本；导出不包含连接凭据。

### 14.10 未覆盖结论与下一步

- 当前已落表 **85 张业务表** + 2 张 FTS5 虚表（含独立账本 recovery_control_ledger、CAP-033 八张控制/捕获表和 CR-024 十七张派生/连接表），覆盖 PRD §8 的核心与扩展实体；D2 前仍有旧租户列/接口，D1～D3 迁移、API loopback 守卫和文件 ACL 门禁仍待完成。CAP-033～035 的本地 Vault、十二项派生、HA/健康连接、来源/连接级删除和导出已落地，但生产 OS/出网/厂商兼容仍需专项门禁。
- **MVP（R1）+ MVP+（R1.5）优先队列已完成**：学习/反馈/会话补齐/溯源/记忆/平台/安全/隐私/埋点/内容/日记域实体全部落表（含 ToolPolicy/AnalyticsEvent/EvalSet、DiarySchedule 等日记域补表、Attachment/EmbeddingIndex、Persona/Skills/MCP 6 张人格域表）。
- **P1（R2）已完成**：`MemoryNode`/`MemoryEdgeEvidence`/`MemoryAlgorithm`（记忆树投影独立化，memory_edges/overrides 已迁移到节点级）、`ConversationBranch`、`KnowledgeRelation` 已全部落表。
- **P2/P3 扩展已完成**：`ExternalSource`、`Plugin`/`PluginGrant`、`CommunityContent`、`Organization` 已全部落表（为生态/社区功能预留）。
- 每张新表上线前必须在 [schema/](../../packages/schema/src) 建表、在 [repositories/types.ts](../../packages/repositories/src/repositories/types/index.ts) 补 Port 签名、在 §11 登记 TC，并同步更新本文档 ERD 与本文清单状态。
