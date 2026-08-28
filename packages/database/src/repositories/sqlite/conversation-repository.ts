/**
 * Aervox｜思隅 @aervox/database — 对话与流式协议 SQLite 仓储实现
 */
import { eq, and, gt, desc, or, lt, isNull } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import {
  sessions,
  turns,
  messages,
  messageVersions,
  turnStreamEvents,
  turnAttempts,
  toolExecutions,
  toolApprovals,
  conversationBranches,
  outboxEvents,
} from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
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
} from "../types.js";

export class SqliteConversationRepository implements IConversationRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async createSession(tenant: TenantContext, title: string): Promise<SessionModel> {
    assertTenantContext(tenant);
    const id = `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(sessions)
      .values({
        id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        title,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as SessionModel;
  }

  async getSession(tenant: TenantContext, sessionId: string): Promise<SessionModel | null> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.workspaceId, tenant.workspaceId),
          eq(sessions.subjectUserId, tenant.subjectUserId),
        ),
      );
    return (found as SessionModel) ?? null;
  }

  /**
   * 按客户端 sessionId 获取会话，不存在则创建。
   *
   * 用于修复 API 直接以外部 sessionId 创建 Turn 时的外键违约
   * （turns.session_id 引用 sessions.id）。注意 sessions.id 为主键，
   * 全局唯一，多租户调用方应自行提供租户限定的 sessionId。
   */
  async getOrCreateSession(
    tenant: TenantContext,
    sessionId: string,
    title = "默认会话",
  ): Promise<SessionModel> {
    assertTenantContext(tenant);
    const existing = await this.getSession(tenant, sessionId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(sessions)
      .values({
        id: sessionId,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        title,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as SessionModel;
  }

  async createTurnWithOutbox(
    tenant: TenantContext,
    turnData: { id: string; sessionId: string; idempotencyKey: string; status?: string },
    userMessage: { id: string; content: string },
    outboxEventData?: { id: string; eventType: string; idempotencyKey: string; payload: unknown },
  ): Promise<{ turn: TurnModel; message: MessageVersionModel }> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();

    return await this.db.transaction(async (tx) => {
      // 1. 插入 Turn 记录
      const [createdTurn] = await tx
        .insert(turns)
        .values({
          id: turnData.id,
          sessionId: turnData.sessionId,
          workspaceId: tenant.workspaceId,
          subjectUserId: tenant.subjectUserId,
          idempotencyKey: turnData.idempotencyKey,
          status: turnData.status ?? "Created",
          lastSequence: 0,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      // 2. 插入首条用户输入消息版本
      const [createdMessage] = await tx
        .insert(messageVersions)
        .values({
          id: userMessage.id,
          turnId: turnData.id,
          workspaceId: tenant.workspaceId,
          subjectUserId: tenant.subjectUserId,
          role: "user",
          version: 1,
          content: userMessage.content,
          isRedacted: 0,
          createdAt: now,
        })
        .returning();

      // 3. 伴随写入 Outbox 事件（若提供）
      if (outboxEventData) {
        await tx.insert(outboxEvents).values({
          id: outboxEventData.id,
          workspaceId: tenant.workspaceId,
          subjectUserId: tenant.subjectUserId,
          idempotencyKey: outboxEventData.idempotencyKey,
          eventType: outboxEventData.eventType,
          payload: outboxEventData.payload,
          status: "pending",
          createdAt: now,
        });
      }

      return {
        turn: createdTurn as TurnModel,
        message: createdMessage as MessageVersionModel,
      };
    });
  }

  async getTurn(tenant: TenantContext, turnId: string): Promise<TurnModel | null> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(turns)
      .where(
        and(
          eq(turns.id, turnId),
          eq(turns.workspaceId, tenant.workspaceId),
          eq(turns.subjectUserId, tenant.subjectUserId),
        ),
      );
    return (found as TurnModel) ?? null;
  }

  async getTurnByIdempotencyKey(
    tenant: TenantContext,
    idempotencyKey: string,
  ): Promise<TurnModel | null> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(turns)
      .where(
        and(
          eq(turns.idempotencyKey, idempotencyKey),
          eq(turns.workspaceId, tenant.workspaceId),
          eq(turns.subjectUserId, tenant.subjectUserId),
        ),
      );
    return (found as TurnModel) ?? null;
  }

  async updateTurnStatus(
    tenant: TenantContext,
    turnId: string,
    status: string,
    lastSequence?: number,
    error?: unknown,
  ): Promise<TurnModel | null> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const updateData: Record<string, unknown> = {
      status,
      updatedAt: now,
    };
    if (lastSequence !== undefined) {
      updateData.lastSequence = lastSequence;
    }
    if (error !== undefined) {
      updateData.error = error;
    }

    const [updated] = await this.db
      .update(turns)
      .set(updateData)
      .where(
        and(
          eq(turns.id, turnId),
          eq(turns.workspaceId, tenant.workspaceId),
          eq(turns.subjectUserId, tenant.subjectUserId),
        ),
      )
      .returning();
    return (updated as TurnModel) ?? null;
  }

  async appendStreamEvent(
    tenant: TenantContext,
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
    },
  ): Promise<TurnStreamEventModel> {
    assertTenantContext(tenant);
    const [created] = await this.db
      .insert(turnStreamEvents)
      .values({
        id: eventData.id,
        turnId: eventData.turnId,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        sequence: eventData.sequence,
        eventType: eventData.eventType,
        payloadVersion: eventData.payloadVersion ?? 1,
        data: eventData.data,
        occurredAt: eventData.occurredAt ?? new Date().toISOString(),
        attemptId: eventData.attemptId ?? null,
        safetyDecision: eventData.safetyDecision ?? null,
        committedAt: eventData.committedAt ?? null,
      })
      .returning();
    return created as TurnStreamEventModel;
  }

  async getStreamEvents(
    tenant: TenantContext,
    turnId: string,
    afterSequence: number = 0,
  ): Promise<TurnStreamEventModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(turnStreamEvents)
      .where(
        and(
          eq(turnStreamEvents.turnId, turnId),
          eq(turnStreamEvents.workspaceId, tenant.workspaceId),
          eq(turnStreamEvents.subjectUserId, tenant.subjectUserId),
          gt(turnStreamEvents.sequence, afterSequence),
        ),
      )
      .orderBy(turnStreamEvents.sequence);
    return rows as TurnStreamEventModel[];
  }

  async deleteMessage(tenant: TenantContext, messageId: string): Promise<boolean> {
    assertTenantContext(tenant);
    const res = await this.db
      .delete(messageVersions)
      .where(
        and(
          eq(messageVersions.id, messageId),
          eq(messageVersions.workspaceId, tenant.workspaceId),
          eq(messageVersions.subjectUserId, tenant.subjectUserId),
        ),
      )
      .returning();
    return res.length > 0;
  }

  // ============ MVP 补齐（PRD §8）：Message 身份 / TurnAttempt ============

  async createMessage(
    tenant: TenantContext,
    messageData: { id: string; sessionId: string; role: string; label?: string | null },
  ): Promise<MessageModel> {
    assertTenantContext(tenant);
    const [created] = await this.db
      .insert(messages)
      .values({
        id: messageData.id,
        sessionId: messageData.sessionId,
        role: messageData.role,
        label: messageData.label ?? null,
        createdAt: new Date().toISOString(),
      })
      .returning();
    return created as MessageModel;
  }

  async getMessage(tenant: TenantContext, messageId: string): Promise<MessageModel | null> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(messages)
      .innerJoin(sessions, eq(messages.sessionId, sessions.id))
      .where(
        and(
          eq(messages.id, messageId),
          eq(sessions.workspaceId, tenant.workspaceId),
          eq(sessions.subjectUserId, tenant.subjectUserId),
        ),
      );
    return (found ? { ...found.messages } : null) as MessageModel | null;
  }

  async createTurnAttempt(
    tenant: TenantContext,
    turnId: string,
    attemptData: { id: string; attempt?: number; leaseId?: string | null; fencingToken?: number },
  ): Promise<TurnAttemptModel> {
    assertTenantContext(tenant);
    const [created] = await this.db
      .insert(turnAttempts)
      .values({
        id: attemptData.id,
        turnId,
        attempt: attemptData.attempt ?? 1,
        leaseId: attemptData.leaseId ?? null,
        fencingToken: attemptData.fencingToken ?? 0,
        status: "Running",
        startedAt: new Date().toISOString(),
      })
      .returning();
    return created as TurnAttemptModel;
  }

  async listTurnAttempts(tenant: TenantContext, turnId: string): Promise<TurnAttemptModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select({ attempt: turnAttempts })
      .from(turnAttempts)
      .innerJoin(turns, eq(turnAttempts.turnId, turns.id))
      .where(
        and(
          eq(turnAttempts.turnId, turnId),
          eq(turns.workspaceId, tenant.workspaceId),
          eq(turns.subjectUserId, tenant.subjectUserId),
        ),
      )
      .orderBy(desc(turnAttempts.attempt));
    return rows.map((r) => r.attempt) as TurnAttemptModel[];
  }

  /**
   * 领取 TurnAttempt（CAS + fencing + 租约）：可领取 =
   * Running 且 fencing 匹配 且 租约为空或已过期（3b-B 抢占语义：未过期租约不可被抢占）。
   * 成功后递增 fencing 并绑定新租约（TTL），防止重复执行（AVX-HAR-001 §11.2）。
   */
  async claimTurnAttempt(
    tenant: TenantContext,
    input: {
      turnId: string;
      attemptId: string;
      expectedFencingToken: number;
      leaseId: string;
      ttlMs?: number;
    },
  ): Promise<{ ok: boolean; fencingToken: number; leaseId: string; leaseExpiresAt: string }> {
    assertTenantContext(tenant);
    const ttlMs = input.ttlMs ?? 60_000;
    const nowIso = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + ttlMs).toISOString();
    // turn_attempts 无租户列，经 turns 关联校验租户后做 CAS 更新
    const [updated] = await this.db
      .update(turnAttempts)
      .set({
        leaseId: input.leaseId,
        fencingToken: input.expectedFencingToken + 1,
        leaseExpiresAt,
      })
      .from(turns)
      .where(
        and(
          eq(turnAttempts.turnId, turns.id),
          eq(turnAttempts.id, input.attemptId),
          eq(turnAttempts.turnId, input.turnId),
          eq(turns.workspaceId, tenant.workspaceId),
          eq(turns.subjectUserId, tenant.subjectUserId),
          eq(turnAttempts.status, "Running"),
          eq(turnAttempts.fencingToken, input.expectedFencingToken),
          or(isNull(turnAttempts.leaseExpiresAt), lt(turnAttempts.leaseExpiresAt, nowIso)),
        ),
      )
      .returning();
    if (!updated) {
      return { ok: false, fencingToken: input.expectedFencingToken, leaseId: input.leaseId, leaseExpiresAt };
    }
    return { ok: true, fencingToken: (updated as TurnAttemptModel).fencingToken, leaseId: input.leaseId, leaseExpiresAt };
  }

  /** 3b-A：续租（CAS：leaseId + fencing 匹配且 Running 才刷新 leaseExpiresAt） */
  async renewTurnAttemptLease(
    tenant: TenantContext,
    input: { attemptId: string; leaseId: string; expectedFencingToken: number; ttlMs?: number },
  ): Promise<boolean> {
    assertTenantContext(tenant);
    const ttlMs = input.ttlMs ?? 60_000;
    const leaseExpiresAt = new Date(Date.now() + ttlMs).toISOString();
    const [updated] = await this.db
      .update(turnAttempts)
      .set({ leaseExpiresAt })
      .from(turns)
      .where(
        and(
          eq(turnAttempts.id, input.attemptId),
          eq(turnAttempts.leaseId, input.leaseId),
          eq(turnAttempts.fencingToken, input.expectedFencingToken),
          eq(turnAttempts.status, "Running"),
          eq(turnAttempts.turnId, turns.id),
          eq(turns.workspaceId, tenant.workspaceId),
          eq(turns.subjectUserId, tenant.subjectUserId),
        ),
      )
      .returning();
    return Boolean(updated);
  }

  /** 提交 TurnAttempt 终态（失败/完成/中断），并记录结束时间 */
  async finalizeTurnAttempt(
    tenant: TenantContext,
    input: { turnId: string; attemptId: string; status: string; finishedAt?: string; expectedFencingToken?: number },
  ): Promise<TurnAttemptModel | null> {
    assertTenantContext(tenant);
    const conditions = [
      eq(turnAttempts.turnId, turns.id),
      eq(turnAttempts.id, input.attemptId),
      eq(turnAttempts.turnId, input.turnId),
      eq(turns.workspaceId, tenant.workspaceId),
      eq(turns.subjectUserId, tenant.subjectUserId),
    ];
    // 3b-B：单一终态（仅 Running 可提交；提供 fencing 期望值时 CAS 校验）
    conditions.push(eq(turnAttempts.status, "Running"));
    if (input.expectedFencingToken !== undefined) {
      conditions.push(eq(turnAttempts.fencingToken, input.expectedFencingToken));
    }
    const [updated] = await this.db
      .update(turnAttempts)
      .set({
        status: input.status,
        finishedAt: input.finishedAt ?? new Date().toISOString(),
      })
      .from(turns)
      .where(and(...conditions))
      .returning();
    return (updated as TurnAttemptModel) ?? null;
  }

  /** 3b-B：恢复过期 Attempt（扫描 Running + 租约过期 → fencing+1 + Interrupted + finishedAt） */
  async recoverExpiredAttempts(client: import("@libsql/client").Client): Promise<number> {
    const now = new Date().toISOString();
    const result = await client.execute(`
      UPDATE turn_attempts
      SET status = 'Interrupted',
          fencing_token = fencing_token + 1,
          finished_at = '${now}'
      WHERE status = 'Running'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at < '${now}'
    `);
    // SQLite UPDATE 不返回行，受影响行数由 libsql rowsAffected 提供
    return result.rowsAffected ?? 0;
  }

  /** 记录一次工具执行（副作用证据账本，AVX-HAR-001 §12；阶段 2d） */
  async recordToolExecution(
    tenant: TenantContext,
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
    assertTenantContext(tenant);
    const [created] = await this.db
      .insert(toolExecutions)
      .values({
        id: `tex_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        turnId: input.turnId,
        attemptId: input.attemptId,
        invocationId: input.invocationId,
        name: input.name,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        argumentsJson: input.arguments,
        status: input.status,
        outputJson: input.output,
        error: input.error ?? null,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
      })
      .returning();
    return created as ToolExecutionModel;
  }

  /** 查询 Turn 的工具执行账本（按时间倒序） */
  async listToolExecutionsByTurn(tenant: TenantContext, turnId: string): Promise<ToolExecutionModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(toolExecutions)
      .where(
        and(
          eq(toolExecutions.turnId, turnId),
          eq(toolExecutions.workspaceId, tenant.workspaceId),
          eq(toolExecutions.subjectUserId, tenant.subjectUserId),
        ),
      )
      .orderBy(desc(toolExecutions.startedAt));
    return rows as ToolExecutionModel[];
  }

  /** 记录一条工具授权（阶段 3a） */
  async recordToolApproval(
    tenant: TenantContext,
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
    assertTenantContext(tenant);
    const [created] = await this.db
      .insert(toolApprovals)
      .values({
        id: `tapp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        turnId: input.turnId,
        attemptId: input.attemptId,
        toolName: input.toolName,
        argumentsHash: input.argumentsHash,
        toolVersion: input.toolVersion ?? null,
        requester: input.requester,
        state: input.state,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
      })
      .returning();
    return created as ToolApprovalModel;
  }

  /** 决定（grant/deny）一条待决授权 */
  async decideToolApproval(
    tenant: TenantContext,
    approvalId: string,
    decision: "granted" | "denied",
    decidedBy: string,
  ): Promise<ToolApprovalModel | null> {
    assertTenantContext(tenant);
    const [updated] = await this.db
      .update(toolApprovals)
      .set({
        state: decision,
        decidedBy,
        decidedAt: new Date().toISOString(),
      })
      .from(turns)
      .where(
        and(
          eq(toolApprovals.id, approvalId),
          eq(toolApprovals.workspaceId, tenant.workspaceId),
          eq(toolApprovals.subjectUserId, tenant.subjectUserId),
          eq(toolApprovals.turnId, turns.id),
          eq(turns.workspaceId, tenant.workspaceId),
          eq(turns.subjectUserId, tenant.subjectUserId),
        ),
      )
      .returning();
    return (updated as ToolApprovalModel) ?? null;
  }

  /** 查询 Turn 的授权账本 */
  async listToolApprovalsByTurn(tenant: TenantContext, turnId: string): Promise<ToolApprovalModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(toolApprovals)
      .where(
        and(
          eq(toolApprovals.turnId, turnId),
          eq(toolApprovals.workspaceId, tenant.workspaceId),
          eq(toolApprovals.subjectUserId, tenant.subjectUserId),
        ),
      )
      .orderBy(desc(toolApprovals.id));
    return rows as ToolApprovalModel[];
  }

  /** 匹配已授权记录（toolName + argumentsHash；跨 turn 复用，取最近一条） */
  async findGrantedToolApproval(
    tenant: TenantContext,
    input: { toolName: string; argumentsHash: string },
  ): Promise<ToolApprovalModel | null> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(toolApprovals)
      .where(
        and(
          eq(toolApprovals.workspaceId, tenant.workspaceId),
          eq(toolApprovals.subjectUserId, tenant.subjectUserId),
          eq(toolApprovals.toolName, input.toolName),
          eq(toolApprovals.argumentsHash, input.argumentsHash),
          eq(toolApprovals.state, "granted"),
        ),
      )
      .orderBy(desc(toolApprovals.id));
    return (found as ToolApprovalModel) ?? null;
  }

  // ============ P1（R2 · CAP-014）：会话地图分支 ============

  async createConversationBranch(
    tenant: TenantContext,
    branchData: { id: string; parentSessionId: string; forkAtMessageId?: string | null; childSessionId: string },
  ): Promise<ConversationBranchModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(conversationBranches)
      .values({
        id: branchData.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        parentSessionId: branchData.parentSessionId,
        forkAtMessageId: branchData.forkAtMessageId ?? null,
        childSessionId: branchData.childSessionId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as ConversationBranchModel;
  }

  async listBranchesByParent(tenant: TenantContext, parentSessionId: string): Promise<ConversationBranchModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(conversationBranches)
      .where(
        and(
          eq(conversationBranches.parentSessionId, parentSessionId),
          eq(conversationBranches.workspaceId, tenant.workspaceId),
          eq(conversationBranches.subjectUserId, tenant.subjectUserId),
        ),
      )
      .orderBy(conversationBranches.createdAt);
    return rows as ConversationBranchModel[];
  }
}
