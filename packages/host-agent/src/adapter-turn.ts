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
import { drainAdapterDriver } from "@aervox/agent-loop";

export interface AdapterTurnInput {
  turnId: string;
  sessionId: string;
  attemptId: string;
  userMessage: string;
  /** 可注入的工具 schema（透传给 adapter；缺省无） */
  tools?: import("@aervox/agent-loop").ToolSpec[];
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
  const { turnId, sessionId, attemptId, userMessage, tools } = input;

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
    await store.appendEvent({ turnId, attemptId, sequence, eventType, data, safetyDecision });
  };

  try {
    let sequence = await store.nextSequence(turnId);
    const messageId = `msg_${turnId}_assistant`;

    // 2) message 身份事件（与 executeTurn 同构）
    await append(sequence++, "message", { messageId, role: "assistant", contentType: "text", isComplete: false });

    // 3) adapter 整 Turn 执行 + 事件映射（映射既有事件类型，SSE 契约稳定）
    const request: AdapterRequest = { turnId, sessionId, attemptId, userMessage, tools };
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
      await append(sequence, "done", { status: "Completed", messageId, isComplete: true, lastSequence: sequence });
      await store.finalizeAttempt({ turnId, attemptId, status: "Completed", expectedFencingToken: claim.fencingToken });
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
    await append(sequence, "done", { status: "Interrupted", messageId, isComplete: false, lastSequence: sequence });
    await store.finalizeAttempt({ turnId, attemptId, status: "Interrupted", expectedFencingToken: claim.fencingToken });
    return { status: "Interrupted", reason };
  } catch (err) {
    // 超时/协议违约/外部异常 → Failed（host 失败自动禁用语义在端口层）
    const message = err instanceof Error ? err.message : String(err);
    try {
      const seq = await store.nextSequence(turnId);
      await append(seq, "error", { code: "ADAPTER_UNAVAILABLE", retryable: true, message, lastSequence: seq });
      await store.finalizeAttempt({ turnId, attemptId, status: "Failed", expectedFencingToken: claim.fencingToken });
    } catch {
      // 落库兜底失败不再上抛（审计失败不得循环）
    }
    return { status: "Failed", reason: message };
  }
}