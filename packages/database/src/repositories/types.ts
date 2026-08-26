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
      sequence: number;
      eventType: string;
      payloadVersion?: number;
      data: unknown;
      occurredAt?: string;
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
  createTurnAttempt(
    tenant: TenantContext,
    turnId: string,
    attempt: { id: string; attempt?: number; leaseId?: string | null; fencingToken?: number },
  ): Promise<TurnAttemptModel>;
  listTurnAttempts(tenant: TenantContext, turnId: string): Promise<TurnAttemptModel[]>;
  // P1（R2 · CAP-014）：会话地图与替代解法分支
  createConversationBranch(
    tenant: TenantContext,
    branch: { id: string; parentSessionId: string; forkAtMessageId?: string | null; childSessionId: string },
  ): Promise<ConversationBranchModel>;
  listBranchesByParent(tenant: TenantContext, parentSessionId: string): Promise<ConversationBranchModel[]>;
}

export interface ConversationBranchModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  parentSessionId: string;
  forkAtMessageId?: string | null;
  childSessionId: string;
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
  createdAt: string;
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
  status: string;
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
    },
  ): Promise<QuestionAttemptModel>;
  listAttemptsByQuestion(tenant: TenantContext, questionId: string): Promise<QuestionAttemptModel[]>;
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
    item: { id: string; knowledgeId: string; dueAt: string; intervalDays: number; schedulerVersion?: number },
  ): Promise<ReviewItemModel>;
  createReviewItem(
    tenant: TenantContext,
    item: { id: string; knowledgeId: string; dueAt: string; intervalDays?: number; schedulerVersion?: number },
  ): Promise<ReviewItemModel>;
  getReviewItem(tenant: TenantContext, id: string): Promise<ReviewItemModel | null>;
  completeReviewAndSchedule(
    tenant: TenantContext,
    data: {
      reviewId: string;
      knowledgeId: string;
      practiceState: {
        correctCount: number;
        wrongCount: number;
        correctStreak: number;
        mastery: number;
        masteryState: string;
        masteryBasis: unknown;
      };
      nextReview: { id: string; dueAt: string; intervalDays: number; schedulerVersion: number };
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
  deletedAt?: string | null;
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
    },
  ): Promise<AttachmentModel>;
  getAttachment(tenant: TenantContext, id: string): Promise<AttachmentModel | null>;
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

// ============ T-04 工具注册表 + AST-04 门控 + PET-05 安全级别 ============

export interface ToolRegistrationModel {
  id: string;
  name: string;
  description: string;
  category: string; // memory/search/learning/diary/system/external
  /** PET-05 安全级别：read_only / write_with_approval / privileged */
  safetyLevel: string;
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

/** 工作区 Anthropic Skill 持久化模型（files 为 path→base64；租户级工作区技能，属 persona 域） */
export interface SkillModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  name: string;
  description: string;
  license?: string | null;
  compatibility?: string | null;
  metadata?: unknown;
  allowedTools?: unknown;
  source: string; // "active" | "workspace" | "imported"
  version: number;
  checksum: string;
  enabled: number;
  valid: number;
  validationErrors: string[];
  filesJson: Record<string, string>;
  skillMarkdown: string;
  importedAt: string;
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

/** MCP 工具注册模型 */
export interface McpToolModel {
  id: string; // "{serverId}:{toolName}"
  workspaceId: string;
  subjectUserId: string;
  serverId: string;
  name: string;
  description?: string | null;
  inputSchema?: unknown;
  scopes: string[];
  healthy: number;
  authorized: number;
  revoked: number;
  killSwitch: number;
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
}

export interface ISkillRepository {
  listSkills(tenant: TenantContext): Promise<SkillModel[]>;
  getSkill(tenant: TenantContext, name: string): Promise<SkillModel | null>;
  upsertSkill(tenant: TenantContext, skill: SkillModel): Promise<SkillModel>;
  setSkillEnabled(tenant: TenantContext, name: string, enabled: boolean): Promise<SkillModel | null>;
  deleteSkill(tenant: TenantContext, name: string): Promise<boolean>;
}

export interface IMcpToolRepository {
  listMcpTools(tenant: TenantContext): Promise<McpToolModel[]>;
  upsertMcpTool(tenant: TenantContext, tool: McpToolModel): Promise<McpToolModel>;
  setMcpToolRevoked(tenant: TenantContext, id: string, revoked: boolean): Promise<McpToolModel | null>;
  setMcpToolKillSwitch(tenant: TenantContext, id: string, killSwitch: boolean): Promise<McpToolModel | null>;
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
