import { sql, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { memoryRecords, outboxEvents } from "@aervox/schema";

const sourceMemory = alias(memoryRecords, "attachment_admission_memory");

/** Existing "clean" metadata has no trusted scan proof. A known attachment-bearing
 * accepted intent cannot supply model input or personal derivatives. Missing and
 * empty attachment arrays preserve legacy text; malformed attachment fields and
 * existing receipts with invalid JSON deny. An absent receipt is not inferred. */
export const unverifiedAttachmentTurn = (turnId: string | SQLWrapper) => sql<number>`exists (
  select 1 from ${outboxEvents}
  where ${outboxEvents.id} = 'outbox_' || ${turnId}
    and case when json_valid(${outboxEvents.payload}) then (
      json_type(${outboxEvents.payload}, '$.intent.message.attachments') is not null and (
        json_type(${outboxEvents.payload}, '$.intent.message.attachments') != 'array'
        or json_array_length(${outboxEvents.payload}, '$.intent.message.attachments') > 0
      )
    ) else 1 end
)`;

/** Applies only when a memory has a known source Turn. Unlinked legacy provenance
 * is not inferred from body text, and user-visible records are not removed. */
export const unverifiedAttachmentMemory = (memoryId: string | SQLWrapper) => sql<number>`exists (
  select 1 from ${memoryRecords} as attachment_admission_memory where ${sourceMemory.id} = ${memoryId}
    and ${unverifiedAttachmentTurn(sourceMemory.sourceTurnId)}
)`;
