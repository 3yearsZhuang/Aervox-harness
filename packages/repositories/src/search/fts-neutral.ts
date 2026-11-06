/**
 * Aervox｜思隅 @aervox/repositories — 双后端全文检索投影
 *
 * 为会话消息与记忆提供无外置搜索引擎依赖的本地全文检索能力。
 */
import type { InStatement, InValue } from "@libsql/client";
import { sql, type SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { messages, messageVersions, memoryRecords, turns } from "@aervox/schema";
import { derivableConversationTurn } from "../repositories/sqlite/conversation/source-visibility.js";
import { assertLocalContext, type LocalContext } from "../local-context.js";
import { FTS_SCHEMA_STATEMENTS } from "../schema/fts-definition.js";
import { unverifiedAttachmentMemory, unverifiedAttachmentTurn, turnReceiptEvidence, admitsTurnReceipt,
  type TurnReceiptEvidence } from "../attachment-source-admission.js";
import type { ConversationCryptoPort } from "../conversation-host-port.js";
import { backendFor } from "../database-backend.js";
import { jsonQuote } from "../sql-dialect.js";

/** Narrow writer/read port so portable restore can keep its own transaction. */
export interface ProjectionWriter {
  execute(input: InStatement): Promise<{ rows: readonly Record<string, unknown>[] }>;
}
interface FtsTransaction extends ProjectionWriter {
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): void | Promise<void>;
  readonly closed: boolean;
}
/** Prepared native writer port, shared by SQLite and PostgreSQL transports. */
export interface FtsConnection extends ProjectionWriter {
  transaction(mode: "write"): Promise<FtsTransaction>;
}
export type ProjectionClient = FtsConnection | ProjectionWriter;

type ReceiptCrypto = Pick<ConversationCryptoPort, "sha256Utf8">;
const REBUILD_PAGE_ROWS = 128;
const MAX_FTS_SEARCH_ROWS = 500;
const searchLimit = (limit: number): number => {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("invalid_fts_search_limit");
  return Math.min(limit, MAX_FTS_SEARCH_ROWS);
};
const receiptAdmitted = (encoded: unknown, crypto?: ReceiptCrypto): boolean => {
  if (encoded === null || encoded === undefined) return admitsTurnReceipt(null, crypto);
  try { return admitsTurnReceipt(JSON.parse(String(encoded)) as TurnReceiptEvidence, crypto); }
  catch { return false; }
};
// PostgreSQL writers use READ COMMITTED: the INSERT must see the same evidence
// whose digest was just checked, rather than a different statement snapshot.
const receiptUnchanged = (db: object, turnId: Parameters<typeof turnReceiptEvidence>[1], encoded: unknown): SQL =>
  encoded === null || encoded === undefined
    ? sql`${turnReceiptEvidence(db, turnId)} is null`
    : sql`${turnReceiptEvidence(db, turnId)} = ${String(encoded)}`;
const decodedId = (value: unknown): string => JSON.parse(String(value)) as string;

/**
 * 初始化 FTS5 全文检索引擎虚表
 */
export async function initFtsTables(client: ProjectionWriter): Promise<void> {
  // PostgreSQL projection structure belongs to its canonical schema initializer.
  if (backendFor(client) === "postgresql") return;
  for (const statement of FTS_SCHEMA_STATEMENTS) await client.execute(statement);
}

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
const eligibleMessage = (db: object) => sql`(
  ${derivableConversationTurn(db, turns.id)}
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
const liveMemoryIndex = sql`exists (select 1 from ${memoryRecords}
  where ${memoryRecords.id} = memories_fts.id and ${eligibleMemory}
    and ${memoryRecords.content} = memories_fts.content)`;

/** Caller owns the writer snapshot. Read only bounded identities before each
 * receipt check; INSERT SELECT keeps authoritative body text inside the database. */
async function rebuildMessages(writer: ProjectionWriter, crypto?: ReceiptCrypto): Promise<void> {
  await writer.execute("DELETE FROM messages_fts");
  let after: string | undefined;
  for (;;) {
    const page = await writer.execute(statement(writer, sql`select ${jsonQuote(writer, messageVersions.id)} as version_id,
      ${jsonQuote(writer, messageVersions.turnId)} as source_turn_id
      from ${messageSources} where ${eligibleMessage(writer)}
        ${after === undefined ? sql`` : sql`and ${messageVersions.id} > ${after}`}
      order by ${messageVersions.id} limit ${REBUILD_PAGE_ROWS}`));
    if (page.rows.length === 0) return;
    for (const row of page.rows) {
      const versionId = decodedId(row.version_id);
      const evidence = await writer.execute(statement(writer, sql`select ${turnReceiptEvidence(writer, decodedId(row.source_turn_id))} as evidence`));
      if (receiptAdmitted(evidence.rows[0]?.evidence, crypto)) {
        await writer.execute(statement(writer, sql`insert into messages_fts(id, content)
          select ${messageIdentity}, ${messageVersions.content} from ${messageSources}
          where ${eligibleMessage(writer)} and ${messageVersions.id} = ${versionId}
            and ${receiptUnchanged(writer, messageVersions.turnId, evidence.rows[0]?.evidence)}`));
      }
      after = versionId;
    }
  }
}

async function inWriter<T>(client: FtsConnection, operation: (writer: FtsTransaction) => Promise<T>): Promise<T> {
  const writer = await client.transaction("write");
  try { const result = await operation(writer); await writer.commit(); return result; }
  catch (error) { if (!writer.closed) await writer.rollback(); throw error; }
  finally { await writer.close(); }
}

/** Rebuild eligible current sources in one explicit writer snapshot. */
export async function rebuildMessageFts(client: FtsConnection, crypto?: ReceiptCrypto): Promise<void> {
  await inWriter(client, writer => rebuildMessages(writer, crypto));
}

/** A delayed indexer cannot replace current content or bypass a changed receipt. */
export async function indexMessageFts(
  client: FtsConnection, ctx: LocalContext, message: { id: string; content: string }, crypto?: ReceiptCrypto,
): Promise<void> {
  assertLocalContext(ctx);
  await inWriter(client, async writer => {
    await writer.execute(statement(writer, sql`DELETE FROM messages_fts WHERE id = ${message.id}`));
    const matches = await writer.execute(statement(writer, sql`select ${turnReceiptEvidence(writer, messageVersions.turnId)} as evidence
      from ${messageSources} where ${eligibleMessage(writer)} and ${messageIdentity} = ${message.id}
        and ${messageVersions.content} = ${message.content} limit 1`));
    if (!matches.rows.length || !receiptAdmitted(matches.rows[0]?.evidence, crypto)) return;
    await writer.execute(statement(writer, sql`insert into messages_fts(id, content)
      select ${messageIdentity}, ${messageVersions.content} from ${messageSources}
      where ${eligibleMessage(writer)} and ${messageIdentity} = ${message.id} and ${messageVersions.content} = ${message.content}
        and ${receiptUnchanged(writer, messageVersions.turnId, matches.rows[0]?.evidence)}`));
  });
}

/**
 * 从 FTS5 虚表中清理被删除的消息索引（满足删除即刻零召回要求）
 */
export async function deleteMessageFts(
  client: ProjectionWriter,
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
  client: ProjectionWriter, ctx: LocalContext, query: string, limit: number = 20, crypto?: ReceiptCrypto,
): Promise<FtsSearchResult[]> {
  assertLocalContext(ctx);
  const boundedLimit = searchLimit(limit);
  const sanitized = query.replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
  if (!sanitized) return [];
  const match = backendFor(client) === "postgresql"
    ? sql`messages_fts.search_vector @@ plainto_tsquery('simple', ${sanitized})` : sql`messages_fts match ${sanitized}`;
  const rank = backendFor(client) === "postgresql"
    ? sql`-ts_rank(messages_fts.search_vector, plainto_tsquery('simple', ${sanitized}))` : sql`rank`;
  const res = await client.execute(statement(client, sql`
    select ${jsonQuote(client, sql`messages_fts.id`)} as encoded_id, ${rank} as score from messages_fts
    where ${match} and exists (
      select 1 from ${messageSources} where ${eligibleMessage(client)}
        and ${messageIdentity} = messages_fts.id and ${messageVersions.content} = messages_fts.content
    ) order by score limit ${boundedLimit}`));
  const results: FtsSearchResult[] = [];
  for (const row of res.rows) {
    const id = decodedId(row.encoded_id);
    // Re-read current eligibility and its bounded receipt in one statement;
    // ranked IDs and a previously computed hash are never admission authority.
    const current = await client.execute(statement(client, sql`select ${turnReceiptEvidence(client, messageVersions.turnId)} as evidence
      from ${messageSources} where ${eligibleMessage(client)} and ${messageIdentity} = ${id}
        and exists (select 1 from messages_fts where messages_fts.id = ${id}
          and messages_fts.content = ${messageVersions.content}) limit 1`));
    if (current.rows.length && receiptAdmitted(current.rows[0]?.evidence, crypto)) results.push({id, score: Number(row.score)});
  }
  return results;
}

/**
 * Rebuild every search projection from its authoritative rows.
 *
 * Used by snapshot restore passthrough (the FTS tables are deliberately outside
 * the logical-backup scope) and by schema staging. The caller owns the write
 * transaction or staging lifecycle; both deletes are bounded table-wide resets,
 * so an empty projection still ends in a well-formed FTS5 state.
 */
export async function rebuildSearchProjections(client: ProjectionClient, crypto?: ReceiptCrypto): Promise<void> {
  const rebuild = async (writer: ProjectionWriter) => {
    await rebuildMessages(writer, crypto);
    await writer.execute("DELETE FROM memories_fts");
    let after: string | undefined;
    for (;;) {
      const page = await writer.execute(statement(writer, sql`select ${jsonQuote(writer, memoryRecords.id)} as encoded_id,
        ${turnReceiptEvidence(writer, memoryRecords.sourceTurnId)} as evidence
        from ${memoryRecords} where ${eligibleMemory}
          and ${unverifiedAttachmentTurn(writer, memoryRecords.sourceTurnId)} = 0
          ${after === undefined ? sql`` : sql`and ${memoryRecords.id} > ${after}`}
        order by ${memoryRecords.id} limit 1`));
      if (page.rows.length === 0) return;
      const row = page.rows[0]!;
      const id = decodedId(row.encoded_id);
      if (receiptAdmitted(row.evidence, crypto)) {
        await writer.execute(statement(writer, sql`insert into memories_fts(id, content)
          select ${memoryRecords.id}, ${memoryRecords.content} from ${memoryRecords}
          where ${memoryRecords.id} = ${id} and ${eligibleMemory}
            and ${unverifiedAttachmentTurn(writer, memoryRecords.sourceTurnId)} = 0
            and ${receiptUnchanged(writer, memoryRecords.sourceTurnId, row.evidence)}`));
      }
      after = id;
    }
  };
  // A supplied Transaction/ProjectionWriter already owns its write lifecycle;
  // a root Client obtains its own writer instead of opening nested transactions.
  if ("transaction" in client) await inWriter(client as FtsConnection, rebuild);
  else await rebuild(client);
}

/**
 * 同步记忆内容到 memories_fts 虚表（先清理旧索引再插入）
 */
export async function indexMemoryFts(
  client: FtsConnection, ctx: LocalContext, memory: { id: string; content: string }, crypto?: ReceiptCrypto,
): Promise<void> {
  assertLocalContext(ctx);
  await inWriter(client, async writer => {
    await writer.execute(statement(writer, sql`DELETE FROM memories_fts WHERE id = ${memory.id}`));
    const source = await writer.execute(statement(writer, sql`select ${turnReceiptEvidence(writer, memoryRecords.sourceTurnId)} as evidence
      from ${memoryRecords} where ${memoryRecords.id} = ${memory.id} and ${eligibleMemory}
        and ${memoryRecords.content} = ${memory.content} and ${unverifiedAttachmentMemory(writer, memory.id)} = 0 limit 1`));
    if (!source.rows.length || !receiptAdmitted(source.rows[0]?.evidence, crypto)) return;
    await writer.execute(statement(writer, sql`INSERT INTO memories_fts(id, content)
      SELECT ${memoryRecords.id}, ${memoryRecords.content} FROM ${memoryRecords}
      WHERE ${memoryRecords.id} = ${memory.id} and ${eligibleMemory}
        and ${memoryRecords.content} = ${memory.content} and ${unverifiedAttachmentMemory(writer, memory.id)} = 0
        and ${receiptUnchanged(writer, memoryRecords.sourceTurnId, source.rows[0]?.evidence)}`));
  });
}

/**
 * 从 memories_fts 虚表中清理被删除记忆的索引（删除即刻零召回）
 */
export async function deleteMemoryFts(
  client: ProjectionWriter,
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
  client: ProjectionWriter, ctx: LocalContext, query: string, limit: number = 20, crypto?: ReceiptCrypto,
): Promise<FtsSearchResult[]> {
  assertLocalContext(ctx);
  const boundedLimit = searchLimit(limit);
  const sanitized = query.replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
  if (!sanitized) return [];
  const match = backendFor(client) === "postgresql"
    ? sql`memories_fts.search_vector @@ plainto_tsquery('simple', ${sanitized})` : sql`memories_fts match ${sanitized}`;
  const rank = backendFor(client) === "postgresql"
    ? sql`-ts_rank(memories_fts.search_vector, plainto_tsquery('simple', ${sanitized}))` : sql`rank`;
  const res = await client.execute(statement(client, sql`SELECT ${jsonQuote(client, sql`memories_fts.id`)} AS encoded_id, ${rank} AS score
    FROM memories_fts WHERE ${match}
      AND ${liveMemoryIndex}
      AND ${unverifiedAttachmentMemory(client, sql`memories_fts.id`)} = 0 ORDER BY score LIMIT ${boundedLimit}`));
  const results: FtsSearchResult[] = [];
  for (const row of res.rows) {
    const id = decodedId(row.encoded_id);
    const current = await client.execute(statement(client, sql`select ${turnReceiptEvidence(client, memoryRecords.sourceTurnId)} as evidence
      from memories_fts inner join ${memoryRecords} on ${memoryRecords.id} = memories_fts.id
      where memories_fts.id = ${id} and ${liveMemoryIndex}
        and ${unverifiedAttachmentMemory(client, sql`memories_fts.id`)} = 0 limit 1`));
    if (current.rows.length && receiptAdmitted(current.rows[0]?.evidence, crypto)) results.push({id, score: Number(row.score)});
  }
  return results;
}
