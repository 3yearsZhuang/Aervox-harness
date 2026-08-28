/**
 * Aervox｜思隅 @aervox/database — 对话与流式协议 SQLite 仓储实现
 */
import { eq, and, gt, desc, or, lt, isNull, inArray, notInArray, notLike } from "drizzle-orm";
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
  safeSegments,
  toolRegistrations,
  conversationBranches,
  outboxEvents,
} from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
import { FencingMismatchError } from "../../errors.js";
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
    assertTenantContext(tenant);
    const fenced =
      eventData.attemptId != null && eventData.expectedFencingToken != null;
    // BEGIN IMMEDIATE：fencing 校验与插入在同一写锁内原子完成，
    // 杜绝「SELECT 校验通过 → 他方抢占提交 → 本事务再插入」的窗口（B1 CAS）。
    return this.db.transaction(
      async (tx) => {
        if (fenced) {
          const [attempt] = await tx
            .select({ status: turnAttempts.status, fencingToken: turnAttempts.fencingToken })
            .from(turnAttempts)
            .where(
              and(
                eq(turnAttempts.id, eventData.attemptId as string),
                eq(turnAttempts.turnId, eventData.turnId),
              ),
            );
          const running = attempt && (attempt.status === "Running" || attempt.status === "CancelRequested");
          const terminalDoneOk =
            attempt &&
            (eventData.eventType === "done" || eventData.eventType === "error") &&
            ["Completed", "Failed", "Interrupted", "Cancelled"].includes(attempt.status);
          if (
            !attempt ||
            attempt.fencingToken !== eventData.expectedFencingToken ||
            !(running || terminalDoneOk)
          ) {
            throw new FencingMismatchError(
              `attempt ${eventData.attemptId} fencing=${attempt?.fencingToken ?? "?"} status=${attempt?.status ?? "?"} cannot append ${eventData.eventType}`,
            );
          }
        }
        const [created] = await tx
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
      },
      { behavior: "immediate" },
    );
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

  // ============ CAP-013：消息编辑、软删除、版本历史、恢复 ============

  /**
   * FR-CONV-004：编辑消息 — 生成新版本，旧版本标记 supersededAt，CAS 校验版本号
   * @returns 新版本记录；若消息已删除或版本不匹配则返回 null
   */
  async editMessage(
    tenant: TenantContext,
    messageId: string,
    content: string,
    expectedVersion: number,
  ): Promise<{ message: MessageModel; newVersion: MessageVersionModel } | null> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();

    // 1. 获取消息，校验存在性和删除状态
    const message = await this.getMessage(tenant, messageId);
    if (!message || message.deletedAt) return null;

    // 2. 获取当前版本，CAS 校验
    const currentVersions = await this.db
      .select()
      .from(messageVersions)
      .where(
        and(
          eq(messageVersions.messageId, messageId),
          eq(messageVersions.workspaceId, tenant.workspaceId),
          eq(messageVersions.subjectUserId, tenant.subjectUserId),
          isNull(messageVersions.supersededAt),
        ),
      )
      .orderBy(desc(messageVersions.version))
      .limit(1);

    if (currentVersions.length === 0) return null;
    const currentVersion = currentVersions[0] as MessageVersionModel;
    if (currentVersion.version !== expectedVersion) return null;

    // 3. 标记旧版本 supersededAt
    await this.db
      .update(messageVersions)
      .set({ supersededAt: now })
      .where(eq(messageVersions.id, currentVersion.id));

    // 4. 插入新版本
    const newVersionId = `mv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const [newVersion] = await this.db
      .insert(messageVersions)
      .values({
        id: newVersionId,
        turnId: currentVersion.turnId,
        messageId: messageId,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        role: currentVersion.role,
        version: expectedVersion + 1,
        content,
        isRedacted: 0,
        createdAt: now,
      })
      .returning();

    // 5. 更新 messages.currentVersionId
    await this.db
      .update(messages)
      .set({ currentVersionId: newVersionId })
      .where(eq(messages.id, messageId));

    return {
      message: { ...message, currentVersionId: newVersionId } as MessageModel,
      newVersion: newVersion as MessageVersionModel,
    };
  }

  /**
   * FR-CONV-005：软删除消息 — 设置 deletedAt，不物理删除
   */
  async softDeleteMessage(tenant: TenantContext, messageId: string): Promise<MessageModel | null> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const message = await this.getMessage(tenant, messageId);
    if (!message || message.deletedAt) return null;

    const [updated] = await this.db
      .update(messages)
      .set({ deletedAt: now })
      .where(eq(messages.id, messageId))
      .returning();

    return (updated as MessageModel) ?? null;
  }

  /**
   * 恢复已删除的消息 — 清除 deletedAt
   */
  async restoreMessage(tenant: TenantContext, messageId: string): Promise<MessageModel | null> {
    assertTenantContext(tenant);
    // 先校验租户归属
    const message = await this.getMessage(tenant, messageId);
    if (!message) return null;

    const [updated] = await this.db
      .update(messages)
      .set({ deletedAt: null })
      .where(eq(messages.id, messageId))
      .returning();

    return (updated as MessageModel) ?? null;
  }

  /**
   * 查询消息的所有版本（按版本号降序）
   */
  async listMessageVersions(
    tenant: TenantContext,
    messageId: string,
  ): Promise<MessageVersionModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(messageVersions)
      .where(
        and(
          eq(messageVersions.messageId, messageId),
          eq(messageVersions.workspaceId, tenant.workspaceId),
          eq(messageVersions.subjectUserId, tenant.subjectUserId),
        ),
      )
      .orderBy(desc(messageVersions.version));
    return rows as MessageVersionModel[];
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
    // 3b-B：单一终态（仅运行中状态 Running/CancelRequested 可提交；提供 fencing 期望值时 CAS 校验）
    conditions.push(
      inArray(turnAttempts.status, ["Running", "CancelRequested"]),
    );
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

  /** 2b：用户取消请求位（CAS：仅 Running attempt → CancelRequested，并同步 turns 若未终态） */
  async requestCancelTurnAttempt(
    tenant: TenantContext,
    input: { turnId: string; attemptId: string },
  ): Promise<{ ok: boolean; reason?: "not_found" | "already_finalized" }> {
    assertTenantContext(tenant);
    const [updatedAttempt] = await this.db
      .update(turnAttempts)
      .set({ status: "CancelRequested" })
      .from(turns)
      .where(
        and(
          eq(turnAttempts.turnId, turns.id),
          eq(turnAttempts.id, input.attemptId),
          eq(turnAttempts.turnId, input.turnId),
          eq(turns.workspaceId, tenant.workspaceId),
          eq(turns.subjectUserId, tenant.subjectUserId),
          eq(turnAttempts.status, "Running"),
        ),
      )
      .returning();
    if (!updatedAttempt) {
      const exists = await this.getTurnAttemptStatus(tenant, input);
      return exists === null
        ? { ok: false, reason: "not_found" }
        : { ok: false, reason: "already_finalized" };
    }
    // turns 终态保护：仅未终态可置 Cancelled；已终态（Completed/Failed/Interrupted/Cancelled 等）不覆盖
    await this.db
      .update(turns)
      .set({ status: "Cancelled" })
      .where(
        and(
          eq(turns.id, input.turnId),
          notInArray(turns.status, ["Completed", "Failed", "Interrupted", "Cancelled"]),
        ),
      );
    return { ok: true };
  }

  /** 2b：读取 Attempt 当前状态（executor 取消检查点轮询） */
  async getTurnAttemptStatus(
    tenant: TenantContext,
    input: { turnId: string; attemptId: string },
  ): Promise<string | null> {
    assertTenantContext(tenant);
    const [row] = await this.db
      .select({ status: turnAttempts.status })
      .from(turnAttempts)
      .innerJoin(turns, eq(turnAttempts.turnId, turns.id))
      .where(
        and(
          eq(turnAttempts.id, input.attemptId),
          eq(turnAttempts.turnId, input.turnId),
          eq(turns.workspaceId, tenant.workspaceId),
          eq(turns.subjectUserId, tenant.subjectUserId),
        ),
      )
      .limit(1);
    return (row as { status: string } | undefined)?.status ?? null;
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

  /** 2c：幂等预留（§9 idempotency reservation；attempt+invocation 唯一，ON CONFLICT DO NOTHING） */
  async reserveToolExecution(
    tenant: TenantContext,
    input: {
      turnId: string;
      attemptId: string;
      invocationId: string;
      name: string;
      arguments?: unknown;
    },
  ): Promise<{ ok: boolean; alreadyReserved: boolean }> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
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
        status: "pending",
        startedAt: now,
        finishedAt: now,
      })
      .onConflictDoNothing({ target: [toolExecutions.attemptId, toolExecutions.invocationId] })
      .returning();
    return { ok: true, alreadyReserved: !created };
  }

  /** 2c：以权威结果收口预留行（UPDATE by attempt+invocation） */
  async updateToolExecutionResult(
    tenant: TenantContext,
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
    assertTenantContext(tenant);
    const [updated] = await this.db
      .update(toolExecutions)
      .set({
        status: input.status,
        outputJson: input.output,
        error: input.error ?? null,
        finishedAt: input.finishedAt ?? new Date().toISOString(),
      })
      .from(turns)
      .where(
        and(
          eq(toolExecutions.turnId, turns.id),
          eq(toolExecutions.attemptId, input.attemptId),
          eq(toolExecutions.invocationId, input.invocationId),
          eq(turns.workspaceId, tenant.workspaceId),
          eq(turns.subjectUserId, tenant.subjectUserId),
        ),
      )
      .returning();
    return { ok: Boolean(updated) };
  }

  /**
   * B4-D（§12.2）：原子提交「工具结果账本收口 + tool_result 事件」。
   * BEGIN IMMEDIATE 事务内：fencing+状态守卫（同 appendStreamEvent fenced 语义）→
   * 写入 tool_executions 结果与 turn_stream_events 事件，两者同生共死。
   * 守卫失配抛 FencingMismatchError（迟到/被抢占执行器被拒）。
   */
  async recordToolOutcomeAtomically(
    tenant: TenantContext,
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
    assertTenantContext(tenant);
    return this.db.transaction(
      async (tx) => {
        const [attempt] = await tx
          .select({ status: turnAttempts.status, fencingToken: turnAttempts.fencingToken })
          .from(turnAttempts)
          .where(
            and(
              eq(turnAttempts.id, input.attemptId),
              eq(turnAttempts.turnId, input.turnId),
            ),
          );
        const running = attempt && (attempt.status === "Running" || attempt.status === "CancelRequested");
        if (!attempt || attempt.fencingToken !== input.expectedFencingToken || !running) {
          throw new FencingMismatchError(
            `attempt ${input.attemptId} fencing=${attempt?.fencingToken ?? "?"} status=${attempt?.status ?? "?"} cannot record tool outcome`,
          );
        }
        await tx.insert(turnStreamEvents).values({
          id: `tev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          turnId: input.turnId,
          attemptId: input.attemptId,
          workspaceId: tenant.workspaceId,
          subjectUserId: tenant.subjectUserId,
          sequence: input.sequence,
          eventType: "tool_result",
          data: input.eventData,
          occurredAt: new Date().toISOString(),
          safetyDecision: input.safetyDecision ?? null,
        });
        await tx
          .update(toolExecutions)
          .set({
            status: input.status,
            outputJson: input.output,
            error: input.error ?? null,
            finishedAt: input.finishedAt ?? new Date().toISOString(),
          })
          .from(turns)
          .where(
            and(
              eq(toolExecutions.turnId, turns.id),
              eq(toolExecutions.attemptId, input.attemptId),
              eq(toolExecutions.invocationId, input.invocationId),
              eq(turns.workspaceId, tenant.workspaceId),
              eq(turns.subjectUserId, tenant.subjectUserId),
            ),
          );
        return true;
      },
      { behavior: "immediate" },
    );
  }

  /**
   * B4-D（§12.2）：原子提交「Attempt 终态 + 收尾事件（done/error）」。
   * BEGIN IMMEDIATE 事务内：终态 CAS（仅 Running/CancelRequested + fencing 匹配，3b-B 单一终态）
   * 成功才一并插入 done/error 事件；CAS 失败返回 false（不写事件，杜绝孤儿 done）。
   */
  async finalizeAttemptWithEventAtomically(
    tenant: TenantContext,
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
    assertTenantContext(tenant);
    return this.db.transaction(
      async (tx) => {
        const [updated] = await tx
          .update(turnAttempts)
          .set({ status: input.status, finishedAt: new Date().toISOString() })
          .from(turns)
          .where(
            and(
              eq(turnAttempts.turnId, turns.id),
              eq(turnAttempts.id, input.attemptId),
              eq(turnAttempts.turnId, input.turnId),
              eq(turns.workspaceId, tenant.workspaceId),
              eq(turns.subjectUserId, tenant.subjectUserId),
              inArray(turnAttempts.status, ["Running", "CancelRequested"]),
              eq(turnAttempts.fencingToken, input.expectedFencingToken),
            ),
          )
          .returning({ id: turnAttempts.id });
        if (!updated) return false;
        await tx.insert(turnStreamEvents).values({
          id: `tev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          turnId: input.turnId,
          attemptId: input.attemptId,
          workspaceId: tenant.workspaceId,
          subjectUserId: tenant.subjectUserId,
          sequence: input.sequence,
          eventType: input.eventType,
          data: input.eventData,
          occurredAt: new Date().toISOString(),
          safetyDecision: input.safetyDecision ?? null,
        });
        return true;
      },
      { behavior: "immediate" },
    );
  }

  /**
   * E2（§12.2「安全片段 + TurnStreamEvent + Draft prefix」）：原子提交「安全片段 + delta 事件」。
   * BEGIN IMMEDIATE 事务内：fencing+状态守卫（同 appendStreamEvent fenced 语义）→ 插入
   * safe_segments 行（committed=1，可见前缀）与 turn_stream_events 行（delta），并回填关联。
   * 守卫失配抛 FencingMismatchError（迟到/被抢占执行器被拒，无部分写入）。
   */
  async recordSafeSegmentAtomically(
    tenant: TenantContext,
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
    assertTenantContext(tenant);
    return this.db.transaction(
      async (tx) => {
        const [attempt] = await tx
          .select({ status: turnAttempts.status, fencingToken: turnAttempts.fencingToken })
          .from(turnAttempts)
          .where(
            and(
              eq(turnAttempts.id, input.attemptId),
              eq(turnAttempts.turnId, input.turnId),
            ),
          );
        const running = attempt && (attempt.status === "Running" || attempt.status === "CancelRequested");
        if (!attempt || attempt.fencingToken !== input.expectedFencingToken || !running) {
          throw new FencingMismatchError(
            `attempt ${input.attemptId} fencing=${attempt?.fencingToken ?? "?"} status=${attempt?.status ?? "?"} cannot record safe segment`,
          );
        }
        const segmentId = `sseg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const eventId = `tev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const now = new Date().toISOString();
        // 1) delta 事件
        await tx.insert(turnStreamEvents).values({
          id: eventId,
          turnId: input.turnId,
          attemptId: input.attemptId,
          workspaceId: tenant.workspaceId,
          subjectUserId: tenant.subjectUserId,
          sequence: input.sequence,
          eventType: "delta",
          data: input.eventData,
          occurredAt: now,
          safetyDecision: input.safetyDecision ?? null,
        });
        // 2) 安全片段（committed=1 可见前缀）并回填事件关联
        await tx.insert(safeSegments).values({
          id: segmentId,
          turnId: input.turnId,
          attemptId: input.attemptId,
          workspaceId: tenant.workspaceId,
          subjectUserId: tenant.subjectUserId,
          sequence: input.sequence,
          text: input.text,
          committed: 1,
          streamEventId: eventId,
          createdAt: now,
          updatedAt: now,
        });
        return true;
      },
      { behavior: "immediate" },
    );
  }

  /**
   * E2：读取 Turn 的已提交安全片段（可见前缀；按 sequence 升序）。
   * 供中断恢复（visible-prefix）与可见前缀重建使用。
   */
  async listCommittedSegments(
    tenant: TenantContext,
    turnId: string,
  ): Promise<Array<{ id: string; sequence: number; text: string; streamEventId: string | null }>> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select({
        id: safeSegments.id,
        sequence: safeSegments.sequence,
        text: safeSegments.text,
        streamEventId: safeSegments.streamEventId,
      })
      .from(safeSegments)
      .where(
        and(
          eq(safeSegments.turnId, turnId),
          eq(safeSegments.workspaceId, tenant.workspaceId),
          eq(safeSegments.subjectUserId, tenant.subjectUserId),
          eq(safeSegments.committed, 1),
        ),
      )
      .orderBy(safeSegments.sequence);
    return rows;
  }

  /**
   * 3c/4b：恢复候选查询（跨租户，供 worker 观测 + host-agent 续跑执行）。
   *
   * 命中条件：过期 Running Attempt + 存在 executed 工具执行 + 无 done 终态事件
   * （§11.3 首范式「工具结果已权威提交但尚未注入」）。
   * 返回含续跑所需完整数据面：租户、session、用户消息、当前 fencing（续跑 claim 预期）与 lastSequence。
   */
  async findResumeCandidates(
    client: import("@libsql/client").Client,
  ): Promise<
    Array<{
      attemptId: string;
      turnId: string;
      sessionId: string;
      lastSequence: number;
      workspaceId: string;
      subjectUserId: string;
      userMessage: string;
      /** 续跑 claim 预期 = 当前已持有的 fencing（抢占语义） */
      fencingToken: number;
    }>
  > {
    const now = new Date().toISOString();
    const result = await client.execute({
      sql: `
        SELECT ta.id AS attempt_id,
               ta.turn_id AS turn_id,
               ta.fencing_token AS fencing_token,
               t.session_id AS session_id,
               t.workspace_id AS workspace_id,
               t.subject_user_id AS subject_user_id,
               (SELECT mv.content FROM message_versions mv
                WHERE mv.turn_id = ta.turn_id AND mv.role = 'user'
                ORDER BY mv.version DESC LIMIT 1) AS user_message,
               (SELECT COALESCE(MAX(sequence), 0) FROM turn_stream_events e
                WHERE e.turn_id = ta.turn_id AND e.event_type = 'tool_result') AS last_sequence
        FROM turn_attempts ta
        JOIN turns t ON t.id = ta.turn_id
        WHERE ta.status = 'Running'
          AND ta.lease_expires_at IS NOT NULL
          AND ta.lease_expires_at < ?
          AND EXISTS (SELECT 1 FROM tool_executions te
                      WHERE te.attempt_id = ta.id AND te.status = 'executed')
          AND NOT EXISTS (SELECT 1 FROM turn_stream_events e2
                          WHERE e2.turn_id = ta.turn_id AND e2.event_type = 'done')
      `,
      args: [now],
    });
    return result.rows.map((row) => ({
      attemptId: String(row.attempt_id),
      turnId: String(row.turn_id),
      sessionId: String(row.session_id ?? ""),
      lastSequence: Number(row.last_sequence),
      workspaceId: String(row.workspace_id ?? ""),
      subjectUserId: String(row.subject_user_id ?? ""),
      userMessage: String(row.user_message ?? ""),
      fencingToken: Number(row.fencing_token ?? 0),
    }));
  }

  /** 2c：崩溃释放后将遗留 pending 预留标记为 outcome_unknown（§11.3：结果未知不自动重放） */
  async markPendingOutcomeUnknown(client: import("@libsql/client").Client): Promise<number> {
    const result = await client.execute(`
      UPDATE tool_executions
      SET status = 'outcome_unknown', finished_at = COALESCE(finished_at, '${new Date().toISOString()}')
      WHERE status = 'pending'
        AND attempt_id IN (
          SELECT id FROM turn_attempts
          WHERE status IN ('Interrupted', 'Failed', 'Cancelled')
        )
    `);
    return result.rowsAffected ?? 0;
  }

  /** 查询 Turn 的工具执行账本（按时间倒序；join tool_registrations 携带 replay 声明供恢复裁决） */
  async listToolExecutionsByTurn(tenant: TenantContext, turnId: string): Promise<ToolExecutionModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select({ execution: toolExecutions, registration: toolRegistrations })
      .from(toolExecutions)
      .leftJoin(
        toolRegistrations,
        or(eq(toolRegistrations.id, toolExecutions.name), eq(toolRegistrations.name, toolExecutions.name)),
      )
      .where(
        and(
          eq(toolExecutions.turnId, turnId),
          eq(toolExecutions.workspaceId, tenant.workspaceId),
          eq(toolExecutions.subjectUserId, tenant.subjectUserId),
        ),
      )
      .orderBy(desc(toolExecutions.startedAt));
    return rows.map((row) => ({
      ...row.execution,
      replay: row.registration?.replay ?? null,
    })) as ToolExecutionModel[];
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
    // E1（§12.2「ToolInvocation + 授权快照 + 幂等预留」）：同 (toolName, argumentsHash) 已存在
    // 未决（pending）授权则复用既有行，不重复插入——授权匹配键跨 turn 复用（schema 注释约定），
    // 幂等预留语义：重复的写工具意图不会产生多行待决授权。granted/denied 后新请求才新建。
    if (input.state === "pending") {
      const [existing] = await this.db
        .select()
        .from(toolApprovals)
        .where(
          and(
            eq(toolApprovals.workspaceId, tenant.workspaceId),
            eq(toolApprovals.subjectUserId, tenant.subjectUserId),
            eq(toolApprovals.toolName, input.toolName),
            eq(toolApprovals.argumentsHash, input.argumentsHash),
            eq(toolApprovals.state, "pending"),
          ),
        )
        .orderBy(desc(toolApprovals.id))
        .limit(1);
      if (existing) return existing as ToolApprovalModel;
    }
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

  /** 3b：读单条授权记录（privileged 管理员校验预检用） */
  async getToolApproval(tenant: TenantContext, approvalId: string): Promise<ToolApprovalModel | null> {
    assertTenantContext(tenant);
    const [row] = await this.db
      .select()
      .from(toolApprovals)
      .where(
        and(
          eq(toolApprovals.id, approvalId),
          eq(toolApprovals.workspaceId, tenant.workspaceId),
          eq(toolApprovals.subjectUserId, tenant.subjectUserId),
        ),
      )
      .limit(1);
    return (row as ToolApprovalModel) ?? null;
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
    input: { toolName: string; argumentsHash: string; excludeDecidedByPrefix?: string },
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
          input.excludeDecidedByPrefix
            ? or(
                isNull(toolApprovals.decidedBy),
                notLike(toolApprovals.decidedBy, `${input.excludeDecidedByPrefix}%`),
              )
            : undefined,
        ),
      )
      .orderBy(desc(toolApprovals.id));
    return (found as ToolApprovalModel) ?? null;
  }

  // ============ P1（R2 · CAP-014）：会话地图分支 ============

  async createConversationBranch(
    tenant: TenantContext,
    branchData: {
      id: string;
      parentSessionId: string;
      forkAtMessageId?: string | null;
      childSessionId: string;
      title?: string;
      branchReason?: string;
    },
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
        title: branchData.title ?? null,
        branchReason: branchData.branchReason ?? null,
        status: "active",
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
          isNull(conversationBranches.deletedAt),
        ),
      )
      .orderBy(conversationBranches.createdAt);
    return rows as ConversationBranchModel[];
  }

  async getBranch(tenant: TenantContext, branchId: string): Promise<ConversationBranchModel | null> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(conversationBranches)
      .where(
        and(
          eq(conversationBranches.id, branchId),
          eq(conversationBranches.workspaceId, tenant.workspaceId),
          eq(conversationBranches.subjectUserId, tenant.subjectUserId),
          isNull(conversationBranches.deletedAt),
        ),
      )
      .limit(1);
    return (found as ConversationBranchModel) ?? null;
  }

  async mergeBranch(tenant: TenantContext, branchId: string): Promise<ConversationBranchModel | null> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(conversationBranches)
      .set({ status: "merged", mergedAt: now, updatedAt: now })
      .where(
        and(
          eq(conversationBranches.id, branchId),
          eq(conversationBranches.workspaceId, tenant.workspaceId),
          eq(conversationBranches.subjectUserId, tenant.subjectUserId),
          eq(conversationBranches.status, "active"),
          isNull(conversationBranches.deletedAt),
        ),
      )
      .returning();
    return (updated as ConversationBranchModel) ?? null;
  }

  async archiveBranch(tenant: TenantContext, branchId: string): Promise<ConversationBranchModel | null> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(conversationBranches)
      .set({ status: "archived", updatedAt: now })
      .where(
        and(
          eq(conversationBranches.id, branchId),
          eq(conversationBranches.workspaceId, tenant.workspaceId),
          eq(conversationBranches.subjectUserId, tenant.subjectUserId),
          eq(conversationBranches.status, "active"),
          isNull(conversationBranches.deletedAt),
        ),
      )
      .returning();
    return (updated as ConversationBranchModel) ?? null;
  }

  async deleteBranch(tenant: TenantContext, branchId: string): Promise<ConversationBranchModel | null> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(conversationBranches)
      .set({ status: "deleted", deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(conversationBranches.id, branchId),
          eq(conversationBranches.workspaceId, tenant.workspaceId),
          eq(conversationBranches.subjectUserId, tenant.subjectUserId),
          isNull(conversationBranches.deletedAt),
        ),
      )
      .returning();
    return (updated as ConversationBranchModel) ?? null;
  }

  async updateBranchLayout(
    tenant: TenantContext,
    branchId: string,
    layoutData: unknown,
  ): Promise<ConversationBranchModel | null> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(conversationBranches)
      .set({ layoutData, updatedAt: now })
      .where(
        and(
          eq(conversationBranches.id, branchId),
          eq(conversationBranches.workspaceId, tenant.workspaceId),
          eq(conversationBranches.subjectUserId, tenant.subjectUserId),
          isNull(conversationBranches.deletedAt),
        ),
      )
      .returning();
    return (updated as ConversationBranchModel) ?? null;
  }

  async getBranchTree(tenant: TenantContext, sessionId: string): Promise<ConversationBranchModel[]> {
    assertTenantContext(tenant);
    // 递归获取所有以 sessionId 为根的分支（包括子分支的子分支）
    const direct = await this.listBranchesByParent(tenant, sessionId);
    const result = [...direct];
    for (const branch of direct) {
      const children = await this.getBranchTree(tenant, branch.childSessionId);
      result.push(...children);
    }
    return result;
  }
}
