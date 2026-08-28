/**
 * Aervox｜思隅 @aervox/database — 工具授权账本（tool_approvals）
 *
 * 规则依据：AVX-HAR-001 §15 阶段 3（写工具审批通道）。
 * 写工具（write_with_approval）执行前须有匹配的已授权记录：
 * - 授权匹配键 = toolName + argumentsHash（参数规范化哈希），跨 turn 复用（一次授权、重放执行）；
 * - turnId/attemptId 仅溯源；state = pending / granted / denied；
 * - 撤权 = 工具停用后 runtimes 层 enabled 校验（fail-closed），此处不级联外表。
 */
import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { tenantColumns } from "./common.js";
import { turns } from "./conversations.js";

export const toolApprovals = sqliteTable(
  "tool_approvals",
  {
    id: text("id").primaryKey(),
    /** 溯源：发起授权的 Turn（生命周期随 turn 删除） */
    turnId: text("turn_id")
      .notNull()
      .references(() => turns.id, { onDelete: "cascade" }),
    attemptId: text("attempt_id").notNull(),
    toolName: text("tool_name").notNull(),
    /** 参数规范化哈希（授权匹配键） */
    argumentsHash: text("arguments_hash").notNull(),
    /** 授权时工具定义版本（审计用；运行校验以 enabled/安全级别为准） */
    toolVersion: text("tool_version"),
    requester: text("requester").notNull(),
    // pending | granted | denied
    state: text("state").notNull().default("pending"),
    decidedBy: text("decided_by"),
    decidedAt: text("decided_at"),
    ...tenantColumns,
  },
  (table) => ({
    matchIdx: index("tool_approvals_match_idx").on(table.toolName, table.argumentsHash, table.state),
    turnIdx: index("tool_approvals_turn_idx").on(table.turnId),
    tenantIdx: index("tool_approvals_tenant_idx").on(table.workspaceId, table.subjectUserId),
  }),
);