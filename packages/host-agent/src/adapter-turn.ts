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
} from "@aervox/core";
import { claimAttemptExecution, ControlContext, drainAdapterDriver } from "@aervox/core";

export interface AdapterTurnInput {
  turnId: string;
  sessionId: string;
  attemptId: string;
  userMessage: string;
  /** Host 已审核的系统提示词；原样透传给进程外 Adapter。 */
  systemPrompt?: string;
  /** 可注入的工具 schema（透传给 adapter；缺省无） */
  tools?: import("@aervox/core").ToolSpec[];
  signal?: AbortSignal;
  deadlineEpochMs?: number;
  maxTurnDurationMs?: number;
  controlContext?: ControlContext;
  deletionGate?: import("@aervox/core").DeletionGatePort;
  leaseHeartbeatIntervalMs?: number;
  beforeComplete?: (signal?: AbortSignal) => Promise<void>;
}

export interface AdapterTurnResult {
  status: "Completed" | "Interrupted" | "Failed" | "Cancelled" | "skipped";
  reason?: string;
  committed?: boolean;
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
  const parent = input.controlContext ?? new ControlContext({ abortSignal: input.signal, deadlineEpochMs: input.deadlineEpochMs });
  const lifecycle = await claimAttemptExecution(input, {
    execution: store, controlContext: parent, deletionGate: input.deletionGate, maxTurnDurationMs: input.maxTurnDurationMs,
    leaseHeartbeatIntervalMs: input.leaseHeartbeatIntervalMs, beforeComplete: input.beforeComplete,
  }).catch(error => { if (!input.controlContext) parent.dispose(); throw error; });
  if (!lifecycle.ok) { if (!input.controlContext) parent.dispose(); return { status: "skipped", reason: lifecycle.reason }; }
  const { claim, control, terminator } = lifecycle;
  const mapResult = (result: import("@aervox/core").ExecuteResult): AdapterTurnResult => ({
    status: ({ completed: "Completed", interrupted: "Interrupted", failed: "Failed", cancelled: "Cancelled", skipped: "skipped" } as const)[result.status],
    reason: "reason" in result ? result.reason : undefined,
    committed: result.status !== "skipped" && !(result.status === "failed" && (result.reason === "lease_lost" || result.reason.endsWith("_finalize_contested"))),
  });

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

  try {
    let sequence = await store.nextSequence(turnId);
    const early = await terminator.prematureTermination(sequence);
    if (early) return mapResult(early);
    const messageId = `msg_${turnId}_assistant`;

    // 2) message 身份事件（与 executeTurn 同构）
    await append(sequence++, "message", { messageId, role: "assistant", contentType: "text", isComplete: false });

    // 3) adapter 整 Turn 执行 + 事件映射（映射既有事件类型，SSE 契约稳定）
    const request: AdapterRequest = { turnId, sessionId, attemptId, userMessage, systemPrompt, tools, signal: control.abortSignal };
    const { events, decision, protocolError } = await drainAdapterDriver(adapter, request);

    let toolSeq = 0;
    for (const ev of events) {
      const interrupted = await terminator.prematureTermination(sequence);
      if (interrupted) return mapResult(interrupted);
      if (ev.type === "delta") {
        await store.recordSafeSegment({
          turnId, attemptId, sequence: sequence++, text: ev.text,
          eventData: { messageId, text: ev.text, isFinal: true },
          safetyDecision: "approved", expectedFencingToken: claim.ok ? claim.fencingToken : 0,
        });
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
      const interrupted = await terminator.prematureTermination(sequence);
      if (interrupted) return mapResult(interrupted);
      return mapResult(await terminator.finalize(sequence, { status: "completed" }, {
        eventType: "done", eventData: { status: "Completed", messageId, isComplete: true, lastSequence: sequence }, safetyDecision: "approved",
      }));
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
    return mapResult(await terminator.finalize(sequence, { status: "interrupted", reason }, {
      eventType: "done", eventData: { status: "Interrupted", messageId, isComplete: false, lastSequence: sequence }, safetyDecision: "approved",
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      return mapResult(await terminator.finalizeFailure(await store.nextSequence(turnId), err, {
        code: "ADAPTER_UNAVAILABLE", retryable: true,
      }));
    } catch {
      // 落库兜底失败不再上抛（审计失败不得循环）
    }
    return { status: "Failed", reason: message };
  } finally {
    lifecycle.dispose();
    if (!input.controlContext) parent.dispose();
  }
}
