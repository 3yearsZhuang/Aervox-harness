/**
 * Aervox｜思隅 @aervox/schema — 本地模型降级阶梯与健康探测留痕 (CR-034/CR-042)
 *
 * 规则依据：docs/reference/changes/CR-034-local-model-fallback-ladder.md
 * - llm_health_snapshots: 预设健康探测快照与迟滞状态
 * - llm_routing_events: 切层审计事件追溯
 */
import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { timestampColumns } from "./common.js";

/** 预设级健康探测状态与迟滞快照 */
export const llmHealthSnapshots = sqliteTable(
  "llm_health_snapshots",
  {
    presetId: text("preset_id").primaryKey(),
    providerType: text("provider_type").notNull(),
    endpointIdentity: text("endpoint_identity").notNull(),
    status: text("status").notNull().default("unknown"),
    consecutiveSuccesses: integer("consecutive_successes").notNull().default(0),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    latencyMs: integer("latency_ms"),
    lastProbeAt: text("last_probe_at"),
    lastSuccessAt: text("last_success_at"),
    lastFailureAt: text("last_failure_at"),
    errorCategory: text("error_category"),
    errorMessage: text("error_message"),
    cooldownUntil: text("cooldown_until"),
    ...timestampColumns,
  },
);

/** 模型路由切层与降级审计账本 */
export const llmRoutingEvents = sqliteTable(
  "llm_routing_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id"),
    turnId: text("turn_id"),
    fromTier: text("from_tier").notNull(),
    toTier: text("to_tier").notNull(),
    fromPresetId: text("from_preset_id"),
    toPresetId: text("to_preset_id"),
    reason: text("reason").notNull(),
    occurredAt: text("occurred_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    sessionIdx: index("llm_routing_events_session_idx").on(table.sessionId, table.occurredAt),
  }),
);
