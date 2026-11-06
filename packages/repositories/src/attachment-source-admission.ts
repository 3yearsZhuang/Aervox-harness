import { Column, eq, getTableName, is, sql, type SQLWrapper } from "drizzle-orm";
import { alias, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { memoryRecords, outboxEvents, turns } from "@aervox/schema";
import type { AervoxDatabase } from "./database.js";
import type { ConversationCryptoPort } from "./conversation-host-port.js";
import { readAcceptedTurnIntent, type AcceptedTurnReceiptSource } from "./conversation-turn-intent-neutral.js";

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
export const unverifiedAttachmentTurn = (turnId: string | SQLWrapper) => sql<number>`exists (
  select 1 from ${outboxEvents}
  where ${q(outboxEvents.id)} = 'outbox_' || ${reference(turnId)}
    and case when json_valid(${q(outboxEvents.payload)}) then case when
      json_type(${q(outboxEvents.payload)}) = 'object'
      and json_type(${q(outboxEvents.payload)}, '$.intent') = 'object'
      and json_type(${q(outboxEvents.payload)}, '$.intent.version') in ('integer', 'real')
      and json_extract(${q(outboxEvents.payload)}, '$.intent.version') = 1
      and json_type(${q(outboxEvents.payload)}, '$.intent.message') = 'object'
      and json_type(${q(outboxEvents.payload)}, '$.intent.message.content') = 'text'
      and json_type(${q(outboxEvents.payload)}, '$.intent.message.contentType') = 'text'
      and json_extract(${q(outboxEvents.payload)}, '$.intent.message.contentType') in ('text', 'markdown')
      and json_type(${q(outboxEvents.payload)}, '$.intent.message.attachments') = 'array'
      and json_type(${q(outboxEvents.payload)}, '$.intent.metadata') = 'object'
      and json_type(${q(outboxEvents.payload)}, '$.intent.toolApprovalMode') = 'text'
      and json_extract(${q(outboxEvents.payload)}, '$.intent.toolApprovalMode') in ('ask', 'full_access')
      and json_type(${q(outboxEvents.payload)}, '$.intent.actorId') in ('null', 'text')
      and case when json_type(${q(outboxEvents.payload)}, '$.intent.references') = 'array' then not exists (
        select 1 from json_each(${q(outboxEvents.payload)}, '$.intent.references') as attachment_admission_reference
        where case when attachment_admission_reference.type = 'object' then case when
          json_type(attachment_admission_reference.value, '$.sourceId') = 'text'
          and json_type(attachment_admission_reference.value, '$.sourceVersion') = 'text'
          then 0 else 1 end else 1 end = 1
      ) else 0 end
      and exists (
        select 1 from ${turns} as attachment_admission_turn where ${q(receiptTurn.id)} = ${reference(turnId)}
          and length(${q(receiptTurn.requestHash)}) = 79
          and substr(${q(receiptTurn.requestHash)}, 1, 15) = 'turn-intent-v1:'
          and substr(${q(receiptTurn.requestHash)}, 16) not glob '*[^0-9a-f]*'
          and ${q(receiptTurn.executionPolicy)} in ('local-v1', 'bot-owner-v1', 'bot-group-member-v1')
          and json_type(${q(outboxEvents.payload)}, '$.turnId') = 'text'
          and json_extract(${q(outboxEvents.payload)}, '$.turnId') = ${q(receiptTurn.id)}
          and json_type(${q(outboxEvents.payload)}, '$.sessionId') = 'text'
          and json_extract(${q(outboxEvents.payload)}, '$.sessionId') = ${q(receiptTurn.sessionId)}
          and json_type(${q(outboxEvents.payload)}, '$.intent.sessionId') = 'text'
          and json_extract(${q(outboxEvents.payload)}, '$.intent.sessionId') = ${q(receiptTurn.sessionId)}
          and json_type(${q(outboxEvents.payload)}, '$.intent.executionPolicy') = 'text'
          and json_extract(${q(outboxEvents.payload)}, '$.intent.executionPolicy') = ${q(receiptTurn.executionPolicy)}
          and json_type(${q(outboxEvents.payload)}, '$.requestHash') = 'text'
          and json_extract(${q(outboxEvents.payload)}, '$.requestHash') = ${q(receiptTurn.requestHash)}
      )
      then json_array_length(${q(outboxEvents.payload)}, '$.intent.message.attachments') > 0
      else 1 end else 1 end
)`;

/** Applies only when a memory has a known source Turn. Unlinked legacy provenance
 * is not inferred from body text, and user-visible records are not removed. */
export const unverifiedAttachmentMemory = (memoryId: string | SQLWrapper) => sql<number>`exists (
  select 1 from ${memoryRecords} as attachment_admission_memory where ${q(sourceMemory.id)} = ${reference(memoryId)}
    and ${unverifiedAttachmentTurn(sourceMemory.sourceTurnId)}
)`;

/** One receipt at a time fits the native cursor budget even after JSON escaping.
 * Oversized present receipts deny admission rather than returning partial JSON. */
export const MAX_ACCEPTANCE_RECEIPT_BYTES = 256 * 1024;
export interface TurnReceiptEvidence extends AcceptedTurnReceiptSource {
  present: number;
  structurallyDenied: number;
  rawReceipt: string | null;
}

export const turnReceiptEvidence = (turnId: string | SQLWrapper) => sql<string | null>`(
  select json_object('turnId', ${q(evidenceTurn.id)}, 'sessionId', ${q(evidenceTurn.sessionId)},
    'executionPolicy', ${q(evidenceTurn.executionPolicy)}, 'requestHash', ${q(evidenceTurn.requestHash)},
    'present', exists (select 1 from ${outboxEvents} where ${q(outboxEvents.id)} = 'outbox_' || ${q(evidenceTurn.id)}),
    'structurallyDenied', ${unverifiedAttachmentTurn(evidenceTurn.id)},
    'rawReceipt', (select case when length(cast(${q(outboxEvents.payload)} as blob)) <= ${MAX_ACCEPTANCE_RECEIPT_BYTES}
      then ${q(outboxEvents.payload)} else null end from ${outboxEvents} where ${q(outboxEvents.id)} = 'outbox_' || ${q(evidenceTurn.id)}))
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
  const [row] = await db.select({ evidence: turnReceiptEvidence(turns.id) }).from(turns).where(eq(turns.id, sourceTurnId)).limit(1);
  return admitsTurnReceipt(row?.evidence ? JSON.parse(row.evidence) as TurnReceiptEvidence : null, crypto);
}
