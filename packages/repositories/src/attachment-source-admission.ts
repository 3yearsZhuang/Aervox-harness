import { Column, eq, getTableName, is, sql, type SQLWrapper } from "drizzle-orm";
import { alias, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { memoryRecords, outboxEvents, turns } from "@aervox/schema";
import type { AervoxDatabase } from "./database.js";
import type { ConversationCryptoPort } from "./conversation-host-port.js";
import { readAcceptedTurnIntent, type AcceptedTurnReceiptSource } from "./conversation-turn-intent-neutral.js";
import { asciiCharactersOnly, byteLength, jsonArrayLength, jsonEach, jsonKind, jsonNumber, jsonObject, jsonText, validJson } from "./sql-dialect.js";

const sourceMemory = alias(memoryRecords, "attachment_admission_memory");
const receiptTurn = alias(turns, "attachment_admission_turn");
const evidenceTurn = alias(turns, "admission_evidence_turn");

// Drizzle strips Column qualifiers in a single-table SELECT projection, even
// inside nested SQL. Explicit identifier chunks preserve correlated subqueries.
const q = (column: AnySQLiteColumn) => sql`${sql.identifier(getTableName(column.table))}.${sql.identifier(column.name)}`;
const reference = (value: string | SQLWrapper) => is(value, Column) ? q(value as AnySQLiteColumn) : value;

/** Existing "clean" metadata has no trusted scan proof. A present receipt must
 * retain the accepted canonical structure and Turn association; SQL NULL or a
 * damaged ancestor is never evidence of text input. This checks shape and stored
 * hash equality, not a recomputed intent digest. Absent receipts are not inferred. */
export const unverifiedAttachmentTurn = (db: object, turnId: string | SQLWrapper) => sql<number>`case when exists (
  select 1 from ${outboxEvents}
  where ${q(outboxEvents.id)} = 'outbox_' || ${reference(turnId)}
    and case when ${validJson(db, q(outboxEvents.payload))} then case when
      ${jsonKind(db, q(outboxEvents.payload))} = 'object'
      and ${jsonKind(db, q(outboxEvents.payload), '$.intent')} = 'object'
      and ${jsonKind(db, q(outboxEvents.payload), '$.intent.version')} in ('integer', 'real')
      and ${jsonNumber(db, q(outboxEvents.payload), '$.intent.version')} = 1
      and ${jsonKind(db, q(outboxEvents.payload), '$.intent.message')} = 'object'
      and ${jsonKind(db, q(outboxEvents.payload), '$.intent.message.content')} = 'text'
      and ${jsonKind(db, q(outboxEvents.payload), '$.intent.message.contentType')} = 'text'
      and ${jsonText(db, q(outboxEvents.payload), '$.intent.message.contentType')} in ('text', 'markdown')
      and ${jsonKind(db, q(outboxEvents.payload), '$.intent.message.attachments')} = 'array'
      and ${jsonKind(db, q(outboxEvents.payload), '$.intent.metadata')} = 'object'
      and ${jsonKind(db, q(outboxEvents.payload), '$.intent.toolApprovalMode')} = 'text'
      and ${jsonText(db, q(outboxEvents.payload), '$.intent.toolApprovalMode')} in ('ask', 'full_access')
      and ${jsonKind(db, q(outboxEvents.payload), '$.intent.actorId')} in ('null', 'text')
      and case when ${jsonKind(db, q(outboxEvents.payload), '$.intent.references')} = 'array' then not exists (
        select 1 from ${jsonEach(db, q(outboxEvents.payload), { path: '$.intent.references', alias: 'attachment_admission_reference', kind: 'array' })}
        where case when attachment_admission_reference.type = 'object' then case when
          ${jsonKind(db, sql`attachment_admission_reference.value`, '$.sourceId')} = 'text'
          and ${jsonKind(db, sql`attachment_admission_reference.value`, '$.sourceVersion')} = 'text'
          then false else true end else true end
      ) else false end
      and exists (
        select 1 from ${turns} as attachment_admission_turn where ${q(receiptTurn.id)} = ${reference(turnId)}
          and length(${q(receiptTurn.requestHash)}) = 79
          and substr(${q(receiptTurn.requestHash)}, 1, 15) = 'turn-intent-v1:'
          and ${asciiCharactersOnly(db, sql`substr(${q(receiptTurn.requestHash)}, 16)`, 'a-f0-9')}
          and ${q(receiptTurn.executionPolicy)} in ('local-v1', 'bot-owner-v1', 'bot-group-member-v1')
          and ${jsonKind(db, q(outboxEvents.payload), '$.turnId')} = 'text'
          and ${jsonText(db, q(outboxEvents.payload), '$.turnId')} = ${q(receiptTurn.id)}
          and ${jsonKind(db, q(outboxEvents.payload), '$.sessionId')} = 'text'
          and ${jsonText(db, q(outboxEvents.payload), '$.sessionId')} = ${q(receiptTurn.sessionId)}
          and ${jsonKind(db, q(outboxEvents.payload), '$.intent.sessionId')} = 'text'
          and ${jsonText(db, q(outboxEvents.payload), '$.intent.sessionId')} = ${q(receiptTurn.sessionId)}
          and ${jsonKind(db, q(outboxEvents.payload), '$.intent.executionPolicy')} = 'text'
          and ${jsonText(db, q(outboxEvents.payload), '$.intent.executionPolicy')} = ${q(receiptTurn.executionPolicy)}
          and ${jsonKind(db, q(outboxEvents.payload), '$.requestHash')} = 'text'
          and ${jsonText(db, q(outboxEvents.payload), '$.requestHash')} = ${q(receiptTurn.requestHash)}
      )
      then ${jsonArrayLength(db, q(outboxEvents.payload), '$.intent.message.attachments')} > 0
      else true end else true end
) then 1 else 0 end`;

/** Applies only when a memory has a known source Turn. Unlinked legacy provenance
 * is not inferred from body text, and user-visible records are not removed. */
export const unverifiedAttachmentMemory = (db: object, memoryId: string | SQLWrapper) => sql<number>`case when exists (
  select 1 from ${memoryRecords} as attachment_admission_memory where ${q(sourceMemory.id)} = ${reference(memoryId)}
    and ${unverifiedAttachmentTurn(db, sourceMemory.sourceTurnId)} > 0
) then 1 else 0 end`;

/** One receipt at a time fits the native cursor budget even after JSON escaping.
 * Oversized present receipts deny admission rather than returning partial JSON. */
export const MAX_ACCEPTANCE_RECEIPT_BYTES = 256 * 1024;
export interface TurnReceiptEvidence extends AcceptedTurnReceiptSource {
  present: number;
  structurallyDenied: number;
  rawReceipt: string | null;
}

export const turnReceiptEvidence = (db: object, turnId: string | SQLWrapper) => sql<string | null>`(
  select ${jsonObject(db, [
    ['turnId', q(evidenceTurn.id)], ['sessionId', q(evidenceTurn.sessionId)],
    ['executionPolicy', q(evidenceTurn.executionPolicy)], ['requestHash', q(evidenceTurn.requestHash)],
    ['present', sql`case when exists (select 1 from ${outboxEvents} where ${q(outboxEvents.id)} = 'outbox_' || ${q(evidenceTurn.id)}) then 1 else 0 end`],
    ['structurallyDenied', unverifiedAttachmentTurn(db, evidenceTurn.id)],
    ['rawReceipt', sql`(select case when ${byteLength(db, q(outboxEvents.payload))} <= ${MAX_ACCEPTANCE_RECEIPT_BYTES}
      then ${q(outboxEvents.payload)} else null end from ${outboxEvents} where ${q(outboxEvents.id)} = 'outbox_' || ${q(evidenceTurn.id)})`],
  ])}
  from ${turns} as admission_evidence_turn where ${q(evidenceTurn.id)} = ${reference(turnId)}
)`;

/** Absent/unlinked historical provenance remains a separate scope. Every present
 * receipt must pass both structural checks and a fresh synchronous intent hash. */
export function admitsTurnReceipt(evidence: TurnReceiptEvidence | null, crypto?: Pick<ConversationCryptoPort, "sha256Utf8">): boolean {
  if (!evidence || evidence.present === 0) return true;
  if (evidence.structurallyDenied !== 0 || !evidence.rawReceipt || !crypto) return false;
  try { return readAcceptedTurnIntent(evidence.rawReceipt, evidence, crypto).message.attachments.length === 0; }
  catch { return false; }
}

/** The caller supplies the same reader/writer snapshot used for its body/write.
 * Selected receipt identities are read individually; no full-history proof scan. */
export async function admitsSourceTurn(
  db: Pick<AervoxDatabase, "select">,
  sourceTurnId: string | null | undefined,
  crypto?: Pick<ConversationCryptoPort, "sha256Utf8">,
): Promise<boolean> {
  if (!sourceTurnId) return true;
  const [row] = await db.select({ evidence: turnReceiptEvidence(db, turns.id) }).from(turns).where(eq(turns.id, sourceTurnId)).limit(1);
  return admitsTurnReceipt(row?.evidence ? JSON.parse(row.evidence) as TurnReceiptEvidence : null, crypto);
}
