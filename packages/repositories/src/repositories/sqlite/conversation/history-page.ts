import { and, desc, eq, lt, notLike, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { messages, messageVersions, sessions, turns, turnStreamEvents } from "@aervox/schema";
import type { SessionHistoryPage, SessionHistoryTurn } from "@aervox/contracts";
import type { AervoxDatabase } from "../../../client.js";
import { assertConversationExecutionPolicy, conversationDispatchTarget } from "../../../conversation-execution-policy.js";
import { disclosableTurn } from "./source-visibility.js";

export type SessionHistoryReadCode = "INVALID_HISTORY_QUERY" | "SESSION_NOT_FOUND" | "HISTORY_CURSOR_EXPIRED" | "HISTORY_ITEM_TOO_LARGE";
export class SessionHistoryReadError extends Error {
  constructor(readonly code: SessionHistoryReadCode) { super(code); }
}
const fail = (code: SessionHistoryReadCode): never => { throw new SessionHistoryReadError(code); };
const MAX_MESSAGES = 100;
const MAX_TURN_BYTES = 256 * 1024;
const MAX_PAGE_BYTES = 512 * 1024;
const ID_BYTES = 4096;
type Cursor = { v: 1; sessionId: string; beforeTurnId: string };
const encode = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");
function decode(token: string, sessionId: string): Cursor {
  try {
    if (token.length > 16_384 || !/^[A-Za-z0-9_-]+$/.test(token)) return fail("INVALID_HISTORY_QUERY");
    const text = Buffer.from(token, "base64url").toString("utf8");
    if (Buffer.from(text).toString("base64url") !== token) return fail("INVALID_HISTORY_QUERY");
    const parsed = JSON.parse(text) as Cursor;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).sort().join(",") !== "beforeTurnId,sessionId,v"
      || parsed.v !== 1 || parsed.sessionId !== sessionId || typeof parsed.beforeTurnId !== "string"
      || !parsed.beforeTurnId || Buffer.byteLength(parsed.beforeTurnId) > ID_BYTES || encode(parsed) !== token) return fail("INVALID_HISTORY_QUERY");
    return parsed;
  } catch { return fail("INVALID_HISTORY_QUERY"); }
}
const parse = <T>(value: string): T => JSON.parse(value) as T;
const bodyBytes = (column: SQL) => sql<number>`coalesce(length(cast(${column} as blob)), 0)`;
const pointerVersion = alias(messageVersions, "history_pointer_version");
const firstUser = alias(messageVersions, "history_first_user");
const inputIdentity = alias(messages, "history_input_identity");
// Display is distinct from derivation: incomplete and extraction-redacted history
// remains addressable, but redacted bodies are withheld until provenance separates
// safe fixed responses from withdrawal. Missing current pointers never fall back.
const currentMessage = sql`(
  (${messageVersions.messageId} is not null and exists (
    select 1 from ${messages} where ${messages.id} = ${messageVersions.messageId}
      and ${messages.sessionId} = ${turns.sessionId} and ${messages.role} = ${messageVersions.role}
      and ${messages.deletedAt} is null and ${messages.currentVersionId} = ${messageVersions.id}
  )) or (${messageVersions.messageId} is null and not exists (
    select 1 from ${messages} where ${messages.id} = ${messageVersions.id} and (
      ${messages.deletedAt} is not null or ${messages.sessionId} <> ${turns.sessionId} or ${messages.role} <> ${messageVersions.role}
      or (${messages.currentVersionId} is not null and ${messages.currentVersionId} <> ${messageVersions.id})
    )
  ))
)`;
const validInputPointer = sql`not exists (
  select 1 from ${messageVersions} as history_first_user
  where ${firstUser.turnId} = ${turns.id} and ${firstUser.role} = 'user' and ${firstUser.version} = 1
    and ${firstUser.messageId} is not null and not exists (
      select 1 from ${messages} as history_input_identity inner join ${messageVersions} as history_pointer_version
        on ${pointerVersion.id} = ${inputIdentity.currentVersionId} and ${pointerVersion.messageId} = ${inputIdentity.id}
      where ${inputIdentity.id} = ${firstUser.messageId} and ${inputIdentity.sessionId} = ${turns.sessionId}
        and ${inputIdentity.role} = 'user' and ${inputIdentity.deletedAt} is null
        and ${pointerVersion.turnId} = ${turns.id} and ${pointerVersion.role} = 'user' and ${pointerVersion.supersededAt} is null
    )
)`;
const eligibleVersion = sql`${messageVersions.supersededAt} is null and ${messageVersions.role} in ('user', 'assistant', 'system') and ${currentMessage}`;
// Older withdrawals may predate the writer's durable version marker. Only the
// marker's type is read; transport payloads never become history content.
const withheld = sql`(${messageVersions.isRedacted} <> 0 or exists (
  select 1 from ${turnStreamEvents} where ${turnStreamEvents.turnId} = ${turns.id} and ${turnStreamEvents.eventType} = 'redacted'
))`;
const messageProjection = sql<string>`json_object(
  'messageId', ${messageVersions.messageId}, 'versionId', ${messageVersions.id}, 'version', ${messageVersions.version},
  'role', ${messageVersions.role}, 'contentKind', case when ${messageVersions.role} = 'user' then 'accepted_input' else 'message' end,
  'content', case when not ${withheld} then ${messageVersions.content} else null end,
  'visibility', case when not ${withheld} then 'available' else 'withheld' end,
  'legacy', json(case when ${messageVersions.messageId} is null then 'true' else 'false' end),
  'readOnly', json(case when ${messageVersions.messageId} is null or ${withheld} then 'true' else 'false' end),
  'createdAt', ${messageVersions.createdAt}
)`;
type Candidate = { id: string | null; status: string | null; createdAt: string | null };

/** One owner-authorized read snapshot, bounded candidates; never scans to fill hidden rows. */
export async function readSessionHistoryPage(db: AervoxDatabase, input: {
  sessionId: string; limit?: number; cursor?: string;
}): Promise<SessionHistoryPage> {
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !input.sessionId || Buffer.byteLength(input.sessionId) > ID_BYTES) fail("INVALID_HISTORY_QUERY");
  const cursor = input.cursor === undefined ? undefined : decode(input.cursor, input.sessionId);
  return db.transaction(async tx => {
    const [session] = await tx.select({ policy: sql<string>`json_quote(${sessions.executionPolicy})`.mapWith(parse<string>) })
      .from(sessions).where(eq(sessions.id, input.sessionId));
    if (!session) return fail("SESSION_NOT_FOUND");
    assertConversationExecutionPolicy(session.policy);
    let before: number | undefined;
    if (cursor) {
      const [anchor] = await tx.select({ position: sql<number>`rowid` }).from(turns).where(and(
        eq(turns.id, cursor.beforeTurnId), eq(turns.sessionId, input.sessionId), eq(turns.executionPolicy, session.policy),
        eq(turns.dispatchTarget, conversationDispatchTarget(session.policy)), notLike(turns.idempotencyKey, "subagent:%"),
      ));
      if (!anchor || !Number.isSafeInteger(anchor.position)) return fail("HISTORY_CURSOR_EXPIRED");
      before = anchor.position;
    }
    const candidates = (await tx.select({ value: sql<string>`json_object(
      'id', case when length(cast(${turns.id} as blob)) <= ${ID_BYTES} then ${turns.id} else null end,
      'status', case when length(cast(${turns.status} as blob)) between 1 and 64 then ${turns.status} else null end,
      'createdAt', case when length(cast(${turns.createdAt} as blob)) <= 128 then ${turns.createdAt} else null end
    )`.mapWith(parse<Candidate>) }).from(turns).where(and(
      eq(turns.sessionId, input.sessionId), eq(turns.executionPolicy, session.policy),
      eq(turns.dispatchTarget, conversationDispatchTarget(session.policy)), notLike(turns.idempotencyKey, "subagent:%"),
      before === undefined ? undefined : lt(sql`rowid`, before),
    )).orderBy(desc(sql`rowid`)).limit(limit + 1)).map(row => row.value);
    const scanned = candidates.slice(0, limit);
    const last = scanned.at(-1);
    const nextCursor = candidates.length > limit && last?.id
      ? encode({ v: 1, sessionId: input.sessionId, beforeTurnId: last.id }) : null;
    if (nextCursor !== null && nextCursor.length > 16_384) return fail("HISTORY_ITEM_TOO_LARGE");
    const items: SessionHistoryTurn[] = [];
    let pageBytes = Buffer.byteLength(JSON.stringify({ sessionId: input.sessionId, items: [], nextCursor }));
    for (const candidate of scanned) {
      if (candidate.id === null || candidate.status === null || candidate.createdAt === null) return fail("HISTORY_ITEM_TOO_LARGE");
      const [source] = await tx.select({ present: sql<number>`1` }).from(turns).where(and(
        eq(turns.id, candidate.id), disclosableTurn(candidate.id), validInputPointer,
      )).limit(1);
      if (!source) continue;
      const bytes = sql<number>`coalesce(sum(
        case when not ${withheld} then ${bodyBytes(sql`${messageVersions.content}`)} else 0 end
        + ${bodyBytes(sql`${messageVersions.id}`)} + ${bodyBytes(sql`${messageVersions.messageId}`)}
        + ${bodyBytes(sql`${messageVersions.role}`)} + ${bodyBytes(sql`${messageVersions.createdAt}`)}
      ), 0)`;
      const [size] = await tx.select({ count: sql<number>`count(*)`, bytes }).from(messageVersions)
        .innerJoin(turns, eq(turns.id, messageVersions.turnId)).where(and(eq(turns.id, candidate.id), eligibleVersion));
      if (!size || size.count > MAX_MESSAGES || size.bytes > MAX_TURN_BYTES) return fail("HISTORY_ITEM_TOO_LARGE");
      const [projected] = await tx.select({ bytes: sql<number>`coalesce(sum(length(cast(${messageProjection} as blob))), 0)` })
        .from(messageVersions).innerJoin(turns, eq(turns.id, messageVersions.turnId)).where(and(eq(turns.id, candidate.id), eligibleVersion));
      const metadata = { turnId: candidate.id, status: candidate.status, isComplete: candidate.status === "Completed", createdAt: candidate.createdAt };
      const turnBytes = Buffer.byteLength(JSON.stringify({ ...metadata, messages: [] })) + (projected?.bytes ?? 0) + Math.max(0, size.count - 1);
      if (turnBytes > MAX_TURN_BYTES) return fail("HISTORY_ITEM_TOO_LARGE");
      pageBytes += turnBytes + (items.length ? 1 : 0);
      if (pageBytes > MAX_PAGE_BYTES) return fail("HISTORY_ITEM_TOO_LARGE");
      const messageRows = await tx.select({ value: messageProjection.mapWith(parse<SessionHistoryTurn["messages"][number]>) }).from(messageVersions)
        .innerJoin(turns, eq(turns.id, messageVersions.turnId)).where(and(eq(turns.id, candidate.id), eligibleVersion))
        .orderBy(sql`(select min(sort_version.version) from message_versions sort_version
          where sort_version.turn_id = ${messageVersions.turnId} and (sort_version.message_id = ${messageVersions.messageId}
            or (${messageVersions.messageId} is null and sort_version.id = ${messageVersions.id})))`)
        .limit(MAX_MESSAGES);
      if (messageRows.length) items.push({ turnId: candidate.id, status: candidate.status, isComplete: candidate.status === "Completed",
        createdAt: candidate.createdAt, messages: messageRows.map(row => row.value) });
    }
    const result = { sessionId: input.sessionId, items: items.reverse(), nextCursor };
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_PAGE_BYTES) return fail("HISTORY_ITEM_TOO_LARGE");
    return result;
  });
}
