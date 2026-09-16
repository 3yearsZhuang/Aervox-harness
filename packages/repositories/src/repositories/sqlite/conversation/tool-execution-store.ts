/**
 * Aervox｜思隅 @aervox/repositories — 工具执行账本（幂等预留/原子收口）Store
 */
import { eq, and, or, inArray, desc } from "drizzle-orm";
import type { AervoxDatabase } from "../../../client.js";
import {
  turns,
  turnStreamEvents,
  turnAttempts,
  toolExecutions,
  toolRegistrations,
} from "@aervox/schema";
import type { LocalContext } from "../../../local-context.js";
import { FencingMismatchError } from "../../../errors.js";
import type { ToolExecutionModel } from "../../types/index.js";
import { streamEventId } from "./stream-event-store.js";

export class ToolExecutionStore {
  constructor(private readonly db: AervoxDatabase) {}

  /** 记录一次工具执行（副作用证据账本，AVX-HAR-001 §12；阶段 2d） */
  async recordToolExecution(
    ctx: LocalContext,
    input: {
      turnId: string;
      attemptId: string;
      invocationId: string;
      name: string;
      arguments?: unknown;
      status: string;
      output?: unknown;
      error?: string | null;
      startedAt: string;
      finishedAt: string;
    },
  ): Promise<ToolExecutionModel> {
    const [created] = await this.db
      .insert(toolExecutions)
      .values({
        id: `tex_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        turnId: input.turnId,
        attemptId: input.attemptId,
        invocationId: input.invocationId,
        name: input.name,
        argumentsJson: input.arguments,
        status: input.status,
        outputJson: input.output,
        error: input.error ?? null,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
      })
      .returning();
    return created as ToolExecutionModel;
  }

  /** 2c：幂等预留（§9 idempotency reservation；attempt+invocation 唯一，ON CONFLICT DO NOTHING） */
  async reserveToolExecution(
    ctx: LocalContext,
    input: {
      turnId: string;
      attemptId: string;
      invocationId: string;
      name: string;
      arguments?: unknown;
    },
  ): Promise<{ ok: boolean; alreadyReserved: boolean }> {
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(toolExecutions)
      .values({
        id: `tex_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        turnId: input.turnId,
        attemptId: input.attemptId,
        invocationId: input.invocationId,
        name: input.name,
        argumentsJson: input.arguments,
        status: "pending",
        startedAt: now,
        finishedAt: now,
      })
      .onConflictDoNothing({ target: [toolExecutions.attemptId, toolExecutions.invocationId] })
      .returning();
    return { ok: true, alreadyReserved: !created };
  }

  /** 2c：以权威结果收口预留行（UPDATE by attempt+invocation） */
  async updateToolExecutionResult(
    ctx: LocalContext,
    input: {
      turnId: string;
      attemptId: string;
      invocationId: string;
      status: string;
      output?: unknown;
      error?: string;
      finishedAt?: string;
    },
  ): Promise<{ ok: boolean }> {
    const [updated] = await this.db
      .update(toolExecutions)
      .set({
        status: input.status,
        outputJson: input.output,
        error: input.error ?? null,
        finishedAt: input.finishedAt ?? new Date().toISOString(),
      })
      .from(turns)
      .where(
        and(
          eq(toolExecutions.turnId, turns.id),
          eq(toolExecutions.attemptId, input.attemptId),
          eq(toolExecutions.invocationId, input.invocationId),
        ),
      )
      .returning();
    return { ok: Boolean(updated) };
  }

  /**
   * B4-D（§12.2）：原子提交「工具结果账本收口 + tool_result 事件」。
   * BEGIN IMMEDIATE 事务内：fencing+状态守卫（同 appendStreamEvent fenced 语义）→
   * 写入 tool_executions 结果与 turn_stream_events 事件，两者同生共死。
   * 守卫失配抛 FencingMismatchError（迟到/被抢占执行器被拒）。
   */
  async recordToolOutcomeAtomically(
    ctx: LocalContext,
    input: {
      turnId: string;
      attemptId: string;
      sequence: number;
      invocationId: string;
      name: string;
      arguments: unknown;
      status: string;
      output?: unknown;
      error?: string;
      startedAt: string;
      finishedAt?: string;
      eventData: unknown;
      safetyDecision?: string | null;
      expectedFencingToken: number;
    },
  ): Promise<boolean> {
    return this.db.transaction(
      async (tx) => {
        const [attempt] = await tx
          .select({ status: turnAttempts.status, fencingToken: turnAttempts.fencingToken })
          .from(turnAttempts)
          .where(
            and(
              eq(turnAttempts.id, input.attemptId),
              eq(turnAttempts.turnId, input.turnId),
            ),
          );
        const running = attempt && (attempt.status === "Running" || attempt.status === "CancelRequested");
        if (!attempt || attempt.fencingToken !== input.expectedFencingToken || !running) {
          throw new FencingMismatchError(
            `attempt ${input.attemptId} fencing=${attempt?.fencingToken ?? "?"} status=${attempt?.status ?? "?"} cannot record tool outcome`,
          );
        }
        await tx.insert(turnStreamEvents).values({
          id: streamEventId(input.turnId, input.sequence),
          turnId: input.turnId,
          attemptId: input.attemptId,
          sequence: input.sequence,
          eventType: "tool_result",
          data: input.eventData,
          occurredAt: new Date().toISOString(),
          safetyDecision: input.safetyDecision ?? null,
        });
        await tx
          .update(toolExecutions)
          .set({
            status: input.status,
            outputJson: input.output,
            error: input.error ?? null,
            finishedAt: input.finishedAt ?? new Date().toISOString(),
          })
          .from(turns)
          .where(
            and(
              eq(toolExecutions.turnId, turns.id),
              eq(toolExecutions.attemptId, input.attemptId),
              eq(toolExecutions.invocationId, input.invocationId),
            ),
          );
        return true;
      },
      { behavior: "immediate" },
    );
  }

  /**
   * B4-D（§12.2）：原子提交「Attempt 终态 + 收尾事件（done/error）」。
   * BEGIN IMMEDIATE 事务内：终态 CAS（仅 Running/CancelRequested + fencing 匹配，3b-B 单一终态）
   * 成功才一并插入 done/error 事件；CAS 失败返回 false（不写事件，杜绝孤儿 done）。
   */
  async finalizeAttemptWithEventAtomically(
    ctx: LocalContext,
    input: {
      turnId: string;
      attemptId: string;
      status: string;
      expectedFencingToken: number;
      sequence: number;
      eventType: string; // "done" | "error"
      eventData: unknown;
      safetyDecision?: string | null;
    },
  ): Promise<boolean> {
    return this.db.transaction(
      async (tx) => {
        const [updated] = await tx
          .update(turnAttempts)
          .set({ status: input.status, finishedAt: new Date().toISOString() })
          .from(turns)
          .where(
            and(
              eq(turnAttempts.turnId, turns.id),
              eq(turnAttempts.id, input.attemptId),
              eq(turnAttempts.turnId, input.turnId),
              inArray(turnAttempts.status, ["Running", "CancelRequested"]),
              eq(turnAttempts.fencingToken, input.expectedFencingToken),
            ),
          )
          .returning({ id: turnAttempts.id });
        if (!updated) return false;
        await tx.insert(turnStreamEvents).values({
          id: streamEventId(input.turnId, input.sequence),
          turnId: input.turnId,
          attemptId: input.attemptId,
          sequence: input.sequence,
          eventType: input.eventType,
          data: input.eventData,
          occurredAt: new Date().toISOString(),
          safetyDecision: input.safetyDecision ?? null,
        });
        return true;
      },
      { behavior: "immediate" },
    );
  }

  /** 查询 Turn 的工具执行账本（按时间倒序；join tool_registrations 携带 replay 声明供恢复裁决） */
  async listToolExecutionsByTurn(ctx: LocalContext, turnId: string): Promise<ToolExecutionModel[]> {
    const rows = await this.db
      .select({ execution: toolExecutions, registration: toolRegistrations })
      .from(toolExecutions)
      .leftJoin(
        toolRegistrations,
        or(eq(toolRegistrations.id, toolExecutions.name), eq(toolRegistrations.name, toolExecutions.name)),
      )
      .where(
        and(
          eq(toolExecutions.turnId, turnId),
        ),
      )
      .orderBy(desc(toolExecutions.startedAt));
    return rows.map((row) => ({
      ...row.execution,
      replay: row.registration?.replay ?? null,
    })) as ToolExecutionModel[];
  }
}
