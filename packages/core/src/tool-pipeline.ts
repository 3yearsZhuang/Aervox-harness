/**
 * Aervox｜思隅 @aervox/core — 工具执行管线（ITER-041 第三段）
 *
 * 从 `executor.ts` 按职责切出的第三段：把「已通过幂等预留与入参校验的一次工具调用，
 * 如何走到一个终局结果」这段抽出。
 *
 * 原实现里这段深��主循环六层，六件事挤在一个 try 块里：审批前置拦截 → 子任务
 * ControlContext 派生 → 真实执行 → 租约丢失中止 → 异常归类 → 资源清理。
 * 其中每一条都是安全或幂等相关的关键路径，却没有任何单元测试能直接锁定 ——
 * 它们只能通过整 Turn 的端到端用例间接覆盖。
 *
 * 本模块的边界选择：**只管「执行」不管「记账」**。账本收口（tool-ledger.ts）与
 * 事件序号分配留在executor 侧，因为它们必须与主循环共享 `sequence` 计数器；
 * 而执行本身（审批 → 派生 → 执行 → 归类）不消耗事件序号，是自包含的。
 *
 * 行为等价性（ITER-041 gate）：本段为纯搬迁，判定顺序、异常语义、subtask 派生参数
 * 与 dispose 时机均未改动。租约丢失仍以 `LeaseLostError` 抛给外层统一收敛。
 */
import { awaitWithSignal } from "./abortable.js";
import { LeaseLostError } from "./errors.js";
import { decideToolCall } from "./approval-decision.js";
import { inspectToolInput } from "./tool-input-safe.js";
import type { ApprovalPolicyPort, ToolProviderPort, ToolSafetyLevel } from "./ports.js";
import type { ControlContext } from "./control-context.js";
import type { ExecuteResult, ToolCallRequest, ToolCallResult } from "./types.js";
import type { LeaseHeartbeat } from "./lease-heartbeat.js";

/** 长耗时工具的放宽超时（ms）：ask_user_question 等用户交互、aervox_diary_write 内含 LLM 生成 */
const LONG_RUNNING_TOOL_TIMEOUT_MS = 120000;
/** 命中即放宽超时的工具名（宿主可注册同名工具，故按名判定） */
const LONG_RUNNING_TOOLS = new Set(["ask_user_question", "aervox_diary_write"]);

/**
 * 工具执行超时的兜底（缺陷 D）：超时 → abort 取消信号并向底层传播，同时 reject；
 * promise settle → 清理 timer。调用方须把 controller.signal 透传给 tools.execute，
 * 使长工具能感知取消并及时清理挂起副作用，避免「超时后底层仍在执行/写副作用」。
 */
function withTimeout<T>(promise: Promise<T>, ms: number, controller?: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller?.abort();
      reject(new Error("tool_timeout"));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** 单次工具执行所需上下文 */
export interface ToolExecutionContext {
  turnId: string;
  attemptId: string;
  sessionId: string;
  /** Host 幂等键（attempt:step:seq） */
  executionId: string;
  call: ToolCallRequest;
  /** 工具提供者（含只读工具清单，用于安全级别判定） */
  tools: ToolProviderPort;
  /** 审批 SPI；缺省则不做审批前置拦截 */
  approvalPolicy?: ApprovalPolicyPort;
  /** 统一执行控制上下文（预算/ 截止 / 取消） */
  control?: ControlContext;
  /** 租约心跳：工具执行期丢失则立即中止在途副作用 */
  heartbeat?: LeaseHeartbeat | null;
  /** 单工具超时（ms） */
  toolTimeoutMs: number;
  /**
   * Step 边界守卫：真实执行前调用，返回非 null 即中止本Step（取消/预算/删除水位）。
   * 由executor 注入 —— 守卫涉及事件序号与终态提交，不属本模块职责。
   */
  prematureTermination: () => Promise<ExecuteResult | null>;
  /** 预算耗尽时收敛Interrupted（由 executor 注入以复用其终态提交路径） */
  finalizeInterrupted: (reason: string) => Promise<ExecuteResult>;
}

/** 工具执行中断信号：抛出即交回executor 主循环收敛 */
export class ToolExecutionAborted extends Error {
  constructor(readonly result: ExecuteResult) {
    // ExecuteResult 是判别联合：reason 只在 failed / skipped 分支存在
    const reason = "reason" in result ? result.reason : result.status;
    super(`tool execution aborted: ${reason}`);
    this.name = "ToolExecutionAborted";
  }
}

/**
 * 执行一次已预留的工具调用，返回其终局结果。
 *
 * 流程：入参沙箱校验 → 审批前置拦截（可选）→ 子任务 ControlContext 派生 →
 * 真实执行 → 异常归类。**不写账本、不发事件**（由调用方settleToolLedger 收口）。
 *
 * 抛出情形（交由调用方处理，勿在此吞掉）：
 * - `ToolExecutionAborted`：Step 边界守卫或预算耗尽，中止整个 Step；
 * - `LeaseLostError`：租约丢失，须立即中止且不产生新副作用（AVX-HAR-001 §11.2）。
 */
export async function runToolExecution(ctx: ToolExecutionContext): Promise<ToolCallResult> {
  const { call, tools, control, heartbeat, toolTimeoutMs, executionId } = ctx;

  // B4-B：工具入参沙箱校验（防路径穿越、防空字节、防命令注入）
  const inputInspection = inspectToolInput({ name: call.name, arguments: call.arguments });
  if (!inputInspection.safe) {
    return {
      id: call.id,
      name: call.name,
      ok: false,
      error: `unsafe_tool_arguments: ${inputInspection.reason ?? "validation_failed"}`,
    };
  }

  // 长耗时工具放宽超时：等待用户交互 / 内含一次完整 LLM 生成
  const effectiveTimeout = LONG_RUNNING_TOOLS.has(call.name)
    ? Math.max(toolTimeoutMs, LONG_RUNNING_TOOL_TIMEOUT_MS)
    : toolTimeoutMs;

  let subtaskControl: ControlContext | undefined;
  let removeLostListener: (() => void) | undefined;
  try {
    const stop = await ctx.prematureTermination();
    if (stop) throw new ToolExecutionAborted(stop);
    if (control && (control.remainingCalls < 1 || control.remainingTokens <= 0)) {
      throw new ToolExecutionAborted(await ctx.finalizeInterrupted("budget_exhausted"));
    }

    // Phase 2: ApprovalPolicyPort 统一审批前置拦截（有界等待：策略不合作时由 abort 信号打破）
    let result: ToolCallResult | undefined;
    if (ctx.approvalPolicy) {
      const spec = (tools.tools || []).find((t) => t.name === call.name);
      const safetyLevel: ToolSafetyLevel = spec?.readOnly ? "read_only" : "write_with_approval";
      const decision = await awaitWithSignal(
        ctx.approvalPolicy.evaluate(
          {
            turnId: ctx.turnId,
            attemptId: ctx.attemptId,
            invocationId: executionId,
            toolName: call.name,
            arguments: call.arguments,
            safetyLevel,
          },
          control?.abortSignal,
        ),
        control?.abortSignal,
      );
      // 裁决映射收敛至 decideToolCall（与 withApprovalPolicy 装饰器共用单一真源）
      // 返回 undefined 表示准予执行 → 继续落到真实执行分支
      result = decideToolCall(decision, { call, invocationId: executionId });
    }

    if (!result) {
      const cancel = new AbortController();
      removeLostListener = heartbeat?.onLost(() => cancel.abort());
      const signal = control ? AbortSignal.any([control.abortSignal, cancel.signal]) : cancel.signal;
      subtaskControl = control?.deriveSubtask({
        subtaskExecutionId: executionId,
        subtaskSignal: signal,
        tighterDeadlineEpochMs: effectiveTimeout > 0 ? Date.now() + effectiveTimeout : undefined,
      });
      control?.recordCallUsed();
      const executed = await withTimeout(
        awaitWithSignal(
          tools.execute({
            turnId: ctx.turnId,
            attemptId: ctx.attemptId,
            invocationId: executionId,
            name: call.name,
            arguments: call.arguments,
            sessionId: ctx.sessionId,
            signal: subtaskControl?.abortSignal ?? signal,
            controlContext: subtaskControl,
          }),
          subtaskControl?.abortSignal ?? signal,
        ),
        effectiveTimeout,
        cancel,
      );
      result = {
        id: call.id,
        name: call.name,
        ok: executed.ok,
        output: executed.output,
        error: executed.error,
        needsApproval: executed.needsApproval,
      };
    }
    return result;
  } catch (err) {
    // 中止信号交回调用方主循环收敛（工具未执行，无副作用需收口）
    if (err instanceof ToolExecutionAborted) throw err;
    // B2：工具执行期间租约已失（心跳探知）→ 立即中止本 Step，不写结果事件、不启动新副作用
    if (heartbeat?.lost) {
      throw new LeaseLostError("lease lost during tool execution");
    }
    return {
      id: call.id,
      name: call.name,
      ok: false,
      error: err instanceof Error ? err.message : "tool_execution_error",
    };
  } finally {
    subtaskControl?.dispose();
    removeLostListener?.();
  }
}
