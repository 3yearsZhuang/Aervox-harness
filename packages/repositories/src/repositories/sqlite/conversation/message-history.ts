import { and, eq, isNull, lt, gt, sql } from "drizzle-orm";
import { messages, messageVersions, safeSegments, turns, turnStreamEvents, deletionRequests } from "@aervox/schema";
import type { AervoxDatabase } from "../../../client.js";
import { FencingMismatchError } from "../../../errors.js";
import { unverifiedDeletionRequest } from "../privacy-repository.js";
import { disclosableTurn } from "./source-visibility.js";

type Writer = Parameters<Parameters<AervoxDatabase["transaction"]>[0]>[0];

async function bodySource(tx: Writer, turnId: string) {
  const [row] = await tx.select({ source: sql<string>`json_object(
    'sessionId', ${turns.sessionId}, 'requestHash', ${turns.requestHash},
    'versionId', ${messageVersions.id}, 'messageId', ${messageVersions.messageId}, 'isRedacted', ${messageVersions.isRedacted}
  )`.mapWith(value => JSON.parse(value) as { sessionId: string; requestHash: string | null; versionId: string; messageId: string | null; isRedacted: number }) }).from(turns)
    .innerJoin(messageVersions, and(eq(messageVersions.turnId, turns.id), eq(messageVersions.role, "user"), eq(messageVersions.version, 1)))
    .where(and(eq(turns.id, turnId), disclosableTurn(turnId))).limit(1);
  const source = row?.source;
  if (!source) return null;
  if (source.messageId) {
    const [identity] = await tx.select().from(messages).where(and(
      eq(messages.id, source.messageId), eq(messages.sessionId, source.sessionId),
      eq(messages.role, "user"), isNull(messages.deletedAt),
    )).limit(1);
    if (!identity) return null;
  }
  return source;
}

/** A source deleted after a model checkpoint cannot receive another durable body. */
export async function assertConversationBodyWritable(tx: Writer, turnId: string): Promise<void> {
  if (!(await bodySource(tx, turnId))) throw new FencingMismatchError("conversation_source_unavailable");
  const [deletion] = await tx.select({ id: deletionRequests.id }).from(deletionRequests).where(unverifiedDeletionRequest).limit(1);
  if (deletion) throw new FencingMismatchError("deletion_blocked");
}

async function trackedSource(tx: Writer, turnId: string) {
  const source = await bodySource(tx, turnId);
  // Existing unlinked/ imported rows are not migrated from short-lived event copies.
  if (!source || source.messageId !== source.versionId || source.isRedacted !== 0
    || !source.requestHash || !/^turn-intent-v1:[a-f0-9]{64}$/.test(source.requestHash)) return null;
  return source;
}

async function nextVersion(tx: Writer, turnId: string): Promise<number> {
  const [row] = await tx.select({ version: sql<number>`coalesce(max(${messageVersions.version}), 0)` }).from(messageVersions)
    .where(eq(messageVersions.turnId, turnId));
  return row!.version + 1;
}

/** The initial empty version binds the assistant identity to this Turn before it can be deleted. */
export async function initializeAssistantHistory(tx: Writer, turnId: string, data: unknown, sequence: number): Promise<void> {
  if (!(await bodySource(tx, turnId))) throw new FencingMismatchError("conversation_source_unavailable");
  const source = await trackedSource(tx, turnId);
  if (!source) return;
  const event = data as { messageId?: unknown; role?: unknown } | null;
  if (event?.role !== "assistant" || typeof event.messageId !== "string" || !event.messageId) return;
  const [existing] = await tx.select({
    id: sql<string>`json_quote(${messages.id})`.mapWith(value => JSON.parse(value) as string),
    sessionId: sql<string>`json_quote(${messages.sessionId})`.mapWith(value => JSON.parse(value) as string),
    role: sql<string>`json_quote(${messages.role})`.mapWith(value => JSON.parse(value) as string),
    deleted: sql<number>`${messages.deletedAt} is not null`,
  }).from(messages).where(eq(messages.id, event.messageId)).limit(1);
  if (existing) {
    const [binding] = await tx.select({ id: messageVersions.id }).from(messageVersions).where(and(
      eq(messageVersions.turnId, turnId), eq(messageVersions.messageId, existing.id), eq(messageVersions.role, "assistant"),
    )).limit(1);
    if (!binding || existing.sessionId !== source.sessionId || existing.role !== "assistant" || existing.deleted !== 0) {
      throw new FencingMismatchError("conversation_message_identity_conflict");
    }
    return;
  }
  const versionId = `mv_history_${sequence}_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await tx.insert(messages).values({ id: event.messageId, sessionId: source.sessionId,
    role: "assistant", currentVersionId: versionId, createdAt: now });
  await tx.insert(messageVersions).values({ id: versionId, turnId, messageId: event.messageId,
    role: "assistant", version: await nextVersion(tx, turnId), content: "", isRedacted: 0, createdAt: now });
}

/** Persist only the committed, approved visible prefix in the terminal writer transaction. */
export async function publishAssistantHistory(tx: Writer, turnId: string, beforeSequence: number): Promise<void> {
  // Sequence is durable control state even after replay payloads/rows are cleaned.
  await tx.update(turns).set({ lastSequence: sql`max(${turns.lastSequence}, ${beforeSequence})` }).where(eq(turns.id, turnId));
  const source = await trackedSource(tx, turnId);
  if (!source) return;
  const [deletion] = await tx.select({ id: deletionRequests.id }).from(deletionRequests).where(unverifiedDeletionRequest).limit(1);
  if (deletion) return;
  const [redacted] = await tx.select({ id: turnStreamEvents.id }).from(turnStreamEvents).where(and(
    eq(turnStreamEvents.turnId, turnId), eq(turnStreamEvents.eventType, "redacted"), lt(turnStreamEvents.sequence, beforeSequence),
  )).limit(1);
  if (redacted) return;
  const current = await tx.select({
    identityId: sql<string>`json_quote(${messages.id})`.mapWith(value => JSON.parse(value) as string),
    versionId: sql<string>`json_quote(${messageVersions.id})`.mapWith(value => JSON.parse(value) as string),
    content: sql<string>`json_quote(${messageVersions.content})`.mapWith(value => JSON.parse(value) as string),
  }).from(messages)
    .innerJoin(messageVersions, and(eq(messageVersions.id, messages.currentVersionId), eq(messageVersions.messageId, messages.id)))
    .where(and(eq(messages.sessionId, source.sessionId), eq(messages.role, "assistant"), isNull(messages.deletedAt),
      eq(messageVersions.turnId, turnId), eq(messageVersions.role, "assistant"), isNull(messageVersions.supersededAt), eq(messageVersions.isRedacted, 0)));
  for (const { identityId, versionId: currentVersionId, content: currentContent } of current) {
    // A user edit has its own version and must not be overwritten by late execution.
    const checkpoint = /^mv_history_([0-9]+)_[0-9a-f-]{36}$/.exec(currentVersionId);
    if (!checkpoint || !Number.isSafeInteger(Number(checkpoint[1]))) continue;
    const segments = await tx.select({ text: sql<string>`json_quote(${safeSegments.text})`.mapWith(value => JSON.parse(value) as string) }).from(safeSegments).innerJoin(turnStreamEvents, and(
      eq(turnStreamEvents.id, safeSegments.streamEventId), eq(turnStreamEvents.turnId, safeSegments.turnId),
      eq(turnStreamEvents.sequence, safeSegments.sequence), eq(turnStreamEvents.attemptId, safeSegments.attemptId),
    )).where(and(eq(safeSegments.turnId, turnId), eq(safeSegments.committed, 1), gt(safeSegments.sequence, Number(checkpoint[1])), lt(safeSegments.sequence, beforeSequence),
      eq(turnStreamEvents.eventType, "delta"), eq(turnStreamEvents.safetyDecision, "approved"),
      sql`json_extract(${turnStreamEvents.data}, '$.messageId') = ${identityId}`,
      sql`json_extract(${turnStreamEvents.data}, '$.text') = ${safeSegments.text}`,
    )).orderBy(safeSegments.sequence);
    const content = currentContent + segments.map(segment => segment.text).join("");
    if (content === currentContent) continue;
    const now = new Date().toISOString();
    const versionId = `mv_history_${beforeSequence}_${crypto.randomUUID()}`;
    await tx.update(messageVersions).set({ supersededAt: now }).where(eq(messageVersions.id, currentVersionId));
    await tx.insert(messageVersions).values({ id: versionId, turnId, messageId: identityId, role: "assistant",
      version: await nextVersion(tx, turnId), content, isRedacted: 0, createdAt: now });
    const [updated] = await tx.update(messages).set({ currentVersionId: versionId }).where(and(eq(messages.id, identityId),
      eq(messages.currentVersionId, currentVersionId), isNull(messages.deletedAt))).returning({ id: messages.id });
    if (!updated) throw new FencingMismatchError("conversation_message_pointer_conflict");
  }
}
