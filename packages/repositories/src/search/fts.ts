/**
 * Aervox｜思隅 @aervox/repositories — SQLite FTS5 全文检索集成
 *
 * 为会话消息与记忆提供无外置搜索引擎依赖的本地全文检索能力。
 */
import type { Client, InValue } from "@libsql/client";
import { sql, type SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { messages, messageVersions, turns } from "@aervox/schema";
import { derivableConversationTurn } from "../repositories/sqlite/conversation/source-visibility.js";
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

const dialect = new SQLiteSyncDialect();
const statement = (query: SQL) => {
  const compiled = dialect.sqlToQuery(query);
  return { sql: compiled.sql, args: compiled.params as InValue[] };
};
const messageIdentity = sql`coalesce(${messageVersions.messageId}, ${messageVersions.id})`;
// One predicate owns live indexing, stale-index qualification and migration rebuilds.
// FTS is a projection of current conversation truth, never an independent source.
const eligibleMessage = sql`(
  ${derivableConversationTurn(turns.id)}
  and ${turns.executionPolicy} in ('local-v1', 'bot-owner-v1')
  and ${messageVersions.role} in ('user', 'assistant')
  and ${messageVersions.isRedacted} = 0 and ${messageVersions.supersededAt} is null
  and ${messageVersions.content} <> ''
  and ((${messageVersions.messageId} is null and not exists (
    select 1 from message_versions newer_fts_version
    where newer_fts_version.turn_id = ${messageVersions.turnId}
      and newer_fts_version.role = ${messageVersions.role}
      and newer_fts_version.superseded_at is null and newer_fts_version.version > ${messageVersions.version}
  )) or exists (
    select 1 from ${messages} where ${messages.id} = ${messageVersions.messageId}
      and ${messages.sessionId} = ${turns.sessionId} and ${messages.role} = ${messageVersions.role}
      and ${messages.deletedAt} is null and ${messages.currentVersionId} = ${messageVersions.id}
  ))
)`;
const messageSources = sql`${messageVersions} inner join ${turns} on ${turns.id} = ${messageVersions.turnId}`;

/** Rebuild only eligible current sources; caller owns the explicit staging lifecycle. */
export async function rebuildMessageFts(client: Client): Promise<void> {
  await client.batch([
    "DELETE FROM messages_fts",
    statement(sql`insert into messages_fts(id, content)
      select ${messageIdentity}, ${messageVersions.content} from ${messageSources} where ${eligibleMessage}`),
  ], "write");
}

/**
 * 同步消息文本到 FTS5 虚表。迟到或伪造的正文不能覆盖当前事实。
 */
export async function indexMessageFts(
  client: Client,
  ctx: LocalContext,
  message: { id: string; content: string },
): Promise<void> {
  assertLocalContext(ctx);
  await client.batch([
    { sql: "DELETE FROM messages_fts WHERE id = ?", args: [message.id] },
    statement(sql`insert into messages_fts(id, content)
      select ${messageIdentity}, ${messageVersions.content} from ${messageSources}
      where ${eligibleMessage} and ${messageIdentity} = ${message.id} and ${messageVersions.content} = ${message.content}`),
  ], "write");
}

/**
 * 从 FTS5 虚表中清理被删除的消息索引（满足删除即刻零召回要求）
 */
export async function deleteMessageFts(
  client: Client,
  ctx: LocalContext,
  messageId: string,
): Promise<void> {
  assertLocalContext(ctx);
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
  ctx: LocalContext,
  query: string,
  limit: number = 20,
): Promise<FtsSearchResult[]> {
  assertLocalContext(ctx);
  const sanitized = query.replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
  if (!sanitized) return [];

  const res = await client.execute(statement(sql`
    select json_quote(messages_fts.id) as encoded_id, rank as score
    from messages_fts
    where messages_fts match ${sanitized} and exists (
      select 1 from ${messageSources} where ${eligibleMessage}
        and ${messageIdentity} = messages_fts.id and ${messageVersions.content} = messages_fts.content
    )
    order by rank limit ${limit}
  `));

  return res.rows.map((row) => ({
    // The native text decoder truncates embedded NUL; JSON preserves the complete identity.
    id: JSON.parse(String(row.encoded_id)) as string,
    score: Number(row.score),
  }));
}

/**
 * 同步记忆内容到 memories_fts 虚表（先清理旧索引再插入）
 */
export async function indexMemoryFts(
  client: Client,
  ctx: LocalContext,
  memory: { id: string; content: string },
): Promise<void> {
  assertLocalContext(ctx);
  await client.execute({ sql: `DELETE FROM memories_fts WHERE id = ?`, args: [memory.id] });
  await client.execute({
    // A late indexer must not resurrect a scrubbed Memory tombstone.
    sql: `INSERT INTO memories_fts(id, content) SELECT ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM memory_records WHERE id = ? AND is_deleted = 1)`,
    args: [memory.id, memory.content, memory.id],
  });
}

/**
 * 从 memories_fts 虚表中清理被删除记忆的索引（删除即刻零召回）
 */
export async function deleteMemoryFts(
  client: Client,
  ctx: LocalContext,
  memoryId: string,
): Promise<void> {
  assertLocalContext(ctx);
  await client.execute({ sql: `DELETE FROM memories_fts WHERE id = ?`, args: [memoryId] });
}

/**
 * 在本地单用户索引中对记忆执行 FTS5 全文搜索
 */
export async function searchMemoriesFts(
  client: Client,
  ctx: LocalContext,
  query: string,
  limit: number = 20,
): Promise<FtsSearchResult[]> {
  assertLocalContext(ctx);
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
