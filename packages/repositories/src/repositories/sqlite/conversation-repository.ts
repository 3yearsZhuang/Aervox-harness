/**
 * Aervox｜思隅 @aervox/repositories — 对话与流式协议 SQLite 仓储 Facade
 *
 * 机械拆分（W-19 先例模式，零行为变更）：实现委托给 conversation/ 目录下
 * 8 个协作 Store；对外导出面（类、MAX_RESUME_CANDIDATE_LIMIT）与
 * IConversationRepository 契约保持不变。
 */
import type { AervoxDatabase } from "../../client.js";
import type { LocalContext } from "../../local-context.js";
import type {
  IConversationRepository,
  SessionModel,
  TurnModel,
  MessageModel,
  MessageVersionModel,
  TurnAttemptModel,
  ConversationBranchModel,
  TurnStreamEventModel,
  ToolExecutionModel,
  ToolApprovalModel,
} from "../types/index.js";
import { ApprovalStore } from "./conversation/approval-store.js";
import { AttemptStore } from "./conversation/attempt-store.js";
import { MessageStore } from "./conversation/message-store.js";
import { SafeSegmentStore } from "./conversation/safe-segment-store.js";
import { SessionStore } from "./conversation/session-store.js";
import { StreamEventStore } from "./conversation/stream-event-store.js";
import { ToolExecutionStore } from "./conversation/tool-execution-store.js";
import { TurnStore } from "./conversation/turn-store.js";

export { MAX_RESUME_CANDIDATE_LIMIT } from "./conversation/safe-segment-store.js";

export class SqliteConversationRepository implements IConversationRepository {
  private readonly sessionStore: SessionStore;
  private readonly turnStore: TurnStore;
  private readonly streamEventStore: StreamEventStore;
  private readonly messageStore: MessageStore;
  private readonly attemptStore: AttemptStore;
  private readonly toolExecutionStore: ToolExecutionStore;
  private readonly safeSegmentStore: SafeSegmentStore;
  private readonly approvalStore: ApprovalStore;

  constructor(private readonly db: AervoxDatabase) {
    this.sessionStore = new SessionStore(db);
    this.turnStore = new TurnStore(db);
    this.streamEventStore = new StreamEventStore(db);
    this.messageStore = new MessageStore(db);
    this.attemptStore = new AttemptStore(db);
    this.toolExecutionStore = new ToolExecutionStore(db);
    this.safeSegmentStore = new SafeSegmentStore(db);
    this.approvalStore = new ApprovalStore(db);
  }

  getSessionHistory(ctx: LocalContext, input: { sessionId: string; beforeTurnId: string }) {
    return this.sessionStore.getSessionHistory(ctx, input);
  }

  async createSession(
    _tenant: LocalContext,
    title: string,
    options?: { id?: string; projectId?: string | null },
  ): Promise<SessionModel> {
    return this.sessionStore.createSession(_tenant, title, options);
  }

  async getSession(ctx: LocalContext, sessionId: string): Promise<SessionModel | null> {
    return this.sessionStore.getSession(ctx, sessionId);
  }

  async getOrCreateSession(
    ctx: LocalContext,
    sessionId: string,
    title = "默认会话",
    projectId?: string | null,
  ): Promise<SessionModel> {
    return this.sessionStore.getOrCreateSession(ctx, sessionId, title, projectId);
  }

  async listSessions(
    _tenant: LocalContext,
    options?: { limit?: number; offset?: number; projectId?: string },
  ): Promise<SessionModel[]> {
    return this.sessionStore.listSessions(_tenant, options);
  }

  async renameSession(
    _tenant: LocalContext,
    sessionId: string,
    updates: string | { title?: string; projectId?: string | null },
  ): Promise<SessionModel | null> {
    return this.sessionStore.renameSession(_tenant, sessionId, updates);
  }

  async deleteSession(
    _tenant: LocalContext,
    sessionId: string,
  ): Promise<boolean> {
    return this.sessionStore.deleteSession(_tenant, sessionId);
  }

  async createTurnWithOutbox(
    ctx: LocalContext,
    turnData: { id: string; sessionId: string; idempotencyKey: string; status?: string },
    userMessage: { id: string; content: string },
    outboxEventData?: { id: string; eventType: string; idempotencyKey: string; payload: unknown },
  ): Promise<{ turn: TurnModel; message: MessageVersionModel }> {
    return this.turnStore.createTurnWithOutbox(ctx, turnData, userMessage, outboxEventData);
  }

  async getTurn(ctx: LocalContext, turnId: string): Promise<TurnModel | null> {
    return this.turnStore.getTurn(ctx, turnId);
  }

  async getTurnByIdempotencyKey(
    ctx: LocalContext,
    idempotencyKey: string,
  ): Promise<TurnModel | null> {
    return this.turnStore.getTurnByIdempotencyKey(ctx, idempotencyKey);
  }

  async updateTurnStatus(
    ctx: LocalContext,
    turnId: string,
    status: string,
    lastSequence?: number,
    error?: unknown,
  ): Promise<TurnModel | null> {
    return this.turnStore.updateTurnStatus(ctx, turnId, status, lastSequence, error);
  }

  async appendStreamEvent(
    ctx: LocalContext,
    eventData: {
      id: string;
      turnId: string;
      sequence: number;
      eventType: string;
      payloadVersion?: number;
      data: unknown;
      occurredAt?: string;
      attemptId?: string | null;
      safetyDecision?: string | null;
      committedAt?: string | null;
      /**
       * 3c+（B1）：事件写入 fencing CAS 校验。仅当 attemptId 与本字段同时给出时启用：
       * 要求对应 turn_attempts 行存在、fencing_token 与期望一致，且状态允许
       * （Running/CancelRequested，或终态下仅收尾的 done/error 事件——终态提交先于
       * done 的路径需要）。被抢占/恢复的执行器（fencing 已递增）写入将被拒绝并抛
       * FencingMismatchError（AVX-HAR-001 §11.2/§12.2）。
       */
      expectedFencingToken?: number | null;
    },
  ): Promise<TurnStreamEventModel> {
    return this.streamEventStore.appendStreamEvent(ctx, eventData);
  }

  async getStreamEvents(
    ctx: LocalContext,
    turnId: string,
    afterSequence: number = 0,
  ): Promise<TurnStreamEventModel[]> {
    return this.streamEventStore.getStreamEvents(ctx, turnId, afterSequence);
  }

  async getStreamEventById(
    ctx: LocalContext,
    turnId: string,
    eventId: string,
  ): Promise<TurnStreamEventModel | null> {
    return this.streamEventStore.getStreamEventById(ctx, turnId, eventId);
  }

  async recordTurnStreamEvent(
    ctx: LocalContext,
    eventData: {
      id?: string;
      turnId: string;
      sequence: number;
      eventType: string;
      payloadVersion?: number;
      data: unknown;
      occurredAt?: string;
      attemptId?: string | null;
      safetyDecision?: string | null;
      committedAt?: string | null;
    },
  ): Promise<TurnStreamEventModel> {
    return this.streamEventStore.recordTurnStreamEvent(ctx, eventData);
  }

  async deleteMessage(ctx: LocalContext, messageId: string): Promise<boolean> {
    return this.messageStore.deleteMessage(ctx, messageId);
  }

  async editMessage(
    ctx: LocalContext,
    messageId: string,
    content: string,
    expectedVersion: number,
  ): Promise<{ message: MessageModel; newVersion: MessageVersionModel } | null> {
    return this.messageStore.editMessage(ctx, messageId, content, expectedVersion);
  }

  async softDeleteMessage(ctx: LocalContext, messageId: string): Promise<MessageModel | null> {
    return this.messageStore.softDeleteMessage(ctx, messageId);
  }

  async restoreMessage(ctx: LocalContext, messageId: string): Promise<MessageModel | null> {
    return this.messageStore.restoreMessage(ctx, messageId);
  }

  async listMessageVersions(
    ctx: LocalContext,
    messageId: string,
  ): Promise<MessageVersionModel[]> {
    return this.messageStore.listMessageVersions(ctx, messageId);
  }

  async redactTurnMessages(ctx: LocalContext, turnId: string): Promise<void> {
    return this.messageStore.redactTurnMessages(ctx, turnId);
  }

  async appendRedactedAssistantMessage(
    ctx: LocalContext,
    input: { id: string; turnId: string; content: string },
  ): Promise<MessageVersionModel> {
    return this.messageStore.appendRedactedAssistantMessage(ctx, input);
  }

  async createMessage(
    ctx: LocalContext,
    messageData: { id: string; sessionId: string; role: string; label?: string | null },
  ): Promise<MessageModel> {
    return this.messageStore.createMessage(ctx, messageData);
  }

  async getMessage(ctx: LocalContext, messageId: string): Promise<MessageModel | null> {
    return this.messageStore.getMessage(ctx, messageId);
  }

  async createTurnAttempt(
    ctx: LocalContext,
    turnId: string,
    attemptData: { id: string; attempt?: number; leaseId?: string | null; fencingToken?: number },
  ): Promise<TurnAttemptModel> {
    return this.attemptStore.createTurnAttempt(ctx, turnId, attemptData);
  }

  async listTurnAttempts(ctx: LocalContext, turnId: string): Promise<TurnAttemptModel[]> {
    return this.attemptStore.listTurnAttempts(ctx, turnId);
  }

  async claimTurnAttempt(
    ctx: LocalContext,
    input: {
      turnId: string;
      attemptId: string;
      expectedFencingToken: number;
      leaseId: string;
      ttlMs?: number;
    },
  ): Promise<{ ok: boolean; fencingToken: number; leaseId: string; leaseExpiresAt: string }> {
    return this.attemptStore.claimTurnAttempt(ctx, input);
  }

  async renewTurnAttemptLease(
    ctx: LocalContext,
    input: { attemptId: string; leaseId: string; expectedFencingToken: number; ttlMs?: number },
  ): Promise<boolean> {
    return this.attemptStore.renewTurnAttemptLease(ctx, input);
  }

  async finalizeTurnAttempt(
    ctx: LocalContext,
    input: { turnId: string; attemptId: string; status: string; finishedAt?: string; expectedFencingToken?: number },
  ): Promise<TurnAttemptModel | null> {
    return this.attemptStore.finalizeTurnAttempt(ctx, input);
  }

  async requestCancelTurnAttempt(
    ctx: LocalContext,
    input: { turnId: string; attemptId: string },
  ): Promise<{ ok: boolean; reason?: "not_found" | "already_finalized" }> {
    return this.attemptStore.requestCancelTurnAttempt(ctx, input);
  }

  async getTurnAttemptStatus(
    ctx: LocalContext,
    input: { turnId: string; attemptId: string },
  ): Promise<string | null> {
    return this.attemptStore.getTurnAttemptStatus(ctx, input);
  }

  async recoverExpiredAttempts(client: import("@libsql/client").Client): Promise<number> {
    return this.attemptStore.recoverExpiredAttempts(client);
  }

  async recordToolExecution(
    ctx: LocalContext,
    input: {
      turnId: string;
      attemptId: string;
      invocationId: string;
      name: string;
      arguments?: unknown;
      status: string;
      output?: unknown;
      error?: string | null;
      startedAt: string;
      finishedAt: string;
    },
  ): Promise<ToolExecutionModel> {
    return this.toolExecutionStore.recordToolExecution(ctx, input);
  }

  async reserveToolExecution(
    ctx: LocalContext,
    input: {
      turnId: string;
      attemptId: string;
      invocationId: string;
      name: string;
      arguments?: unknown;
    },
  ): Promise<{ ok: boolean; alreadyReserved: boolean }> {
    return this.toolExecutionStore.reserveToolExecution(ctx, input);
  }

  async updateToolExecutionResult(
    ctx: LocalContext,
    input: {
      turnId: string;
      attemptId: string;
      invocationId: string;
      status: string;
      output?: unknown;
      error?: string;
      finishedAt?: string;
    },
  ): Promise<{ ok: boolean }> {
    return this.toolExecutionStore.updateToolExecutionResult(ctx, input);
  }

  async recordToolOutcomeAtomically(
    ctx: LocalContext,
    input: {
      turnId: string;
      attemptId: string;
      sequence: number;
      invocationId: string;
      name: string;
      arguments: unknown;
      status: string;
      output?: unknown;
      error?: string;
      startedAt: string;
      finishedAt?: string;
      eventData: unknown;
      safetyDecision?: string | null;
      expectedFencingToken: number;
    },
  ): Promise<boolean> {
    return this.toolExecutionStore.recordToolOutcomeAtomically(ctx, input);
  }

  async finalizeAttemptWithEventAtomically(
    ctx: LocalContext,
    input: {
      turnId: string;
      attemptId: string;
      status: string;
      expectedFencingToken: number;
      sequence: number;
      eventType: string; // "done" | "error"
      eventData: unknown;
      safetyDecision?: string | null;
    },
  ): Promise<boolean> {
    return this.toolExecutionStore.finalizeAttemptWithEventAtomically(ctx, input);
  }

  async recordSafeSegmentAtomically(
    ctx: LocalContext,
    input: {
      turnId: string;
      attemptId: string;
      sequence: number;
      text: string;
      eventData: unknown;
      safetyDecision?: string | null;
      expectedFencingToken: number;
    },
  ): Promise<boolean> {
    return this.safeSegmentStore.recordSafeSegmentAtomically(ctx, input);
  }

  async recordSafeSegmentsAtomically(
    ctx: LocalContext,
    inputs: Array<{
      turnId: string;
      attemptId: string;
      sequence: number;
      text: string;
      eventData: unknown;
      safetyDecision?: string | null;
      expectedFencingToken: number;
    }>,
  ): Promise<boolean> {
    return this.safeSegmentStore.recordSafeSegmentsAtomically(ctx, inputs);
  }

  async listCommittedSegments(
    ctx: LocalContext,
    turnId: string,
  ): Promise<Array<{ id: string; sequence: number; text: string; streamEventId: string | null }>> {
    return this.safeSegmentStore.listCommittedSegments(ctx, turnId);
  }

  async findResumeCandidates(
    client: import("@libsql/client").Client,
    limit?: number,
  ): Promise<
    Array<{
      attemptId: string;
      turnId: string;
      sessionId: string;
      lastSequence: number;
      userMessage: string;
      /** 续跑 claim 预期 = 当前已持有的 fencing（抢占语义） */
      fencingToken: number;
    }>
  > {
    return this.safeSegmentStore.findResumeCandidates(client, limit);
  }

  async markPendingOutcomeUnknown(client: import("@libsql/client").Client): Promise<number> {
    return this.safeSegmentStore.markPendingOutcomeUnknown(client);
  }

  async listToolExecutionsByTurn(ctx: LocalContext, turnId: string): Promise<ToolExecutionModel[]> {
    return this.toolExecutionStore.listToolExecutionsByTurn(ctx, turnId);
  }

  async recordToolApproval(
    ctx: LocalContext,
    input: {
      turnId: string;
      attemptId: string;
      toolName: string;
      argumentsHash: string;
      requester: string;
      state: "pending" | "granted" | "denied";
      toolVersion?: string | null;
    },
  ): Promise<ToolApprovalModel> {
    return this.approvalStore.recordToolApproval(ctx, input);
  }

  async decideToolApproval(
    ctx: LocalContext,
    approvalId: string,
    decision: "granted" | "denied",
    decidedBy: string,
  ): Promise<ToolApprovalModel | null> {
    return this.approvalStore.decideToolApproval(ctx, approvalId, decision, decidedBy);
  }

  async getToolApproval(ctx: LocalContext, approvalId: string): Promise<ToolApprovalModel | null> {
    return this.approvalStore.getToolApproval(ctx, approvalId);
  }

  async listToolApprovalsByTurn(ctx: LocalContext, turnId: string): Promise<ToolApprovalModel[]> {
    return this.approvalStore.listToolApprovalsByTurn(ctx, turnId);
  }

  async findGrantedToolApproval(
    ctx: LocalContext,
    input: {
      toolName: string;
      argumentsHash: string;
      excludeDecidedByPrefix?: string;
      excludeDecidedByPrefixes?: string[];
    },
  ): Promise<ToolApprovalModel | null> {
    return this.approvalStore.findGrantedToolApproval(ctx, input);
  }

  async createConversationBranch(
    ctx: LocalContext,
    branchData: {
      id: string;
      parentSessionId: string;
      forkAtMessageId?: string | null;
      childSessionId: string;
      title?: string;
      branchReason?: string;
    },
  ): Promise<ConversationBranchModel> {
    return this.sessionStore.createConversationBranch(ctx, branchData);
  }

  async listBranchesByParent(ctx: LocalContext, parentSessionId: string): Promise<ConversationBranchModel[]> {
    return this.sessionStore.listBranchesByParent(ctx, parentSessionId);
  }

  async getBranch(ctx: LocalContext, branchId: string): Promise<ConversationBranchModel | null> {
    return this.sessionStore.getBranch(ctx, branchId);
  }

  async mergeBranch(ctx: LocalContext, branchId: string): Promise<ConversationBranchModel | null> {
    return this.sessionStore.mergeBranch(ctx, branchId);
  }

  async archiveBranch(ctx: LocalContext, branchId: string): Promise<ConversationBranchModel | null> {
    return this.sessionStore.archiveBranch(ctx, branchId);
  }

  async deleteBranch(ctx: LocalContext, branchId: string): Promise<ConversationBranchModel | null> {
    return this.sessionStore.deleteBranch(ctx, branchId);
  }

  async updateBranchLayout(
    ctx: LocalContext,
    branchId: string,
    layoutData: unknown,
  ): Promise<ConversationBranchModel | null> {
    return this.sessionStore.updateBranchLayout(ctx, branchId, layoutData);
  }

  async getBranchTree(ctx: LocalContext, sessionId: string): Promise<ConversationBranchModel[]> {
    return this.sessionStore.getBranchTree(ctx, sessionId);
  }

  async importSession(
    _tenant: LocalContext,
    input: {
      title?: string;
      projectId?: string | null;
      messages: Array<{
        role: "user" | "assistant" | "system";
        content: string;
        createdAt?: string;
      }>;
    },
  ): Promise<{
    session: SessionModel;
    turnsCount: number;
    messagesCount: number;
  }> {
    return this.sessionStore.importSession(_tenant, input);
  }
}
