---
id: AVX-DB-002
type: reference
scope: baseline
owner: maintainers
doc_status: review-candidate
decision_status: not-applicable
delivery_status: not-applicable
version: 0.5.0
updated_at: 2026-09-18
reviewed_at: 2026-09-18
review_interval_days: 90
sources:
  - docs/reference/DATABASE.md
  - docs/reference/PRD.md
---

# Aervox｜思隅 数据库数据模型覆盖矩阵（Database Coverage Matrix）

- 提出人：3yearszhuang · 2026-09-10
- 修改人：3yearszhuang · 2026-09-18

关联：[SQLite 本地单用户数据库契约](DATABASE.md)（AVX-DB-001）、[产品需求文档 PRD §8](PRD.md#prd-data)（AVX-PRD-001）、`CR-030`（已归档）

本文从 [SQLite 本地单用户数据库契约](DATABASE.md) 拆分而来，作为 PRD 全量数据模型在数据库落表状态的完整附录清单。

## PRD 全量数据模型覆盖清单

> 本清单以 [PRD §8](PRD.md#prd-data) 为全生命周期基线，逐实体标注**交付阶段**与**实现状态**，用于追踪数据库设计对 PRD 的覆盖。约定：
>
> - **阶段**：`MVP`（R1）/ `MVP+`（R1.5）/ `P1`（R2）/ `P2`（R4）/ `P3`（R5）；不再包含 PostgreSQL 启用阶段。
> - **实现状态**：`已落表`（当前 SQLite Schema/DDL 已有）／ `已建模`（本文档有规划表或规划列）／ `未落表`（仅 PRD 定义，进入规划 backlog）。
> - CR-030 纯本地单用户真源已全面落地，全库无租户列。当前代码库 `@aervox/schema` 共维护 **131 张业务表**，另有 2 张 SQLite FTS5 虚拟表（`messages_fts`、`memories_fts`）与 1 张迁移记录表（`_migration_journal`），全仓持久化表总数为 134 张。

### 14.1 本地用户档案与同意

| PRD 实体 | 阶段 | 实现状态 | 说明 / 对应表 |
|---|---|---|---|
| User | P2 | 未落表 | 可选本地用户档案，不作为共享数据库认证主体 |
| ConsentGrant | MVP | 已落表 | `consent_grants`（未撤销授权条件唯一：`revoked_at IS NULL`）；按 purpose/scope/version 约束 |
| UserPreference | MVP | 已落表 | `persona_preferences`（语气 tone、主动性 proactiveness、称谓 addressForm、提醒节奏 reminderCadence） |

### 14.2 会话域 Conversations

| PRD 实体 | 阶段 | 实现状态 | 说明 / 对应表 |
|---|---|---|---|
| Session | MVP | 已落表 | `sessions`（会话元数据，支持关联 `projectId`） |
| Message | MVP | 已落表 | `messages` 身份表（currentVersionId/label/deletedAt） |
| MessageVersion | MVP | 已落表 | `message_versions`（不可变版本历史，含 messageId/supersededAt） |
| Turn | MVP | 已落表 | `turns`（包含 requestHash、acceptedAt、cancelledAt、completedAt 状态字段） |
| TurnAttempt | MVP | 已落表 | `turn_attempts`（leaseId/fencingToken，turn+attempt 唯一） |
| TurnStreamEvent | MVP | 已落表 | `turn_stream_events`（已补 attemptId/safetyDecision/visibilityRevision/committedAt） |
| ConversationBranch | P1 | 已落表 | `conversation_branches`（会话树状分支与会话地图，CAP-014） |
| ToolApproval | MVP+ | 已落表 | `tool_approvals`（工具执行用户授权记录） |
| SafeSegment | MVP+ | 已落表 | `safe_segments`（流式输出分段安全状态记录） |
| AgentInboxItem | MVP+ | 已落表 | `agent_inbox_items`（Agent 命令收件箱，ADR-017） |
| SubagentRun | MVP+ | 已落表 | `subagent_runs`（子 Agent 执行生命周期追踪） |
| PendingUserQuestion | MVP+ | 已落表 | `pending_user_questions`（挂起等待用户回答的结构化提问） |

### 14.3 学习 · 练习 · 复习域

| PRD 实体 | 阶段 | 实现状态 | 说明 / 对应表 |
|---|---|---|---|
| LearningGoal | MVP | 已落表 | `learning_goals`（topic/level/availableMinutes/status/idempotencyKey 条件唯一） |
| Question | MVP | 已落表 | `questions`（sourceArtifactId 应用层维护；可选 knowledgeId 关联知识点） |
| QuestionAttempt | MVP | 已落表 | `question_attempts` 不可变事实（judgement/evidence/idempotencyKey 条件唯一） |
| KnowledgeItem | MVP | 已落表 | `knowledge_items`（掌握度模型，correctCount/wrongCount/masteryBasis） |
| ReviewItem | MVP | 已落表 | `review_items`（间隔重复调度，活动项条件唯一：`status = 'active'`） |
| Feedback | MVP | 已落表 | `feedback`（用户对回答/练习的反馈打分与建议） |
| KnowledgeRelation | P1 | 已落表 | `knowledge_relations`（思维宇宙知识图谱网络边，CAP-015） |
| PracticeSession | P1 | 已落表 | `practice_sessions`（自适应刷题会话，CAP-016） |
| PracticeReport | P1 | 已落表 | `practice_reports`（练习诊断分析报告，CAP-016） |
| MistakeDisposition | P1 | 已落表 | `mistake_dispositions`（错题本归因与处理状态，CAP-004） |
| MistakeInsight | P1 | 已落表 | `mistake_insights`（错题聚类洞察与归因归纳） |
| LearningPlan | P1 | 已落表 | `learning_plans`（考试日备考复习计划主表，CAP-017） |
| PlanMilestone | P1 | 已落表 | `plan_milestones`（复习计划里程碑节点） |
| PlanTask | P1 | 已落表 | `plan_tasks`（复习计划每日原子任务） |
| StudyMaterial | P1 | 已落表 | `study_materials`（学习资料与讲义主表，CAP-011） |
| MaterialVersion | P1 | 已落表 | `material_versions`（学习资料多版本修订） |
| MaterialSource | P1 | 已落表 | `material_sources`（学习资料来源溯源映射） |

### 14.4 记忆域 Memory

| PRD 实体 | 阶段 | 实现状态 | 说明 / 对应表 |
|---|---|---|---|
| MemoryRecord | MVP/MVP+ | 已落表 | `memory_records`（四段记忆模型分层：ephemeral/short_term/long_term） |
| MemoryRevision | MVP | 已落表 | `memory_revisions`（不可变修订，content/confidence/importance） |
| SourceArtifact / SourceRevision | MVP | 已落表 | `source_artifacts` + `source_revisions`（来源事实与不可变版本） |
| MemoryEvidence | MVP | 已落表 | `memory_evidence`（记忆修订 ↔ 来源证据，保留 tombstone） |
| MemoryEvent | MVP | 已落表 | `memory_events`（生成/晋升/衰减/锁定/冲突/失效/删除审计事件） |
| MemoryNode | P1 | 已落表 | `memory_nodes`（长期记忆树投影节点，ADR-007） |
| MemoryProjectionOverride | P1 | 已落表 | `memory_projection_overrides`（节点级人工干预与重命名覆盖） |
| MemoryEdge | P1 | 已落表 | `memory_edges`（记忆网络语义关联边） |
| MemoryEdgeEvidence | P1 | 已落表 | `memory_edge_evidence`（记忆边支撑证据关联） |
| MemoryEmbedding | MVP+ | 已落表 | `memory_embeddings`（记忆条目向量数据，用于本地语义召回） |
| MemoryCompactionMarker | MVP+ | 已落表 | `memory_compaction_markers`（记忆压实与窗口合并游标标记） |
| EmbeddingIndex | MVP+ | 已落表 | `embedding_indexes`（向量模型与索引生命周期元数据） |
| MemoryAlgorithm | P1 | 已落表 | `memory_algorithms`（记忆提炼与投影算法配置） |

### 14.5 日记域 Diary

| PRD 实体 | 阶段 | 实现状态 | 说明 / 对应表 |
|---|---|---|---|
| Diary | MVP+ | 已落表 | `diaries`（自动日记主行，auto_generated 条件唯一） |
| DiarySchedule | MVP+ | 已落表 | `diary_schedules` 计划主实体（nextRunAt/bufferMinutes/quietHours） |
| DiaryScheduleRevision | MVP+ | 已落表 | `diary_schedule_revisions`（计划配置版本化修订） |
| DiaryCycle | MVP+ | 已落表 | `diary_cycles`（周期窗口与截止时间快照） |
| DiaryRunAttempt | MVP+ | 已落表 | `diary_run_attempts`（生成尝试与租约锁控制） |
| DiaryVersion | MVP+ | 已落表 | `diary_versions`（日记内容多版本，不覆盖历史） |
| DiaryParagraphSource | MVP+ | 已落表 | `diary_paragraph_sources`（段落级来源溯源引用） |
| DiaryMaterialBuffer | MVP+ | 已落表 | `diary_material_buffers`（日记素材缓冲，不被普通对话召回） |

### 14.6 内容 · 扩展 · 插件域

| PRD 实体 | 阶段 | 实现状态 | 说明 / 对应表 |
|---|---|---|---|
| Attachment | MVP+ | 已落表 | `attachments`（本地文件附件，objectKey 指向本地 `data/attachments`） |
| AttachmentParseResult | MVP+ | 已落表 | `attachment_parse_results`（OCR/用户裁剪/转文字派生解析结果，幂等键条件唯一） |
| Plugin / PluginGrant | P2 | 已落表 | `plugins`（插件清单）+ `plugin_grants`（细粒度权限授权，未撤销条件唯一） |
| PluginConfig | P2 | 已落表 | `plugin_configs`（插件配置键值快照） |
| PluginConfigSecret | P2 | 已落表 | `plugin_config_secrets`（插件加密敏感凭据） |
| PluginPage | P2 | 已落表 | `plugin_pages`（插件注册的 UI 扩展页面） |
| ExternalSource | P2 | 已落表 | `external_sources`（外部数据源连接与同步状态） |
| CommunityContent | P3 | 已落表 | `community_contents`（社区内容与公开网页分享预留） |
| Organization | P3 | 已落表 | `organizations`（多组织/家庭协同模式预留） |

### 14.7 工具 · 技能 · MCP 域

| PRD 实体 | 阶段 | 实现状态 | 说明 / 对应表 |
|---|---|---|---|
| ToolRegistration | MVP+ | 已落表 | `tool_registrations`（系统全局工具注册表，含内置与插件工具） |
| ToolExecution | MVP+ | 已落表 | `tool_executions`（工具调用执行记录与审计结果） |
| WorkspaceSkill | P2 | 已落表 | `workspace_skills`（工作区 SKILL.md 导入解析，name 唯一） |
| SkillRegistration | P2 | 已落表 | `skill_registrations`（CAP-020 Neo 技能注册） |
| SkillPayload | P2 | 已落表 | `skill_payloads`（技能实现载荷代码与元数据） |
| SkillCandidate | P2 | 已落表 | `skill_candidates`（技能候选晋升评估） |
| SkillRelease | P2 | 已落表 | `skill_releases`（技能正式发布阶段版本，stage 活跃条件唯一） |
| McpServer | P2 | 已落表 | `mcp_servers`（MCP 服务端连接配置与传输状态） |
| McpTool | P2 | 已落表 | `mcp_tools`（MCP 工具同步记录，serverId+name 唯一） |

### 14.8 人格域 Persona

| PRD 实体 | 阶段 | 实现状态 | 说明 / 对应表 |
|---|---|---|---|
| Persona | P1 | 已落表 | `personas`（人格身份主表，CAP-019） |
| PersonaRevision | P1 | 已落表 | `persona_revisions`（人格配置不可变修订，checksum 校验） |
| ActivePersonaSelection | P1 | 已落表 | `persona_selections`（当前活动人格选择） |
| PersonaTurnContext | P1 | 已落表 | `persona_turn_contexts`（回合执行时的人格与技能快照） |
| PersonaSwitchLog | P1 | 已落表 | `persona_switch_logs`（人格切换历史与回滚审计） |
| PersonaMemoryScope | P1 | 已落表 | `persona_memory_scopes`（人格隔离/共享记忆策略配置） |

### 14.9 运营 · 平台域

| PRD 实体 | 阶段 | 实现状态 | 说明 / 对应表 |
|---|---|---|---|
| OutboxEvent | MVP | 已落表 | `outbox_events`（跨模块可靠解耦与事务消息投递） |
| Notification | MVP | 已落表 | `notifications`（关怀/复习/日记提醒，支持优先级与已读） |
| ScheduledJob | MVP | 已落表 | `scheduled_jobs`（Worker 定时与延迟任务可见状态） |
| ModelRun | MVP | 已落表 | `model_runs`（模型调用指标、延迟、Token 消耗账本） |
| PromptVersion | MVP | 已落表 | `prompt_versions`（系统 Prompt 版本控制） |
| ContextManifest | MVP | 已落表 | `context_manifests`（模型输入上下文清单） |
| ToolPolicy | MVP | 已落表 | `tool_policies`（工具执行策略与安全配额） |
| EvalSet | MVP+ | 已落表 | `eval_sets`（离线评估与回归测试集） |
| AnalyticsEvent | MVP | 已落表 | `analytics_events`（本地埋点事件，去标识化） |
| SafetyIncident | MVP | 已落表 | `safety_incidents`（安全防护门禁拦截事件） |
| AuditRecord | MVP | 已落表 | `audit_records`（安全、隐私、删除与高风险操作审计） |
| AuditLog | MVP+ | 已落表 | `audit_logs`（Agent 执行循环与工具调用结构化日志） |
| DeletionRequest | MVP | 已落表 | `deletion_requests`（数据删除请求与传播进度） |
| DeletionTarget | MVP | 已落表 | `deletion_targets`（删除传播清单逐目标确认状态） |
| RecoveryControlLedger | MVP | 已落表 | `recovery_control_ledger`（独立恢复控制账本，单调序列号） |
| LlmConfig | MVP+ | 已落表 | `llm_configs`（大语言模型供应商与端点持久化配置） |
| LlmHealthSnapshot | MVP+ | 已落表 | `llm_health_snapshots`（模型端点探活与可用性快照） |
| LlmRoutingEvent | MVP+ | 已落表 | `llm_routing_events`（模型智能路由与降级切回事件） |

### 14.10 主动智能核心与派生域（CAP-033～035）

| 逻辑实体 | 状态 | SQLite 对应表与约束 |
|---|---|---|
| ProfileAuthorizationRevision | 已落表 | `proactive_profile_revisions`（全量权限清单版本控制） |
| DeviceCapabilityGrant | 已落表 | `proactive_source_grants`（设备感知源细粒度授权） |
| LocalActivationLease | 已落表 | `proactive_activation_leases`（主动模式心跳与激活租约） |
| RawCaptureSegment | 已落表 | `proactive_captures`（7 天滚动感知原始捕获） |
| ProfileClaim | 已落表 | `proactive_profile_claims`（推断画像属性与置信度） |
| BehaviorObservation | 已落表 | `proactive_observations`（行为模式观察与归一化载荷） |
| ProactiveAction | 已落表 | `proactive_actions`（主动介入动作执行与结果） |
| ProactiveAuditEvent | 已落表 | `proactive_audit_events`（主动智能专项审计日志） |
| PersonalTimeline | 已落表 | `proactive_timeline_events`（个人时间线大事件） |
| ProactiveProject | 已落表 | `proactive_projects`（主动感知推断的项目进程） |
| ProactiveRelationship | 已落表 | `proactive_relationships`（人际关系与互动记录） |
| ProactiveCommitment | 已落表 | `proactive_commitments`（待办承诺与约定跟踪） |
| WorkflowTemplate | 已落表 | `proactive_workflow_templates`（自适应工作流模板） |
| TriggerRule | 已落表 | `proactive_trigger_rules`（主动提醒触发规则） |
| TriggerEvent | 已落表 | `proactive_trigger_events`（触发器激活事件记录） |
| ActionVerification | 已落表 | `proactive_action_verifications`（介入动作效果核验） |
| ClaimConflict | 已落表 | `proactive_claim_conflicts`（画像属性冲突检测与标记） |
| PreparationBundle | 已落表 | `proactive_preparation_bundles`（场景预备包素材组合） |
| AttentionState | 已落表 | `proactive_attention_states`（用户当前注意力模式推断） |
| DriftSignal | 已落表 | `proactive_drift_signals`（习惯漂移与注意力分散信号） |
| SceneSnapshot | 已落表 | `proactive_scene_snapshots`（综合场景态势快照） |
| ReviewReport | 已落表 | `proactive_review_reports`（主动智能每日/每周复盘报告） |
| SituationSnapshot | 已落表 | `proactive_situation_snapshots`（态势感知短期瞬态快照） |
| AttentionBudget | 已落表 | `proactive_attention_budgets`（每日关怀防打扰配额） |
| InterventionReceipt | 已落表 | `proactive_intervention_receipts`（干预投递回执与用户反应） |
| BudgetFeedbackEvent | 已落表 | `proactive_budget_feedback_events`（配额消耗反馈事件） |
| PerceptionEvent | 已落表 | `perception_events`（全域感知输入原始事件流） |
| PerceptionEventConsumer | 已落表 | `perception_event_consumers`（感知消费者位点游标） |
| ExternalConnection | 已落表 | `proactive_external_connections`（HA / 运动健康外部连接与凭据加密存储） |
| HomeEntity | 已落表 | `proactive_home_entities`（Home Assistant 同步设备实体） |
| HealthSample | 已落表 | `proactive_health_samples`（运动健康每日摘要样本） |

### 14.11 项目域 Project

| PRD 实体 | 阶段 | 实现状态 | 说明 / 对应表 |
|---|---|---|---|
| Project | MVP+ | 已落表 | `projects`（用户自定义项目分组：name/description/color/icon/archivedAt，供 `sessions.projectId` 关联） |

### 14.12 语音服务域 Voice

| PRD 实体 | 阶段 | 实现状态 | 说明 / 对应表 |
|---|---|---|---|
| VoiceConfig | MVP+ | 已落表 | `voice_configs`（本地语音合成/TTS 服务端配置） |
| VoiceInputConfig | MVP+ | 已落表 | `voice_input_configs`（本地 Sherpa-ONNX 语音识别/STT 配置） |
| VoiceRemoteConfig | MVP+ | 已落表 | `voice_remote_configs`（远程商业语音服务配置与 API Key） |

---

## 覆盖总结

- **全量落表总数**：**131 张业务表** + 2 张 FTS5 全文搜索虚拟表（`messages_fts`、`memories_fts`）+ 1 张内部迁移日志表（`_migration_journal`），共计 134 张 SQLite 表。
- **单一事实源约束**：所有业务表的 Schema 定义在 `@aervox/schema`，对应的 SQLite DDL 与索引初始化由 `@aervox/repositories` 承载，并通过自动化测试（`schema-index-parity.test.ts`）严格保证 Schema 与 DDL 的 100% 结构一致。
- **纯本地单用户架构**：CR-030 去租户化彻底闭环，全库 131 张业务表均无 `workspace_id` 与 `subject_user_id` 租户隔离列。
