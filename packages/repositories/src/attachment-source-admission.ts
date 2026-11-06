import { sql, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { memoryRecords, outboxEvents, turns } from "@aervox/schema";

const sourceMemory = alias(memoryRecords, "attachment_admission_memory");
const receiptTurn = alias(turns, "attachment_admission_turn");

/** Existing "clean" metadata has no trusted scan proof. A present receipt must
 * retain the accepted canonical structure and Turn association; SQL NULL or a
 * damaged ancestor is never evidence of text input. This checks shape and stored
 * hash equality, not a recomputed intent digest. Absent receipts are not inferred. */
export const unverifiedAttachmentTurn = (turnId: string | SQLWrapper) => sql<number>`exists (
  select 1 from ${outboxEvents}
  where ${outboxEvents.id} = 'outbox_' || ${turnId}
    and case when json_valid(${outboxEvents.payload}) then case when
      json_type(${outboxEvents.payload}) = 'object'
      and json_type(${outboxEvents.payload}, '$.intent') = 'object'
      and json_type(${outboxEvents.payload}, '$.intent.version') in ('integer', 'real')
      and json_extract(${outboxEvents.payload}, '$.intent.version') = 1
      and json_type(${outboxEvents.payload}, '$.intent.message') = 'object'
      and json_type(${outboxEvents.payload}, '$.intent.message.content') = 'text'
      and json_type(${outboxEvents.payload}, '$.intent.message.contentType') = 'text'
      and json_extract(${outboxEvents.payload}, '$.intent.message.contentType') in ('text', 'markdown')
      and json_type(${outboxEvents.payload}, '$.intent.message.attachments') = 'array'
      and json_type(${outboxEvents.payload}, '$.intent.metadata') = 'object'
      and json_type(${outboxEvents.payload}, '$.intent.toolApprovalMode') = 'text'
      and json_extract(${outboxEvents.payload}, '$.intent.toolApprovalMode') in ('ask', 'full_access')
      and json_type(${outboxEvents.payload}, '$.intent.actorId') in ('null', 'text')
      and case when json_type(${outboxEvents.payload}, '$.intent.references') = 'array' then not exists (
        select 1 from json_each(${outboxEvents.payload}, '$.intent.references') as attachment_admission_reference
        where case when attachment_admission_reference.type = 'object' then case when
          json_type(attachment_admission_reference.value, '$.sourceId') = 'text'
          and json_type(attachment_admission_reference.value, '$.sourceVersion') = 'text'
          then 0 else 1 end else 1 end = 1
      ) else 0 end
      and exists (
        select 1 from ${turns} as attachment_admission_turn where ${receiptTurn.id} = ${turnId}
          and length(${receiptTurn.requestHash}) = 79
          and substr(${receiptTurn.requestHash}, 1, 15) = 'turn-intent-v1:'
          and substr(${receiptTurn.requestHash}, 16) not glob '*[^0-9a-f]*'
          and ${receiptTurn.executionPolicy} in ('local-v1', 'bot-owner-v1', 'bot-group-member-v1')
          and json_type(${outboxEvents.payload}, '$.turnId') = 'text'
          and json_extract(${outboxEvents.payload}, '$.turnId') = ${receiptTurn.id}
          and json_type(${outboxEvents.payload}, '$.sessionId') = 'text'
          and json_extract(${outboxEvents.payload}, '$.sessionId') = ${receiptTurn.sessionId}
          and json_type(${outboxEvents.payload}, '$.intent.sessionId') = 'text'
          and json_extract(${outboxEvents.payload}, '$.intent.sessionId') = ${receiptTurn.sessionId}
          and json_type(${outboxEvents.payload}, '$.intent.executionPolicy') = 'text'
          and json_extract(${outboxEvents.payload}, '$.intent.executionPolicy') = ${receiptTurn.executionPolicy}
          and json_type(${outboxEvents.payload}, '$.requestHash') = 'text'
          and json_extract(${outboxEvents.payload}, '$.requestHash') = ${receiptTurn.requestHash}
      )
      then json_array_length(${outboxEvents.payload}, '$.intent.message.attachments') > 0
      else 1 end else 1 end
)`;

/** Applies only when a memory has a known source Turn. Unlinked legacy provenance
 * is not inferred from body text, and user-visible records are not removed. */
export const unverifiedAttachmentMemory = (memoryId: string | SQLWrapper) => sql<number>`exists (
  select 1 from ${memoryRecords} as attachment_admission_memory where ${sourceMemory.id} = ${memoryId}
    and ${unverifiedAttachmentTurn(sourceMemory.sourceTurnId)}
)`;
