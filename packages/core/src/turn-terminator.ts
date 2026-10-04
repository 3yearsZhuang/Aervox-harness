/**
 * Aervox｜思隅 @aervox/core — Turn 终态收敛器（ITER-041）
 *
 * 从 `executor.ts` 按职责切出的第一段：把「终态如何落库」这件事从「Turn 如何推进」
 * 中剥离。二者原先混在一个 900+ 行函数里，导致取消/预算/删除闸门/租约丢失四条收敛
 * 路径与主循环交织，任何控制流改动都要在七个嵌套层之间穿行。
 *
 * 收敛器只依赖三样东西：执行存储端口、本次 claim 的 fencing 租约标识、已执行步数 ——
 * 不读`ControlContext`、不碰 Provider 与工具，因此可独立推理与测试。
 *
 * 行为等价性（ITER-041 gate）：本段为纯搬迁，未改任何判定顺序、CAS 参数或 reason 字符串。
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
}

/** 收敛器出口：三个终态提交器 + 一个 Step 边界守卫 */
export interface TurnTerminator {
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

  const finalizeCancelled = async (atSequence: number): Promise<ExecuteResult> => {
    // B4-D：终态 + done 事件原子提交（§12.2；CAS 失败即他方已终结 → 无孤儿 done）
    const finalized = await execution.finalizeAttemptWithEvent({
      turnId,
      attemptId,
      status: "Cancelled",
      expectedFencingToken: claimFencingToken,
      sequence: atSequence,
      eventType: "done",
      eventData: { status: "Cancelled", isComplete: false, lastSequence: atSequence },
      safetyDecision: "approved",
    });
    if (!finalized.ok) {
      // 终态 CAS 失败（他方已终结/抢占）→ 不写 done，返回 contested
      return { status: "failed", attemptId, reason: "cancelled_finalize_contested" };
    }
    return { status: "cancelled", attemptId, lastSequence: atSequence, stepsTaken: ctx.stepsTaken };
  };

  const abortIfCancelled = async (atSequence: number): Promise<ExecuteResult | null> => {
    if (await execution.isCancelRequested({ turnId, attemptId })) {
      return finalizeCancelled(atSequence);
    }
    return null;
  };

  const finalizeInterrupted = async (atSequence: number, reason: string): Promise<ExecuteResult> => {
    // B4-D：终态 + done 事件原子提交（§12.2；CAS 失败即他方已终结 → 无孤儿 done）
    const finalized = await execution.finalizeAttemptWithEvent({
      turnId,
      attemptId,
      status: "Interrupted",
      expectedFencingToken: claimFencingToken,
      sequence: atSequence,
      eventType: "done",
      eventData: { status: "Interrupted", isComplete: false, lastSequence: atSequence, reason },
      safetyDecision: "approved",
    });
    if (!finalized.ok) {
      return { status: "failed", attemptId, reason: `${reason}_finalize_contested` };
    }
    // 收敛语义：库内终态 Interrupted ↔ 返回值 interrupted（ITER-042 命名收敛）
    return { status: "interrupted", attemptId, reason };
  };

  /** Step 边界守卫 —— 取消 / 删除撤权水位 / 总耗时预算 / ControlContext，任一命中即收敛 */
  const prematureTermination = async (atSequence: number): Promise<ExecuteResult | null> => {
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

  return { finalizeCancelled, finalizeInterrupted, abortIfCancelled, prematureTermination };
}
