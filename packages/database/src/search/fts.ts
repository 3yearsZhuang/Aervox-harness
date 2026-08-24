/**
 * Aervox｜思隅 @aervox/database — SQLite FTS5 全文检索集成
 *
 * 为会话消息与记忆提供无外置搜索引擎依赖的本地全文检索能力。
 */
import type { Client } from "@libsql/client";
import { assertTenantContext, type TenantContext } from "../tenant.js";

/**
 * 初始化 FTS5 全文检索引擎虚表
 */
export async function initFtsTables(client: Client): Promise<void> {
  await client.execute(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      id UNINDEXED,
      workspace_id UNINDEXED,
      subject_user_id UNINDEXED,
      content,
      tokenize = 'unicode61'
    );
  `);

  await client.execute(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      id UNINDEXED,
      workspace_id UNINDEXED,
      subject_user_id UNINDEXED,
      content,
      tokenize = 'unicode61'
    );
  `);
}

/**
 * 同步消息文本到 FTS5 虚表
 */
export async function indexMessageFts(
  client: Client,
  tenant: TenantContext,
  message: { id: string; content: string },
): Promise<void> {
  assertTenantContext(tenant);
  // 先清理旧索引（若存在），再插入新索引
  await client.execute({
    sql: `DELETE FROM messages_fts WHERE id = ? AND workspace_id = ? AND subject_user_id = ?`,
    args: [message.id, tenant.workspaceId, tenant.subjectUserId],
  });
  await client.execute({
    sql: `INSERT INTO messages_fts(id, workspace_id, subject_user_id, content) VALUES (?, ?, ?, ?)`,
    args: [message.id, tenant.workspaceId, tenant.subjectUserId, message.content],
  });
}

/**
 * 从 FTS5 虚表中清理被删除的消息索引（满足删除即刻零召回要求）
 */
export async function deleteMessageFts(
  client: Client,
  tenant: TenantContext,
  messageId: string,
): Promise<void> {
  assertTenantContext(tenant);
  await client.execute({
    sql: `DELETE FROM messages_fts WHERE id = ? AND workspace_id = ? AND subject_user_id = ?`,
    args: [messageId, tenant.workspaceId, tenant.subjectUserId],
  });
}

export interface FtsSearchResult {
  readonly id: string;
  readonly score: number;
}

/**
 * 在租户隔离下执行 FTS5 全文搜索
 */
export async function searchMessagesFts(
  client: Client,
  tenant: TenantContext,
  query: string,
  limit: number = 20,
): Promise<FtsSearchResult[]> {
  assertTenantContext(tenant);
  const sanitized = query.replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
  if (!sanitized) return [];

  const res = await client.execute({
    sql: `
      SELECT id, rank AS score
      FROM messages_fts
      WHERE messages_fts MATCH ?
        AND workspace_id = ?
        AND subject_user_id = ?
      ORDER BY rank
      LIMIT ?;
    `,
    args: [sanitized, tenant.workspaceId, tenant.subjectUserId, limit],
  });

  return res.rows.map((row) => ({
    id: String(row.id),
    score: Number(row.score),
  }));
}
