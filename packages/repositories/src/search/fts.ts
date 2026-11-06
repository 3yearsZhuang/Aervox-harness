/**
 * Aervox｜思隅 @aervox/repositories — 主库全文检索投影
 *
 * 为会话消息与记忆提供无外置搜索引擎依赖的本地全文检索能力。
 */
import type { InStatement, InValue, Transaction } from "@libsql/client";
import { sql, type SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { messages, messageVersions, memoryRecords, turns } from "@aervox/schema";
import { derivableConversationTurn } from "../repositories/sqlite/conversation/source-visibility.js";
import { assertLocalContext, type LocalContext } from "../local-context.js";
import { FTS_SCHEMA_STATEMENTS } from "../schema/fts-definition.js";
import { backendFor } from "../database-backend.js";
import { jsonQuote } from "../sql-dialect.js";

/** Backend-neutral query and atomic writer surface, without connection creation. */
export interface FtsConnection {
  execute(input: InStatement): Promise<{ rows: readonly Record<string, unknown>[] }>;
  batch(statements: InStatement[], mode?: "write"): Promise<unknown>;
}

/**
 * 初始化 FTS5 全文检索引擎虚表
 */
export async function initFtsTables(client: FtsConnection): Promise<void> {
  // PostgreSQL projection structure belongs to its canonical schema initializer.
  if (backendFor(client) === "postgresql") return;
  for (const statement of FTS_SCHEMA_STATEMENTS) await client.execute(statement);
}

// Only parameter emission differs for these explicitly authored statements.
// Keep the compiler portable: backup consumers do not load the Node pg Session.
class PostgresqlFtsDialect extends SQLiteSyncDialect {
  override escapeParam(index: number): string { return `$${index + 1}`; }
}
const sqliteDialect = new SQLiteSyncDialect();
const postgresDialect = new PostgresqlFtsDialect();
const statement = (client: object, query: SQL) => {
  const compiled = (backendFor(client) === "postgresql" ? postgresDialect : sqliteDialect).sqlToQuery(query);
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
const eligibleMemory = sql`${memoryRecords.isDeleted} = 0 and ${memoryRecords.content} <> ''`;

/** Rebuild only eligible current sources; caller owns the explicit staging lifecycle. */
export async function rebuildMessageFts(client: FtsConnection): Promise<void> {
  await client.batch([
    "DELETE FROM messages_fts",
    statement(client, sql`insert into messages_fts(id, content)
      select ${messageIdentity}, ${messageVersions.content} from ${messageSources} where ${eligibleMessage}`),
  ], "write");
}

/**
 * 同步消息文本到 FTS5 虚表。迟到或伪造的正文不能覆盖当前事实。
 */
export async function indexMessageFts(
  client: FtsConnection,
  ctx: LocalContext,
  message: { id: string; content: string },
): Promise<void> {
  assertLocalContext(ctx);
  await client.batch([
    statement(client, sql`DELETE FROM messages_fts WHERE id = ${message.id}`),
    statement(client, sql`insert into messages_fts(id, content)
      select ${messageIdentity}, ${messageVersions.content} from ${messageSources}
      where ${eligibleMessage} and ${messageIdentity} = ${message.id} and ${messageVersions.content} = ${message.content}`),
  ], "write");
}

/**
 * 从 FTS5 虚表中清理被删除的消息索引（满足删除即刻零召回要求）
 */
export async function deleteMessageFts(
  client: FtsConnection,
  ctx: LocalContext,
  messageId: string,
): Promise<void> {
  assertLocalContext(ctx);
  await client.execute(statement(client, sql`DELETE FROM messages_fts WHERE id = ${messageId}`));
}

export interface FtsSearchResult {
  readonly id: string;
  readonly score: number;
}

/**
 * 在本地单用户索引中执行 FTS5 全文搜索
 */
export async function searchMessagesFts(
  client: FtsConnection,
  ctx: LocalContext,
  query: string,
  limit: number = 20,
): Promise<FtsSearchResult[]> {
  assertLocalContext(ctx);
  const sanitized = query.replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
  if (!sanitized) return [];

  const match = backendFor(client) === "postgresql"
    ? sql`messages_fts.search_vector @@ plainto_tsquery('simple', ${sanitized})`
    : sql`messages_fts match ${sanitized}`;
  const rank = backendFor(client) === "postgresql"
    ? sql`-ts_rank(messages_fts.search_vector, plainto_tsquery('simple', ${sanitized}))` : sql`rank`;
  const res = await client.execute(statement(client, sql`
    select ${jsonQuote(client, sql`messages_fts.id`)} as encoded_id, ${rank} as score
    from messages_fts
    where ${match} and exists (
      select 1 from ${messageSources} where ${eligibleMessage}
        and ${messageIdentity} = messages_fts.id and ${messageVersions.content} = messages_fts.content
    )
    order by score limit ${limit}
  `));

  return res.rows.map((row) => ({
    // The native text decoder truncates embedded NUL; JSON preserves the complete identity.
    id: JSON.parse(String(row.encoded_id)) as string,
    score: Number(row.score),
  }));
}

/** Only the single call a projection rebuild needs; a Client, a libsql Transaction
 * or any host-owned writer adapter satisfies it. Narrow on purpose so the mobile
 * restore path can rebuild inside its own transaction. */
export interface ProjectionWriter {
  execute(input: InStatement): Promise<unknown>;
}
export type ProjectionClient = FtsConnection | Transaction | ProjectionWriter;

/**
 * Rebuild every search projection from its authoritative rows.
 *
 * Used by snapshot restore passthrough (the FTS tables are deliberately outside
 * the logical-backup scope) and by schema staging. The caller owns the write
 * transaction or staging lifecycle; both deletes are bounded table-wide resets,
 * so an empty projection still ends in a well-formed FTS5 state.
 */
export async function rebuildSearchProjections(client: ProjectionClient): Promise<void> {
  // Statement order matters: clear, re-index messages, clear, re-index memories.
  for (const entry of [
    statement(client, sql`delete from messages_fts`),
    statement(client, sql`insert into messages_fts(id, content)
      select ${messageIdentity}, ${messageVersions.content} from ${messageSources} where ${eligibleMessage}`),
    statement(client, sql`delete from memories_fts`),
    statement(client, sql`insert into memories_fts(id, content)
      select ${memoryRecords.id}, ${memoryRecords.content} from ${memoryRecords} where ${eligibleMemory}`),
  ]) await (client as ProjectionWriter).execute(entry);
}

/**
 * 同步记忆内容到 memories_fts 虚表（先清理旧索引再插入）
 */
export async function indexMemoryFts(
  client: FtsConnection,
  ctx: LocalContext,
  memory: { id: string; content: string },
): Promise<void> {
  assertLocalContext(ctx);
  await client.batch([
    statement(client, sql`DELETE FROM memories_fts WHERE id = ${memory.id}`),
    // Only an existing, live fact can supply the projection's exact current body.
    statement(client, sql`INSERT INTO memories_fts(id, content)
      SELECT ${memoryRecords.id}, ${memoryRecords.content} FROM ${memoryRecords}
      WHERE ${eligibleMemory} AND ${memoryRecords.id} = ${memory.id} AND ${memoryRecords.content} = ${memory.content}`),
  ], "write");
}

/**
 * 从 memories_fts 虚表中清理被删除记忆的索引（删除即刻零召回）
 */
export async function deleteMemoryFts(
  client: FtsConnection,
  ctx: LocalContext,
  memoryId: string,
): Promise<void> {
  assertLocalContext(ctx);
  await client.execute(statement(client, sql`DELETE FROM memories_fts WHERE id = ${memoryId}`));
}

/**
 * 在本地单用户索引中对记忆执行 FTS5 全文搜索
 */
export async function searchMemoriesFts(
  client: FtsConnection,
  ctx: LocalContext,
  query: string,
  limit: number = 20,
): Promise<FtsSearchResult[]> {
  assertLocalContext(ctx);
  const sanitized = query.replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
  if (!sanitized) return [];

  const match = backendFor(client) === "postgresql"
    ? sql`memories_fts.search_vector @@ plainto_tsquery('simple', ${sanitized})`
    : sql`memories_fts match ${sanitized}`;
  const rank = backendFor(client) === "postgresql"
    ? sql`-ts_rank(memories_fts.search_vector, plainto_tsquery('simple', ${sanitized}))` : sql`rank`;
  const res = await client.execute(statement(client, sql`
    SELECT ${jsonQuote(client, sql`memories_fts.id`)} AS encoded_id, ${rank} AS score
    FROM memories_fts
    WHERE ${match} AND EXISTS (
      SELECT 1 FROM ${memoryRecords} WHERE ${eligibleMemory}
        AND ${memoryRecords.id} = memories_fts.id AND ${memoryRecords.content} = memories_fts.content
    )
    ORDER BY score LIMIT ${limit}
  `));

  return res.rows.map((row) => ({
    id: JSON.parse(String(row.encoded_id)) as string,
    score: Number(row.score),
  }));
}
