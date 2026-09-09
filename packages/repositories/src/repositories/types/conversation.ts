/**
 * Aervox｜思隅 @aervox/repositories — conversation 仓储类型（自 types.ts 机械拆分）
 */
import type { MessageModel, TurnAttemptModel } from "./outbox.js";
import type { TenantContext } from "../../tenant.js";

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

export interface SessionHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface IConversationRepository {
  /** 当前轮之前、同租户同会话的有界安全历史；不含当前输入。 */
  getSessionHistory(
    tenant: TenantContext,
    input: { sessionId: string; beforeTurnId: string },
  ): Promise<SessionHistoryMessage[]>;
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
  verificationStatus?: string;
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
