/**
 * Aervox｜思隅 @aervox/database — SQLite FTS5 全文检索集成
 *
 * 为会话消息与记忆提供无外置搜索引擎依赖的本地全文检索能力。
 */
import type { Client } from "@libsql/client";
import { assertLocalContext, type LocalContext } from "../local-context.js";

/**
 * 初始化 FTS5 全文检索引擎虚表
 */
export async function initFtsTables(client: Client): Promise<void> {
  await client.execute(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      id UNINDEXED,
      content,
      tokenize = 'unicode61'
    );
  `);

  await client.execute(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      id UNINDEXED,
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
  tenant: LocalContext,
  message: { id: string; content: string },
): Promise<void> {
  assertLocalContext(tenant);
  // 先清理旧索引（若存在），再插入新索引
  await client.execute({ sql: `DELETE FROM messages_fts WHERE id = ?`, args: [message.id] });
  await client.execute({
    sql: `INSERT INTO messages_fts(id, content) VALUES (?, ?)`,
    args: [message.id, message.content],
  });
}

/**
 * 从 FTS5 虚表中清理被删除的消息索引（满足删除即刻零召回要求）
 */
export async function deleteMessageFts(
  client: Client,
  tenant: LocalContext,
  messageId: string,
): Promise<void> {
  assertLocalContext(tenant);
  await client.execute({ sql: `DELETE FROM messages_fts WHERE id = ?`, args: [messageId] });
}

export interface FtsSearchResult {
  readonly id: string;
  readonly score: number;
}

/**
 * 在本地单用户索引中执行 FTS5 全文搜索
 */
export async function searchMessagesFts(
  client: Client,
  tenant: LocalContext,
  query: string,
  limit: number = 20,
): Promise<FtsSearchResult[]> {
  assertLocalContext(tenant);
  const sanitized = query.replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
  if (!sanitized) return [];

  const res = await client.execute({
    sql: `
      SELECT id, rank AS score
      FROM messages_fts
      WHERE messages_fts MATCH ?
      ORDER BY rank
      LIMIT ?;
    `,
    args: [sanitized, limit],
  });

  return res.rows.map((row) => ({
    id: String(row.id),
    score: Number(row.score),
  }));
}

/**
 * 同步记忆内容到 memories_fts 虚表（先清理旧索引再插入）
 */
export async function indexMemoryFts(
  client: Client,
  tenant: LocalContext,
  memory: { id: string; content: string },
): Promise<void> {
  assertLocalContext(tenant);
  await client.execute({ sql: `DELETE FROM memories_fts WHERE id = ?`, args: [memory.id] });
  await client.execute({
    sql: `INSERT INTO memories_fts(id, content) VALUES (?, ?)`,
    args: [memory.id, memory.content],
  });
}

/**
 * 从 memories_fts 虚表中清理被删除记忆的索引（删除即刻零召回）
 */
export async function deleteMemoryFts(
  client: Client,
  tenant: LocalContext,
  memoryId: string,
): Promise<void> {
  assertLocalContext(tenant);
  await client.execute({ sql: `DELETE FROM memories_fts WHERE id = ?`, args: [memoryId] });
}

/**
 * 在本地单用户索引中对记忆执行 FTS5 全文搜索
 */
export async function searchMemoriesFts(
  client: Client,
  tenant: LocalContext,
  query: string,
  limit: number = 20,
): Promise<FtsSearchResult[]> {
  assertLocalContext(tenant);
  const sanitized = query.replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
  if (!sanitized) return [];

  const res = await client.execute({
    sql: `
      SELECT id, rank AS score
      FROM memories_fts
      WHERE memories_fts MATCH ?
      ORDER BY rank
      LIMIT ?;
    `,
    args: [sanitized, limit],
  });

  return res.rows.map((row) => ({
    id: String(row.id),
    score: Number(row.score),
  }));
}
