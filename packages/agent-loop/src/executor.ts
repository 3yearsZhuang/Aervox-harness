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
import type { ExecuteResult, ModelChunk, PromptMessage, ToolCallResult } from "./types.js";

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
}

export interface ExecuteTurnDeps {
  execution: ExecutionStorePort;
  provider: ModelProviderPort;
  contextBuilder: ContextBuilderPort;
  /** 阶段 2：只读工具提供者；缺省则工具请求被 fail-closed 拒绝 */
  tools?: ToolProviderPort;
  options?: ExecuteTurnOptions;
}

/** 工具调用去重键：name + 参数序列化 */
const dedupeKey = (name: string, args: unknown): string => `${name}:${JSON.stringify(args)}`;

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
  const { execution, provider, contextBuilder, tools, options } = deps;
  const maxSteps = options?.maxSteps ?? 8;
  const toolTimeoutMs = options?.toolTimeoutMs ?? 5000;

  const claim = await execution.claimTurnAttempt({
    turnId: input.turnId,
    attemptId: input.attemptId,
    expectedFencingToken: 0,
  });
  if (!claim.ok) {
    return { status: "skipped", attemptId: input.attemptId, reason: claim.reason };
  }

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
    let textAccumulator: string[] = [];
    let stepsTaken = 0;

    for (let step = 1; step <= maxSteps; step += 1) {
      stepsTaken = step;
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
          await execution.appendEvent({
            turnId: input.turnId,
            attemptId: input.attemptId,
            sequence: sequence++,
            eventType: "tool_request",
            data: { invocationId: call.id, name: call.name, arguments: call.arguments },
            safetyDecision: "approved",
          });
          await execution.appendEvent({
            turnId: input.turnId,
            attemptId: input.attemptId,
            sequence: sequence++,
            eventType: "tool_result",
            data: { invocationId: call.id, name: call.name, ok: false, error: "tools_disabled" },
            safetyDecision: "approved",
          });
        }
        await execution.finalizeAttempt({
          turnId: input.turnId,
          attemptId: input.attemptId,
          status: "Failed",
        });
        return { status: "failed", attemptId: input.attemptId, reason: "tools_disabled" };
      }

      const results: ToolCallResult[] = [];
      for (const call of toolCalls) {
        await execution.appendEvent({
          turnId: input.turnId,
          attemptId: input.attemptId,
          sequence: sequence++,
          eventType: "tool_request",
          data: { invocationId: call.id, name: call.name, arguments: call.arguments },
          safetyDecision: "approved",
        });

        let result: ToolCallResult;
        if (seenToolCalls.has(dedupeKey(call.name, call.arguments))) {
          result = { id: call.id, name: call.name, ok: false, error: "duplicate_tool_call" };
        } else {
          seenToolCalls.add(dedupeKey(call.name, call.arguments));
          try {
            const executed = await withTimeout(
              tools.execute({
                turnId: input.turnId,
                attemptId: input.attemptId,
                invocationId: call.id,
                name: call.name,
                arguments: call.arguments,
              }),
              toolTimeoutMs,
            );
            result = { id: call.id, name: call.name, ok: executed.ok, output: executed.output, error: executed.error };
          } catch (err) {
            result = { id: call.id, name: call.name, ok: false, error: err instanceof Error ? err.message : "tool_execution_error" };
          }
        }
        results.push(result);

        await execution.appendEvent({
          turnId: input.turnId,
          attemptId: input.attemptId,
          sequence: sequence++,
          eventType: "tool_result",
          data: {
            invocationId: call.id,
            name: call.name,
            ok: result.ok,
            output: result.output,
            error: result.error,
          },
          safetyDecision: "approved",
        });
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

    // maxSteps 耗尽且仍在请求工具 → 预算终止（Interrupted）
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
    }).catch(() => undefined);
    return { status: "failed", attemptId: input.attemptId, reason: "execution error" };
  }
}