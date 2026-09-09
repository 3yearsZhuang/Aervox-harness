/**
 * Aervox｜思隅 @aervox/repositories — agent-inbox 仓储类型（自 types.ts 机械拆分）
 */
import type { AgentInboxEnqueueInput, AgentInboxItemModel } from "./outbox.js";
import type { TenantContext } from "../../tenant.js";

export interface IAgentInboxRepository {
  /** 提交一条受控 inbox command（幂等：同 idempotencyKey 重复提交返回既有项） */
  enqueue(tenant: TenantContext, input: AgentInboxEnqueueInput): Promise<AgentInboxItemModel>;
  /**
   * claim 一批可消费 inbox 项（pending → claimed）：
   * - next-step：按 sessionId + attemptId + boundary 过滤（attemptId 必填）；
   * - next-turn：按 sessionId + boundary 过滤（attemptId 可空）。
   * 过滤未过期项，按 orderingSeq 排序。
   */
  claimForConsumption(
    tenant: TenantContext,
    input: { sessionId: string; attemptId?: string | null; type: "next-turn" | "next-step"; limit?: number },
  ): Promise<AgentInboxItemModel[]>;
  /** ack 消费完成（claimed → acknowledged）；只接受属于本租户的项 */
  acknowledge(tenant: TenantContext, itemIds: string[]): Promise<void>;
  /** 按 idempotencyKey 查询（API 幂等返回用） */
  getByIdempotencyKey(tenant: TenantContext, idempotencyKey: string): Promise<AgentInboxItemModel | null>;
  /** 过期回收（跨租户，Worker 轮询）：expiresAt < now 且 status ∈ pending/claimed → expired；返回回收条数 */
  expireOverdue(now?: string): Promise<number>;
}

export interface SubagentRunModel {
  id: string;
  sessionId: string;
  parentTurnId: string;
  parentAttemptId: string;
  parentExecutionId: string;
  subTurnId: string;
  subAttemptId: string;
  task: string;
  toolScope: unknown | null;
  /** Running / Completed / Failed / Interrupted / Cancelled（对齐 AttemptStatus） */
  status: string;
  resultText?: string | null;
  error?: string | null;
  finishedAt?: string | null;
  workspaceId: string;
  subjectUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface SubagentRunCreateInput {
  id: string;
  sessionId: string;
  parentTurnId: string;
  parentAttemptId: string;
  parentExecutionId: string;
  subTurnId: string;
  subAttemptId: string;
  task: string;
  toolScope?: unknown;
}
