/**
 * Aervox｜思隅 @aervox/database — 对话与流式协议 SQLite 仓储实现
 */
import { eq, and, gt, desc } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import {
  sessions,
  turns,
  messages,
  messageVersions,
  turnStreamEvents,
  turnAttempts,
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
