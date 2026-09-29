/**
 * Aervox｜思隅 @aervox/host-agent — Adapter 整 Turn 执行路径（阶段 6b）
 *
 * 规则依据：ADR-017/AVX-HAR-001「可替换 Loop Driver、Model Provider 或受限 Contribution」。
 * 当 Host 绑定已准入的进程外 Adapter（dsh/pi）时，执行走本路径，不与 executeTurn 双层循环
 * 混用（adapter 自带完整 Agent 循环）：
 * - claim（CAS+fencing，expected=0）一次；终态 finalize 单一终态语义与既有一致；
 * - adapter 事件流映射为**既有** LoopEventType（delta/tool_request/tool_result/done），
 *   SSE 契约稳定、客户端零改动（阶段 6b 决策）；
 * - 终止收紧：batch 声明经 concludeAdapterBatch（阶段 6 冻结）→ all-results-conclude：
 *   concluded→Completed；mixed_batch 拒绝→Interrupted；none/空→Interrupted；
 *   超时/协议缺陷/异常→Failed + error 事件；
 * - 已准入的 manifest（固定 SHA + 许可证）在端口层完成（createStdioAdapterDriver），本层不重复。
 */
import type {
  ExecutionStorePort,
  LoopEventType,
  SafetyDecision,
  AdapterEvent,
  AdapterDriverPort,
  AdapterRequest,
} from "@aervox/agent-loop";
import { drainAdapterDriver, LeaseLostError } from "@aervox/agent-loop";

export interface AdapterTurnInput {
  turnId: string;
  sessionId: string;
  attemptId: string;
  userMessage: string;
  /** Host 已审核的系统提示词；原样透传给进程外 Adapter。 */
  systemPrompt?: string;
  /** 可注入的工具 schema（透传给 adapter；缺省无） */
  tools?: import("@aervox/agent-loop").ToolSpec[];
  /** BTD-05 / ITER-007: 统一执行控制上下文 */
  controlContext?: import("@aervox/agent-loop").ControlContext;
}

export interface AdapterTurnResult {
  status: "Completed" | "Interrupted" | "Failed" | "skipped";
  reason?: string;
}

/** Host 幂等键（attempt:0:seq；adapter 无 Step 概念，为其保留审计键面） */
const hostExecutionId = (attemptId: string, seq: number): string => `${attemptId}:0:${seq}`;

/**
 * 以 adapter 执行一次整 Turn（Host 侧分支）：
 * - claim → 事件映射落库（message/delta/tool_request/tool_result/done/error）→ finalize；
 * - 返回终态；skipped = claim 失败（重复投递安全）。
 */
export async function runAdapterTurn(
  store: ExecutionStorePort,
  adapter: AdapterDriverPort,
  input: AdapterTurnInput,
): Promise<AdapterTurnResult> {
  const { turnId, sessionId, attemptId, userMessage, systemPrompt, tools } = input;

  // 1) claim（CAS + fencing；expected=0 —— 全新 Attempt 语义与 executeTurn 一致）
  const claim = await store.claimTurnAttempt({ turnId, attemptId, expectedFencingToken: 0 });
  if (!claim.ok) {
    return { status: "skipped", reason: claim.reason };
  }

  const append = async (
    sequence: number,
    eventType: LoopEventType,
    data: unknown,
    safetyDecision: SafetyDecision = "approved",
  ): Promise<void> => {
    // B1：事件写入携带本 Turn claim 得到的 fencing（被抢占后写入将被 CAS 拒绝）
    await store.appendEvent({
      turnId,
      attemptId,
      sequence,
      eventType,
      data,
      safetyDecision,
      expectedFencingToken: claim.ok ? claim.fencingToken : 0,
    });
  };

  const finalize = async (sequence: number, status: "Completed" | "Failed" | "Interrupted", eventType: "done" | "error", eventData: unknown) => {
    const result = await store.finalizeAttemptWithEvent({ turnId, attemptId, sequence, status, eventType, eventData, expectedFencingToken: claim.fencingToken, safetyDecision: "approved" });
    if (!result.ok) throw new LeaseLostError("adapter finalization contested");
  };

  try {
    let sequence = await store.nextSequence(turnId);
    const messageId = `msg_${turnId}_assistant`;

    // 2) message 身份事件（与 executeTurn 同构）
    await append(sequence++, "message", { messageId, role: "assistant", contentType: "text", isComplete: false });

    input.controlContext?.abortSignal.throwIfAborted();
    if (input.controlContext?.localProcessingOnly || input.controlContext?.tokenBudget || input.controlContext?.callBudget) {
      throw new Error("adapter_control_unsupported");
    }
    // 3) adapter 整 Turn 执行 + 事件映射（映射既有事件类型，SSE 契约稳定）
    const request: AdapterRequest = {
      turnId,
      sessionId,
      attemptId,
      userMessage,
      systemPrompt,
      tools,
      signal: input.controlContext?.abortSignal,
    };
    const { events, decision, protocolError } = await drainAdapterDriver(adapter, request);

    let toolSeq = 0;
    for (const ev of events) {
      if (ev.type === "delta") {
        await append(sequence++, "delta", { messageId, text: ev.text, isFinal: true });
      } else if (ev.type === "tool_request") {
        await append(sequence++, "tool_request", {
          invocationId: ev.invocationId,
          executionId: hostExecutionId(attemptId, ++toolSeq),
          name: ev.name,
          arguments: ev.arguments,
        });
      } else if (ev.type === "tool_result") {
        await append(sequence++, "tool_result", {
          invocationId: ev.invocationId,
          executionId: hostExecutionId(attemptId, toolSeq > 0 ? toolSeq : ++toolSeq),
          name: ev.name,
          ok: ev.ok,
          output: ev.output,
          error: ev.error,
        });
      }
      // batch：不落库，仅驱动收敛（阶段 6 收紧语义）
    }

    // 4) 收紧判定 → 终态
    if (decision.concluded) {
      await finalize(sequence, "Completed", "done", { status: "Completed", messageId, isComplete: true, lastSequence: sequence });
      return { status: "Completed" };
    }

    // 未收敛：mixed_batch 拒绝 / none / 空批次 / 协议缺陷 → Interrupted + 原因事件
    const reason =
      decision.reason === "mixed_batch"
        ? `adapter_mixed_batch (declared=${decision.declaredPolicy})`
        : protocolError
          ? `adapter_protocol: ${protocolError}`
          : decision.reason === "none_concluded"
            ? "adapter_none_concluded"
            : "adapter_batch_not_declared";
    await append(sequence++, "error", {
      code: "ADAPTER_NOT_CONCLUDED",
      retryable: true,
      message: reason,
      lastSequence: sequence,
    });
    await finalize(sequence, "Interrupted", "done", { status: "Interrupted", messageId, isComplete: false, lastSequence: sequence });
    return { status: "Interrupted", reason };
  } catch (err) {
    if (err instanceof LeaseLostError) return { status: "skipped", reason: "lease_lost" };
    if (input.controlContext?.isExpired() || input.controlContext?.isAborted()) {
      const isExpired = input.controlContext.isExpired();
      const reason = isExpired ? "deadline_exceeded" : "cancelled";
      try {
        const messageId = `msg_${turnId}_assistant`;
        const seq = await store.nextSequence(turnId);
        await finalize(seq, "Interrupted", "done", { status: "Interrupted", messageId, isComplete: false, lastSequence: seq, reason });
      } catch {
        return { status: "skipped", reason: "finalize_contested" };
      }
      return { status: "Interrupted", reason };
    }
    // 超时/协议违约/外部异常 → Failed（host 失败自动禁用语义在端口层）
    const message = err instanceof Error ? err.message : String(err);
    try {
      const seq = await store.nextSequence(turnId);
      await finalize(seq, "Failed", "error", { code: "ADAPTER_UNAVAILABLE", retryable: true, message, lastSequence: seq });
    } catch {
      return { status: "skipped", reason: "finalize_contested" };
    }
    return { status: "Failed", reason: message };
  }
}
