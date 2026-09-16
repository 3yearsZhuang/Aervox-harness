/**
 * Aervox｜思隅 @aervox/repositories — TurnAttempt（领取/租约/终态/恢复）Store
 */
import { eq, and, or, lt, isNull, inArray, notInArray, desc } from "drizzle-orm";
import type { AervoxDatabase } from "../../../client.js";
import { turnAttempts, turns } from "@aervox/schema";
import type { LocalContext } from "../../../local-context.js";
import type { TurnAttemptModel } from "../../types/index.js";

export class AttemptStore {
  constructor(private readonly db: AervoxDatabase) {}

  async createTurnAttempt(
    ctx: LocalContext,
    turnId: string,
    attemptData: { id: string; attempt?: number; leaseId?: string | null; fencingToken?: number },
  ): Promise<TurnAttemptModel> {
    const [created] = await this.db
      .insert(turnAttempts)
      .values({
        id: attemptData.id,
        turnId,
        attempt: attemptData.attempt ?? 1,
        leaseId: attemptData.leaseId ?? null,
        fencingToken: attemptData.fencingToken ?? 0,
        status: "Running",
        startedAt: new Date().toISOString(),
      })
      .returning();
    return created as TurnAttemptModel;
  }

  async listTurnAttempts(ctx: LocalContext, turnId: string): Promise<TurnAttemptModel[]> {
    const rows = await this.db
      .select({ attempt: turnAttempts })
      .from(turnAttempts)
      .innerJoin(turns, eq(turnAttempts.turnId, turns.id))
      .where(
        and(
          eq(turnAttempts.turnId, turnId),
        ),
      )
      .orderBy(desc(turnAttempts.attempt));
    return rows.map((r) => r.attempt) as TurnAttemptModel[];
  }

  /**
   * 领取 TurnAttempt（CAS + fencing + 租约）：可领取 =
   * Running 且 fencing 匹配 且 租约为空或已过期（3b-B 抢占语义：未过期租约不可被抢占）。
   * 成功后递增 fencing 并绑定新租约（TTL），防止重复执行（AVX-HAR-001 §11.2）。
   */
  async claimTurnAttempt(
    ctx: LocalContext,
    input: {
      turnId: string;
      attemptId: string;
      expectedFencingToken: number;
      leaseId: string;
      ttlMs?: number;
    },
  ): Promise<{ ok: boolean; fencingToken: number; leaseId: string; leaseExpiresAt: string }> {
    const ttlMs = input.ttlMs ?? 60_000;
    const nowIso = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + ttlMs).toISOString();
    // turn_attempts 无租户列，经 turns 关联校验租户后做 CAS 更新
    const [updated] = await this.db
      .update(turnAttempts)
      .set({
        leaseId: input.leaseId,
        fencingToken: input.expectedFencingToken + 1,
        leaseExpiresAt,
      })
      .from(turns)
      .where(
        and(
          eq(turnAttempts.turnId, turns.id),
          eq(turnAttempts.id, input.attemptId),
          eq(turnAttempts.turnId, input.turnId),
          eq(turnAttempts.status, "Running"),
          eq(turnAttempts.fencingToken, input.expectedFencingToken),
          or(isNull(turnAttempts.leaseExpiresAt), lt(turnAttempts.leaseExpiresAt, nowIso)),
        ),
      )
      .returning();
    if (!updated) {
      return { ok: false, fencingToken: input.expectedFencingToken, leaseId: input.leaseId, leaseExpiresAt };
    }
    return { ok: true, fencingToken: (updated as TurnAttemptModel).fencingToken, leaseId: input.leaseId, leaseExpiresAt };
  }

  /** 3b-A：续租（CAS：leaseId + fencing 匹配且 Running 才刷新 leaseExpiresAt） */
  async renewTurnAttemptLease(
    ctx: LocalContext,
    input: { attemptId: string; leaseId: string; expectedFencingToken: number; ttlMs?: number },
  ): Promise<boolean> {
    const ttlMs = input.ttlMs ?? 60_000;
    const leaseExpiresAt = new Date(Date.now() + ttlMs).toISOString();
    const [updated] = await this.db
      .update(turnAttempts)
      .set({ leaseExpiresAt })
      .from(turns)
      .where(
        and(
          eq(turnAttempts.id, input.attemptId),
          eq(turnAttempts.leaseId, input.leaseId),
          eq(turnAttempts.fencingToken, input.expectedFencingToken),
          eq(turnAttempts.status, "Running"),
          eq(turnAttempts.turnId, turns.id),
        ),
      )
      .returning();
    return Boolean(updated);
  }

  /** 提交 TurnAttempt 终态（失败/完成/中断），并记录结束时间 */
  async finalizeTurnAttempt(
    ctx: LocalContext,
    input: { turnId: string; attemptId: string; status: string; finishedAt?: string; expectedFencingToken?: number },
  ): Promise<TurnAttemptModel | null> {
    const conditions = [
      eq(turnAttempts.turnId, turns.id),
      eq(turnAttempts.id, input.attemptId),
      eq(turnAttempts.turnId, input.turnId),
    ];
    // 3b-B：单一终态（仅运行中状态 Running/CancelRequested 可提交；提供 fencing 期望值时 CAS 校验）
    conditions.push(
      inArray(turnAttempts.status, ["Running", "CancelRequested"]),
    );
    if (input.expectedFencingToken !== undefined) {
      conditions.push(eq(turnAttempts.fencingToken, input.expectedFencingToken));
    }
    const [updated] = await this.db
      .update(turnAttempts)
      .set({
        status: input.status,
        finishedAt: input.finishedAt ?? new Date().toISOString(),
      })
      .from(turns)
      .where(and(...conditions))
      .returning();
    return (updated as TurnAttemptModel) ?? null;
  }

  /** 2b：用户取消请求位（CAS：仅 Running attempt → CancelRequested，并同步 turns 若未终态） */
  async requestCancelTurnAttempt(
    ctx: LocalContext,
    input: { turnId: string; attemptId: string },
  ): Promise<{ ok: boolean; reason?: "not_found" | "already_finalized" }> {
    const [updatedAttempt] = await this.db
      .update(turnAttempts)
      .set({ status: "CancelRequested" })
      .from(turns)
      .where(
        and(
          eq(turnAttempts.turnId, turns.id),
          eq(turnAttempts.id, input.attemptId),
          eq(turnAttempts.turnId, input.turnId),
          eq(turnAttempts.status, "Running"),
        ),
      )
      .returning();
    if (!updatedAttempt) {
      const exists = await this.getTurnAttemptStatus(ctx, input);
      return exists === null
        ? { ok: false, reason: "not_found" }
        : { ok: false, reason: "already_finalized" };
    }
    // turns 终态保护：仅未终态可置 Cancelled；已终态（Completed/Failed/Interrupted/Cancelled 等）不覆盖
    await this.db
      .update(turns)
      .set({ status: "Cancelled" })
      .where(
        and(
          eq(turns.id, input.turnId),
          notInArray(turns.status, ["Completed", "Failed", "Interrupted", "Cancelled"]),
        ),
      );
    return { ok: true };
  }

  /** 2b：读取 Attempt 当前状态（executor 取消检查点轮询） */
  async getTurnAttemptStatus(
    ctx: LocalContext,
    input: { turnId: string; attemptId: string },
  ): Promise<string | null> {
    const [row] = await this.db
      .select({ status: turnAttempts.status })
      .from(turnAttempts)
      .innerJoin(turns, eq(turnAttempts.turnId, turns.id))
      .where(
        and(
          eq(turnAttempts.id, input.attemptId),
          eq(turnAttempts.turnId, input.turnId),
        ),
      )
      .limit(1);
    return (row as { status: string } | undefined)?.status ?? null;
  }

  /** 3b-B：恢复过期 Attempt（扫描 Running + 租约过期 → fencing+1 + Interrupted + finishedAt） */
  async recoverExpiredAttempts(client: import("@libsql/client").Client): Promise<number> {
    const now = new Date().toISOString();
    const result = await client.execute(`
      UPDATE turn_attempts
      SET status = 'Interrupted',
          fencing_token = fencing_token + 1,
          finished_at = '${now}'
      WHERE status = 'Running'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at < '${now}'
    `);
    // SQLite UPDATE 不返回行，受影响行数由 libsql rowsAffected 提供
    return result.rowsAffected ?? 0;
  }
}
