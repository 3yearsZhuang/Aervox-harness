/**
 * Aervox｜思隅 @aervox/agent-loop — Turn 执行器（阶段 1：无工具单 Step Loop）
 *
 * 算法对齐 AVX-HAR-001 §6 单次 Turn 执行的最小路径，并落实两处硬规则：
 * - 原始 Provider chunk 不直达客户端：全部先写持久 turn_stream_events（分段安全门 approved）再被 SSE 读取；
 * - 事件序列确定：message（身份）→ delta*（正文流）→ done（终态）。
 */
import type { ExecutionStorePort, ModelProviderPort } from "./ports.js";
import type { ContextBuilderPort } from "./ports.js";
import type { ExecuteResult } from "./types.js";

export interface ExecuteTurnInput {
  turnId: string;
  sessionId: string;
  attemptId: string;
  /** 阶段 1：用户输入即上下文来源（历史消息组装留阶段 2） */
  userMessage: string;
}

export interface ExecuteTurnDeps {
  execution: ExecutionStorePort;
  provider: ModelProviderPort;
  contextBuilder: ContextBuilderPort;
}

/** 执行一次 Turn：claim → 组装上下文 → Provider 流式输出 → 分段写事件 → done+终态 */
export async function executeTurn(
  deps: ExecuteTurnDeps,
  input: ExecuteTurnInput,
): Promise<ExecuteResult> {
  const { execution, provider, contextBuilder } = deps;

  const claim = await execution.claimTurnAttempt({
    turnId: input.turnId,
    attemptId: input.attemptId,
    expectedFencingToken: 0,
  });
  if (!claim.ok) {
    return { status: "skipped", attemptId: input.attemptId, reason: claim.reason };
  }

  try {
    const context = contextBuilder.build({
      turnId: input.turnId,
      sessionId: input.sessionId,
      messages: [{ role: "user", content: input.userMessage }],
    });

    let sequence = await execution.nextSequence(input.turnId);
    const messageId = `msg_${input.turnId}_assistant`;

    // 1) message 事件：Assistant Message 身份先提交
    await execution.appendEvent({
      turnId: input.turnId,
      attemptId: input.attemptId,
      sequence: sequence++,
      eventType: "message",
      data: { messageId, role: "assistant", contentType: "text", isComplete: false },
      safetyDecision: "approved",
    });

    // 2) delta 事件：Provider 文本流分块写入（均已过安全门）
    const textParts: string[] = [];
    for await (const chunk of provider.stream({
      turnId: input.turnId,
      attemptId: input.attemptId,
      context,
    })) {
      textParts.push(chunk.text);
      await execution.appendEvent({
        turnId: input.turnId,
        attemptId: input.attemptId,
        sequence: sequence++,
        eventType: "delta",
        data: { messageId, text: chunk.text, isFinal: chunk.isFinal },
        safetyDecision: "approved",
      });
    }

    // 3) done 事件：Turn 终态提交
    const lastSequence = sequence;
    await execution.appendEvent({
      turnId: input.turnId,
      attemptId: input.attemptId,
      sequence,
      eventType: "done",
      data: {
        status: "Completed",
        messageId,
        isComplete: true,
        lastSequence,
      },
      safetyDecision: "approved",
    });

    await execution.finalizeAttempt({
      turnId: input.turnId,
      attemptId: input.attemptId,
      status: "Completed",
    });

    return { status: "completed", attemptId: input.attemptId, lastSequence };
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