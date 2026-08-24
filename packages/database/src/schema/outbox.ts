/**
 * Aervox｜思隅 @aervox/database — 事务 Outbox 实体表
 *
 * 规则依据：docs/architecture/adr/ADR-004-outbox-idempotent-jobs.md + ADR-013
 */
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { tenantColumns } from "./common.js";

export const outboxEvents = sqliteTable(
  "outbox_events",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    controlEventId: text("control_event_id"), // 关联 RecoveryControlLedger 独立账本事件 ID
    idempotencyKey: text("idempotency_key").notNull(),
    eventType: text("event_type").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    status: text("status").notNull().default("pending"), // "pending" | "published" | "failed" | "dead_letter"
    retryCount: integer("retry_count").notNull().default(0),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
    publishedAt: text("published_at"),
  },
  (table) => ({
    tenantIdempotencyIdx: uniqueIndex("outbox_tenant_idempotency_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.idempotencyKey,
    ),
    statusIdx: index("outbox_status_idx").on(table.status, table.createdAt),
  }),
);
