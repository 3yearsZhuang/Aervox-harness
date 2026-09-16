/**
 * Aervox｜思隅 @aervox/repositories — 安全片段（可见前缀）与恢复候选 Store
 */
import { eq, and } from "drizzle-orm";
import type { AervoxDatabase } from "../../../client.js";
import { turnStreamEvents, turnAttempts, safeSegments } from "@aervox/schema";
import type { LocalContext } from "../../../local-context.js";
import { FencingMismatchError } from "../../../errors.js";
import { streamEventId } from "./stream-event-store.js";

/**
 * Recovery runs frequently and the host only needs a small work queue. Keep
 * candidate reads bounded even when a caller forgets to pass a page size.
 */
export const MAX_RESUME_CANDIDATE_LIMIT = 100;
/**
 * Keep multi-row safe-segment inserts below SQLite/libSQL bind-variable
 * limits. A model step normally produces far fewer rows; the cap is a guard
 * for providers that emit unusually fine-grained chunks.
 */
const SAFE_SEGMENT_BATCH_SIZE = 32;

const safeSegmentId = (turnId: string, sequence: number): string => `sseg_${turnId}_${sequence}`;

function normalizeResumeCandidateLimit(limit?: number): number {
  if (limit === undefined || limit === Infinity) return MAX_RESUME_CANDIDATE_LIMIT;
  if (!Number.isFinite(limit)) return 0;
  return Math.max(0, Math.min(MAX_RESUME_CANDIDATE_LIMIT, Math.floor(limit)));
}

export class SafeSegmentStore {
  constructor(private readonly db: AervoxDatabase) {}

  /**
   * E2（§12.2「安全片段 + TurnStreamEvent + Draft prefix」）：原子提交「安全片段 + delta 事件」。
   * BEGIN IMMEDIATE 事务内：fencing+状态守卫（同 appendStreamEvent fenced 语义）→ 插入
   * safe_segments 行（committed=1，可见前缀）与 turn_stream_events 行（delta），并回填关联。
   * 守卫失配抛 FencingMismatchError（迟到/被抢占执行器被拒，无部分写入）。
   */
  async recordSafeSegmentAtomically(
    ctx: LocalContext,
    input: {
      turnId: string;
      attemptId: string;
      sequence: number;
      text: string;
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
            `attempt ${input.attemptId} fencing=${attempt?.fencingToken ?? "?"} status=${attempt?.status ?? "?"} cannot record safe segment`,
          );
        }
        const segmentId = safeSegmentId(input.turnId, input.sequence);
        const eventId = streamEventId(input.turnId, input.sequence);
        const now = new Date().toISOString();
        // 1) delta 事件
        await tx.insert(turnStreamEvents).values({
          id: eventId,
          turnId: input.turnId,
          attemptId: input.attemptId,
          sequence: input.sequence,
          eventType: "delta",
          data: input.eventData,
          occurredAt: now,
          safetyDecision: input.safetyDecision ?? null,
        });
        // 2) 安全片段（committed=1 可见前缀）并回填事件关联
        await tx.insert(safeSegments).values({
          id: segmentId,
          turnId: input.turnId,
          attemptId: input.attemptId,
          sequence: input.sequence,
          text: input.text,
          committed: 1,
          streamEventId: eventId,
          createdAt: now,
          updatedAt: now,
        });
        return true;
      },
      { behavior: "immediate" },
    );
  }

  /**
   * E2 batch variant: retain one `safe_segments`/`delta` row per text chunk,
   * but validate fencing once and insert the whole chunk set in one transaction.
   * Large sets are split into bounded statements inside that transaction to
   * stay within SQLite parameter limits; the complete set remains atomic.
   */
  async recordSafeSegmentsAtomically(
    ctx: LocalContext,
    inputs: Array<{
      turnId: string;
      attemptId: string;
      sequence: number;
      text: string;
      eventData: unknown;
      safetyDecision?: string | null;
      expectedFencingToken: number;
    }>,
  ): Promise<boolean> {
    if (inputs.length === 0) return true;
    return this.db.transaction(
      async (tx) => {
        const first = inputs[0]!;
        const [attempt] = await tx
          .select({ status: turnAttempts.status, fencingToken: turnAttempts.fencingToken })
          .from(turnAttempts)
          .where(
            and(
              eq(turnAttempts.id, first.attemptId),
              eq(turnAttempts.turnId, first.turnId),
            ),
          );
        const running = attempt && (attempt.status === "Running" || attempt.status === "CancelRequested");
        const sameAttempt = inputs.every((input) =>
          input.turnId === first.turnId &&
          input.attemptId === first.attemptId &&
          input.expectedFencingToken === first.expectedFencingToken,
        );
        if (!attempt || attempt.fencingToken !== first.expectedFencingToken || !running || !sameAttempt) {
          throw new FencingMismatchError(
            `attempt ${first.attemptId} fencing=${attempt?.fencingToken ?? "?"} status=${attempt?.status ?? "?"} cannot record safe segment batch`,
          );
        }

        const now = new Date().toISOString();
        for (let offset = 0; offset < inputs.length; offset += SAFE_SEGMENT_BATCH_SIZE) {
          const batch = inputs.slice(offset, offset + SAFE_SEGMENT_BATCH_SIZE);
          const rows = batch.map((input) => {
            return {
              input,
              eventId: streamEventId(input.turnId, input.sequence),
              segmentId: safeSegmentId(input.turnId, input.sequence),
            };
          });
          await tx.insert(turnStreamEvents).values(rows.map(({ input, eventId }) => ({
            id: eventId,
            turnId: input.turnId,
            attemptId: input.attemptId,
            sequence: input.sequence,
            eventType: "delta",
            data: input.eventData,
            occurredAt: now,
            safetyDecision: input.safetyDecision ?? null,
          })));
          await tx.insert(safeSegments).values(rows.map(({ input, eventId, segmentId }) => ({
            id: segmentId,
            turnId: input.turnId,
            attemptId: input.attemptId,
            sequence: input.sequence,
            text: input.text,
            committed: 1,
            streamEventId: eventId,
            createdAt: now,
            updatedAt: now,
          })));
        }
        return true;
      },
      { behavior: "immediate" },
    );
  }

  /**
   * E2：读取 Turn 的已提交安全片段（可见前缀；按 sequence 升序）。
   * 供中断恢复（visible-prefix）与可见前缀重建使用。
   */
  async listCommittedSegments(
    ctx: LocalContext,
    turnId: string,
  ): Promise<Array<{ id: string; sequence: number; text: string; streamEventId: string | null }>> {
    const rows = await this.db
      .select({
        id: safeSegments.id,
        sequence: safeSegments.sequence,
        text: safeSegments.text,
        streamEventId: safeSegments.streamEventId,
      })
      .from(safeSegments)
      .where(
        and(
          eq(safeSegments.turnId, turnId),
          eq(safeSegments.committed, 1),
        ),
      )
      .orderBy(safeSegments.sequence);
    return rows;
  }

  /**
   * 3c/4b：本地恢复候选查询（供 worker 观测 + host-agent 续跑执行）。
   *
   * 命中条件：过期 Running Attempt + 存在 executed 工具执行 + 无 done 终态事件
   * （§11.3 首范式「工具结果已权威提交但尚未注入」）。
   * 返回含续跑所需完整数据面：租户、session、用户消息、当前 fencing（续跑 claim 预期）与 lastSequence。
   */
  async findResumeCandidates(
    client: import("@libsql/client").Client,
    limit?: number,
  ): Promise<
    Array<{
      attemptId: string;
      turnId: string;
      sessionId: string;
      lastSequence: number;
      userMessage: string;
      /** 续跑 claim 预期 = 当前已持有的 fencing（抢占语义） */
      fencingToken: number;
    }>
  > {
    const candidateLimit = normalizeResumeCandidateLimit(limit);
    if (candidateLimit === 0) return [];
    const now = new Date().toISOString();
    const result = await client.execute({
      sql: `
        SELECT ta.id AS attempt_id,
               ta.turn_id AS turn_id,
               ta.fencing_token AS fencing_token,
               t.session_id AS session_id,
               (SELECT mv.content FROM message_versions mv
                WHERE mv.turn_id = ta.turn_id AND mv.role = 'user'
                ORDER BY mv.version DESC LIMIT 1) AS user_message,
               (SELECT COALESCE(MAX(sequence), 0) FROM turn_stream_events e
                WHERE e.turn_id = ta.turn_id AND e.event_type = 'tool_result') AS last_sequence
        FROM turn_attempts ta
        JOIN turns t ON t.id = ta.turn_id
        WHERE ta.status = 'Running'
          AND ta.lease_expires_at IS NOT NULL
          AND ta.lease_expires_at < ?
          AND EXISTS (SELECT 1 FROM tool_executions te
                      WHERE te.attempt_id = ta.id AND te.status = 'executed')
          AND NOT EXISTS (SELECT 1 FROM turn_stream_events e2
                          WHERE e2.turn_id = ta.turn_id AND e2.event_type = 'done')
        ORDER BY ta.lease_expires_at ASC, ta.id ASC
        LIMIT ?
      `,
      args: [now, candidateLimit],
    });
    return result.rows.map((row) => ({
      attemptId: String(row.attempt_id),
      turnId: String(row.turn_id),
      sessionId: String(row.session_id ?? ""),
      lastSequence: Number(row.last_sequence),
      userMessage: String(row.user_message ?? ""),
      fencingToken: Number(row.fencing_token ?? 0),
    }));
  }

  /** 2c：崩溃释放后将遗留 pending 预留标记为 outcome_unknown（§11.3：结果未知不自动重放） */
  async markPendingOutcomeUnknown(client: import("@libsql/client").Client): Promise<number> {
    const result = await client.execute(`
      UPDATE tool_executions
      SET status = 'outcome_unknown', finished_at = COALESCE(finished_at, '${new Date().toISOString()}')
      WHERE status = 'pending'
        AND attempt_id IN (
          SELECT id FROM turn_attempts
          WHERE status IN ('Interrupted', 'Failed', 'Cancelled')
        )
    `);
    return result.rowsAffected ?? 0;
  }
}
