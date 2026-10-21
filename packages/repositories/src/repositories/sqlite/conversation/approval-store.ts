/**
 * Aervox｜思隅 @aervox/repositories — 工具授权账本（待决/裁决/复用）Store
 */
import { eq, and, or, isNull, desc, notLike } from "drizzle-orm";
import type { AervoxDatabase } from "../../../client.js";
import { toolApprovals, turns, turnAttempts, toolExecutions, turnStreamEvents } from "@aervox/schema";
import type { LocalContext } from "../../../local-context.js";
import type { ToolApprovalModel } from "../../types/index.js";

export class ApprovalStore {
  constructor(private readonly db: AervoxDatabase) {}

  /** 记录一条工具授权（阶段 3a） */
  async recordToolApproval(
    ctx: LocalContext,
    input: {
      turnId: string;
      attemptId: string;
      toolName: string;
      argumentsHash: string;
      requester: string;
      state: "pending" | "granted" | "denied";
      toolVersion?: string | null;
    },
  ): Promise<ToolApprovalModel> {
    // E1（§12.2「ToolInvocation + 授权快照 + 幂等预留」）：同 (toolName, argumentsHash) 已存在
    // 未决（pending）授权仅在本 Turn 复用；已批准记录仍按工具与参数跨 Turn 匹配，
    // 幂等预留语义：重复的写工具意图不会产生多行待决授权。granted/denied 后新请求才新建。
    if (input.state === "pending") {
      const [existing] = await this.db
        .select()
        .from(toolApprovals)
        .where(
          and(
            eq(toolApprovals.toolName, input.toolName),
            eq(toolApprovals.argumentsHash, input.argumentsHash),
            eq(toolApprovals.state, "pending"),
            eq(toolApprovals.turnId, input.turnId),
          ),
        )
        .orderBy(desc(toolApprovals.id))
        .limit(1);
      if (existing) return existing as ToolApprovalModel;
    }
    const [created] = await this.db
      .insert(toolApprovals)
      .values({
        id: `tapp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        turnId: input.turnId,
        attemptId: input.attemptId,
        toolName: input.toolName,
        argumentsHash: input.argumentsHash,
        toolVersion: input.toolVersion ?? null,
        requester: input.requester,
        state: input.state,
      })
      .returning();
    return created as ToolApprovalModel;
  }

  /** 决定（grant/deny）一条待决授权 */
  async decideToolApproval(
    ctx: LocalContext,
    approvalId: string,
    decision: "granted" | "denied",
    decidedBy: string,
  ): Promise<ToolApprovalModel | null> {
    const [updated] = await this.db
      .update(toolApprovals)
      .set({
        state: decision,
        decidedBy,
        decidedAt: new Date().toISOString(),
      })
      .from(turns)
      .where(
        and(
          eq(toolApprovals.id, approvalId),
          eq(toolApprovals.turnId, turns.id),
        ),
      )
      .returning();
    return (updated as ToolApprovalModel) ?? null;
  }

  /** Decide and reserve the never-executed intent under the same writer transaction. */
  async decideAndResume(ctx: LocalContext, input: {
    turnId: string; approvalId: string; decision: "granted" | "denied"; decidedBy: string;
  }) {
    return this.db.transaction(async tx => {
      const [approval] = await tx.select().from(toolApprovals).where(and(
        eq(toolApprovals.id, input.approvalId), eq(toolApprovals.turnId, input.turnId),
      )).limit(1);
      if (!approval) return null;
      const events = await tx.select().from(turnStreamEvents).where(eq(turnStreamEvents.turnId, input.turnId))
        .orderBy(desc(turnStreamEvents.sequence));
      if (approval.state !== "pending") {
        const event = events.find(event => ["tool_approval_granted", "tool_approval_denied"].includes(event.eventType)
          && (event.data as { approvalId?: string })?.approvalId === approval.id) ?? null;
        return { approval, continuation: null, event, ready: true };
      }
      const [turn] = await tx.select().from(turns).where(eq(turns.id, input.turnId)).limit(1);
      const [latest] = await tx.select().from(turnAttempts).where(eq(turnAttempts.turnId, input.turnId))
        .orderBy(desc(turnAttempts.attempt)).limit(1);
      const request = events.find(event => event.eventType === "tool_approval_required"
        && (event.data as { approvalId?: string; argumentsHash?: string })?.approvalId === approval.id
        && (event.data as { argumentsHash?: string }).argumentsHash === approval.argumentsHash);
      const data = request?.data as { invocationId?: string } | undefined;
      // Legacy requests lack host/model IDs: recover them from their exact preceding intent.
      const intent = request && events.find(event => event.eventType === "tool_request"
        && event.sequence < request.sequence
        && (event.data as { name?: string })?.name === approval.toolName
        && (data?.invocationId ? (event.data as { executionId?: string }).executionId === data.invocationId
          : event.attemptId === request.attemptId));
      const call = intent?.data as { executionId?: string; invocationId?: string; name?: string } | undefined;
      const [pending] = call?.executionId ? await tx.select().from(toolExecutions).where(and(
        eq(toolExecutions.turnId, input.turnId), eq(toolExecutions.attemptId, request!.attemptId!),
        eq(toolExecutions.invocationId, call.executionId), eq(toolExecutions.name, approval.toolName),
        eq(toolExecutions.status, "pending_approval"),
      )).limit(1) : [];
      // Do not accept an early click before Interrupted or revive cancelled/completed work.
      if (!turn || turn.status !== "Interrupted" || latest?.status !== "Interrupted"
        || !pending || latest.id !== pending.attemptId || !call?.invocationId) {
        return { approval, continuation: null, event: null, ready: false };
      }
      const now = new Date().toISOString();
      const [updated] = await tx.update(toolApprovals).set({
        state: input.decision, decidedBy: input.decidedBy, decidedAt: now,
      }).where(and(eq(toolApprovals.id, approval.id), eq(toolApprovals.state, "pending"))).returning();
      if (!updated) return null;
      const [attempt] = await tx.insert(turnAttempts).values({
        id: `att_${input.turnId}_${latest.attempt + 1}`, turnId: input.turnId,
        attempt: latest.attempt + 1, fencingToken: 0, status: "Running", startedAt: now,
      }).returning();
      // Ownership transfer allows crash recovery to mark unknown results without replaying them.
      await tx.update(toolExecutions).set({ attemptId: attempt!.id, status: "pending" })
        .where(and(eq(toolExecutions.id, pending.id), eq(toolExecutions.status, "pending_approval")));
      const sequence = Math.max(turn.lastSequence, events[0]?.sequence ?? 0) + 1;
      const [event] = await tx.insert(turnStreamEvents).values({
        id: `tev_${input.turnId}_${sequence}`, turnId: input.turnId, attemptId: attempt!.id,
        sequence, eventType: input.decision === "granted" ? "tool_approval_granted" : "tool_approval_denied",
        occurredAt: now, data: { approvalId: approval.id, decision: input.decision,
          toolName: approval.toolName, continuationAttemptId: attempt!.id },
      }).returning();
      await tx.update(turns).set({ status: "Running", lastSequence: sequence, updatedAt: now })
        .where(eq(turns.id, input.turnId));
      const step = Number(call.executionId!.split(":").at(-2));
      return { approval: updated, event, ready: true,
        continuation: { attempt: attempt!, pending, turn, toolCallId: call.invocationId,
          step: Number.isSafeInteger(step) && step > 0 ? step : 1 } };
    }, { behavior: "immediate" });
  }

  /** 3b：读单条授权记录（privileged 管理员校验预检用） */
  async getToolApproval(ctx: LocalContext, approvalId: string): Promise<ToolApprovalModel | null> {
    const [row] = await this.db
      .select()
      .from(toolApprovals)
      .where(
        and(
          eq(toolApprovals.id, approvalId),
        ),
      )
      .limit(1);
    return (row as ToolApprovalModel) ?? null;
  }

  /** 查询 Turn 的授权账本 */
  async listToolApprovalsByTurn(ctx: LocalContext, turnId: string): Promise<ToolApprovalModel[]> {
    const rows = await this.db
      .select()
      .from(toolApprovals)
      .where(
        and(
          eq(toolApprovals.turnId, turnId),
        ),
      )
      .orderBy(desc(toolApprovals.id));
    return rows as ToolApprovalModel[];
  }

  /** 匹配已授权记录（toolName + argumentsHash；跨 turn 复用，取最近一条） */
  async findGrantedToolApproval(
    ctx: LocalContext,
    input: {
      toolName: string;
      argumentsHash: string;
      excludeDecidedByPrefix?: string;
      excludeDecidedByPrefixes?: string[];
    },
  ): Promise<ToolApprovalModel | null> {
    const excludedPrefixes = [
      ...(input.excludeDecidedByPrefixes ?? []),
      ...(input.excludeDecidedByPrefix ? [input.excludeDecidedByPrefix] : []),
    ];
    const [found] = await this.db
      .select()
      .from(toolApprovals)
      .where(
        and(
          eq(toolApprovals.toolName, input.toolName),
          eq(toolApprovals.argumentsHash, input.argumentsHash),
          eq(toolApprovals.state, "granted"),
          excludedPrefixes.length > 0
            ? or(
                isNull(toolApprovals.decidedBy),
                and(...excludedPrefixes.map((prefix) => notLike(toolApprovals.decidedBy, `${prefix}%`))),
              )
            : undefined,
        ),
      )
      .orderBy(desc(toolApprovals.id));
    return (found as ToolApprovalModel) ?? null;
  }
}
