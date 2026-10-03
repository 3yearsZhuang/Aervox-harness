/**
 * Aervox｜思隅 @aervox/core — 工具执行结果分类与账本收口（ITER-041 第二段）
 *
 * 从 `executor.ts` 按职责切出的第二段：把「一次工具调用结束后，结果如何归类、
 * 账本如何收口」这件纯映射逻辑从控制流中剥离。
 *
 * 原实现里这段是一段嵌套深处的 40 行 if/else，与取消、租约丢失、审批分支交织在同
 * 一个函数体内。它本身不含控制流决策（除 needsApproval 分支），却是幂等账本正确性
 * 的关键：分类错了，账本就会把「需授权」记成「已执行」，恢复器据此重放会造成
 * 副作用重复 —— 正是 AVX-HAR-001 §11.3 要防的情形。
 *
 * 抽出后它是三个纯函数，可独立推理与测试；executor 侧只剩调用点。
 */
import type { ExecutionStorePort } from "./ports.js";
import type { ToolCallRequest, ToolCallResult, ToolExecutionStatus } from "./types.js";

/**
 * 工具执行结果 → 账本状态。
 *
 * - `needsApproval` → `pending_approval`（宿主未执行，等待授权；**不得**记为已执行）
 * - 成功 → `executed`
 * - 超时（`tool_timeout`）→ `timeout_error`（与普通拒绝区分，便于恢复器判定是否可重试）
 * - 其余失败 → `rejected`
 */
export function classifyToolOutcome(result: ToolCallResult): ToolExecutionStatus {
  if (result.needsApproval) return "pending_approval";
  if (result.ok) return "executed";
  if (result.error === "tool_timeout") return "timeout_error";
  return "rejected";
}

/** 账本收口所需上下文 */
export interface LedgerSettlementInput {
  execution: ExecutionStorePort;
  turnId: string;
  attemptId: string;
  /** Host 幂等键（attempt:step:seq） */
  invocationId: string;
  /** claim 得到的 fencing token */
  expectedFencingToken: number;
  /** 本次事件序号（收口会消耗一个 sequence，故由调用方以 getter 传入） */
  nextSequence: () => number;
  /** 模型原始工具请求（事件载荷保留模型 callId 关联） */
  call: ToolCallRequest;
  result: ToolCallResult;
  startedAt: string;
}

/**
 * 以权威结果收口预留行（AVX-HAR-001 §9：非幂等副作用失败不自动重试）。
 *
 * 两条分支按 §12.2 语义分流：
 * - `needsApproval`：只更新账本为 `pending_approval`，**不发 tool_result 事件**
 *   （工具未被执行，没有结果可回填给模型；等授权后由恢复路径推进）；
 * - 其余：账本收口 + `tool_result` 事件**同事务**原子提交（B4-D），崩溃不把两者拆散。
 *
 * 行为等价性（ITER-041 gate）：分类规则、事件载荷字段、CAS 参数与原实现逐字一致，
 * 差异仅在于「序号取号」由调用方以 getter 提供（原先是 `sequence++` 内联）。
 */
export async function settleToolLedger(input: LedgerSettlementInput): Promise<void> {
  const { execution, turnId, attemptId, invocationId, expectedFencingToken, call, result, startedAt } = input;
  const status = classifyToolOutcome(result);

  if (result.needsApproval) {
    await execution.updateToolExecutionResult({
      turnId,
      attemptId,
      invocationId,
      status,
      output: result.output,
      error: "requires_approval",
    });
    return;
  }

  await execution.recordToolOutcome({
    turnId,
    attemptId,
    sequence: input.nextSequence(),
    invocationId,
    name: call.name,
    arguments: call.arguments,
    status,
    output: result.output,
    error: result.error,
    startedAt,
    finishedAt: new Date().toISOString(),
    eventData: {
      invocationId: call.id,
      executionId: invocationId,
      name: call.name,
      ok: result.ok,
      output: result.output,
      error: result.error,
    },
    safetyDecision: "approved",
    expectedFencingToken,
  });
}

/** 重复调用的账本留痕（duplicate：账本无预留行，需插入独立记录 + tool_result 事件） */
export async function settleDuplicateToolCall(input: {
  execution: ExecutionStorePort;
  turnId: string;
  attemptId: string;
  invocationId: string;
  expectedFencingToken: number;
  nextSequence: () => number;
  call: ToolCallRequest;
  startedAt: string;
}): Promise<void> {
  const { execution, turnId, attemptId, invocationId, expectedFencingToken, call, startedAt } = input;
  await execution.recordToolOutcome({
    turnId,
    attemptId,
    sequence: input.nextSequence(),
    invocationId,
    name: call.name,
    arguments: call.arguments,
    status: "duplicate",
    error: "duplicate_tool_call",
    startedAt,
    finishedAt: new Date().toISOString(),
    eventData: {
      invocationId: call.id,
      executionId: invocationId,
      name: call.name,
      ok: false,
      error: "duplicate_tool_call",
    },
    safetyDecision: "approved",
    expectedFencingToken,
  });
}
