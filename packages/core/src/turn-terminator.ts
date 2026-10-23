/**
 * Aervox｜思隅 @aervox/core — Turn 终态收敛器（ITER-041）
 *
 * 从 `executor.ts` 按职责切出的第一段：把「终态如何落库」这件事从「Turn 如何推进」
 * 中剥离。二者原先混在一个 900+ 行函数里，导致取消/预算/删除闸门/租约丢失四条收敛
 * 路径与主循环交织，任何控制流改动都要在七个嵌套层之间穿行。
 *
 * 终态提交统一检查 CAS，再映射执行结果；检查点另消费控制上下文，
 * 不调用 Provider 或工具。
 */
import type { DeletionGatePort, ExecutionStorePort } from "./ports.js";
import type { ExecuteResult } from "./types.js";
import type { ControlContext } from "./control-context.js";

/** 收敛器所需的最小上下文（与 executor 解耦，避免整包回传造成循环依赖） */
export interface TerminatorContext {
  execution: ExecutionStorePort;
  turnId: string;
  attemptId: string;
  sessionId: string;
  /** claim 得到的 fencing token：所有终态 CAS 的期望值 */
  claimFencingToken: number;
  /** 已执行步数：仅 cancelled 终态回传用。
   *  以 getter 传入而非定值 —— 主循环的 stepsTaken 随Step 推进递增，
   *  收敛器必须在调用时读到当前值（定值会把取消终态的 stepsTaken 冻结在构造时刻）。 */
  readonly stepsTaken: number;
  /** 2d：删除/撤权水位闸门；缺省不启用 */
  deletionGate?: DeletionGatePort;
  /** BTD-05：统一执行控制上下文（截止/ 预算 / 取消） */
  control?: ControlContext;
  /** 单 Turn 总耗时预算（ms）；0 关闭 */
  maxTurnDurationMs?: number;
  /** Turn 起始时刻（Date.now() 基准，用于总耗时判定） */
  startedAt: number;
  interruptionReason?: () => string | undefined;
  checkFailure?: () => void;
}

type TerminalOutcome =
  | { status: "completed" | "cancelled" }
  | { status: "interrupted" | "failed"; reason: string };
type TerminalEvent = Pick<Parameters<ExecutionStorePort["finalizeAttemptWithEvent"]>[0], "eventType" | "eventData" | "safetyDecision">;

/** 所有终态共享提交与结果映射，检查点复用取消和中断入口。 */
export interface TurnTerminator {
  finalize(atSequence: number, outcome: TerminalOutcome, event: TerminalEvent): Promise<ExecuteResult>;
  /** 2b：用户取消闭环（AVX-HAR-001 §11.1）——CAS 夺终态成功才写 done */
  finalizeCancelled(atSequence: number): Promise<ExecuteResult>;
  /** 2d：预算/环境原因终止（Interrupted + done） */
  finalizeInterrupted(atSequence: number, reason: string): Promise<ExecuteResult>;
  /** 检查点：已被请求取消时立刻走取消终态；未请求则返回 null */
  abortIfCancelled(atSequence: number): Promise<ExecuteResult | null>;
  /** Step 边界守卫：取消 / 删除水位 / 预算 / ControlContext，任一命中即收敛 */
  prematureTermination(atSequence: number): Promise<ExecuteResult | null>;
}

export function createTurnTerminator(ctx: TerminatorContext): TurnTerminator {
  const { execution, turnId, attemptId, sessionId, claimFencingToken, control } = ctx;

  const finalize: TurnTerminator["finalize"] = async (atSequence, outcome, event) => {
    const statuses = { completed: "Completed", cancelled: "Cancelled", interrupted: "Interrupted", failed: "Failed" } as const;
    // Done closes an attempt, including suspensions and unsuccessful execution.
    // Keep its reason in the same atomic record so observers can distinguish a
    // pending approval from budgets, deletion or other execution interruption.
    const eventData = event.eventType === "done" && "reason" in outcome
      ? { ...(event.eventData && typeof event.eventData === "object" && !Array.isArray(event.eventData) ? event.eventData : {}), reason: outcome.reason }
      : event.eventData;
    const finalized = await execution.finalizeAttemptWithEvent({
      turnId,
      attemptId,
      status: statuses[outcome.status],
      expectedFencingToken: claimFencingToken,
      sequence: atSequence,
      ...event,
      eventData,
    });
    if (!finalized.ok) {
      const reason = "reason" in outcome ? outcome.reason.replaceAll(" ", "_") : outcome.status;
      return { status: "failed", attemptId, reason: `${reason}_finalize_contested` };
    }
    if ("reason" in outcome) return { ...outcome, attemptId };
    return { ...outcome, attemptId, lastSequence: atSequence, stepsTaken: ctx.stepsTaken };
  };

  const finalizeCancelled = (atSequence: number): Promise<ExecuteResult> =>
    finalize(atSequence, { status: "cancelled" }, {
      eventType: "done",
      eventData: { status: "Cancelled", isComplete: false, lastSequence: atSequence },
      safetyDecision: "approved",
    });

  const abortIfCancelled = async (atSequence: number): Promise<ExecuteResult | null> => {
    if (await execution.isCancelRequested({ turnId, attemptId })) {
      return finalizeCancelled(atSequence);
    }
    return null;
  };

  const finalizeInterrupted = (atSequence: number, reason: string): Promise<ExecuteResult> =>
    finalize(atSequence, { status: "interrupted", reason }, {
      eventType: "done",
      eventData: { status: "Interrupted", isComplete: false, lastSequence: atSequence },
      safetyDecision: "approved",
    });

  /** Step 边界守卫 —— 取消 / 删除撤权水位 / 总耗时预算 / ControlContext，任一命中即收敛 */
  const prematureTermination = async (atSequence: number): Promise<ExecuteResult | null> => {
    ctx.checkFailure?.();
    const reason = ctx.interruptionReason?.();
    if (reason && reason !== "cancelled") return finalizeInterrupted(atSequence, reason);
    if (control?.isExpired()) {
      return finalizeInterrupted(atSequence, "deadline_exceeded");
    }
    if (control?.budgetExceeded) return finalizeInterrupted(atSequence, "token_or_call_budget_exceeded");
    if (control?.isAborted()) {
      return finalizeCancelled(atSequence);
    }
    const cancelled = await abortIfCancelled(atSequence);
    if (cancelled) return cancelled;
    if (ctx.deletionGate && (await ctx.deletionGate.isBlocked({ turnId, sessionId }))) {
      return finalizeInterrupted(atSequence, "deletion_blocked");
    }
    const maxTurnDurationMs = ctx.maxTurnDurationMs ?? 0;
    if (maxTurnDurationMs > 0 && Date.now() - ctx.startedAt > maxTurnDurationMs) {
      return finalizeInterrupted(atSequence, "turn_timeout");
    }
    return null;
  };

  return { finalize, finalizeCancelled, finalizeInterrupted, abortIfCancelled, prematureTermination };
}
