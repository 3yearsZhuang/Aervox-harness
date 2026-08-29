/**
 * Aervox｜思隅 @aervox/database — Subagent 运行关联（subagent_runs）
 *
 * 规则依据：AVX-HAR-001 §13 阶段 5 / 5c「Subagent/Workflow Contribution」：
 * - Leader Loop 在 Step 调用 `subagent_delegate`，宿主创建独立子 turn/attempt 落库（可审计/恢复）；
 * - 本表承载父子关联（parentAttemptId + parentExecutionId 幂等，崩溃/重试不重复创建子任务）
 *   与结果摘要（子任务完整事件在子 turn 下审计，不入本表）；
 * - 租户隔离与既有域一致（workspace_id + subject_user_id）。
 */
import { sqliteTable, text, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { tenantColumns, timestampColumns } from "./common.js";

export const subagentRuns = sqliteTable(
  "subagent_runs",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    /** 父（Leader）Turn/Attempt/执行键（入口：Host 幂等键 executionId = attempt:step:seq） */
    parentTurnId: text("parent_turn_id").notNull(),
    parentAttemptId: text("parent_attempt_id").notNull(),
    parentExecutionId: text("parent_execution_id").notNull(),
    /** 子任务 Turn/Attempt（独立落库，事件与终态在其下审计） */
    subTurnId: text("sub_turn_id").notNull(),
    subAttemptId: text("sub_attempt_id").notNull(),
    /** 子任务目标（隔离注入子上下文） */
    task: text("task").notNull(),
    /** 子任务工具集约束（JSON；空 = Host 默认） */
    toolScopeJson: text("tool_scope_json", { mode: "json" }),
    /** 子 Attempt 终态（Running / Completed / Failed / Interrupted / Cancelled） */
    status: text("status").notNull().default("Running"),
    /** 结果摘要（Completed 的正文输出） */
    resultText: text("result_text"),
    error: text("error"),
    finishedAt: text("finished_at"),
    ...tenantColumns,
    ...timestampColumns,
  },
  (table) => ({
    tenantParentIdx: index("subagent_runs_tenant_parent_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.parentTurnId,
    ),
    tenantSessionIdx: index("subagent_runs_tenant_session_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.sessionId,
    ),
    tenantParentExecIdx: uniqueIndex("subagent_runs_tenant_parent_exec_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.parentAttemptId,
      table.parentExecutionId,
    ),
  }),
);
