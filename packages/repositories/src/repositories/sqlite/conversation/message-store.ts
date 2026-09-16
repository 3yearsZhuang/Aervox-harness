/**
 * Aervox｜思隅 @aervox/repositories — 消息身份与版本（编辑/软删/脱敏）Store
 */
import { eq, and, desc, isNull } from "drizzle-orm";
import type { AervoxDatabase } from "../../../client.js";
import { messages, messageVersions, sessions } from "@aervox/schema";
import type { LocalContext } from "../../../local-context.js";
import type { MessageModel, MessageVersionModel } from "../../types/index.js";

export class MessageStore {
  constructor(private readonly db: AervoxDatabase) {}

  async deleteMessage(ctx: LocalContext, messageId: string): Promise<boolean> {
    const res = await this.db
      .delete(messageVersions)
      .where(
        and(
          eq(messageVersions.id, messageId),
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
    ctx: LocalContext,
    messageId: string,
    content: string,
    expectedVersion: number,
  ): Promise<{ message: MessageModel; newVersion: MessageVersionModel } | null> {
    const now = new Date().toISOString();

    // 1. 获取消息，校验存在性和删除状态
    const message = await this.getMessage(ctx, messageId);
    if (!message || message.deletedAt) return null;

    // 2. 获取当前版本，CAS 校验
    const currentVersions = await this.db
      .select()
      .from(messageVersions)
      .where(
        and(
          eq(messageVersions.messageId, messageId),
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
  async softDeleteMessage(ctx: LocalContext, messageId: string): Promise<MessageModel | null> {
    const now = new Date().toISOString();
    const message = await this.getMessage(ctx, messageId);
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
  async restoreMessage(ctx: LocalContext, messageId: string): Promise<MessageModel | null> {
    // 先校验租户归属
    const message = await this.getMessage(ctx, messageId);
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
    ctx: LocalContext,
    messageId: string,
  ): Promise<MessageVersionModel[]> {
    const rows = await this.db
      .select()
      .from(messageVersions)
      .where(
        and(
          eq(messageVersions.messageId, messageId),
        ),
      )
      .orderBy(desc(messageVersions.version));
    return rows as MessageVersionModel[];
  }

  /**
   * 将指定 Turn 下全部消息版本标记为脱敏（CAP-008：危机干预时阻断进入日记与记忆素材）
   */
  async redactTurnMessages(ctx: LocalContext, turnId: string): Promise<void> {
    await this.db
      .update(messageVersions)
      .set({ isRedacted: 1 })
      .where(eq(messageVersions.turnId, turnId));
  }

  /**
   * 写入已脱敏的助手消息版本（CAP-008：危机求助固定回复，避免被日记/记忆提取收集）
   */
  async appendRedactedAssistantMessage(
    ctx: LocalContext,
    input: { id: string; turnId: string; content: string },
  ): Promise<MessageVersionModel> {
    const [created] = await this.db
      .insert(messageVersions)
      .values({
        id: input.id,
        turnId: input.turnId,
        role: "assistant",
        version: 2,
        content: input.content,
        isRedacted: 1,
        createdAt: new Date().toISOString(),
      })
      .returning();
    return created as MessageVersionModel;
  }

  // ============ MVP 补齐（PRD §8）：Message 身份 / TurnAttempt ============

  async createMessage(
    ctx: LocalContext,
    messageData: { id: string; sessionId: string; role: string; label?: string | null },
  ): Promise<MessageModel> {
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

  async getMessage(ctx: LocalContext, messageId: string): Promise<MessageModel | null> {
    const [found] = await this.db
      .select()
      .from(messages)
      .innerJoin(sessions, eq(messages.sessionId, sessions.id))
      .where(
        and(
          eq(messages.id, messageId),
        ),
      );
    return (found ? { ...found.messages } : null) as MessageModel | null;
  }
}
