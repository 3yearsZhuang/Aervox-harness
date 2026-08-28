/**
 * Aervox｜思隅 @aervox/agent-loop — Turn 执行器（阶段 2：只读工具多 Step Loop）
 *
 * 算法对齐 AVX-HAR-001 §6 单次 Turn 执行 + §9 工具执行管线最小路径：
 * - claim（CAS+fencing）只发生一次，多 Step 共享同一 Attempt；
 * - 模型输出文本逐块持久化（分段安全门 approved），原始 chunk 不直达客户端；
 * - 模型请求工具时：写 tool_request → 白名单校验 + 去重 + 超时执行 → 写 tool_result，
 *   工具结果以 tool 消息回填下一轮上下文；
 * - 终止：自然完成（无工具请求）→ done Completed；maxSteps 内始终请求工具 → done Interrupted；
 *   未配置工具却出现工具请求，或执行错误 → fail-closed。
 */
import type { ExecutionStorePort, ModelProviderPort, ToolProviderPort } from "./ports.js";
import type { ContextBuilderPort } from "./ports.js";
import type { ExecuteResult, ModelChunk, PromptMessage, ToolCallResult, ToolExecutionStatus } from "./types.js";

export interface ExecuteTurnInput {
  turnId: string;
  sessionId: string;
  attemptId: string;
  /** 阶段 1/2：用户输入即上下文来源（历史消息组装留后续阶段） */
  userMessage: string;
}

export interface ExecuteTurnOptions {
  /** Step 上限（防死循环）；默认 8。多 Step 工具 Loop 由该边界兜底 */
  maxSteps?: number;
  /** 单个工具超时（ms）；默认 5000 */
  toolTimeoutMs?: number;
  /** 2d：单 Turn 总耗时预算（ms）；0 关闭；超出以 Interrupted 收敛（§10 maxTurnDurationMs） */
  maxTurnDurationMs?: number;
  /** 2d：连续同名工具请求上限（防工具死循环）；0 关闭；超出以 Interrupted 收敛（§10 maxConsecutiveSameTool） */
  maxConsecutiveSameTool?: number;
}

/** 2d：删除/撤权水位闸门（§11.3：删除/撤权水位未追平 → fail closed，不继续模型或工具调用） */
export interface DeletionGatePort {
  isBlocked(input: { turnId: string; sessionId: string }): Promise<boolean>;
}

export interface ExecuteTurnDeps {
  execution: ExecutionStorePort;
  provider: ModelProviderPort;
  contextBuilder: ContextBuilderPort;
  /** 阶段 2：只读工具提供者；缺省则工具请求被 fail-closed 拒绝 */
  tools?: ToolProviderPort;
  /** 2d：删除/撤权未追平闸门；缺省不启用 */
  deletionGate?: DeletionGatePort;
  options?: ExecuteTurnOptions;
}

/** 工具调用去重键：name + 参数序列化 */
const dedupeKey = (name: string, args: unknown): string => `${name}:${JSON.stringify(args)}`;

/** 3a：Host 幂等键重生成（AVX-HAR-001 §9：上游 callId 不可信，副作用标识由 Host 生成） */
const hostExecutionId = (attemptId: string, step: number, seq: number): string => `${attemptId}:${step}:${seq}`;

/** 超时包装（阶段 3 换租约/取消信号，此处以固定超时兜底） */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("tool_timeout")), ms);
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

/** 执行一次 Turn：claim → 多 Step 模型—工具循环 → 分段写事件 → 终态 */
export async function executeTurn(
  deps: ExecuteTurnDeps,
  input: ExecuteTurnInput,
): Promise<ExecuteResult> {
  const { execution, provider, contextBuilder, tools, deletionGate, options } = deps;
  const maxSteps = options?.maxSteps ?? 8;
  const toolTimeoutMs = options?.toolTimeoutMs ?? 5000;
  const maxTurnDurationMs = options?.maxTurnDurationMs ?? 0;
  const maxConsecutiveSameTool = options?.maxConsecutiveSameTool ?? 0;
  const startedAt = Date.now();

  const claim = await execution.claimTurnAttempt({
    turnId: input.turnId,
    attemptId: input.attemptId,
    expectedFencingToken: 0,
  });
  if (!claim.ok) {
    return { status: "skipped", attemptId: input.attemptId, reason: claim.reason };
  }
  const claimLeaseId = claim.leaseId;
  const claimFencingToken = claim.fencingToken;
  let stepsTaken = 0;

  // 2b：用户取消闭环（AVX-HAR-001 §11.1）——先 CAS 夺终态（Cancelled），成功才写 done 事件；
  // finalize 返回 false（与它方终态竞态）则静默中止，不产生不一致事件。
  const finalizeCancelled = async (atSequence: number): Promise<ExecuteResult> => {
    const finalized = await execution.finalizeAttempt({
      turnId: input.turnId,
      attemptId: input.attemptId,
      status: "Cancelled",
      expectedFencingToken: claimFencingToken,
    });
    if (!finalized.ok) {
      return { status: "failed", attemptId: input.attemptId, reason: "cancelled_finalize_contested" };
    }
    await execution.appendEvent({
      turnId: input.turnId,
      attemptId: input.attemptId,
      sequence: atSequence,
      eventType: "done",
      data: { status: "Cancelled", isComplete: false, lastSequence: atSequence },
      safetyDecision: "approved",
    });
    return { status: "cancelled", attemptId: input.attemptId, lastSequence: atSequence, stepsTaken };
  };
  /** 检查点：已被请求取消时立刻走取消终态 */
  const abortIfCancelled = async (atSequence: number): Promise<ExecuteResult | null> => {
    if (await execution.isCancelRequested({ turnId: input.turnId, attemptId: input.attemptId })) {
      return finalizeCancelled(atSequence);
    }
    return null;
  };

  /** 2d：预算/环境原因终止（Interrupted + done；§5.3 budget-exhausted、§11.3 删除未追平） */
  const finalizeInterrupted = async (atSequence: number, reason: string): Promise<ExecuteResult> => {
    const finalized = await execution.finalizeAttempt({
      turnId: input.turnId,
      attemptId: input.attemptId,
      status: "Interrupted",
      expectedFencingToken: claimFencingToken,
    });
    if (!finalized.ok) {
      return { status: "failed", attemptId: input.attemptId, reason: `${reason}_finalize_contested` };
    }
    await execution.appendEvent({
      turnId: input.turnId,
      attemptId: input.attemptId,
      sequence: atSequence,
      eventType: "done",
      data: { status: "Interrupted", isComplete: false, lastSequence: atSequence, reason },
      safetyDecision: "approved",
    });
    return { status: "failed", attemptId: input.attemptId, reason };
  };

  /** 2d：Step 边界守卫 —— 取消 / 删除撤权水位 / 总耗时预算，任一命中即收敛 */
  const prematureTermination = async (atSequence: number): Promise<ExecuteResult | null> => {
    const cancelled = await abortIfCancelled(atSequence);
    if (cancelled) return cancelled;
    if (deletionGate && (await deletionGate.isBlocked({ turnId: input.turnId, sessionId: input.sessionId }))) {
      return finalizeInterrupted(atSequence, "deletion_blocked");
    }
    if (maxTurnDurationMs > 0 && Date.now() - startedAt > maxTurnDurationMs) {
      return finalizeInterrupted(atSequence, "turn_timeout");
    }
    return null;
  };

  try {
    let sequence = await execution.nextSequence(input.turnId);
    const messageId = `msg_${input.turnId}_assistant`;

    // 1) message 事件：Assistant Message 身份先提交（一次）
    await execution.appendEvent({
      turnId: input.turnId,
      attemptId: input.attemptId,
      sequence: sequence++,
      eventType: "message",
      data: { messageId, role: "assistant", contentType: "text", isComplete: false },
      safetyDecision: "approved",
    });

    // 多 Step 共享上下文：随工具结果逐步增长
    const history: PromptMessage[] = [{ role: "user", content: input.userMessage }];
    const seenToolCalls = new Set<string>();
    let toolCallSeq = 0;
    let streakName: string | undefined;
    let sameToolStreak = 0;
    let textAccumulator: string[] = [];

    for (let step = 1; step <= maxSteps; step += 1) {
      stepsTaken = step;

      // 2b：检查点 · Step 首部（取消优先于租约探活：用户取消时不得因续租失败误报 lease_lost）
      const stepOpeningCancel = await prematureTermination(sequence);
      if (stepOpeningCancel) return stepOpeningCancel;

      // 3b-B：Step 首部租约活性校验（续租即探活；租约被抢占/过期 → 立即中止，丢弃本轮与后续事件）
      if (claimLeaseId) {
        const alive = await execution.renewAttemptLease({
          attemptId: input.attemptId,
          leaseId: claimLeaseId,
          expectedFencingToken: claimFencingToken,
        });
        if (!alive.ok) {
          return { status: "failed", attemptId: input.attemptId, reason: "lease_lost" };
        }
      }

      const chunks: ModelChunk[] = [];
      const context = contextBuilder.build({
        turnId: input.turnId,
        sessionId: input.sessionId,
        messages: history,
      });

      // 收集本 Step 输出（文本增量 + 工具请求）
      for await (const chunk of provider.stream({
        turnId: input.turnId,
        attemptId: input.attemptId,
        step,
        context,
        tools: tools?.tools,
      })) {
        chunks.push(chunk);
      }
      const stepText = chunks.map((c) => c.text).join("");
      const toolCalls = chunks.flatMap((c) => c.toolCalls ?? []);
      const hasToolCalls = toolCalls.length > 0;
      if (stepText) textAccumulator.push(stepText);

      // 无工具请求 → 正文完成，终止循环
      if (!hasToolCalls) {
        for (const chunk of chunks) {
          if (chunk.text.length === 0) continue;
          await execution.appendEvent({
            turnId: input.turnId,
            attemptId: input.attemptId,
            sequence: sequence++,
            eventType: "delta",
            data: { messageId, text: chunk.text, isFinal: true },
            safetyDecision: "approved",
          });
        }
        // 2b：检查点 · 自然完成终态提交前（取消优先，杜绝取消后写 Completed done）
        const finalCancel = await prematureTermination(sequence);
        if (finalCancel) return finalCancel;
        await execution.appendEvent({
          turnId: input.turnId,
          attemptId: input.attemptId,
          sequence,
          eventType: "done",
          data: { status: "Completed", messageId, isComplete: true, lastSequence: sequence },
          safetyDecision: "approved",
        });
        await execution.finalizeAttempt({
          turnId: input.turnId,
          attemptId: input.attemptId,
          status: "Completed",
          expectedFencingToken: claimFencingToken,
        });
        return { status: "completed", attemptId: input.attemptId, lastSequence: sequence, stepsTaken };
      }

      // 工具请求 → 先落文本 delta（未完成），再逐个执行工具
      for (const chunk of chunks) {
        if (chunk.text.length === 0) continue;
        await execution.appendEvent({
          turnId: input.turnId,
          attemptId: input.attemptId,
          sequence: sequence++,
          eventType: "delta",
          data: { messageId, text: chunk.text, isFinal: false },
          safetyDecision: "approved",
        });
      }

      // fail-closed：未配置工具却收到工具请求
      if (!tools) {
        for (const call of toolCalls) {
          const startedAt = new Date().toISOString();
          const executionId = hostExecutionId(input.attemptId, step, ++toolCallSeq);
          await execution.appendEvent({
            turnId: input.turnId,
            attemptId: input.attemptId,
            sequence: sequence++,
            eventType: "tool_request",
            data: { invocationId: call.id, executionId, name: call.name, arguments: call.arguments },
            safetyDecision: "approved",
          });
          await execution.appendEvent({
            turnId: input.turnId,
            attemptId: input.attemptId,
            sequence: sequence++,
            eventType: "tool_result",
            data: { invocationId: call.id, executionId, name: call.name, ok: false, error: "tools_disabled" },
            safetyDecision: "approved",
          });
          await execution.recordToolExecution({
            turnId: input.turnId,
            attemptId: input.attemptId,
            invocationId: executionId,
            name: call.name,
            arguments: call.arguments,
            status: "rejected",
            error: "tools_disabled",
            startedAt,
            finishedAt: new Date().toISOString(),
          });
        }
        // 2b：检查点 · 工具环境缺失 fail-closed 提交前（取消优先）
        const disabledCancel = await prematureTermination(sequence);
        if (disabledCancel) return disabledCancel;
        await execution.finalizeAttempt({
          turnId: input.turnId,
          attemptId: input.attemptId,
          status: "Failed",
          expectedFencingToken: claimFencingToken,
        });
        return { status: "failed", attemptId: input.attemptId, reason: "tools_disabled" };
      }

      // 2b：检查点 · 工具批次执行前（未开始副作用即取消则立即中止）
      const toolsCancel = await prematureTermination(sequence);
      if (toolsCancel) return toolsCancel;
      const results: ToolCallResult[] = [];
      for (const call of toolCalls) {
        // 2d：连续同名工具阻断（§10 maxConsecutiveSameTool；跨 Step 累计）
        sameToolStreak = call.name === streakName ? sameToolStreak + 1 : 1;
        streakName = call.name;
        if (maxConsecutiveSameTool > 0 && sameToolStreak > maxConsecutiveSameTool) {
          return finalizeInterrupted(sequence, "repeat_tool");
        }
        // 3a：Host 幂等键（副作用账本与工具执行以 executionId 为准；事件保留模型 callId 关联）
        const executionId = hostExecutionId(input.attemptId, step, ++toolCallSeq);
        const startedAt = new Date().toISOString();
        await execution.appendEvent({
          turnId: input.turnId,
          attemptId: input.attemptId,
          sequence: sequence++,
          eventType: "tool_request",
          data: { invocationId: call.id, executionId, name: call.name, arguments: call.arguments },
          safetyDecision: "approved",
        });

        let result: ToolCallResult;
        let reserved = false;
        if (seenToolCalls.has(dedupeKey(call.name, call.arguments))) {
          result = { id: call.id, name: call.name, ok: false, error: "duplicate_tool_call" };
        } else {
          seenToolCalls.add(dedupeKey(call.name, call.arguments));
          // 2c：幂等预留（§9 idempotency reservation）——意图先于外部副作用持久化（executionId 为 Host 键）
          reserved = true;
          await execution.reserveToolExecution({
            turnId: input.turnId,
            attemptId: input.attemptId,
            invocationId: executionId,
            name: call.name,
            arguments: call.arguments,
          });
          try {
            const executed = await withTimeout(
              tools.execute({
                turnId: input.turnId,
                attemptId: input.attemptId,
                invocationId: executionId,
                name: call.name,
                arguments: call.arguments,
              }),
              toolTimeoutMs,
            );
            result = { id: call.id, name: call.name, ok: executed.ok, output: executed.output, error: executed.error, needsApproval: executed.needsApproval };
          } catch (err) {
            result = { id: call.id, name: call.name, ok: false, error: err instanceof Error ? err.message : "tool_execution_error" };
          }
          // 2c：以权威结果收口预留行（§9：非幂等副作用失败不自动重试）
          const finalStatus: ToolExecutionStatus = result.needsApproval
            ? "pending_approval"
            : result.ok
              ? "executed"
              : result.error === "tool_timeout"
                ? "timeout_error"
                : "rejected";
          await execution.updateToolExecutionResult({
            turnId: input.turnId,
            attemptId: input.attemptId,
            invocationId: executionId,
            status: finalStatus,
            output: result.output,
            error: result.needsApproval ? "requires_approval" : result.error,
          });
        }
        results.push(result);

        // 阶段 3a：写工具需授权（宿主未执行）→ 记审批待决事件，中断等待授权（预留行已由 update 收口为 pending_approval）
        if (result.needsApproval) {
          const info = result.needsApproval;
          await execution.appendEvent({
            turnId: input.turnId,
            attemptId: input.attemptId,
            sequence: sequence++,
            eventType: "tool_approval_required",
            data: { approvalId: info.approvalId, toolName: info.toolName, argumentsHash: info.argumentsHash },
            safetyDecision: "approved",
          });
          await execution.appendEvent({
            turnId: input.turnId,
            attemptId: input.attemptId,
            sequence,
            eventType: "done",
            data: { status: "Interrupted", messageId, isComplete: false, lastSequence: sequence },
            safetyDecision: "approved",
          });
          await execution.finalizeAttempt({
            turnId: input.turnId,
            attemptId: input.attemptId,
            status: "Interrupted",
            expectedFencingToken: claimFencingToken,
          });
          return { status: "failed", attemptId: input.attemptId, reason: "pending_approval" };
        }

        await execution.appendEvent({
          turnId: input.turnId,
          attemptId: input.attemptId,
          sequence: sequence++,
          eventType: "tool_result",
          data: {
            invocationId: call.id,
            executionId,
            name: call.name,
            ok: result.ok,
            output: result.output,
            error: result.error,
          },
          safetyDecision: "approved",
        });

        // 副作用证据：duplicate（未走预留）独立留痕；已预留调用由 updateToolExecutionResult 收口
        if (!reserved) {
          await execution.recordToolExecution({
            turnId: input.turnId,
            attemptId: input.attemptId,
            invocationId: executionId,
            name: call.name,
            arguments: call.arguments,
            status: "duplicate",
            error: "duplicate_tool_call",
            startedAt,
            finishedAt: new Date().toISOString(),
          });
        }
      }

      // 工具结果回填上下文（工具消息），模型下一轮可见
      history.push({ role: "assistant", content: stepText, name: toolCalls[0]?.name, toolCallId: toolCalls[0]?.id });
      for (const result of results) {
        history.push({
          role: "tool",
          content: JSON.stringify({ ok: result.ok, output: result.output, error: result.error }),
          toolCallId: result.id,
          name: result.name,
        });
      }
    }

    // maxSteps 耗尽且仍在请求工具 → 预算终止（Interrupted）；取消优先于预算结论
    // 2b：检查点 · 预算终止前
    const budgetCancel = await prematureTermination(sequence);
    if (budgetCancel) return budgetCancel;
    await execution.appendEvent({
      turnId: input.turnId,
      attemptId: input.attemptId,
      sequence,
      eventType: "done",
      data: {
        status: "Interrupted",
        messageId,
        isComplete: false,
        lastSequence: sequence,
      },
      safetyDecision: "approved",
    });
    await execution.finalizeAttempt({
      turnId: input.turnId,
      attemptId: input.attemptId,
      status: "Interrupted",
      expectedFencingToken: claimFencingToken,
    });
    return { status: "failed", attemptId: input.attemptId, reason: "max_steps" };
  } catch (err) {
    await execution.appendEvent({
      turnId: input.turnId,
      attemptId: input.attemptId,
      sequence: await execution.nextSequence(input.turnId),
      eventType: "error",
      data: {
        code: "MODEL_UNAVAILABLE",
        retryable: true,
        message: err instanceof Error ? err.message : "execution failed",
        lastSequence: Math.max(0, (await execution.nextSequence(input.turnId)) - 1),
      },
      safetyDecision: "approved",
    }).catch(() => undefined);
    await execution.finalizeAttempt({
      turnId: input.turnId,
      attemptId: input.attemptId,
      status: "Failed",
      expectedFencingToken: claimFencingToken,
    }).catch(() => undefined);
    return { status: "failed", attemptId: input.attemptId, reason: "execution error" };
  }
}