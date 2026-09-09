/**
 * Aervox｜思隅 @aervox/database — Agent Loop 工具执行账本（tool_executions）
 *
 * 规则依据：docs/reference/agent-harness-loop.md（AVX-HAR-001）§12 副作用证据与持久化边界：
 * 每次工具调用（成功/拒绝/重复/超时）都留下执行证据，用于审计与副作用追溯；
 * 由 agent-loop 的 ExecutionStorePort.recordToolExecution 落库（阶段 2d）。
 */
import { sqliteTable, text, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { tenantColumns } from "./common.js";
import { turns } from "./conversations.js";

/** Agent Loop 工具执行账本（副作用证据；attempt 内 invocationId 唯一） */
export const toolExecutions = sqliteTable(
  "tool_executions",
  {
    id: text("id").primaryKey(),
    turnId: text("turn_id")
      .notNull()
      .references(() => turns.id, { onDelete: "cascade" }),
    attemptId: text("attempt_id").notNull(),
    /** 模型请求中的工具调用 ID（attempt 内唯一） */
    invocationId: text("invocation_id").notNull(),
    name: text("name").notNull(),
    ...tenantColumns,
    /** 请求参数（JSON） */
    argumentsJson: text("arguments_json", { mode: "json" }),
    /** executed / rejected / duplicate / timeout_error */
    status: text("status").notNull(),
    /** 成功输出（JSON，read_only 结果） */
    outputJson: text("output_json", { mode: "json" }),
    error: text("error"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at").notNull(),
  },
  (table) => ({
    turnIdx: index("tool_executions_turn_idx").on(table.turnId),
    attemptIdx: index("tool_executions_attempt_idx").on(table.attemptId),
    tenantIdx: index("tool_executions_tenant_idx").on(table.workspaceId, table.subjectUserId),
    /** 2c：幂等预留唯一键（attempt+invocation；对应 init 的 CREATE UNIQUE INDEX 幂等补齐） */
    attemptInvocationIdx: uniqueIndex("tool_executions_attempt_invocation_idx").on(table.attemptId, table.invocationId),
  }),
);