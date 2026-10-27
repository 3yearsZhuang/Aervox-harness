/**
 * Aervox｜思隅 @aervox/repositories — 会话生命周期、分支地图（CAP-014）与会话导入 Store
 */
import { conversationSha256, conversationUUID, requireConversationCrypto, type ConversationCryptoPort } from "../../../conversation-host-port.js";
import { eq, and, desc, isNull } from "drizzle-orm";
import type { AervoxDatabase } from "../../../client.js";
import {
  sessions,
  turns,
  messages,
  messageVersions,
  conversationBranches,
  outboxEvents,
  type ConversationExecutionPolicy,
} from "@aervox/schema";
import { assertPluginGeneration, type PluginGenerationIdentity } from "../../../plugin-generation-guard.js";
import { assertConversationExecutionPolicy } from "../../../conversation-execution-policy.js";
import { BRANCH_TREE_MAX_BRANCHES, BRANCH_TREE_MAX_SESSIONS, BranchTreeLimitError, type BranchTreeReadOptions } from "../../../conversation-branch-tree.js";
import { deleteBotConversationData } from "./bot-data-deletion.js";
import type { LocalContext } from "../../../local-context.js";
import { readSessionHistory } from "../session-history.js";
import type { SessionModel, ConversationBranchModel, CreateExplorationBranchInput } from "../../types/index.js";

export class ConversationSessionStore {
  constructor(private readonly db: AervoxDatabase, private readonly crypto: ConversationCryptoPort) { requireConversationCrypto(crypto); }

  getSessionHistory(ctx: LocalContext, input: { sessionId: string; beforeTurnId: string }) {
    return readSessionHistory(this.db, ctx, input);
  }

  async createSession(
    _tenant: LocalContext,
    title: string,
    options?: { id?: string; projectId?: string | null; executionPolicy?: ConversationExecutionPolicy; pluginGeneration?: PluginGenerationIdentity },
  ): Promise<SessionModel> {
    return this.db.transaction(async (tx) => {
    await assertPluginGeneration(tx, options?.pluginGeneration);
    const executionPolicy = options?.executionPolicy ?? "local-v1";
    assertConversationExecutionPolicy(executionPolicy);
    const id = options?.id?.trim() || `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const [created] = await tx
      .insert(sessions)
      .values({
        id,
        title,
        projectId: options?.projectId ?? null,
        executionPolicy,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as SessionModel;
    });
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
    if (found) assertConversationExecutionPolicy(found.executionPolicy);
    return (found as SessionModel) ?? null;
  }

  /**
   * 按客户端 sessionId 获取会话，不存在则创建。
   *
   * 用于修复 API 直接以外部 sessionId 创建 Turn 时的外键违约
   * （turns.session_id 引用 sessions.id）。注意 sessions.id 为主键，
   * 在本地实例内唯一；调用方应复用同一对话的 sessionId。
   */
  async getOrCreateSession(
    ctx: LocalContext,
    sessionId: string,
    title = "默认会话",
    projectId?: string | null,
    executionPolicy?: ConversationExecutionPolicy,
  ): Promise<SessionModel> {
    if (executionPolicy !== undefined) assertConversationExecutionPolicy(executionPolicy);
    const existing = await this.getSession(ctx, sessionId);
    if (existing) {
      if (executionPolicy !== undefined && executionPolicy !== existing.executionPolicy) throw new Error("conversation_execution_policy_mismatch");
      return existing;
    }
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(sessions)
      .values({
        id: sessionId,
        title,
        projectId: projectId ?? null,
        executionPolicy: executionPolicy ?? "local-v1",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (created) return created as SessionModel;
    const concurrent = await this.getSession(ctx, sessionId);
    if (!concurrent) throw new Error("conversation_session_unavailable");
    if (executionPolicy !== undefined && executionPolicy !== concurrent.executionPolicy) throw new Error("conversation_execution_policy_mismatch");
    return concurrent;
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
    return this.db.transaction(async (tx) => {
      await deleteBotConversationData(tx, { sessionId });
      const result = await tx
        .delete(sessions)
        .where(eq(sessions.id, sessionId))
        .returning();
      return result.length > 0;
    });
  }

  // ============ P1（R2 · CAP-014）：会话地图分支 ============

  /** Child, edge and outbox share a transaction and one request identity. */
  async createExplorationBranch(ctx: LocalContext, input: CreateExplorationBranchInput): Promise<ConversationBranchModel | null> {
    if (input.idempotencyKey !== undefined && (!input.idempotencyKey.trim() || input.idempotencyKey.length > 512)) {
      throw new Error("conversation_branch_idempotency_key_invalid");
    }
    // Scope to the parent and command, rather than a process-local IPC/request ID.
    // No key preserves the established ability to create independent duplicate edges.
    const id = input.idempotencyKey === undefined ? (input.id ?? `br_${conversationUUID(this.crypto)}`)
      : `br_${conversationSha256(this.crypto, JSON.stringify(["exploration-branch-v1", input.parentSessionId, input.idempotencyKey]))}`;
    const childSessionId = input.childSessionId ?? `session_explore_${id}`;
    if (input.parentSessionId === childSessionId) throw new Error("conversation_branch_self_reference");
    return this.db.transaction(async (tx) => {
      await assertPluginGeneration(tx, input.pluginGeneration);
      const [parent] = await tx.select().from(sessions).where(eq(sessions.id, input.parentSessionId));
      if (!parent) return null;
      assertConversationExecutionPolicy(parent.executionPolicy);
      const [existing] = await tx.select().from(conversationBranches).where(eq(conversationBranches.id, id));
      if (existing) {
        if (existing.parentSessionId !== input.parentSessionId || existing.childSessionId !== childSessionId ||
          existing.title !== (input.title ?? null) || existing.forkAtMessageId !== (input.forkAtMessageId ?? null) ||
          existing.branchReason !== (input.branchReason ?? null)) throw new Error("conversation_branch_idempotency_conflict");
        return existing as ConversationBranchModel;
      }
      const [receipt] = await tx.select({ id: outboxEvents.id }).from(outboxEvents)
        .where(eq(outboxEvents.idempotencyKey, `branch:${id}`)).limit(1);
      // A deleted child cascades its edge away. Its durable command receipt must
      // prevent recreation, even though there is no longer a row to return.
      if (receipt) throw new Error("conversation_branch_result_unavailable");
      // Historical fork markers are opaque metadata, not a source-message FK.
      const now = new Date().toISOString();
      const [child] = await tx.select().from(sessions).where(eq(sessions.id, childSessionId));
      if (child && child.executionPolicy !== parent.executionPolicy) throw new Error("conversation_execution_policy_mismatch");
      if (!child) await tx.insert(sessions).values({ id: childSessionId, title: input.title ?? parent.title, projectId: parent.projectId,
        executionPolicy: parent.executionPolicy, createdAt: now, updatedAt: now });
      const [branch] = await tx.insert(conversationBranches).values({ id, parentSessionId: input.parentSessionId, childSessionId, title: input.title ?? null,
        forkAtMessageId: input.forkAtMessageId ?? null, branchReason: input.branchReason ?? null, status: "active", createdAt: now, updatedAt: now }).returning();
      await tx.insert(outboxEvents).values({ id: `out_branch_${id}`, idempotencyKey: `branch:${id}`, eventType: "conversation.branch.created",
        payload: { branchId: id, parentSessionId: input.parentSessionId, childSessionId }, createdAt: now });
      return branch as ConversationBranchModel;
    });
  }

  async listBranchesByParent(ctx: LocalContext, parentSessionId: string, options?: { limit?: number }): Promise<ConversationBranchModel[]> {
    const query = this.db
      .select()
      .from(conversationBranches)
      .where(
        and(
          eq(conversationBranches.parentSessionId, parentSessionId),
          isNull(conversationBranches.deletedAt),
        ),
      )
      .orderBy(conversationBranches.createdAt);
    const rows = await (options?.limit === undefined ? query : query.limit(options.limit));
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

  async getBranchTree(ctx: LocalContext, sessionId: string, options?: BranchTreeReadOptions): Promise<ConversationBranchModel[]> {
    const pending = [sessionId];
    const visitedSessions = new Set<string>();
    const seenBranches = new Set<string>();
    const result: ConversationBranchModel[] = [];
    while (pending.length) {
      options?.signal?.throwIfAborted();
      const parentSessionId = pending.pop()!;
      if (visitedSessions.has(parentSessionId)) continue;
      if (visitedSessions.size >= BRANCH_TREE_MAX_SESSIONS) throw new BranchTreeLimitError();
      visitedSessions.add(parentSessionId);
      // Fetch one sentinel row beyond the remaining budget, rather than materializing a wide node.
      const direct = await this.listBranchesByParent(ctx, parentSessionId, { limit: BRANCH_TREE_MAX_BRANCHES - result.length + 1 });
      options?.signal?.throwIfAborted();
      const children: string[] = [];
      for (const branch of direct) {
        if (seenBranches.has(branch.id)) continue;
        if (result.length >= BRANCH_TREE_MAX_BRANCHES) throw new BranchTreeLimitError();
        seenBranches.add(branch.id);
        result.push(branch);
        children.push(branch.childSessionId);
      }
      // Keep direct siblings first, then their descendants in the existing sibling order.
      for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]!);
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
