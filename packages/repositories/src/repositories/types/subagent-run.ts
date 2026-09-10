/**
 * Aervox｜思隅 @aervox/repositories — subagent-run 仓储类型（自 types.ts 机械拆分）
 */
import type { SubagentRunCreateInput, SubagentRunModel } from "./agent-inbox.js";
import type { LocalContext } from "../../local-context.js";

export interface ISubagentRunRepository {
  /**
   * 幂等创建：同 tenant + parentAttemptId + parentExecutionId 已存在则返回既有行
   * （子任务崩溃/重试不重复落库——Host 幂等键=executionId 语义，AVX-HAR-001 §9）。
   */
  createRun(tenant: LocalContext, input: SubagentRunCreateInput): Promise<SubagentRunModel>;
  /** 终态收口：status/resultText/error/finishedAt（仅 Running 可收口，返回 null 表示非 Running/缺失） */
  finalizeRun(
    tenant: LocalContext,
    runId: string,
    input: { status: string; resultText?: string | null; error?: string | null },
  ): Promise<SubagentRunModel | null>;
  /** 按父执行键回查（重试/幂等复用） */
  getRunByParentExecution(
    tenant: LocalContext,
    parentAttemptId: string,
    parentExecutionId: string,
  ): Promise<SubagentRunModel | null>;
  /** 父 Turn 的全部子任务运行（API 审计端点，租户隔离） */
  listRunsByTurn(tenant: LocalContext, parentTurnId: string): Promise<SubagentRunModel[]>;
}

export interface PendingUserQuestionModel {
  turnId: string;
  attemptId: string;
  step: number;
  /** 模型提出的问题清单（AskUserQuestionItem[]） */
  questions: unknown;
  timeoutMs: number;
  /** createdAt + timeoutMs；晚于此时间提交答案视为超时 */
  expiresAt: string;
  createdAt: string;
  workspaceId: string;
  subjectUserId: string;
}

export interface PendingUserQuestionUpsertInput {
  turnId: string;
  attemptId: string;
  step: number;
  questions: unknown;
  timeoutMs: number;
  expiresAt: string;
  createdAt: string;
}
