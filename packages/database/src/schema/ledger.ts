/**
 * Aervox｜思隅 @aervox/database — RecoveryControlLedger 独立 deny 账本实体表
 *
 * 规则依据：docs/reference/PRD.md §8 数据规则 + docs/reference/DATABASE.md §14.7
 *
 * 关键约束：本表必须与业务数据库分离凭据、分离故障域（独立 libsql 文件/连接），
 * 不可与业务库共享事务。服务端先以确定性 eventId/idempotencyKey 追加账本并取得持久确认，
 * 再幂等提交业务状态；账本不可用/序列缺口/水位未追平时受影响范围 fail closed。
 */
import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const recoveryControlLedger = sqliteTable(
  "recovery_control_ledger",
  {
    eventId: text("event_id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    eventType: text("event_type").notNull(), // "delete" | "consent_revoke" | "external_revoke"
    workspaceRef: text("workspace_ref"), // 假名化引用
    subjectRef: text("subject_ref"), // 假名化引用
    targetRef: text("target_ref"), // 假名化引用
    occurredAt: text("occurred_at").notNull(),
    sequence: integer("sequence").notNull(),
    tamperEvidence: text("tamper_evidence", { mode: "json" }), // 哈希链/签名证据
  },
  (table) => ({
    idemIdx: uniqueIndex("recovery_ledger_idempotency_idx").on(table.idempotencyKey),
    sequenceIdx: index("recovery_ledger_sequence_idx").on(table.sequence),
  }),
);
