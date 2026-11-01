import { and, desc, eq, inArray, isNull, lt, notLike, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { AervoxDatabase } from "../../client.js";
import { messages, messageVersions, sessions, turns, turnStreamEvents } from "@aervox/schema";
import { assertConversationExecutionPolicy } from "../../conversation-execution-policy.js";
import { derivableConversationTurn } from "./conversation/source-visibility.js";
import type { LocalContext } from "../../local-context.js";
import type { SessionHistoryMessage } from "../types/index.js";

const MAX_HISTORY_TURNS = 20;
const MAX_HISTORY_CHARACTERS = 32_000;

type Reader = Pick<AervoxDatabase, "select">;
type Version = { id: string; turnId: string; messageId: string | null; role: string; version: number; content: string; isRedacted: number; firstVersion: number };
type Event = { turnId: string; attemptId: string | null; sequence: number; eventType: string; safetyDecision: string | null; data: unknown };
type Identity = { id: string; role: string; currentVersionId: string | null; deleted: number };
type Source = { turnId: string; versionId: string; messageId: string | null; requestHash: string | null; isRedacted: number };
const durableSource = (source: Source): boolean => source.messageId === source.versionId
  && !!source.requestHash && /^turn-intent-v1:[a-f0-9]{64}$/.test(source.requestHash);
const versionOrder = alias(messageVersions, "history_version_order");
const parse = <T>(value: string): T => JSON.parse(value) as T;
function payload(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Model-context projection, bounded by recent completed Turns and complete-pair
 * character budget. New accepted dialogue reads durable MessageVersion bodies;
 * legacy unlinked sources retain their existing approved online-event projection.
 * One read snapshot keeps source qualification and current pointers consistent.
 */
export async function readSessionHistory(
  db: AervoxDatabase,
  _ctx: LocalContext,
  input: { sessionId: string; beforeTurnId: string },
): Promise<SessionHistoryMessage[]> {
  return db.transaction(tx => readHistorySnapshot(tx, input));
}

async function readHistorySnapshot(db: Reader, input: { sessionId: string; beforeTurnId: string }): Promise<SessionHistoryMessage[]> {
  const [current] = await db.select({
    position: sql<number>`rowid`,
    idempotencyKey: sql<string>`json_quote(${turns.idempotencyKey})`.mapWith(parse<string>),
    executionPolicy: sql<string>`json_quote(${turns.executionPolicy})`.mapWith(parse<string>),
  }).from(turns).where(and(eq(turns.id, input.beforeTurnId), eq(turns.sessionId, input.sessionId)));
  if (!current || current.idempotencyKey.startsWith("subagent:")) return [];
  assertConversationExecutionPolicy(current.executionPolicy);
  const [session] = await db.select({ policy: sql<string>`json_quote(${sessions.executionPolicy})`.mapWith(parse<string>) })
    .from(sessions).where(eq(sessions.id, input.sessionId));
  if (!session || session.policy !== current.executionPolicy) throw new Error("conversation_execution_policy_mismatch");

  // Preserve insertion order and the existing 20-completed-Turn candidate window.
  const previous = await db.select({ id: sql<string>`json_quote(${turns.id})`.mapWith(parse<string>) }).from(turns).where(and(
    eq(turns.sessionId, input.sessionId), eq(turns.executionPolicy, current.executionPolicy), eq(turns.status, "Completed"),
    notLike(turns.idempotencyKey, "subagent:%"), lt(sql`rowid`, current.position),
  )).orderBy(desc(sql`rowid`)).limit(MAX_HISTORY_TURNS);
  if (!previous.length) return [];
  const turnIds = previous.map(turn => turn.id);
  const sources = await db.select({ source: sql<string>`json_object(
    'turnId', ${turns.id}, 'requestHash', ${turns.requestHash}, 'versionId', ${messageVersions.id},
    'messageId', ${messageVersions.messageId}, 'isRedacted', ${messageVersions.isRedacted}
  )`.mapWith(parse<Source>) }).from(turns)
    .innerJoin(messageVersions, and(eq(messageVersions.turnId, turns.id), eq(messageVersions.role, "user"), eq(messageVersions.version, 1)))
    .where(and(inArray(turns.id, turnIds), derivableConversationTurn(turns.id)));
  const sourceByTurn = new Map(sources.map(({ source }) => [source.turnId, source]));
  const durableTurnIds = sources.filter(({ source }) => durableSource(source)).map(({ source }) => source.turnId);
  const legacyTurnIds = sources.filter(({ source }) => !durableSource(source)).map(({ source }) => source.turnId);
  // Durable bodies no longer depend on replay rows. Keep the same event-level
  // withdrawal gate, but project at most one unsafe identity per candidate Turn
  // instead of copying every streaming delta through a bounded native cursor.
  const unsafeDurableTurnIds = new Set(durableTurnIds.length ? (await db.select({
    turnId: sql<string>`json_quote(${turnStreamEvents.turnId})`.mapWith(parse<string>),
  }).from(turnStreamEvents).where(and(inArray(turnStreamEvents.turnId, durableTurnIds),
    inArray(turnStreamEvents.eventType, ["message", "delta", "done", "redacted"]),
    or(eq(turnStreamEvents.eventType, "redacted"), inArray(turnStreamEvents.safetyDecision, ["blocked", "redacted"])),
  )).groupBy(turnStreamEvents.turnId).limit(MAX_HISTORY_TURNS)).map(row => row.turnId) : []);
  // Legacy, unlinked sources still need their approved final-attempt event
  // projection. Do not change their qualification or substitute a durable body.
  const events = legacyTurnIds.length ? (await db.select({ event: sql<string>`json_object(
    'turnId', ${turnStreamEvents.turnId}, 'attemptId', ${turnStreamEvents.attemptId}, 'sequence', ${turnStreamEvents.sequence},
    'eventType', ${turnStreamEvents.eventType}, 'safetyDecision', ${turnStreamEvents.safetyDecision}, 'data', json(${turnStreamEvents.data})
  )`.mapWith(parse<Event>) }).from(turnStreamEvents).where(and(inArray(turnStreamEvents.turnId, legacyTurnIds),
    inArray(turnStreamEvents.eventType, ["message", "delta", "done", "redacted"]))).orderBy(turnStreamEvents.sequence)).map(row => row.event) : [];
  const eventsByTurn = new Map<string, Event[]>();
  for (const event of events) {
    const rows = eventsByTurn.get(event.turnId) ?? []; rows.push(event); eventsByTurn.set(event.turnId, rows);
  }
  const result: SessionHistoryMessage[][] = [];
  let remaining = MAX_HISTORY_CHARACTERS;
  for (const turn of previous) {
    const source = sourceByTurn.get(turn.id);
    if (!source || source.isRedacted !== 0) continue;
    const turnEvents = eventsByTurn.get(turn.id) ?? [];
    if (unsafeDurableTurnIds.has(turn.id)
      || turnEvents.some(event => event.eventType === "redacted" || event.safetyDecision === "blocked" || event.safetyDecision === "redacted")) continue;
    // Read bodies one Turn at a time in the same snapshot. Individually legal
    // native Turns can exceed a CursorWindow when twenty are copied together.
    // Select latest rows before visibility; never fall back from a missing or
    // redacted current identity to an older version or transport copy.
    const versions = (await db.select({ version: sql<string>`json_object(
      'id', ${messageVersions.id}, 'turnId', ${messageVersions.turnId}, 'messageId', ${messageVersions.messageId},
      'role', ${messageVersions.role}, 'version', ${messageVersions.version}, 'content', ${messageVersions.content}, 'isRedacted', ${messageVersions.isRedacted},
      'firstVersion', (select min(${versionOrder.version}) from ${messageVersions} as history_version_order
        where ${versionOrder.turnId} = ${messageVersions.turnId} and ${versionOrder.messageId} = ${messageVersions.messageId})
    )`.mapWith(parse<Version>) }).from(messageVersions).where(and(eq(messageVersions.turnId, turn.id),
      inArray(messageVersions.role, ["user", "assistant"]), isNull(messageVersions.supersededAt)))
      .orderBy(desc(messageVersions.version))).map(row => row.version);
    const identityIds = new Set(versions.map(version => version.messageId ?? version.id));
    for (const event of turnEvents) {
      const messageId = payload(event.data).messageId;
      if (typeof messageId === "string") identityIds.add(messageId);
    }
    const identities = identityIds.size ? (await db.select({ identity: sql<string>`json_object(
      'id', ${messages.id}, 'role', ${messages.role}, 'currentVersionId', ${messages.currentVersionId}, 'deleted', ${messages.deletedAt} is not null
    )`.mapWith(parse<Identity>) }).from(messages).where(and(eq(messages.sessionId, input.sessionId), inArray(messages.id, [...identityIds])))).map(row => row.identity) : [];
    const identityById = new Map(identities.map(identity => [identity.id, identity]));
    const currentVersion = (version: Version): boolean => {
      const identity = identityById.get(version.messageId ?? version.id);
      return version.isRedacted === 0 && !identity?.deleted && (!version.messageId || !!identity)
        && (!identity || (identity.role === version.role && (version.messageId
          ? identity.currentVersionId === version.id : !identity.currentVersionId || identity.currentVersionId === version.id)));
    };
    const user = versions.find(version => version.role === "user");
    if (!user || !currentVersion(user) || !user.content.trim()) continue;
    const durable = durableSource(source);
    let assistantBodies: string[];
    if (durable) {
      const assistants = versions.filter(version => version.role === "assistant");
      // Keep multiple assistant identities in their original creation order,
      // independent of later user edits advancing one identity's version number.
      if (!assistants.length || assistants.some(version => !version.messageId || !currentVersion(version))) continue;
      assistants.sort((a, b) => a.firstVersion - b.firstVersion);
      assistantBodies = assistants.map(version => version.content).filter(content => content.trim());
    } else {
      const done = turnEvents.findLast(event => event.eventType === "done");
      if (!done || done.safetyDecision !== "approved" || payload(done.data).status !== "Completed" || payload(done.data).isComplete !== true) continue;
      const messageId = payload(done.data).messageId;
      if (typeof messageId !== "string" || identityById.get(messageId)?.deleted) continue;
      const deltas = turnEvents.filter(event => event.eventType === "delta" && event.sequence < done.sequence
        && event.attemptId === done.attemptId && payload(event.data).messageId === messageId);
      if (!deltas.length || deltas.some(event => event.safetyDecision !== "approved")) continue;
      assistantBodies = [deltas.map(event => payload(event.data).text).filter((text): text is string => typeof text === "string").join("")];
    }
    if (!assistantBodies.some(content => content.trim())) continue;
    const size = user.content.length + assistantBodies.reduce((sum, content) => sum + content.length, 0);
    if (size > remaining) break;
    remaining -= size;
    result.push([{ role: "user", content: user.content }, ...assistantBodies.map(content => ({ role: "assistant" as const, content }))]);
  }
  return result.reverse().flat();
}
