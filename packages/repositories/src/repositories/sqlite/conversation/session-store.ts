/**
 * Aervox｜思隅 @aervox/repositories — 会话生命周期、分支地图（CAP-014）与会话导入 Store
 */
import { eq, and, desc, isNull } from "drizzle-orm";
import type { AervoxDatabase } from "../../../client.js";
import {
  sessions,
  turns,
  messages,
  messageVersions,
  conversationBranches,
} from "@aervox/schema";
import type { LocalContext } from "../../../local-context.js";
import { readSessionHistory } from "../session-history.js";
import type { SessionModel, ConversationBranchModel } from "../../types/index.js";

export class SessionStore {
  constructor(private readonly db: AervoxDatabase) {}

  getSessionHistory(ctx: LocalContext, input: { sessionId: string; beforeTurnId: string }) {
    return readSessionHistory(this.db, ctx, input);
  }

  async createSession(
    _tenant: LocalContext,
    title: string,
    options?: { id?: string; projectId?: string | null },
  ): Promise<SessionModel> {
    const id = options?.id?.trim() || `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(sessions)
      .values({
        id,
        title,
        projectId: options?.projectId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as SessionModel;
  }

  async getSession(ctx: LocalContext, sessionId: string): Promise<SessionModel | null> {
    const [found] = await this.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.id, sessionId),
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
    ctx: LocalContext,
    sessionId: string,
    title = "默认会话",
    projectId?: string | null,
  ): Promise<SessionModel> {
    const existing = await this.getSession(ctx, sessionId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(sessions)
      .values({
        id: sessionId,
        title,
        projectId: projectId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as SessionModel;
  }

  async listSessions(
    _tenant: LocalContext,
    options?: { limit?: number; offset?: number; projectId?: string },
  ): Promise<SessionModel[]> {
    const query = this.db.select().from(sessions);
    const rows = options?.projectId
      ? await query
          .where(eq(sessions.projectId, options.projectId))
          .orderBy(desc(sessions.updatedAt))
          .limit(options?.limit ?? 100)
          .offset(options?.offset ?? 0)
      : await query
          .orderBy(desc(sessions.updatedAt))
          .limit(options?.limit ?? 100)
          .offset(options?.offset ?? 0);
    return rows as SessionModel[];
  }

  async renameSession(
    _tenant: LocalContext,
    sessionId: string,
    updates: string | { title?: string; projectId?: string | null },
  ): Promise<SessionModel | null> {
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { updatedAt: now };

    if (typeof updates === "string") {
      patch.title = updates;
    } else {
      if (updates.title !== undefined) patch.title = updates.title;
      if (updates.projectId !== undefined) patch.projectId = updates.projectId;
    }

    const [updated] = await this.db
      .update(sessions)
      .set(patch)
      .where(eq(sessions.id, sessionId))
      .returning();
    return (updated as SessionModel) ?? null;
  }

  async deleteSession(
    _tenant: LocalContext,
    sessionId: string,
  ): Promise<boolean> {
    const result = await this.db
      .delete(sessions)
      .where(eq(sessions.id, sessionId))
      .returning();
    return result.length > 0;
  }

  // ============ P1（R2 · CAP-014）：会话地图分支 ============

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
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(conversationBranches)
      .values({
        id: branchData.id,
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

  async listBranchesByParent(ctx: LocalContext, parentSessionId: string): Promise<ConversationBranchModel[]> {
    const rows = await this.db
      .select()
      .from(conversationBranches)
      .where(
        and(
          eq(conversationBranches.parentSessionId, parentSessionId),
          isNull(conversationBranches.deletedAt),
        ),
      )
      .orderBy(conversationBranches.createdAt);
    return rows as ConversationBranchModel[];
  }

  async getBranch(ctx: LocalContext, branchId: string): Promise<ConversationBranchModel | null> {
    const [found] = await this.db
      .select()
      .from(conversationBranches)
      .where(
        and(
          eq(conversationBranches.id, branchId),
          isNull(conversationBranches.deletedAt),
        ),
      )
      .limit(1);
    return (found as ConversationBranchModel) ?? null;
  }

  async mergeBranch(ctx: LocalContext, branchId: string): Promise<ConversationBranchModel | null> {
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(conversationBranches)
      .set({ status: "merged", mergedAt: now, updatedAt: now })
      .where(
        and(
          eq(conversationBranches.id, branchId),
          eq(conversationBranches.status, "active"),
          isNull(conversationBranches.deletedAt),
        ),
      )
      .returning();
    return (updated as ConversationBranchModel) ?? null;
  }

  async archiveBranch(ctx: LocalContext, branchId: string): Promise<ConversationBranchModel | null> {
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(conversationBranches)
      .set({ status: "archived", updatedAt: now })
      .where(
        and(
          eq(conversationBranches.id, branchId),
          eq(conversationBranches.status, "active"),
          isNull(conversationBranches.deletedAt),
        ),
      )
      .returning();
    return (updated as ConversationBranchModel) ?? null;
  }

  async deleteBranch(ctx: LocalContext, branchId: string): Promise<ConversationBranchModel | null> {
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(conversationBranches)
      .set({ status: "deleted", deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(conversationBranches.id, branchId),
          isNull(conversationBranches.deletedAt),
        ),
      )
      .returning();
    return (updated as ConversationBranchModel) ?? null;
  }

  async updateBranchLayout(
    ctx: LocalContext,
    branchId: string,
    layoutData: unknown,
  ): Promise<ConversationBranchModel | null> {
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(conversationBranches)
      .set({ layoutData, updatedAt: now })
      .where(
        and(
          eq(conversationBranches.id, branchId),
          isNull(conversationBranches.deletedAt),
        ),
      )
      .returning();
    return (updated as ConversationBranchModel) ?? null;
  }

  async getBranchTree(ctx: LocalContext, sessionId: string): Promise<ConversationBranchModel[]> {
    // 递归获取所有以 sessionId 为根的分支（包括子分支的子分支）
    const direct = await this.listBranchesByParent(ctx, sessionId);
    const result = [...direct];
    for (const branch of direct) {
      const children = await this.getBranchTree(ctx, branch.childSessionId);
      result.push(...children);
    }
    return result;
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
    const sessionId = `ses_imp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const title =
      input.title?.trim() ||
      input.messages.find((m) => m.role === "user")?.content.slice(0, 30) ||
      "导入会话";

    return await this.db.transaction(async (tx) => {
      const [session] = await tx
        .insert(sessions)
        .values({
          id: sessionId,
          title,
          projectId: input.projectId ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      let turnIndex = 0;
      let currentTurnId = "";
      let versionInTurn = 0;
      let turnsCount = 0;

      for (let i = 0; i < input.messages.length; i++) {
        const msg = input.messages[i]!;
        const msgTime = msg.createdAt || now;

        if (msg.role === "user" || !currentTurnId) {
          turnIndex++;
          turnsCount++;
          currentTurnId = `turn_imp_${Date.now().toString(36)}_${turnIndex}_${Math.random().toString(36).slice(2, 6)}`;
          versionInTurn = 0;

          await tx.insert(turns).values({
            id: currentTurnId,
            sessionId,
            idempotencyKey: `idem_${currentTurnId}`,
            status: "Completed",
            lastSequence: 1,
            completedAt: msgTime,
            createdAt: msgTime,
            updatedAt: msgTime,
          });
        }

        versionInTurn++;
        const messageId = `msg_imp_${Date.now().toString(36)}_${i + 1}_${Math.random().toString(36).slice(2, 6)}`;
        const versionId = `mv_imp_${Date.now().toString(36)}_${i + 1}_${Math.random().toString(36).slice(2, 6)}`;

        await tx.insert(messages).values({
          id: messageId,
          sessionId,
          role: msg.role,
          currentVersionId: versionId,
          createdAt: msgTime,
        });

        await tx.insert(messageVersions).values({
          id: versionId,
          turnId: currentTurnId,
          messageId,
          role: msg.role,
          version: versionInTurn,
          content: msg.content,
          isRedacted: 0,
          createdAt: msgTime,
        });
      }

      return {
        session: session as SessionModel,
        turnsCount,
        messagesCount: input.messages.length,
      };
    });
  }
}
