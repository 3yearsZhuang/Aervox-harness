/**
 * Aervox｜思隅 @aervox/repositories — outbox 仓储类型（自 types.ts 机械拆分）
 */
import type { OutboxEventModel } from "./conversation.js";
import type { TenantContext } from "../../tenant.js";

export interface IOutboxRepository {
  insertEvent(
    tenant: TenantContext,
    event: {
      id: string;
      idempotencyKey: string;
      eventType: string;
      payload: unknown;
      controlEventId?: string | null;
    },
  ): Promise<OutboxEventModel>;
  fetchPendingEvents(limit?: number): Promise<OutboxEventModel[]>;
  markPublished(eventId: string): Promise<void>;
  markFailed(eventId: string, error: string): Promise<void>;
}

export interface MessageModel {
  id: string;
  sessionId: string;
  role: string;
  currentVersionId?: string | null;
  label?: string | null;
  createdAt: string;
  deletedAt?: string | null;
}

export interface TurnAttemptModel {
  id: string;
  turnId: string;
  attempt: number;
  leaseId?: string | null;
  fencingToken: number;
  status: string;
  startedAt: string;
  finishedAt?: string | null;
  leaseExpiresAt?: string | null;
}

export interface ToolExecutionModel {
  id: string;
  turnId: string;
  attemptId: string;
  invocationId: string;
  name: string;
  workspaceId: string;
  subjectUserId: string;
  argumentsJson?: unknown;
  status: string;
  outputJson?: unknown;
  error?: string | null;
  startedAt: string;
  finishedAt: string;
  /** B3：工具注册的 replay 声明（join tool_registrations；NULL=未声明） */
  replay?: string | null;
}

export interface ToolApprovalModel {
  id: string;
  turnId: string;
  attemptId: string;
  toolName: string;
  argumentsHash: string;
  toolVersion?: string | null;
  requester: string;
  state: "pending" | "granted" | "denied";
  decidedBy?: string | null;
  decidedAt?: string | null;
  workspaceId: string;
  subjectUserId: string;
}

export interface AgentInboxItemModel {
  id: string;
  idempotencyKey: string;
  sessionId: string;
  attemptId?: string | null;
  stepId?: string | null;
  type: "followup" | "steer" | "inject";
  orderingSeq: number;
  sourceActor: string;
  payload: unknown;
  status: "pending" | "claimed" | "acknowledged" | "expired";
  consumeBoundary: "next-turn" | "next-step";
  claimedAt?: string | null;
  ackedAt?: string | null;
  expiresAt?: string | null;
  workspaceId: string;
  subjectUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentInboxEnqueueInput {
  id: string;
  idempotencyKey: string;
  sessionId: string;
  attemptId?: string | null;
  stepId?: string | null;
  type: "followup" | "steer" | "inject";
  sourceActor: "user" | "agent" | "plugin";
  payload: unknown;
  consumeBoundary?: "next-turn" | "next-step";
  expiresAt?: string | null;
}
