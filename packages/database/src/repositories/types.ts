/**
 * Aervox｜思隅 @aervox/database — 仓储接口定义（Repository Interfaces）
 *
 * 规则依据：仓储抽象与 Port 模式，上层业务仅依赖接口，解耦具体 SQLite / PostgreSQL 实现。
 */
import type { TenantContext } from "../tenant.js";

export interface SessionModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface TurnModel {
  id: string;
  sessionId: string;
  workspaceId: string;
  subjectUserId: string;
  idempotencyKey: string;
  status: string;
  lastSequence: number;
  error?: unknown;
  quoteMessageId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageVersionModel {
  id: string;
  turnId: string;
  workspaceId: string;
  subjectUserId: string;
  role: string;
  version: number;
  content: string;
  isRedacted: number;
  createdAt: string;
}

export interface TurnStreamEventModel {
  id: string;
  turnId: string;
  workspaceId: string;
  subjectUserId: string;
  sequence: number;
  eventType: string;
  payloadVersion: number;
  data: unknown;
  occurredAt: string;
  attemptId?: string | null;
  safetyDecision?: string | null;
  committedAt?: string | null;
}

export interface OutboxEventModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  controlEventId?: string | null;
  idempotencyKey: string;
  eventType: string;
  payload: unknown;
  status: string;
  retryCount: number;
  lastError?: string | null;
  createdAt: string;
  publishedAt?: string | null;
}

export interface IConversationRepository {
  createSession(tenant: TenantContext, title: string): Promise<SessionModel>;
  getSession(tenant: TenantContext, sessionId: string): Promise<SessionModel | null>;
  getOrCreateSession(tenant: TenantContext, sessionId: string, title?: string): Promise<SessionModel>;
  createTurnWithOutbox(
    tenant: TenantContext,
    turn: { id: string; sessionId: string; idempotencyKey: string; status?: string },
    userMessage: { id: string; content: string },
    outboxEvent?: { id: string; eventType: string; idempotencyKey: string; payload: unknown },
  ): Promise<{ turn: TurnModel; message: MessageVersionModel }>;
  getTurn(tenant: TenantContext, turnId: string): Promise<TurnModel | null>;
  getTurnByIdempotencyKey(tenant: TenantContext, idempotencyKey: string): Promise<TurnModel | null>;
  updateTurnStatus(
    tenant: TenantContext,
    turnId: string,
    status: string,
    lastSequence?: number,
    error?: unknown,
  ): Promise<TurnModel | null>;
  appendStreamEvent(
    tenant: TenantContext,
    event: {
      id: string;
      turnId: string;
      /** 可选：缺省或冲突时仓储原子分配 MAX(sequence)+1（多写入方并发安全） */
      sequence?: number;
      eventType: string;
      payloadVersion?: number;
      data: unknown;
      occurredAt?: string;
      attemptId?: string | null;
      safetyDecision?: string | null;
      committedAt?: string | null;
      /**
       * 3c+（B1）：事件写入 fencing CAS 校验。attemptId 与本字段同时给出时，
       * 仓储要求 turn_attempts 的 fencing_token 与期望一致且状态允许，
       * 否则抛 FencingMismatchError（迟到的抢占执行器写入被拒绝）。
       */
      expectedFencingToken?: number | null;
    },
  ): Promise<TurnStreamEventModel>;
  getStreamEvents(
    tenant: TenantContext,
    turnId: string,
    afterSequence?: number,
  ): Promise<TurnStreamEventModel[]>;
  deleteMessage(tenant: TenantContext, messageId: string): Promise<boolean>;
  // MVP 补齐（PRD §8）：Message 身份表 / TurnAttempt
  createMessage(
    tenant: TenantContext,
    message: { id: string; sessionId: string; role: string; label?: string | null },
  ): Promise<MessageModel>;
  getMessage(tenant: TenantContext, messageId: string): Promise<MessageModel | null>;
  // CAP-013：消息编辑、软删除、版本历史、恢复
  editMessage(
    tenant: TenantContext,
    messageId: string,
    content: string,
    expectedVersion: number,
  ): Promise<{ message: MessageModel; newVersion: MessageVersionModel } | null>;
  softDeleteMessage(tenant: TenantContext, messageId: string): Promise<MessageModel | null>;
  restoreMessage(tenant: TenantContext, messageId: string): Promise<MessageModel | null>;
  listMessageVersions(tenant: TenantContext, messageId: string): Promise<MessageVersionModel[]>;
  createTurnAttempt(
    tenant: TenantContext,
    turnId: string,
    attempt: { id: string; attempt?: number; leaseId?: string | null; fencingToken?: number },
  ): Promise<TurnAttemptModel>;
  listTurnAttempts(tenant: TenantContext, turnId: string): Promise<TurnAttemptModel[]>;
  /** 2b：用户取消请求位（CAS：仅 Running → CancelRequested，同步 turns 至 Cancelled 若未终态） */
  requestCancelTurnAttempt(
    tenant: TenantContext,
    input: { turnId: string; attemptId: string },
  ): Promise<{ ok: boolean; reason?: "not_found" | "already_finalized" }>;
  /** 2b：读取 Attempt 当前状态（executor 取消检查点） */
  getTurnAttemptStatus(tenant: TenantContext, input: { turnId: string; attemptId: string }): Promise<string | null>;
  /** 2c：幂等预留（attempt+invocation 唯一；ON CONFLICT DO NOTHING） */
  reserveToolExecution(
    tenant: TenantContext,
    input: { turnId: string; attemptId: string; invocationId: string; name: string; arguments?: unknown },
  ): Promise<{ ok: boolean; alreadyReserved: boolean }>;
  /** 2c：以权威结果收口预留行 */
  updateToolExecutionResult(
    tenant: TenantContext,
    input: { turnId: string; attemptId: string; invocationId: string; status: string; output?: unknown; error?: string; finishedAt?: string },
  ): Promise<{ ok: boolean }>;
  /** 2c：崩溃释放后将遗留 pending 预留标记为 outcome_unknown（§11.3） */
  markPendingOutcomeUnknown(client: import("@libsql/client").Client): Promise<number>;
  // P1（R2 · CAP-014）：会话地图与替代解法分支
  createConversationBranch(
    tenant: TenantContext,
    branch: {
      id: string;
      parentSessionId: string;
      forkAtMessageId?: string | null;
      childSessionId: string;
      title?: string;
      branchReason?: string;
    },
  ): Promise<ConversationBranchModel>;
  listBranchesByParent(tenant: TenantContext, parentSessionId: string): Promise<ConversationBranchModel[]>;
  /** CAP-014：获取分支详情 */
  getBranch(tenant: TenantContext, branchId: string): Promise<ConversationBranchModel | null>;
  /** CAP-014：合并分支回主线 */
  mergeBranch(tenant: TenantContext, branchId: string): Promise<ConversationBranchModel | null>;
  /** CAP-014：归档分支 */
  archiveBranch(tenant: TenantContext, branchId: string): Promise<ConversationBranchModel | null>;
  /** CAP-014：软删除分支 */
  deleteBranch(tenant: TenantContext, branchId: string): Promise<ConversationBranchModel | null>;
  /** CAP-014：更新布局数据（布局丢失不影响会话内容） */
  updateBranchLayout(
    tenant: TenantContext,
    branchId: string,
    layoutData: unknown,
  ): Promise<ConversationBranchModel | null>;
  /** CAP-014：获取会话地图（所有分支树） */
  getBranchTree(tenant: TenantContext, sessionId: string): Promise<ConversationBranchModel[]>;
}

export interface ConversationBranchModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  parentSessionId: string;
  forkAtMessageId?: string | null;
  childSessionId: string;
  /** CAP-014：分支标题 */
  title?: string | null;
  /** CAP-014：分支原因 */
  branchReason?: string | null;
  /** CAP-014：生命周期状态 */
  status: string;
  /** CAP-014：合并时间戳 */
  mergedAt?: string | null;
  /** CAP-014：布局数据 */
  layoutData?: unknown;
  /** CAP-014：软删除 */
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryRecordModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  layer: string;
  type: string;
  content: string;
  canonicalParentId?: string | null;
  sourceTurnId?: string | null;
  version: number;
  isDeleted: number;
  // PET-02 记忆条目字段
  source?: string; // "user_said" | "ai_inferred"
  category?: string; // identity/preference/habit/schedule/relationship/event/other
  keywordsJson?: string | null;
  lastUsedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryEdgeModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  fromNodeId: string;
  toNodeId: string;
  relationType: string;
  confidence: number;
  visibilityScope: string;
  status: string;
  createdAt: string;
}

export interface MemoryNodeModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  canonicalParentId?: string | null;
  label: string;
  nodeType: string;
  confidence: number;
  status: string;
  projectionVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryEdgeEvidenceModel {
  id: string;
  edgeId: string;
  memoryRevisionId: string;
  status: string;
  createdAt: string;
}

export interface MemoryAlgorithmModel {
  id: string;
  stage: string;
  schemaVersion: number;
  promptVersionId?: string | null;
  thresholds?: unknown;
  status: string;
  approvedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryTreeNode {
  record: MemoryRecordModel;
  depth: number;
  path: string;
  children: MemoryTreeNode[];
}

export interface IMemoryRepository {
  createRecord(
    tenant: TenantContext,
    record: {
      id: string;
      layer: string;
      type: string;
      content: string;
      canonicalParentId?: string | null;
      sourceTurnId?: string | null;
      // PET-02 可选记忆条目字段
      source?: string;
      category?: string;
      keywords?: string[];
      lastUsedAt?: string | null;
      /** 校验状态；缺省沿用 schema 默认 unverified（候选语义） */
      verificationStatus?: string;
    },
  ): Promise<MemoryRecordModel>;
  getRecord(tenant: TenantContext, id: string): Promise<MemoryRecordModel | null>;
  listRecordsByLayer(tenant: TenantContext, layer: string): Promise<MemoryRecordModel[]>;
  createEdge(
    tenant: TenantContext,
    edge: { id: string; fromNodeId: string; toNodeId: string; relationType: string; confidence?: number; visibilityScope?: string },
  ): Promise<MemoryEdgeModel>;
  getTreeProjection(
    tenant: TenantContext,
    rootRecordId?: string | null,
  ): Promise<MemoryTreeNode[]>;
  softDeleteRecord(tenant: TenantContext, id: string): Promise<boolean>;
  // P1（R2）：记忆树投影节点 / 边证据 / 算法版本
  createNode(
    tenant: TenantContext,
    node: { id: string; label: string; nodeType?: string; canonicalParentId?: string | null; confidence?: number; projectionVersion?: number },
  ): Promise<MemoryNodeModel>;
  getNode(tenant: TenantContext, id: string): Promise<MemoryNodeModel | null>;
  listNodesByTenant(tenant: TenantContext): Promise<MemoryNodeModel[]>;
  createEdgeEvidence(
    evidence: { id: string; edgeId: string; memoryRevisionId: string },
  ): Promise<MemoryEdgeEvidenceModel>;
  createMemoryAlgorithm(
    algorithm: {
      id: string;
      stage: string;
      schemaVersion?: number;
      promptVersionId?: string | null;
      thresholds?: unknown;
      status?: string;
    },
  ): Promise<MemoryAlgorithmModel>;
  getActiveAlgorithm(stage: string): Promise<MemoryAlgorithmModel | null>;
}

// ============ T-03 上下文压缩标记 ============

export interface MemoryCompactionMarkerModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  memoryId: string;
  snapshotId: string;
  coveredUpToMessageId?: string | null;
  summaryText?: string | null;
  phase: string; // "auto" | "manual"
  status: string; // "completed" | "failed"
  thoughtDurationMs?: number | null;
  summaryDurationMs?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface IMemoryCompactionRepository {
  /**
   * 幂等写入压缩标记：同一 memoryId + snapshotId 已存在时不覆盖（快照溯源不可改写）。
   * 由调用方保证在「完整响应持久化后」（先写后投递时序）调用。
   */
  upsertMarker(
    tenant: TenantContext,
    marker: {
      id: string;
      memoryId: string;
      snapshotId: string;
      coveredUpToMessageId?: string | null;
      summaryText?: string | null;
      phase?: string;
      status?: string;
      thoughtDurationMs?: number | null;
      summaryDurationMs?: number | null;
    },
  ): Promise<MemoryCompactionMarkerModel>;
  getMarkerBySnapshotId(tenant: TenantContext, snapshotId: string): Promise<MemoryCompactionMarkerModel | null>;
  listMarkersByMemoryId(tenant: TenantContext, memoryId: string): Promise<MemoryCompactionMarkerModel[]>;
  /** 写 memory_events 审计（action = "compressed" 等） */
  recordEvent(
    tenant: TenantContext,
    event: {
      id: string;
      memoryId: string;
      action: string;
      fromTier?: string | null;
      toTier?: string | null;
      reason?: string | null;
      actorType?: string;
    },
  ): Promise<void>;
}

// ============ T-05 记忆向量存储 ============

export interface MemoryEmbeddingModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  memoryId: string;
  dimension: number;
  modelId: string;
  vector: number[];
  sourceCreatedAt?: string | null;
  indexVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryEmbeddingBatchProgress {
  current: number;
  total: number;
}

export interface IMemoryEmbeddingRepository {
  /**
   * 批量写入向量（对照 AST-02 Port 形态：分批 + 重试 + 进度回调）。
   * 同一 memoryId 已有向量时覆盖（同 model_id 重算场景），换模型请用不同 model_id。
   */
  insertBatch(
    tenant: TenantContext,
    items: Array<{
      id: string;
      memoryId: string;
      vector: number[];
      modelId: string;
      sourceCreatedAt?: string | null;
      indexVersion?: number;
    }>,
    options?: {
      batchSize?: number;
      maxRetries?: number;
      progressCallback?: (progress: MemoryEmbeddingBatchProgress) => void;
    },
  ): Promise<void>;
  /** 余弦检索 topK（JS 行扫描，SQLite 无原生向量扩展时的兜底） */
  retrieve(
    tenant: TenantContext,
    queryVector: number[],
    topK: number,
    minScore?: number,
    modelId?: string,
  ): Promise<Array<{ memoryId: string; score: number }>>;
  deleteByMemoryId(tenant: TenantContext, memoryId: string): Promise<void>;
  clearTenant(tenant: TenantContext): Promise<void>;
}

export interface DiaryModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  localDate: string;
  autoGenerated: number;
  title: string;
  content: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface DiaryCycleModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  scheduleEpochId: string;
  localDate: string;
  previousCutoffAt: string;
  cutoffAt: string;
  status: string;
  scheduleVersion: number;
  fencingToken: number;
  diaryId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IDiaryRepository {
  createCycle(
    tenant: TenantContext,
    cycle: {
      id: string;
      scheduleEpochId: string;
      localDate: string;
      previousCutoffAt: string;
      cutoffAt: string;
      status?: string;
    },
  ): Promise<DiaryCycleModel>;
  getCycle(tenant: TenantContext, cycleId: string): Promise<DiaryCycleModel | null>;
  claimCycleWithLease(
    tenant: TenantContext,
    params: {
      cycleId: string;
      workerId: string;
      leaseDurationMs: number;
      expectedScheduleVersion: number;
    },
  ): Promise<{ success: boolean; newScheduleVersion?: number; fencingToken?: number }>;
  publishDiaryWithCycle(
    tenant: TenantContext,
    params: {
      cycleId: string;
      diary: { id: string; localDate: string; title: string; content: string; autoGenerated?: number };
      expectedScheduleVersion: number;
      outboxEvent?: { id: string; eventType: string; idempotencyKey: string; payload: unknown };
    },
  ): Promise<{ diary: DiaryModel; cycle: DiaryCycleModel }>;
  getDiaryByDate(tenant: TenantContext, localDate: string): Promise<DiaryModel | null>;
  // MVP+ 补齐（PRD §8）：计划主实体 / 版本 / 段落来源 / 素材缓冲
  createDiarySchedule(
    tenant: TenantContext,
    schedule: {
      id: string;
      scheduleEpochId: string;
      activeFrom: string;
      initialWindowStart: string;
      cutoffRule: string;
      bufferMinutes?: number;
      contentScopes?: unknown;
      quietHours?: unknown;
    },
  ): Promise<DiaryScheduleModel>;
  getDiarySchedule(tenant: TenantContext, id: string): Promise<DiaryScheduleModel | null>;
  createDiaryVersion(
    tenant: TenantContext,
    version: { id: string; diaryId: string; perspective: string; content: string; modelRunId?: string | null },
  ): Promise<DiaryVersionModel>;
  /** 改写路径：主行内容推进到新版本（version+1、状态转 edited；历史版本不覆盖） */
  updateDiaryContent(
    tenant: TenantContext,
    diaryId: string,
    update: { title?: string; content: string },
  ): Promise<DiaryModel>;
  createDiaryParagraphSource(
    source: {
      id: string;
      diaryVersionId: string;
      paragraphIndex: number;
      sourceArtifactId: string;
      sourceRevisionId: string;
      permissionSnapshot?: unknown;
    },
  ): Promise<DiaryParagraphSourceModel>;
  createDiaryMaterialBuffer(
    tenant: TenantContext,
    buffer: {
      id: string;
      cycleId: string;
      sourceArtifactId: string;
      sourceRevisionId: string;
      occurredAt: string;
      ingestedAt: string;
      expiresAt: string;
      ephemeralSnapshot?: unknown;
      permissionSnapshot?: unknown;
    },
  ): Promise<DiaryMaterialBufferModel>;
}

export interface DiaryScheduleModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  enabled: number;
  scheduleEpochId: string;
  activeFrom: string;
  disabledAt?: string | null;
  currentRevisionId?: string | null;
  nextRunAt?: string | null;
  lastCutoffAt?: string | null;
  initialWindowStart: string;
  cutoffRule: string;
  bufferMinutes: number;
  contentScopes?: unknown;
  quietHours?: unknown;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface DiaryVersionModel {
  id: string;
  diaryId: string;
  perspective: string;
  content: string;
  modelRunId?: string | null;
  createdAt: string;
  supersededAt?: string | null;
}

export interface DiaryParagraphSourceModel {
  id: string;
  diaryVersionId: string;
  paragraphIndex: number;
  sourceArtifactId: string;
  sourceRevisionId: string;
  permissionSnapshot?: unknown;
}

export interface DiaryMaterialBufferModel {
  id: string;
  cycleId: string;
  workspaceId: string;
  subjectUserId: string;
  sourceArtifactId: string;
  sourceRevisionId: string;
  occurredAt: string;
  ingestedAt: string;
  ephemeralSnapshot?: unknown;
  permissionSnapshot?: unknown;
  expiresAt: string;
  status: string;
}

export interface IOutboxRepository {
  insertEvent(
    tenant: TenantContext,
    event: {
      id: string;
      idempotencyKey: string;
      eventType: string;
      payload: unknown;
      controlEventId?: string | null;
    },
  ): Promise<OutboxEventModel>;
  fetchPendingEvents(limit?: number): Promise<OutboxEventModel[]>;
  markPublished(eventId: string): Promise<void>;
  markFailed(eventId: string, error: string): Promise<void>;
}

// ============ 会话补齐：Message 身份 / TurnAttempt ============

export interface MessageModel {
  id: string;
  sessionId: string;
  role: string;
  currentVersionId?: string | null;
  label?: string | null;
  createdAt: string;
  deletedAt?: string | null;
}

export interface TurnAttemptModel {
  id: string;
  turnId: string;
  attempt: number;
  leaseId?: string | null;
  fencingToken: number;
  status: string;
  startedAt: string;
  finishedAt?: string | null;
  leaseExpiresAt?: string | null;
}

/** Agent Loop 工具执行账本行（tool_executions） */
export interface ToolExecutionModel {
  id: string;
  turnId: string;
  attemptId: string;
  invocationId: string;
  name: string;
  workspaceId: string;
  subjectUserId: string;
  argumentsJson?: unknown;
  status: string;
  outputJson?: unknown;
  error?: string | null;
  startedAt: string;
  finishedAt: string;
  /** B3：工具注册的 replay 声明（join tool_registrations；NULL=未声明） */
  replay?: string | null;
}

/** 工具授权账本行（tool_approvals，阶段 3a） */
export interface ToolApprovalModel {
  id: string;
  turnId: string;
  attemptId: string;
  toolName: string;
  argumentsHash: string;
  toolVersion?: string | null;
  requester: string;
  state: "pending" | "granted" | "denied";
  decidedBy?: string | null;
  decidedAt?: string | null;
  workspaceId: string;
  subjectUserId: string;
}

// ============ 阶段 5a：Agent 收件箱（agent_inbox_items；ADR-017）============

/** AgentInboxItem 行（agent_inbox_items；与 @aervox/agent-loop AgentInboxItem 语义对齐） */
export interface AgentInboxItemModel {
  id: string;
  idempotencyKey: string;
  sessionId: string;
  attemptId?: string | null;
  stepId?: string | null;
  type: "followup" | "steer" | "inject";
  orderingSeq: number;
  sourceActor: string;
  payload: unknown;
  status: "pending" | "claimed" | "acknowledged" | "expired";
  consumeBoundary: "next-turn" | "next-step";
  claimedAt?: string | null;
  ackedAt?: string | null;
  expiresAt?: string | null;
  workspaceId: string;
  subjectUserId: string;
  createdAt: string;
  updatedAt: string;
}

/** 受控 inbox command（ADR-017：外部插件只能提交受限 command） */
export interface AgentInboxEnqueueInput {
  id: string;
  idempotencyKey: string;
  sessionId: string;
  attemptId?: string | null;
  stepId?: string | null;
  type: "followup" | "steer" | "inject";
  sourceActor: "user" | "agent" | "plugin";
  payload: unknown;
  consumeBoundary?: "next-turn" | "next-step";
  expiresAt?: string | null;
}

export interface IAgentInboxRepository {
  /** 提交一条受控 inbox command（幂等：同 idempotencyKey 重复提交返回既有项） */
  enqueue(tenant: TenantContext, input: AgentInboxEnqueueInput): Promise<AgentInboxItemModel>;
  /**
   * claim 一批可消费 inbox 项（pending → claimed）：
   * - next-step：按 sessionId + attemptId + boundary 过滤（attemptId 必填）；
   * - next-turn：按 sessionId + boundary 过滤（attemptId 可空）。
   * 过滤未过期项，按 orderingSeq 排序。
   */
  claimForConsumption(
    tenant: TenantContext,
    input: { sessionId: string; attemptId?: string | null; type: "next-turn" | "next-step"; limit?: number },
  ): Promise<AgentInboxItemModel[]>;
  /** ack 消费完成（claimed → acknowledged）；只接受属于本租户的项 */
  acknowledge(tenant: TenantContext, itemIds: string[]): Promise<void>;
  /** 按 idempotencyKey 查询（API 幂等返回用） */
  getByIdempotencyKey(tenant: TenantContext, idempotencyKey: string): Promise<AgentInboxItemModel | null>;
  /** 过期回收（跨租户，Worker 轮询）：expiresAt < now 且 status ∈ pending/claimed → expired；返回回收条数 */
  expireOverdue(now?: string): Promise<number>;
}

// ============ 阶段 5c：Subagent 运行关联（subagent_runs）============

/** Subagent 子任务运行行（父 Turn 与子任务的溯源关联 + 结果摘要；完整事件在子 turn 下审计） */
export interface SubagentRunModel {
  id: string;
  sessionId: string;
  parentTurnId: string;
  parentAttemptId: string;
  parentExecutionId: string;
  subTurnId: string;
  subAttemptId: string;
  task: string;
  toolScope: unknown | null;
  /** Running / Completed / Failed / Interrupted / Cancelled（对齐 AttemptStatus） */
  status: string;
  resultText?: string | null;
  error?: string | null;
  finishedAt?: string | null;
  workspaceId: string;
  subjectUserId: string;
  createdAt: string;
  updatedAt: string;
}

/** 创建子任务运行行的输入（status 初始 Running，终态由 finalizeRun 收口） */
export interface SubagentRunCreateInput {
  id: string;
  sessionId: string;
  parentTurnId: string;
  parentAttemptId: string;
  parentExecutionId: string;
  subTurnId: string;
  subAttemptId: string;
  task: string;
  toolScope?: unknown;
}

/** Subagent 运行关联仓储（阶段 5c） */
export interface ISubagentRunRepository {
  /**
   * 幂等创建：同 tenant + parentAttemptId + parentExecutionId 已存在则返回既有行
   * （子任务崩溃/重试不重复落库——Host 幂等键=executionId 语义，AVX-HAR-001 §9）。
   */
  createRun(tenant: TenantContext, input: SubagentRunCreateInput): Promise<SubagentRunModel>;
  /** 终态收口：status/resultText/error/finishedAt（仅 Running 可收口，返回 null 表示非 Running/缺失） */
  finalizeRun(
    tenant: TenantContext,
    runId: string,
    input: { status: string; resultText?: string | null; error?: string | null },
  ): Promise<SubagentRunModel | null>;
  /** 按父执行键回查（重试/幂等复用） */
  getRunByParentExecution(
    tenant: TenantContext,
    parentAttemptId: string,
    parentExecutionId: string,
  ): Promise<SubagentRunModel | null>;
  /** 父 Turn 的全部子任务运行（API 审计端点，租户隔离） */
  listRunsByTurn(tenant: TenantContext, parentTurnId: string): Promise<SubagentRunModel[]>;
}

// ============ 缺陷 C：挂起提问会话（pending_user_questions）============

/** 挂起提问会话行（无论 Loop 进程是否存活均存在；expiresAt 为超时唯一真源） */
export interface PendingUserQuestionModel {
  turnId: string;
  attemptId: string;
  step: number;
  /** 模型提出的问题清单（AskUserQuestionItem[]） */
  questions: unknown;
  timeoutMs: number;
  /** createdAt + timeoutMs；晚于此时间提交答案视为超时 */
  expiresAt: string;
  createdAt: string;
  workspaceId: string;
  subjectUserId: string;
}

export interface PendingUserQuestionUpsertInput {
  turnId: string;
  attemptId: string;
  step: number;
  questions: unknown;
  timeoutMs: number;
  expiresAt: string;
  createdAt: string;
}

/** 挂起提问会话仓储（缺陷 C：持久化真源，进程重启后仍可接受回答/查询） */
export interface IUserQuestionRepository {
  /** 幂等写入挂起会话（同 turnId 覆盖）；供提问时调用 */
  upsertPending(tenant: TenantContext, input: PendingUserQuestionUpsertInput): Promise<void>;
  /** 按 turn 查询挂起会话（租户隔离）；无则 null */
  getPending(tenant: TenantContext, turnId: string): Promise<PendingUserQuestionModel | null>;
  /** 会话完成/超时后清除（租户隔离；仅删除属于本租户的行） */
  deletePending(tenant: TenantContext, turnId: string): Promise<void>;
}

// ============ 学习/练习/复习域 ============

export interface LearningGoalModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  topic: string;
  level: string;
  availableMinutes: number;
  status: string;
  idempotencyKey?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QuestionModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  sourceArtifactId?: string | null;
  knowledgeId?: string | null;
  prompt: string;
  answerSpec: unknown;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface QuestionAttemptModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  sessionId: string;
  questionId: string;
  answer: string;
  judgement: string;
  evidence?: unknown;
  idempotencyKey?: string | null;
  hintCount: number;
  timeSpentSec?: number | null;
  createdAt: string;
}

export interface MistakeItemModel {
  questionId: string;
  knowledgeId?: string | null;
  prompt: string;
  latestAnswer: string;
  latestAttemptAt: string;
  wrongCount: number;
  masteryState: string;
  status: "active" | "mastered" | "dismissed";
  reasonCode?: "concept_gap" | "calculation" | "careless" | "misread" | "other" | null;
  note?: string | null;
}

export interface PracticeSessionModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  questionCount: number;
  questionIds: string[];
  status: string;
  startedAt: string;
  endedAt?: string | null;
}

export interface KnowledgeItemModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  concept: string;
  sourceStatus: string;
  masteryState: string;
  correctCount: number;
  wrongCount: number;
  correctStreak: number;
  mastery: number;
  masteryBasis?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewItemModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  knowledgeId: string;
  dueAt: string;
  intervalDays: number;
  schedulerVersion: number;
  timezoneSnapshot: string;
  status: string;
  completionIsCorrect?: boolean | null;
  nextReviewId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ILearningRepository {
  createLearningGoal(
    tenant: TenantContext,
    goal: {
      id: string;
      topic: string;
      level?: string;
      availableMinutes?: number;
      status?: string;
      idempotencyKey?: string | null;
    },
  ): Promise<LearningGoalModel>;
  createLearningGoalIdempotent(
    tenant: TenantContext,
    goal: {
      id: string;
      topic: string;
      level?: string;
      availableMinutes?: number;
      idempotencyKey: string;
    },
  ): Promise<{ goal: LearningGoalModel; created: boolean }>;
  getLearningGoal(tenant: TenantContext, id: string): Promise<LearningGoalModel | null>;
  listLearningGoals(tenant: TenantContext, includeArchived?: boolean): Promise<LearningGoalModel[]>;
  updateLearningGoal(
    tenant: TenantContext,
    id: string,
    goal: { topic?: string; level?: string; availableMinutes?: number; status?: string },
  ): Promise<LearningGoalModel | null>;
  createQuestion(
    tenant: TenantContext,
    question: {
      id: string;
      prompt: string;
      answerSpec: unknown;
      sourceArtifactId?: string | null;
      knowledgeId?: string | null;
    },
  ): Promise<QuestionModel>;
  getQuestion(tenant: TenantContext, id: string): Promise<QuestionModel | null>;
  listActiveQuestions(tenant: TenantContext, limit: number): Promise<QuestionModel[]>;
  createPracticeSession(
    tenant: TenantContext,
    session: { id: string; questionCount: number; questionIds: string[] },
  ): Promise<PracticeSessionModel>;
  getPracticeSession(tenant: TenantContext, sessionId: string): Promise<PracticeSessionModel | null>;
  getLatestActivePracticeSession(tenant: TenantContext): Promise<PracticeSessionModel | null>;
  completePracticeSession(tenant: TenantContext, sessionId: string): Promise<PracticeSessionModel | null>;
  recordAttempt(
    tenant: TenantContext,
    attempt: {
      id: string;
      sessionId: string;
      questionId: string;
      answer: string;
      judgement: string;
      evidence?: unknown;
      idempotencyKey?: string | null;
      hintCount?: number;
      timeSpentSec?: number;
    },
  ): Promise<QuestionAttemptModel>;
  listAttemptsByQuestion(tenant: TenantContext, questionId: string): Promise<QuestionAttemptModel[]>;
  listAttemptsBySession(tenant: TenantContext, sessionId: string): Promise<QuestionAttemptModel[]>;
  listMistakes(
    tenant: TenantContext,
    status?: "active" | "mastered" | "dismissed" | "all",
  ): Promise<MistakeItemModel[]>;
  setMistakeDisposition(tenant: TenantContext, item: { id: string; questionId: string; status: "active" | "dismissed" }): Promise<void>;
  setMistakeInsight(
    tenant: TenantContext,
    item: { id: string; questionId: string; reasonCode: "concept_gap" | "calculation" | "careless" | "misread" | "other"; note?: string | null },
  ): Promise<void>;
  clearMistakeInsight(tenant: TenantContext, questionId: string): Promise<void>;
  getAttemptByIdempotencyKey(
    tenant: TenantContext,
    questionId: string,
    idempotencyKey: string,
  ): Promise<QuestionAttemptModel | null>;
  recordAttemptIdempotent(
    tenant: TenantContext,
    attempt: {
      id: string;
      sessionId: string;
      questionId: string;
      answer: string;
      judgement: string;
      evidence?: unknown;
      idempotencyKey: string;
      hintCount?: number;
      timeSpentSec?: number;
    },
  ): Promise<{ attempt: QuestionAttemptModel; created: boolean }>;
  createKnowledgeItem(
    tenant: TenantContext,
    item: {
      id: string;
      concept: string;
      sourceStatus?: string;
      masteryState?: string;
      correctCount?: number;
      wrongCount?: number;
      correctStreak?: number;
      mastery?: number;
    },
  ): Promise<KnowledgeItemModel>;
  getKnowledgeItem(tenant: TenantContext, id: string): Promise<KnowledgeItemModel | null>;
  updateMastery(tenant: TenantContext, id: string, masteryState: string, basis?: unknown): Promise<KnowledgeItemModel | null>;
  updatePracticeState(
    tenant: TenantContext,
    id: string,
    state: {
      correctCount: number;
      wrongCount: number;
      correctStreak: number;
      mastery: number;
      masteryState: string;
      masteryBasis: unknown;
    },
  ): Promise<KnowledgeItemModel | null>;
  scheduleReviewItem(
    tenant: TenantContext,
    item: { id: string; knowledgeId: string; dueAt: string; intervalDays: number; schedulerVersion?: number; timezoneSnapshot?: string },
  ): Promise<ReviewItemModel>;
  createReviewItem(
    tenant: TenantContext,
    item: { id: string; knowledgeId: string; dueAt: string; intervalDays?: number; schedulerVersion?: number; timezoneSnapshot?: string },
  ): Promise<ReviewItemModel>;
  getReviewItem(tenant: TenantContext, id: string): Promise<ReviewItemModel | null>;
  listCompletedReviewItems(tenant: TenantContext, limit?: number): Promise<ReviewItemModel[]>;
  completeReviewAndSchedule(
    tenant: TenantContext,
    data: {
      reviewId: string;
      knowledgeId: string;
      isCorrect: boolean;
      practiceState: {
        correctCount: number;
        wrongCount: number;
        correctStreak: number;
        mastery: number;
        masteryState: string;
        masteryBasis: unknown;
      };
      nextReview: { id: string; dueAt: string; intervalDays: number; schedulerVersion: number; timezoneSnapshot: string };
    },
  ): Promise<{ completed: ReviewItemModel; nextReview: ReviewItemModel; knowledge: KnowledgeItemModel } | null>;
  listDueReviewItems(tenant: TenantContext, before: string): Promise<ReviewItemModel[]>;
  completeReviewItem(tenant: TenantContext, id: string): Promise<ReviewItemModel | null>;
  // P1（R2 · CAP-015）：思维宇宙知识关系
  createKnowledgeRelation(
    tenant: TenantContext,
    relation: {
      id: string;
      fromKnowledgeId: string;
      toKnowledgeId: string;
      relationType: string;
      source?: string;
      confidence?: number;
    },
  ): Promise<KnowledgeRelationModel>;
  listKnowledgeRelations(tenant: TenantContext, knowledgeId: string): Promise<KnowledgeRelationModel[]>;
  /** CAP-015：获取关系详情 */
  getKnowledgeRelation(tenant: TenantContext, relationId: string): Promise<KnowledgeRelationModel | null>;
  /** CAP-015：纠正关系 — corrected 状态停止用于讲解和推荐 */
  correctKnowledgeRelation(
    tenant: TenantContext,
    relationId: string,
    reason: string,
  ): Promise<KnowledgeRelationModel | null>;
  /** CAP-015：合并两条关系 */
  mergeKnowledgeRelations(
    tenant: TenantContext,
    sourceRelationId: string,
    targetRelationId: string,
  ): Promise<KnowledgeRelationModel | null>;
  /** CAP-015：拆分关系（标记为 split，可选创建新关系） */
  splitKnowledgeRelation(
    tenant: TenantContext,
    relationId: string,
    reason: string,
  ): Promise<KnowledgeRelationModel | null>;
  /** CAP-015：软删除关系 */
  deleteKnowledgeRelation(tenant: TenantContext, relationId: string): Promise<KnowledgeRelationModel | null>;
  /** CAP-015：获取知识图谱（仅 active 关系，用于讲解和推荐） */
  getActiveKnowledgeGraph(
    tenant: TenantContext,
    knowledgeId: string,
  ): Promise<KnowledgeRelationModel[]>;

  // ============ CAP-016 练习报告 ============

  /** CAP-016：创建练习报告 */
  createPracticeReport(
    tenant: TenantContext,
    input: {
      id: string;
      sessionId: string;
      totalQuestions: number;
      correctCount: number;
      incorrectCount: number;
      avgTimeSpentSec?: number;
      totalHintsUsed?: number;
      masteryPrediction?: number;
      biasAssessment?: string;
      reportType?: string;
    },
  ): Promise<PracticeReportModel>;
  /** CAP-016：获取练习报告 */
  getPracticeReport(tenant: TenantContext, reportId: string): Promise<PracticeReportModel | null>;
  /** CAP-016：按会话查询报告 */
  listPracticeReports(tenant: TenantContext, sessionId: string): Promise<PracticeReportModel[]>;
  /** CAP-016：重置推断（保留原始作答） */
  resetMasteryInference(
    tenant: TenantContext,
    sessionId: string,
  ): Promise<PracticeReportModel>;

  // ============ CAP-017 学习规划（里程碑 + 任务路线图） ============

  /** 创建学习规划（事务写入规划 + 里程碑 + 任务） */
  createLearningPlan(
    tenant: TenantContext,
    input: {
      id: string;
      topic: string;
      level?: string;
      title: string;
      description: string;
      learningObjective: string;
      gains?: string[];
      dailyAvailableMinutes?: number;
      milestones: Array<{
        id: string;
        title: string;
        description?: string;
        briefing?: string;
        completionCriteria?: string;
        debrief?: string;
        tasks: Array<{
          id: string;
          title: string;
          description?: string;
          hints?: string[];
        }>;
      }>;
    },
  ): Promise<LearningPlanModel>;
  /** 获取规划（聚合里程碑与任务） */
  getLearningPlan(tenant: TenantContext, planId: string): Promise<LearningPlanModel | null>;
  /** 列出规划 */
  listLearningPlans(tenant: TenantContext, includeArchived?: boolean): Promise<LearningPlanModel[]>;
  /** 更新任务状态并推进里程碑（任务全 done → 里程碑 completed + 下一里程碑 active） */
  setPlanTaskStatus(
    tenant: TenantContext,
    taskId: string,
    status: "todo" | "done",
  ): Promise<LearningPlanModel | null>;
  /** 归档规划 */
  archiveLearningPlan(tenant: TenantContext, planId: string): Promise<LearningPlanModel | null>;
}

export interface KnowledgeRelationModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  fromKnowledgeId: string;
  toKnowledgeId: string;
  relationType: string;
  source: string;
  confidence: number;
  /** CAP-015：纠正状态 */
  correctionStatus: string;
  /** CAP-015：纠正原因 */
  correctionReason?: string | null;
  /** CAP-015：合并目标 */
  mergedInto?: string | null;
  /** CAP-015：软删除 */
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

// ============ CAP-016 练习报告 ============

export interface PracticeReportModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  sessionId: string;
  totalQuestions: number;
  correctCount: number;
  incorrectCount: number;
  avgTimeSpentSec?: number | null;
  totalHintsUsed: number;
  masteryPrediction?: number | null;
  biasAssessment?: string | null;
  reportType: string;
  isReset: boolean;
  createdAt: string;
  updatedAt: string;
}

// ============ CAP-017 学习规划（里程碑 + 任务路线图） ============

export interface PlanTaskModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  milestoneId: string;
  order: number;
  title: string;
  description?: string | null;
  hints: string[];
  status: string; // "todo" | "done"
  createdAt: string;
  updatedAt: string;
}

export interface PlanMilestoneModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  planId: string;
  order: number;
  title: string;
  description?: string | null;
  briefing?: string | null;
  completionCriteria?: string | null;
  debrief?: string | null;
  status: string; // "locked" | "active" | "completed"
  tasks: PlanTaskModel[];
  createdAt: string;
  updatedAt: string;
}

export interface LearningPlanModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  topic: string;
  level: string;
  title: string;
  description: string;
  learningObjective: string;
  gains: string[];
  dailyAvailableMinutes: number;
  status: string; // "active" | "archived"
  milestones: PlanMilestoneModel[];
  createdAt: string;
  updatedAt: string;
}

// ============ 反馈域 ============

export interface FeedbackModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  actorId: string;
  subjectType: string;
  subjectId: string;
  type: string;
  note?: string | null;
  createdAt: string;
}

export interface IFeedbackRepository {
  createFeedback(
    tenant: TenantContext,
    feedbackData: {
      id: string;
      actorId: string;
      subjectType: string;
      subjectId: string;
      type: string;
      note?: string | null;
    },
  ): Promise<FeedbackModel>;
  listFeedback(tenant: TenantContext, subjectType?: string, subjectId?: string): Promise<FeedbackModel[]>;
}

// ============ 统一来源链 + 记忆版本/证据/事件 ============

export interface SourceArtifactModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  kind: string;
  ownerModule: string;
  currentRevisionId?: string | null;
  occurredAt: string;
  ingestedAt: string;
  deletedAt?: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface SourceRevisionModel {
  id: string;
  artifactId: string;
  checksum: string;
  content?: string | null;
  version: number;
  supersededAt?: string | null;
  createdAt: string;
}

export interface MemoryRevisionModel {
  id: string;
  memoryId: string;
  content: string;
  confidence: number;
  importance: number;
  algorithmVersion?: string | null;
  createdAt: string;
}

export interface MemoryEvidenceModel {
  id: string;
  memoryRevisionId: string;
  sourceArtifactId: string;
  sourceRevisionId: string;
  sourceRange?: string | null;
  status: string;
  createdAt: string;
}

export interface MemoryEventModel {
  id: string;
  memoryId: string;
  action: string;
  fromTier?: string | null;
  toTier?: string | null;
  reason?: string | null;
  actorType: string;
  createdAt: string;
}

export interface IProvenanceRepository {
  createSourceArtifact(
    tenant: TenantContext,
    artifact: {
      id: string;
      kind: string;
      ownerModule: string;
      occurredAt: string;
      ingestedAt: string;
    },
  ): Promise<SourceArtifactModel>;
  getSourceArtifact(tenant: TenantContext, id: string): Promise<SourceArtifactModel | null>;
  appendSourceRevision(
    tenant: TenantContext,
    artifactId: string,
    revision: { id: string; checksum: string; content?: string | null },
  ): Promise<SourceRevisionModel>;
  setCurrentRevision(tenant: TenantContext, artifactId: string, revisionId: string): Promise<SourceArtifactModel | null>;
  appendMemoryRevision(
    tenant: TenantContext,
    revision: {
      id: string;
      memoryId: string;
      content: string;
      confidence?: number;
      importance?: number;
      algorithmVersion?: string | null;
    },
  ): Promise<MemoryRevisionModel>;
  setMemoryCurrentRevision(tenant: TenantContext, memoryId: string, revisionId: string): Promise<boolean>;
  listMemoryRevisions(tenant: TenantContext, memoryId: string): Promise<MemoryRevisionModel[]>;
  createMemoryEvidence(
    tenant: TenantContext,
    evidence: {
      id: string;
      memoryRevisionId: string;
      sourceArtifactId: string;
      sourceRevisionId: string;
      sourceRange?: string | null;
    },
  ): Promise<MemoryEvidenceModel>;
  recordMemoryEvent(
    tenant: TenantContext,
    event: {
      id: string;
      memoryId: string;
      action: string;
      fromTier?: string | null;
      toTier?: string | null;
      reason?: string | null;
      actorType?: string;
    },
  ): Promise<MemoryEventModel>;
  listMemoryEvents(tenant: TenantContext, memoryId: string): Promise<MemoryEventModel[]>;
}

// ============ 平台/运营域 ============

export interface ScheduledJobModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  jobType: string;
  subjectId: string;
  idempotencyKey: string;
  runAt: string;
  status: string;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  type: string;
  scheduledAt: string;
  sentAt?: string | null;
  channel: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface PromptVersionModel {
  id: string;
  purpose: string;
  version: number;
  checksum: string;
  status: string;
  approvedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelRunModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  /** 阶段 7（ADR-017）：Attempt/Step 关联（存量慢启动回填，可为空） */
  attemptId?: string | null;
  stepId?: number | null;
  purpose: string;
  provider: string;
  modelId: string;
  promptVersionId?: string | null;
  contextManifestId?: string | null;
  latencyMs?: number | null;
  tokenUsage?: unknown;
  cost?: number | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContextManifestModel {
  id: string;
  modelRunId: string;
  purpose: string;
  sourceArtifactId: string;
  sourceRevisionId: string;
  selectionReason?: string | null;
  permissionSnapshot?: unknown;
  /** 阶段 7（ADR-017）：上下文快照（每 Turn 首个 Step 的 messages；可空） */
  snapshot?: unknown;
  tokenBudget?: number | null;
  createdAt: string;
}

export interface AuditRecordModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  actorType: string;
  actorId: string;
  action: string;
  subjectType: string;
  subjectId: string;
  metadata?: unknown;
  createdAt: string;
}

export interface IPlatformRepository {
  createScheduledJob(
    tenant: TenantContext,
    job: { id: string; jobType: string; subjectId: string; idempotencyKey: string; runAt: string },
  ): Promise<ScheduledJobModel>;
  markJobDone(tenant: TenantContext, id: string): Promise<ScheduledJobModel | null>;
  createNotification(
    tenant: TenantContext,
    notification: { id: string; type: string; scheduledAt: string; channel: string },
  ): Promise<NotificationModel>;
  markNotificationSent(tenant: TenantContext, id: string): Promise<NotificationModel | null>;
  listNotifications(tenant: TenantContext, limit?: number): Promise<NotificationModel[]>;
  createPromptVersion(
    version: { id: string; purpose: string; version: number; checksum: string; status?: string },
  ): Promise<PromptVersionModel>;
  getPromptVersion(purpose: string, version: number): Promise<PromptVersionModel | null>;
  createModelRun(
    tenant: TenantContext,
    run: {
      id: string;
      purpose: string;
      provider: string;
      modelId: string;
      promptVersionId?: string | null;
    },
  ): Promise<ModelRunModel>;
  completeModelRun(
    tenant: TenantContext,
    id: string,
    result: { latencyMs?: number; tokenUsage?: unknown; cost?: number; status?: string },
  ): Promise<ModelRunModel | null>;
  attachContextManifest(tenant: TenantContext, modelRunId: string, manifestId: string): Promise<ModelRunModel | null>;
  createContextManifest(
    manifest: {
      id: string;
      modelRunId: string;
      purpose: string;
      sourceArtifactId: string;
      sourceRevisionId: string;
      selectionReason?: string | null;
      permissionSnapshot?: unknown;
      tokenBudget?: number | null;
    },
  ): Promise<ContextManifestModel>;
  createAuditRecord(
    tenant: TenantContext,
    record: {
      id: string;
      actorType: string;
      actorId: string;
      action: string;
      subjectType: string;
      subjectId: string;
      metadata?: unknown;
    },
  ): Promise<AuditRecordModel>;
  listAuditRecords(tenant: TenantContext, limit?: number): Promise<AuditRecordModel[]>;
  // MVP 补齐（PRD §8）：工具策略 + 评估集（系统级，无租户列）
  createToolPolicy(policy: {
    id: string;
    purpose: string;
    toolName: string;
    scope?: string;
    approvalMode?: string;
    timeoutMs?: number | null;
    quota?: number | null;
    version?: number;
    status?: string;
  }): Promise<ToolPolicyModel>;
  getToolPolicy(purpose: string, toolName: string, version: number): Promise<ToolPolicyModel | null>;
  createEvalSet(evalSet: {
    id: string;
    purpose: string;
    version: number;
    language?: string;
    domain: string;
    sampleCount?: number;
    annotationPolicy?: unknown;
    status?: string;
  }): Promise<EvalSetModel>;
  listEvalSets(purpose: string): Promise<EvalSetModel[]>;
}

export interface ToolPolicyModel {
  id: string;
  purpose: string;
  toolName: string;
  scope: string;
  approvalMode: string;
  timeoutMs?: number | null;
  quota?: number | null;
  version: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface EvalSetModel {
  id: string;
  purpose: string;
  version: number;
  language: string;
  domain: string;
  sampleCount: number;
  annotationPolicy?: unknown;
  status: string;
  createdAt: string;
  updatedAt: string;
}

// ============ 埋点事件域 ============

export interface AnalyticsEventModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  eventName: string;
  eventSchemaVersion: number;
  occurredAt: string;
  analyticsSubjectId: string;
  context?: unknown;
  privacyClass: string;
}

export interface IAnalyticsRepository {
  recordEvent(
    tenant: TenantContext,
    event: {
      id: string;
      eventName: string;
      eventSchemaVersion?: number;
      occurredAt?: string;
      analyticsSubjectId: string;
      context?: unknown;
      privacyClass?: string;
    },
  ): Promise<AnalyticsEventModel>;
  listEventsBySubject(tenant: TenantContext, analyticsSubjectId: string, limit?: number): Promise<AnalyticsEventModel[]>;
}

// ============ 内容/资源域 ============

export interface AttachmentModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  objectKey: string;
  mediaType: string;
  size: number;
  scanStatus: string;
  sourceLicense?: string | null;
  /** CAP-012：用途声明 */
  purpose?: string | null;
  /** CAP-012：解析状态 */
  parseStatus?: string | null;
  /** CAP-012：幂等键 */
  idempotencyKey?: string | null;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** CAP-012 FR-EXT-002：附件解析结果模型 */
export interface AttachmentParseResultModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  attachmentId: string;
  parseStatus: string;
  parsedText?: string | null;
  confidence?: number | null;
  parseError?: string | null;
  cropData?: unknown;
  operation: string;
  idempotencyKey?: string | null;
  supersededAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmbeddingIndexModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  sourceArtifactId: string;
  sourceRevisionId: string;
  modelId: string;
  dimension: number;
  indexVersion: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface IContentRepository {
  createAttachment(
    tenant: TenantContext,
    attachment: {
      id: string;
      objectKey: string;
      mediaType: string;
      size?: number;
      scanStatus?: string;
      sourceLicense?: string | null;
      purpose?: string | null;
      idempotencyKey?: string | null;
    },
  ): Promise<AttachmentModel>;
  getAttachment(tenant: TenantContext, id: string): Promise<AttachmentModel | null>;
  /** CAP-012 BR-EXT-002：软删除附件 */
  softDeleteAttachment(tenant: TenantContext, id: string): Promise<AttachmentModel | null>;
  /** CAP-012 BR-EXT-001：幂等键查询 */
  getAttachmentByIdempotencyKey(tenant: TenantContext, key: string): Promise<AttachmentModel | null>;
  /** CAP-012 FR-EXT-002：创建解析结果 */
  createParseResult(
    tenant: TenantContext,
    input: {
      id: string;
      attachmentId: string;
      parseStatus?: string;
      parsedText?: string;
      confidence?: number;
      parseError?: string;
      cropData?: unknown;
      operation?: string;
      idempotencyKey?: string;
    },
  ): Promise<AttachmentParseResultModel>;
  /** CAP-012 FR-EXT-002：获取当前（未取代）解析结果 */
  getActiveParseResult(tenant: TenantContext, attachmentId: string): Promise<AttachmentParseResultModel | null>;
  /** CAP-012 BR-EXT-001 AC-02：幂等键查询解析结果 */
  getParseResultByIdempotencyKey(tenant: TenantContext, key: string): Promise<AttachmentParseResultModel | null>;
  /** CAP-012 FR-EXT-002：列出租户内附件的所有解析结果 */
  listParseResults(tenant: TenantContext, attachmentId: string): Promise<AttachmentParseResultModel[]>;
  /** CAP-012 FR-EXT-002：取代旧解析结果（裁剪/转文字时） */
  supersedeParseResult(tenant: TenantContext, parseResultId: string): Promise<void>;
  /** CAP-012 BR-EXT-002：失效所有解析结果（删除附件时） */
  invalidateParseResults(tenant: TenantContext, attachmentId: string): Promise<number>;
  createEmbeddingIndex(
    tenant: TenantContext,
    index: {
      id: string;
      sourceArtifactId: string;
      sourceRevisionId: string;
      modelId: string;
      dimension?: number;
      indexVersion?: number;
      status?: string;
    },
  ): Promise<EmbeddingIndexModel>;
  listEmbeddingIndexes(tenant: TenantContext, sourceArtifactId: string): Promise<EmbeddingIndexModel[]>;
}

// ============ CAP-011 学习资料整理（FR-LRN-002/003、BR-LRN-001）============

export interface StudyMaterialModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  goalId?: string | null;
  type: string;
  title: string;
  currentVersionId?: string | null;
  status: string;
  idempotencyKey?: string | null;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MaterialVersionModel {
  id: string;
  materialId: string;
  workspaceId: string;
  subjectUserId: string;
  version: number;
  content: string;
  format: string;
  author: string;
  supersededAt?: string | null;
  createdAt: string;
}

export interface MaterialSourceModel {
  id: string;
  materialVersionId: string;
  workspaceId: string;
  subjectUserId: string;
  sourceType: string;
  sourceUri?: string | null;
  sourceTitle?: string | null;
  licenseStatus: string;
  verificationStatus: string;
  invalidatedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IStudyMaterialRepository {
  create(
    tenant: TenantContext,
    input: {
      id: string;
      goalId?: string;
      type: string;
      title: string;
      idempotencyKey?: string;
    },
  ): Promise<StudyMaterialModel>;
  get(tenant: TenantContext, id: string): Promise<StudyMaterialModel | null>;
  listByGoal(tenant: TenantContext, goalId: string): Promise<StudyMaterialModel[]>;
  listByTenant(tenant: TenantContext): Promise<StudyMaterialModel[]>;
  updateStatus(tenant: TenantContext, id: string, status: string): Promise<StudyMaterialModel | null>;
  softDelete(tenant: TenantContext, id: string): Promise<StudyMaterialModel | null>;
  getByIdempotencyKey(tenant: TenantContext, key: string): Promise<StudyMaterialModel | null>;

  createVersion(
    tenant: TenantContext,
    input: {
      id: string;
      materialId: string;
      content: string;
      format?: string;
      author?: string;
    },
  ): Promise<MaterialVersionModel>;
  getVersion(tenant: TenantContext, versionId: string): Promise<MaterialVersionModel | null>;
  listVersions(tenant: TenantContext, materialId: string): Promise<MaterialVersionModel[]>;
  editVersion(
    tenant: TenantContext,
    materialId: string,
    content: string,
    expectedVersion: number,
  ): Promise<MaterialVersionModel | null>;

  addSource(
    tenant: TenantContext,
    input: {
      id: string;
      materialVersionId: string;
      sourceType: string;
      sourceUri?: string;
      sourceTitle?: string;
      licenseStatus?: string;
      verificationStatus?: string;
    },
  ): Promise<MaterialSourceModel>;
  listSources(tenant: TenantContext, materialVersionId: string): Promise<MaterialSourceModel[]>;
  invalidateSources(tenant: TenantContext, materialVersionId: string): Promise<number>;
}

// ============ 安全域 ============

export interface SafetyIncidentModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  category: string;
  severity: string;
  disposition: string;
  policyVersion: string;
  createdAt: string;
}

export interface ISafetyRepository {
  recordIncident(
    tenant: TenantContext,
    incident: { id: string; category: string; severity: string; disposition: string; policyVersion: string },
  ): Promise<SafetyIncidentModel>;
  listIncidents(tenant: TenantContext, limit?: number): Promise<SafetyIncidentModel[]>;
}

// ============ 隐私/删除域 ============

export interface ConsentGrantModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  actorId: string;
  purpose: string;
  scope: string;
  policyVersion: string;
  grantedAt: string;
  revokedAt?: string | null;
  createdAt: string;
}

export interface DeletionRequestModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  scope: string;
  idempotencyKey: string;
  requestedAt: string;
  effectiveAt?: string | null;
  status: string;
  attemptCount: number;
  lastError?: string | null;
  ownerModule: string;
  lastVerifiedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeletionTargetModel {
  requestId: string;
  targetType: string;
  targetId: string;
  ownerModule: string;
  status: string;
  attemptCount: number;
  verifiedAt?: string | null;
  evidenceRef?: string | null;
}

export interface IPrivacyRepository {
  /** 2d：该租户是否存在未完成的删除/撤权请求（Loop fail-closed 闸门数据源） */
  hasPendingDeletionRequest(tenant: TenantContext): Promise<boolean>;
  grantConsent(
    tenant: TenantContext,
    grant: {
      id: string;
      actorId: string;
      purpose: string;
      scope: string;
      policyVersion: string;
      grantedAt?: string;
    },
  ): Promise<ConsentGrantModel>;
  revokeConsent(tenant: TenantContext, id: string, revokedAt?: string): Promise<ConsentGrantModel | null>;
  hasActiveConsent(tenant: TenantContext, purpose: string, scope: string): Promise<boolean>;
  createDeletionRequest(
    tenant: TenantContext,
    request: {
      id: string;
      scope: string;
      idempotencyKey: string;
      requestedAt?: string;
      ownerModule: string;
    },
  ): Promise<DeletionRequestModel>;
  getDeletionRequest(tenant: TenantContext, id: string): Promise<DeletionRequestModel | null>;
  updateDeletionRequestStatus(
    tenant: TenantContext,
    id: string,
    status: string,
    patch?: { lastError?: string | null; lastVerifiedAt?: string; attemptCount?: number },
  ): Promise<DeletionRequestModel | null>;
  createDeletionTarget(
    target: { requestId: string; targetType: string; targetId: string; ownerModule: string },
  ): Promise<DeletionTargetModel>;
  updateDeletionTargetStatus(
    target: { requestId: string; targetType: string; targetId: string },
    status: string,
    evidenceRef?: string,
  ): Promise<DeletionTargetModel | null>;
}

// ============ RecoveryControlLedger（独立故障域账本）============

export interface RecoveryLedgerEventModel {
  eventId: string;
  idempotencyKey: string;
  eventType: string;
  workspaceRef?: string | null;
  subjectRef?: string | null;
  targetRef?: string | null;
  occurredAt: string;
  sequence: number;
  tamperEvidence?: unknown;
}

export interface IRecoveryLedgerPort {
  appendEvent(event: {
    eventId: string;
    idempotencyKey: string;
    eventType: string;
    workspaceRef?: string | null;
    subjectRef?: string | null;
    targetRef?: string | null;
    occurredAt?: string;
    tamperEvidence?: unknown;
  }): Promise<RecoveryLedgerEventModel>;
  getMaxSequence(): Promise<number>;
  getBySequence(sequence: number): Promise<RecoveryLedgerEventModel | null>;
  getByIdempotencyKey(idempotencyKey: string): Promise<RecoveryLedgerEventModel | null>;
}

// ============ 内容/生态扩展域（P2/P3）============

export interface ExternalSourceModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  provider: string;
  externalId: string;
  permissionScope: string;
  syncState: string;
  revokedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PluginModel {
  id: string;
  publisher: string;
  version: string;
  checksum: string;
  signature?: string | null;
  permissions?: unknown;
  installSource: string;
  enabled: number;
  configSchemaJson?: unknown;
  configSchemaVersion?: number;
  createdAt: string;
  updatedAt: string;
}

export interface PluginGrantModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  pluginId: string;
  permission: string;
  scope: string;
  grantedAt: string;
  revokedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommunityContentModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  authorId: string;
  type: string;
  status: string;
  reviewState: string;
  visibility: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  ownerId: string;
  memberScope: string;
  policyVersion: string;
  createdAt: string;
  updatedAt: string;
}

export interface IExtensionRepository {
  createExternalSource(
    tenant: TenantContext,
    source: { id: string; provider: string; externalId: string; permissionScope: string; syncState?: string },
  ): Promise<ExternalSourceModel>;
  getExternalSource(tenant: TenantContext, id: string): Promise<ExternalSourceModel | null>;
  createPlugin(
    plugin: {
      id: string;
      publisher: string;
      version: string;
      checksum: string;
      signature?: string | null;
      permissions?: unknown;
      installSource?: string;
      enabled?: number;
      configSchemaJson?: unknown;
      configSchemaVersion?: number;
    },
  ): Promise<PluginModel>;
  listPlugins(): Promise<PluginModel[]>;
  getPlugin(id: string): Promise<PluginModel | null>;
  /** CR-006：登记插件配置 Schema（系统级） */
  setPluginConfigSchema(id: string, schema: unknown, schemaVersion: number): Promise<PluginModel | null>;

  /** CAP-020：启停插件（联动其声明的工具启停） */
  setPluginEnabled(id: string, enabled: boolean): Promise<PluginModel | null>;
  /** CAP-020：卸载插件（需先注销其工具） */
  deletePlugin(id: string): Promise<boolean>;
  grantPlugin(
    tenant: TenantContext,
    grant: { id: string; pluginId: string; permission: string; scope: string; grantedAt?: string },
  ): Promise<PluginGrantModel>;
  revokePluginGrant(tenant: TenantContext, id: string): Promise<PluginGrantModel | null>;
  hasPluginPermission(tenant: TenantContext, pluginId: string, permission: string): Promise<boolean>;
  createCommunityContent(
    tenant: TenantContext,
    content: { id: string; authorId: string; type: string; status?: string; reviewState?: string; visibility?: string },
  ): Promise<CommunityContentModel>;
  getCommunityContent(tenant: TenantContext, id: string): Promise<CommunityContentModel | null>;
  createOrganization(
    tenant: TenantContext,
    org: { id: string; ownerId: string; memberScope?: string; policyVersion: string },
  ): Promise<OrganizationModel>;
  getOrganization(tenant: TenantContext, id: string): Promise<OrganizationModel | null>;
}

// ============ 插件 Config / Page（CAP-020 扩展 · CR-006）============

export interface PluginConfigModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  pluginId: string;
  /** 非敏感配置值 */
  valuesJson: unknown;
  /** 已配置 secret 字段键 */
  secretKeysJson: string[];
  schemaVersion: number;
  revision: number;
  orphanedValuesJson?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface PluginSecretModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  pluginId: string;
  fieldKey: string;
  valueJson: unknown;
  configured: number;
  createdAt: string;
  updatedAt: string;
}

export interface PluginPageModel {
  id: string;
  pluginId: string;
  pageId: string;
  title: unknown;
  description?: unknown;
  entry: string;
  capabilitiesJson: string[];
  checksum?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 配置保存输入（由 API 层完成 Schema 校验/默认值合并后调用） */
export interface PluginConfigSaveInput {
  pluginId: string;
  schemaVersion: number;
  /** 期望 revision（-1 表示无条件写） */
  expectedRevision: number;
  values: Record<string, unknown>;
  secretKeys: string[];
  orphanedValues?: Record<string, unknown>;
}

export interface IPluginConfigRepository {
  getConfig(
    tenant: TenantContext,
    pluginId: string,
  ): Promise<PluginConfigModel | null>;
  saveConfig(
    tenant: TenantContext,
    input: PluginConfigSaveInput,
  ): Promise<{ saved: PluginConfigModel; conflict: boolean }>;
  resetConfig(
    tenant: TenantContext,
    pluginId: string,
    schemaVersion: number,
    defaults: Record<string, unknown>,
  ): Promise<PluginConfigModel>;
  deleteConfigsForPlugin(pluginId: string): Promise<void>;
}

export interface IPluginSecretRepository {
  put(
    tenant: TenantContext,
    entry: { pluginId: string; fieldKey: string; value: unknown },
  ): Promise<void>;
  getState(
    tenant: TenantContext,
    pluginId: string,
    fieldKey: string,
  ): Promise<{ configured: boolean }>;
  listStates(
    tenant: TenantContext,
    pluginId: string,
  ): Promise<Array<{ fieldKey: string; configured: boolean }>>;
  delete(
    tenant: TenantContext,
    pluginId: string,
    fieldKey: string,
  ): Promise<void>;
  deleteAllForPlugin(pluginId: string): Promise<void>;
}

export interface IPluginPageRepository {
  upsertPage(page: {
    pluginId: string;
    pageId: string;
    title: unknown;
    description?: unknown;
    entry: string;
    capabilities: string[];
    checksum?: string | null;
  }): Promise<PluginPageModel>;
  listPages(pluginId: string): Promise<PluginPageModel[]>;
  getPage(pluginId: string, pageId: string): Promise<PluginPageModel | null>;
  deletePagesForPlugin(pluginId: string): Promise<void>;
}

// ============ CAP-010 人格问卷与基础偏好（FR-PER-001/002/003）============

export interface PersonaPreferencesModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  /** 语气: "friendly" | "neutral" | "formal" */
  tone: string;
  /** 主动程度: "low" | "medium" | "high" */
  proactiveness: string;
  /** 称呼: "casual" | "formal" | "none" */
  addressForm: string;
  /** 提醒节奏: "gentle" | "moderate" | "frequent" */
  reminderCadence: string;
  /** 偏好版本号，每次修改递增 */
  version: number;
  /** 问卷是否已跳过 */
  skipped: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface IPersonaPreferencesRepository {
  /** 获取当前租户偏好（不存在返回 null） */
  get(tenant: TenantContext): Promise<PersonaPreferencesModel | null>;
  /** 首次填写问卷（跳过或提交四项） */
  save(
    tenant: TenantContext,
    input: {
      tone?: string;
      proactiveness?: string;
      addressForm?: string;
      reminderCadence?: string;
      skipped?: boolean;
    },
  ): Promise<PersonaPreferencesModel>;
  /** 单项或多项更新，版本号递增 */
  update(
    tenant: TenantContext,
    input: {
      tone?: string;
      proactiveness?: string;
      addressForm?: string;
      reminderCadence?: string;
    },
  ): Promise<PersonaPreferencesModel>;
  /** 重置为中性默认值（FR-PER-002） */
  reset(tenant: TenantContext): Promise<PersonaPreferencesModel>;
}

// ============ 语音输出配置（系统核心能力 · CR-011 阶段 1：本地语音模型配置）============

/** 本地语音模型配置模型（voice_configs 行；每租户一行） */
export interface LocalVoiceConfigModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  enabled: number;
  providerId: string;
  modelPath?: string | null;
  modelId: string;
  speakerId?: string | null;
  settingsJson?: unknown;
  createdAt: string;
  updatedAt: string;
}

/** 本地语音配置保存输入（由 API 层完成 Schema 校验/默认值合并后调用） */
export interface LocalVoiceConfigSaveInput {
  enabled: boolean;
  providerId: string;
  modelPath?: string | null;
  modelId: string;
  speakerId?: string | null;
  settings?: Record<string, unknown>;
}

export interface IVoiceConfigRepository {
  /** 读取当前租户的本地语音配置（不存在返回 null） */
  getConfig(tenant: TenantContext): Promise<LocalVoiceConfigModel | null>;
  /** upsert：存在则更新，不存在则插入；返回保存后的模型 */
  saveConfig(tenant: TenantContext, input: LocalVoiceConfigSaveInput): Promise<LocalVoiceConfigModel>;
}

// ============ CR-016 离线语音输入 (ASR) 配置持久化 ============

export interface VoiceInputConfigModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  enabled: number;
  engineType: string;
  modelPath?: string | null;
  modelId: string;
  endpoint?: string | null;
  apiKey?: string | null;
  autoStopOnKeyboard: number;
  vadSilenceThresholdMs: number;
  settingsJson: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceInputConfigSaveInput {
  enabled: boolean;
  engineType: string;
  modelPath?: string | null;
  modelId: string;
  endpoint?: string | null;
  apiKey?: string | null;
  autoStopOnKeyboard?: boolean;
  vadSilenceThresholdMs?: number;
  settings?: Record<string, unknown>;
}

export interface IVoiceInputConfigRepository {
  getConfig(tenant: TenantContext): Promise<VoiceInputConfigModel | null>;
  saveConfig(
    tenant: TenantContext,
    input: VoiceInputConfigSaveInput,
  ): Promise<VoiceInputConfigModel>;
}

// ============ T-04 工具注册表 + AST-04 门控 + PET-05 安全级别 ============

export interface ToolRegistrationModel {
  id: string;
  name: string;
  description: string;
  category: string; // memory/search/learning/diary/system/external
  /** PET-05 安全级别：read_only / write_with_approval / privileged */
  safetyLevel: string;
  /** B3：结果未知恢复复议声明（"never" | "safe"；NULL=未声明，收敛） */
  replay?: string | null;
  requiredPermissionsJson?: unknown;
  inputSchemaJson?: unknown;
  builtin: number; // 0 | 1
  pluginId?: string | null;
  enabled: number; // 0 | 1
  /** AST-04 条件门控（JSON 数组，运行时求值） */
  gatingConditionsJson?: unknown;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export interface IToolRegistryRepository {
  /** 注册工具（幂等：同一 id 覆盖元数据，enabled 保持不变） */
  registerTool(
    tool: {
      id: string;
      name: string;
      description: string;
      category: string;
      safetyLevel?: string;
      /** B3：结果未知恢复复议声明（"never" | "safe"；省略=未声明，收敛） */
      replay?: string;
      requiredPermissions?: unknown;
      inputSchema?: unknown;
      builtin?: boolean;
      pluginId?: string | null;
      gatingConditions?: unknown;
      priority?: number;
    },
  ): Promise<ToolRegistrationModel>;
  /** 获取单个工具注册信息 */
  getTool(id: string): Promise<ToolRegistrationModel | null>;
  /** 列出所有工具 */
  listTools(): Promise<ToolRegistrationModel[]>;
  /** 启用/禁用工具（disabledToolIds 操作） */
  setEnabled(id: string, enabled: boolean): Promise<ToolRegistrationModel | null>;
  /** 注销工具（内置工具不可注销） */
  unregisterTool(id: string): Promise<boolean>;
  /**
   * 导出工具注册表快照（面向 AI 运行时 / MCP server）
   * 过滤逻辑：enabled = 1 且门控条件通过（门控求值由调用方注入 evaluator）
   */
  exportRegistry(
    options?: {
      /** 全局禁用列表（补充 per-entry enabled=false） */
      disabledToolIds?: string[];
      /** AST-04 门控求值函数（field, operator, value, context）→ boolean */
      gatingEvaluator?: (condition: {
        field: string;
        operator: string;
        value?: unknown;
        evaluatorId?: string;
      }, context?: unknown) => boolean;
      /** 门控求值上下文 */
      gatingContext?: unknown;
      /** 按分类过滤 */
      category?: string;
    },
  ): Promise<ToolRegistrationModel[]>;
}

// ============ Persona / Skills / MCP / 上下文快照域（CAP-019/CAP-020）============

/** 人格（与 @aervox/mod-persona 领域类型结构一致，但由主仓数据库拥有模型） */
export interface PersonaModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  name: string;
  description: string;
  source: string; // "builtin" | "user_created" | "imported"
  status: string; // "active" | "archived"
  /** 模板审核状态：draft | pending_review | approved | rejected */
  reviewStatus: string;
  /** 审核备注 */
  reviewNotes: string;
  /** 审核时间 ISO-8601 */
  reviewedAt: string | null;
  currentRevisionId: string;
  createdAt: string;
  updatedAt: string;
}

// ============ CAP-020 Skill 能力（系统级注册表 + Neo 生命周期）============

/** Skill 注册表条目（DB 真源映射；内容本体在文件系统） */
export interface SkillRegistrationModel {
  /** 技能唯一标识（即目录名） */
  id: string;
  name: string;
  description: string;
  /** local / plugin / ai_authored */
  source: string;
  /** 0 | 1 */
  active: number;
  /** 0 | 1 */
  readonly: number;
  version: string;
  checksum?: string | null;
  pluginId?: string | null;
  /** AST-04 条件门控（JSON 数组） */
  gatingConditionsJson?: unknown;
  contentPath?: string | null;
  lastUsedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 人格不可变修订 */
export interface PersonaRevisionModel {
  id: string;
  personaId: string;
  revision: number;
  config: unknown; // PersonaRevisionConfig（JSON）
  checksum: string;
  createdAt: string;
}

/** 当前激活人格 */
export interface ActivePersonaSelectionModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  personaId: string;
  revisionId: string;
  selectedAt: string;
  createdAt: string;
  updatedAt: string;
}

/** Neo 生命周期：不可变技能内容载荷 */
export interface SkillPayloadModel {
  payloadRef: string;
  kind: string;
  content: unknown;
  checksum?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Neo 生命周期：技能候选 */
export interface SkillCandidateModel {
  candidateId: string;
  skillKey: string;
  /** { turnIds, memoryIds, learningItemIds } */
  sourceEvidence: { turnIds: string[]; memoryIds: string[]; learningItemIds: string[] };
  payloadRef?: string | null;
  scenarioKey?: string | null;
  /** pending / evaluated / promoted / rejected */
  status: string;
  createdAt: string;
  updatedAt: string;
}

/** Neo 生命周期：发布记录 */
export interface SkillReleaseModel {
  releaseId: string;
  skillKey: string;
  /** canary / stable */
  stage: string;
  candidateId: string;
  payloadRef?: string | null;
  version: number;
  /** 0 | 1 */
  active: number;
  /** 0 | 1 */
  syncedToLocal: number;
  createdAt: string;
  updatedAt: string;
}

/** Turn 级 PersonaContextSnapshot 持久化模型 */
export interface PersonaTurnContextModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  turnId: string;
  personaId: string;
  revisionId: string;
  revisionChecksum: string;
  promptChecksum: string;
  skillChecksums: string[];
  mcpToolIds: string[];
  voice?: unknown;
  createdAt: string;
}

/** 人格切换日志（CAP-019） */
export interface PersonaSwitchLogModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  personaId: string;
  revisionId: string;
  previousPersonaId: string | null;
  previousRevisionId: string | null;
  switchReason: string; // "user_initiated" | "rollback" | "system_default"
  regressionNotes: string | null;
  switchedAt: string;
}

/** 人格记忆范围配置（CAP-019） */
export interface PersonaMemoryScopeModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  personaId: string;
  memoryPolicy: string; // "isolated" | "shared"
  sharedPersonaIds: string[];
  sharedCategories: string[]; // "learning" | "preference" | "diary" | "fact"
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IPersonaRepository {
  listPersonas(tenant: TenantContext): Promise<PersonaModel[]>;
  getPersona(tenant: TenantContext, personaId: string): Promise<PersonaModel | null>;
  listPersonaRevisions(tenant: TenantContext, personaId: string): Promise<PersonaRevisionModel[]>;
  getPersonaRevision(
    tenant: TenantContext,
    personaId: string,
    revisionId?: string,
  ): Promise<PersonaRevisionModel | null>;
  /** 按全局唯一 personaId 读取修订（personaId 为 UUID，租户不参与过滤；仅供模块适配器使用） */
  getPersonaRevisionById(personaId: string, revisionId?: string): Promise<PersonaRevisionModel | null>;
  createPersona(
    tenant: TenantContext,
    data: {
      id: string;
      name: string;
      description?: string;
      source?: string;
      config: unknown;
      checksum: string;
    },
  ): Promise<{ persona: PersonaModel; revision: PersonaRevisionModel }>;
  updatePersona(
    tenant: TenantContext,
    data: {
      personaId: string;
      expectedRevision: number;
      name?: string;
      description?: string;
      config: unknown;
      checksum: string;
    },
  ): Promise<{ persona: PersonaModel; revision: PersonaRevisionModel } | null>;
  deletePersona(tenant: TenantContext, personaId: string): Promise<boolean>;
  activatePersona(
    tenant: TenantContext,
    personaId: string,
    revisionId?: string,
  ): Promise<ActivePersonaSelectionModel | null>;
  getActivePersona(tenant: TenantContext): Promise<ActivePersonaSelectionModel | null>;
  saveTurnContext(tenant: TenantContext, context: PersonaTurnContextModel): Promise<PersonaTurnContextModel>;
  getTurnContext(tenant: TenantContext, turnId: string): Promise<PersonaTurnContextModel | null>;

  // ---- CAP-019 扩展：模板审核、切换日志、回滚、记忆范围 ----

  /** 更新人格审核状态 */
  reviewPersona(
    tenant: TenantContext,
    personaId: string,
    reviewStatus: "pending_review" | "approved" | "rejected",
    reviewNotes?: string,
  ): Promise<PersonaModel | null>;

  /** 回滚人格到指定修订（更新 currentRevisionId，不删除修订历史） */
  rollbackPersona(
    tenant: TenantContext,
    personaId: string,
    revisionId: string,
  ): Promise<{ persona: PersonaModel; revision: PersonaRevisionModel } | null>;

  /** 记录人格切换日志 */
  recordSwitchLog(
    tenant: TenantContext,
    data: {
      personaId: string;
      revisionId: string;
      previousPersonaId?: string | null;
      previousRevisionId?: string | null;
      switchReason?: string;
      regressionNotes?: string | null;
    },
  ): Promise<PersonaSwitchLogModel>;

  /** 获取人格切换历史 */
  getSwitchHistory(
    tenant: TenantContext,
    personaId?: string,
  ): Promise<PersonaSwitchLogModel[]>;

  /** 获取人格记忆范围配置 */
  getMemoryScope(tenant: TenantContext, personaId: string): Promise<PersonaMemoryScopeModel | null>;

  /** 更新或创建人格记忆范围配置 */
  upsertMemoryScope(
    tenant: TenantContext,
    personaId: string,
    data: {
      memoryPolicy: "isolated" | "shared";
      sharedPersonaIds?: string[];
      sharedCategories?: string[];
      confirmedAt?: string | null;
    },
  ): Promise<PersonaMemoryScopeModel>;
}

// ============ CAP-020 Skill 能力：系统级注册表 + Neo 生命周期（本分支实现） ============

export interface ISkillRegistryRepository {
  /** 注册技能（幂等：同一 id 覆盖元数据，active/readonly 保持既有状态） */
  registerSkill(
    skill: {
      id: string;
      name: string;
      description: string;
      source?: string;
      active?: boolean;
      readonly?: boolean;
      version?: string;
      checksum?: string | null;
      pluginId?: string | null;
      gatingConditions?: unknown;
      contentPath?: string | null;
    },
  ): Promise<SkillRegistrationModel>;
  getSkill(id: string): Promise<SkillRegistrationModel | null>;
  listSkills(activeOnly?: boolean): Promise<SkillRegistrationModel[]>;
  /** 启停技能（plugin/系统只读例外由调用方决定） */
  setActive(id: string, active: boolean): Promise<SkillRegistrationModel | null>;
  /** 注销技能（readonly=1 拒绝；由调用方负责清理文件系统内容） */
  unregisterSkill(id: string): Promise<boolean>;
  /** 无条件移除技能（忽略 readonly，供插件卸载等内部生命周期使用；调用方负责清理文件系统） */
  removeSkill(id: string): Promise<boolean>;
  /** 记录最近引用时间（召回窗口淘汰用） */
  touchSkill(id: string): Promise<SkillRegistrationModel | null>;
  /** 导出运行时可调用快照（active + 门控过滤） */
  exportSkills(options?: {
    gatingEvaluator?: (condition: {
      field: string;
      operator: string;
      value?: unknown;
      evaluatorId?: string;
    }, context?: unknown) => boolean;
    gatingContext?: unknown;
  }): Promise<SkillRegistrationModel[]>;
}

export interface ISkillLifecycleRepository {
  /** 创建载荷（幂等：同一 payloadRef 覆盖内容，checksum 同步） */
  createPayload(
    payload: { payloadRef: string; kind?: string; content: unknown; checksum?: string | null },
  ): Promise<SkillPayloadModel>;
  getPayload(payloadRef: string): Promise<SkillPayloadModel | null>;
  /** 创建候选（幂等：同一 candidateId 返回既有记录） */
  createCandidate(
    candidate: {
      candidateId: string;
      skillKey: string;
      sourceEvidence: { turnIds: string[]; memoryIds: string[]; learningItemIds: string[] };
      payloadRef?: string | null;
      scenarioKey?: string | null;
    },
  ): Promise<SkillCandidateModel>;
  getCandidate(candidateId: string): Promise<SkillCandidateModel | null>;
  listCandidates(options?: { skillKey?: string; status?: string }): Promise<SkillCandidateModel[]>;
  /** 更新候选状态（pending → evaluated/promoted/rejected） */
  updateCandidateStatus(
    candidateId: string,
    status: string,
  ): Promise<SkillCandidateModel | null>;
  /** 创建发布（幂等：同 skillKey+stage+version 返回既有；自动取消同 key+stage 旧 active） */
  createRelease(
    release: {
      releaseId: string;
      skillKey: string;
      stage: string;
      candidateId: string;
      payloadRef?: string | null;
      version: number;
    },
  ): Promise<SkillReleaseModel>;
  getRelease(releaseId: string): Promise<SkillReleaseModel | null>;
  listReleases(options?: { skillKey?: string; stage?: string; activeOnly?: boolean }): Promise<SkillReleaseModel[]>;
  /** 标记发布为已同步本地（synced_to_local=1） */
  markSyncedToLocal(releaseId: string): Promise<SkillReleaseModel | null>;
  /** 回滚：取消当前 active 发布（使旧发布重新可激活由调用方编排） */
  deactivateRelease(releaseId: string): Promise<SkillReleaseModel | null>;
  /** 设置发布 active 状态（回滚重新激活旧发布 / 取消激活用） */
  setReleaseActive(releaseId: string, active: boolean): Promise<SkillReleaseModel | null>;
}

// ============ CR-012 大语言模型与供应商配置持久化 ============

export interface LLMConfigModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  enabled: number;
  providerType: string;
  baseUrl: string;
  apiKey?: string | null;
  modelId: string;
  temperature: number;
  maxTokens?: number | null;
  settingsJson: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface LLMConfigSaveInput {
  enabled: boolean;
  providerType: string;
  baseUrl: string;
  apiKey?: string | null;
  modelId: string;
  temperature: number;
  maxTokens?: number;
  settings?: Record<string, unknown>;
}

export interface ILLMConfigRepository {
  getConfig(tenant: TenantContext): Promise<LLMConfigModel | null>;
  saveConfig(
    tenant: TenantContext,
    input: LLMConfigSaveInput,
  ): Promise<LLMConfigModel>;
}

// ============ CAP-033 主动智能模式：广域本地画像数据面 ============

export type ProactiveDesiredState = "none" | "enabled" | "paused" | "revoking" | "revoked";
export type ProactiveRevisionStatus = "draft" | "active" | "superseded" | "revoked";
export type ProactiveSourceGrantState = "requested" | "granted" | "denied" | "revoked" | "expired";
export type ProactiveActivationStatus = "active" | "expired" | "ended" | "revoked";
export type ProactiveCaptureDistillationStatus = "pending" | "distilled" | "failed" | "blocked" | "deleted";
export type ProactiveClaimState = "observed" | "inferred" | "user_asserted" | "confirmed" | "rejected";
export type ProactiveActionState =
  | "pending"
  | "approved"
  | "running"
  | "executed"
  | "denied"
  | "failed"
  | "revoked";

export interface ProactiveProfileRevisionModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  profileVersion: string;
  revision: number;
  deviceId: string;
  desiredState: ProactiveDesiredState;
  status: ProactiveRevisionStatus;
  fullAccessRequired: boolean;
  processingBoundary: "local_only";
  manifest: unknown;
  grantSetHash?: string | null;
  confirmedAt?: string | null;
  revokedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProactiveSourceGrantModel {
  id: string;
  revisionId: string;
  workspaceId: string;
  subjectUserId: string;
  sourceKey: string;
  purpose: string;
  scope: string;
  osCapability: string;
  state: ProactiveSourceGrantState;
  mandatory: boolean;
  processingBoundary: "local_only";
  grantVersion: number;
  metadata: unknown;
  grantedAt?: string | null;
  revokedAt?: string | null;
  lastVerifiedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProactiveActivationLeaseModel {
  id: string;
  revisionId: string;
  workspaceId: string;
  subjectUserId: string;
  deviceId: string;
  epoch: string;
  status: ProactiveActivationStatus;
  localReady: boolean;
  fullAccessSnapshot: boolean;
  issuedAt: string;
  expiresAt: string;
  heartbeatAt: string;
  endedAt?: string | null;
  endReason?: string | null;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ProactiveCaptureModel {
  id: string;
  revisionId: string;
  sourceGrantId: string;
  workspaceId: string;
  subjectUserId: string;
  sourceKey: string;
  contentType: string;
  payloadText?: string | null;
  payload?: unknown;
  checksum: string;
  byteSize: number;
  processingBoundary: "local_only";
  observedAt: string;
  ingestedAt: string;
  retentionUntil: string;
  distillationStatus: ProactiveCaptureDistillationStatus;
  distillationAttemptCount: number;
  lastDistillationError?: string | null;
  retentionBlockedAt?: string | null;
  distilledAt?: string | null;
  distilledMemoryIds: string[];
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProactiveBehaviorObservationModel {
  id: string;
  revisionId: string;
  sourceGrantId: string;
  workspaceId: string;
  subjectUserId: string;
  sourceKey: string;
  observationType: string;
  subjectKey: string;
  payload: unknown;
  checksum: string;
  processingBoundary: "local_only";
  algorithmVersion: string;
  observedAt: string;
  normalizedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProactiveProfileClaimModel {
  id: string;
  revisionId: string;
  workspaceId: string;
  subjectUserId: string;
  claimType: string;
  subjectKey: string;
  content: string;
  state: ProactiveClaimState;
  confidence: number;
  algorithmVersion: string;
  processingBoundary: "local_only";
  evidenceCaptureIds: string[];
  evidenceRefs: unknown[];
  sourceGrantIds: string[];
  firstObservedAt?: string | null;
  lastObservedAt?: string | null;
  confirmedAt?: string | null;
  rejectedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProactiveActionModel {
  id: string;
  revisionId: string;
  activationLeaseId?: string | null;
  workspaceId: string;
  subjectUserId: string;
  actionType: string;
  target: string;
  request: unknown;
  authorizationScope: string;
  actionGrantRevision: string;
  state: ProactiveActionState;
  requestedBy: string;
  approvedBy?: string | null;
  approvedAt?: string | null;
  reversible: boolean;
  external: boolean;
  startedAt?: string | null;
  finishedAt?: string | null;
  outcome?: unknown;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProactiveAuditEventModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  revisionId?: string | null;
  eventType: string;
  actorId: string;
  resourceType: string;
  resourceId: string;
  payload: unknown;
  processingBoundary: "local_only";
  occurredAt: string;
  createdAt: string;
}

export interface ProactiveConsentModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  actorId: string;
  purpose: string;
  scope: string;
  policyVersion: string;
  grantedAt: string;
  revokedAt?: string | null;
  createdAt: string;
}

export interface ProactiveEffectiveStatus {
  desiredState: ProactiveDesiredState;
  effectiveState: "inactive" | "configuring" | "active" | "limited" | "suspended" | "revoking";
  reason: string;
  revision: ProactiveProfileRevisionModel | null;
  sources: ProactiveSourceGrantModel[];
  activationLease: ProactiveActivationLeaseModel | null;
  mandatorySources: { total: number; granted: number; missing: string[] };
  expiredUndistilledCaptures: number;
}

export interface ProactiveExportSnapshot {
  exportedAt: string;
  schemaVersion: string;
  tenant: { workspaceId: string; subjectUserId: string };
  profileRevisions: ProactiveProfileRevisionModel[];
  sourceGrants: ProactiveSourceGrantModel[];
  activationLeases: ProactiveActivationLeaseModel[];
  captures: ProactiveCaptureModel[];
  observations: ProactiveBehaviorObservationModel[];
  claims: ProactiveProfileClaimModel[];
  actions: ProactiveActionModel[];
  auditEvents: ProactiveAuditEventModel[];
  consents: ProactiveConsentModel[];
}

export interface ProactiveSourceDeletionResult {
  sourceGrantId: string;
  capturesScrubbed: number;
  observationsDeleted: number;
  claimsDeleted: number;
  actionsScrubbed: number;
}

export interface IProactiveProfileRepository {
  /** 原子确认一套版本化全量画像授权包，并写入逐来源授权回执。 */
  confirmProfile(
    tenant: TenantContext,
    input: {
      id: string;
      profileVersion?: string;
      deviceId: string;
      manifest?: unknown;
      grantSetHash?: string | null;
      fullAccessSnapshot?: boolean;
      actorId: string;
      sources?: Array<{
        id: string;
        sourceKey: string;
        purpose?: string;
        scope?: string;
        osCapability?: string;
        state?: ProactiveSourceGrantState;
        mandatory?: boolean;
        grantVersion?: number;
        metadata?: unknown;
        grantedAt?: string | null;
        lastVerifiedAt?: string | null;
      }>;
    },
  ): Promise<{ revision: ProactiveProfileRevisionModel; sources: ProactiveSourceGrantModel[] }>;
  createDraft(
    tenant: TenantContext,
    input: {
      id: string;
      profileVersion?: string;
      deviceId: string;
      manifest?: unknown;
      actorId: string;
    },
  ): Promise<ProactiveProfileRevisionModel>;
  getRevision(tenant: TenantContext, revisionId?: string): Promise<ProactiveProfileRevisionModel | null>;
  listRevisions(tenant: TenantContext, limit?: number): Promise<ProactiveProfileRevisionModel[]>;
  setDesiredState(
    tenant: TenantContext,
    state: ProactiveDesiredState,
    actorId: string,
    revisionId?: string,
  ): Promise<ProactiveProfileRevisionModel | null>;
  listSourceGrants(tenant: TenantContext, revisionId?: string): Promise<ProactiveSourceGrantModel[]>;
  updateSourceGrant(
    tenant: TenantContext,
    sourceGrantId: string,
    input: {
      state: ProactiveSourceGrantState;
      metadata?: unknown;
      lastVerifiedAt?: string | null;
      actorId: string;
    },
  ): Promise<ProactiveSourceGrantModel | null>;
  deleteSourceData(
    tenant: TenantContext,
    sourceGrantId: string,
    actorId: string,
  ): Promise<ProactiveSourceDeletionResult | null>;
  createActivationLease(
    tenant: TenantContext,
    input: {
      id: string;
      revisionId: string;
      deviceId: string;
      epoch: string;
      ttlMs?: number;
      localReady: boolean;
      fullAccessSnapshot: boolean;
      metadata?: unknown;
      actorId: string;
    },
  ): Promise<ProactiveActivationLeaseModel>;
  heartbeatActivationLease(
    tenant: TenantContext,
    leaseId: string,
    input: { ttlMs?: number; localReady?: boolean; fullAccessSnapshot?: boolean; metadata?: unknown },
  ): Promise<ProactiveActivationLeaseModel | null>;
  endActivationLease(tenant: TenantContext, leaseId: string, reason: string, actorId: string): Promise<ProactiveActivationLeaseModel | null>;
  getEffectiveStatus(tenant: TenantContext, now?: string): Promise<ProactiveEffectiveStatus>;
  createCapture(
    tenant: TenantContext,
    input: {
      id: string;
      revisionId: string;
      sourceGrantId: string;
      sourceKey: string;
      contentType: string;
      payloadText?: string | null;
      payload?: unknown;
      checksum: string;
      byteSize?: number;
      observedAt?: string;
      ingestedAt?: string;
    },
  ): Promise<ProactiveCaptureModel>;
  listCaptures(tenant: TenantContext, options?: { revisionId?: string; sourceKey?: string; includeDeleted?: boolean; limit?: number }): Promise<ProactiveCaptureModel[]>;
  createObservation(
    tenant: TenantContext,
    input: {
      id: string;
      revisionId: string;
      sourceGrantId: string;
      sourceKey: string;
      observationType: string;
      subjectKey: string;
      payload?: unknown;
      checksum: string;
      algorithmVersion?: string;
      observedAt?: string;
      normalizedAt?: string;
    },
  ): Promise<ProactiveBehaviorObservationModel>;
  listObservations(tenant: TenantContext, options?: { revisionId?: string; sourceKey?: string; limit?: number }): Promise<ProactiveBehaviorObservationModel[]>;
  markCaptureDistilled(tenant: TenantContext, captureId: string, memoryIds: string[]): Promise<ProactiveCaptureModel | null>;
  markCaptureDistillationFailed(tenant: TenantContext, captureId: string, reason?: string): Promise<ProactiveCaptureModel | null>;
  purgeEligibleCaptures(tenant?: TenantContext, now?: string, limit?: number): Promise<number>;
  createClaim(
    tenant: TenantContext,
    input: {
      id: string;
      revisionId: string;
      claimType: string;
      subjectKey: string;
      content: string;
      state?: ProactiveClaimState;
      confidence?: number;
      algorithmVersion?: string;
      evidenceCaptureIds?: string[];
      evidenceRefs?: unknown[];
      sourceGrantIds?: string[];
      firstObservedAt?: string | null;
      lastObservedAt?: string | null;
    },
  ): Promise<ProactiveProfileClaimModel>;
  listClaims(tenant: TenantContext, options?: { revisionId?: string; state?: ProactiveClaimState; limit?: number }): Promise<ProactiveProfileClaimModel[]>;
  updateClaimState(tenant: TenantContext, claimId: string, state: ProactiveClaimState, actorId: string): Promise<ProactiveProfileClaimModel | null>;
  createAction(
    tenant: TenantContext,
    input: {
      id: string;
      revisionId: string;
      activationLeaseId?: string | null;
      actionType: string;
      target: string;
      request?: unknown;
      authorizationScope: string;
      actionGrantRevision: string;
      requestedBy: string;
      reversible?: boolean;
      external?: boolean;
    },
  ): Promise<ProactiveActionModel>;
  listActions(tenant: TenantContext, options?: { revisionId?: string; state?: ProactiveActionState; limit?: number }): Promise<ProactiveActionModel[]>;
  updateAction(
    tenant: TenantContext,
    actionId: string,
    input: { state: ProactiveActionState; actorId?: string; outcome?: unknown; error?: string | null },
  ): Promise<ProactiveActionModel | null>;
  recordAudit(tenant: TenantContext, input: { id: string; revisionId?: string | null; eventType: string; actorId: string; resourceType: string; resourceId: string; payload?: unknown }): Promise<ProactiveAuditEventModel>;
  listAuditEvents(tenant: TenantContext, limit?: number): Promise<ProactiveAuditEventModel[]>;
  exportSnapshot(tenant: TenantContext, options?: { includeRaw?: boolean }): Promise<ProactiveExportSnapshot>;
}
