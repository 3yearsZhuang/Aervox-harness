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
import type { ExecutionStorePort, InboxPort, ModelProviderPort, ToolProviderPort } from "./ports.js";
import type { ContextBuilderPort } from "./ports.js";
import type {
  ExecuteResult,
  ModelChunk,
  PromptMessage,
  ToolCallResult,
  ToolExecutionStatus,
} from "./types.js";
import { LeaseLostError } from "./errors.js";
import { LeaseHeartbeat } from "./lease-heartbeat.js";
import { inspectToolResult } from "./tool-result-safe.js";

export interface ExecuteTurnInput {
  turnId: string;
  sessionId: string;
  attemptId: string;
  /** 阶段 1/2：用户输入即上下文来源（历史消息组装留后续阶段） */
  userMessage: string;
}

/**
 * 3c/4b 续跑输入（§11.3 首范式「工具结果已权威提交但尚未注入」）：
 * 由恢复器从事件流 + 工具账本重建上下文后，以「抢占续跑」方式在原 Attempt 上继续，
 * 禁止重复已提交副作用与事件。executor 跳过 message 身份事件、沿用既有 sequence 之后追加。
 */
export interface ExecuteTurnResumeInput {
  /** 原执行已 claim 的 fencing（续跑以抢占语义重新 claim，预期=当前值） */
  expectedFencingToken: number;
  /** 已存在事件的最大序号：新事件从 lastSequence+1 追加 */
  lastSequence: number;
  /** 原执行已完成的 Step 数：续跑 Step 与 executionId（attempt:step:seq）从其后继续，避免与新事件冲突 */
  lastStep: number;
  /** 续跑上下文：恢复器重建的 PromptMessage[]（含 user + 既有 assistant 文本 + 权威 tool 结果） */
  history: PromptMessage[];
  /** 已提交的助手消息身份（message 事件 data.messageId），续跑 delta/done 复用 */
  messageId: string;
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
  /** 4b：续跑（§11.3 首范式）；缺省为全新执行 */
  resume?: ExecuteTurnResumeInput;
  /**
   * B2：租约 TTL（ms）。心跳续租以此续期；默认 60_000（与数据库层 claim/renew 默认一致）。
   */
  leaseTtlMs?: number;
  /**
   * B2：长调用周期心跳间隔（ms）。默认 = leaseTtlMs / 2；0 关闭心跳（Step 首部探活仍然生效）。
   * 覆盖 Provider 长流与长工具调用（如 ask_user_question 最长 120s），防止租约超时被
   * 恢复器误判为僵尸原地收敛（AVX-HAR-001 §11.2）。
   */
  leaseHeartbeatIntervalMs?: number;
  /**
   * §10 maxModelRetries：模型调用重试次数。仅「首个可见片段前且无副作用」时生效
   * （默认 1；0 关闭）。已有任何 delta/事件或租约丢失不重试。
   */
  maxModelRetries?: number;
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
  /** 阶段 5a：受控收件箱（ADR-017）；缺省不启用 Inbox 消费 */
  inbox?: InboxPort;
  /**
   * 阶段 7（ADR-017）：ModelRun 元数据（provider/modelId/purpose；缺省用 provider.id + 占位）。
   * 写入为可观测副作用（recordModelRun/recordContextManifest），不影响控制流。
   */
  modelRunMeta?: { provider?: string; modelId?: string; purpose?: string };
  options?: ExecuteTurnOptions;
}

/** 工具调用去重键：name + 参数序列化 */
const dedupeKey = (name: string, args: unknown): string => `${name}:${JSON.stringify(args)}`;

/** 3a：Host 幂等键重生成（AVX-HAR-001 §9：上游 callId 不可信，副作用标识由 Host 生成） */
const hostExecutionId = (attemptId: string, step: number, seq: number): string => `${attemptId}:${step}:${seq}`;

/** 工具超时兜底（缺陷 D）：超时 → abort 取消信号并向底层传播，同时 reject；promise settle → 清理 timer。
 *  调用方须把 controller.signal 透传给 tools.execute(input)，使长工具（ask_user_question 等）
 *  能感知取消并及时清理挂起副作用，避免「超时后底层仍在执行/写副作用」。 */
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

/** 执行一次 Turn：claim → 多 Step 模型—工具循环 → 分段写事件 → 终态 */
export async function executeTurn(
  deps: ExecuteTurnDeps,
  input: ExecuteTurnInput,
): Promise<ExecuteResult> {
  const { execution, provider, contextBuilder, tools, deletionGate, inbox, options } = deps;
  const maxSteps = options?.maxSteps ?? 8;
  const toolTimeoutMs = options?.toolTimeoutMs ?? 5000;
  const maxTurnDurationMs = options?.maxTurnDurationMs ?? 0;
  const maxConsecutiveSameTool = options?.maxConsecutiveSameTool ?? 0;
  const maxModelRetries = options?.maxModelRetries ?? 1;
  const startedAt = Date.now();

  // 4b 续跑：以「抢占续跑」语义重新 claim（预期 = 原执行已持有的 fencing）；
  // 全新执行为 0（首次 claim）。
  const resume = options?.resume;
  const claim = await execution.claimTurnAttempt({
    turnId: input.turnId,
    attemptId: input.attemptId,
    expectedFencingToken: resume?.expectedFencingToken ?? 0,
  });
  if (!claim.ok) {
    return { status: "skipped", attemptId: input.attemptId, reason: claim.reason };
  }
  const claimLeaseId = claim.leaseId;
  const claimFencingToken = claim.fencingToken;
  let stepsTaken = 0;

  // B2：长模型/工具调用期间周期心跳续租（§11.2）。默认 TTL/2 间隔；0 关闭。
  // 心跳续租失败（CAS 语义：被抢占/恢复/终态）→ lost，abort 在途工具并在检查点收敛 lease_lost。
  const leaseTtlMs = options?.leaseTtlMs ?? 60_000;
  const leaseHeartbeatIntervalMs =
    options?.leaseHeartbeatIntervalMs ?? Math.floor(leaseTtlMs / 2);
  const heartbeat =
    claimLeaseId && leaseHeartbeatIntervalMs > 0
      ? new LeaseHeartbeat({
          renew: () =>
            execution.renewAttemptLease({
              attemptId: input.attemptId,
              leaseId: claimLeaseId,
              expectedFencingToken: claimFencingToken,
              ttlMs: leaseTtlMs,
            }),
          intervalMs: leaseHeartbeatIntervalMs,
        })
      : null;
  heartbeat?.start();

  // 2b：用户取消闭环（AVX-HAR-001 §11.1）——先 CAS 夺终态（Cancelled），成功才写 done 事件；
  // finalize 返回 false（与它方终态竞态）则静默中止，不产生不一致事件。
  const finalizeCancelled = async (atSequence: number): Promise<ExecuteResult> => {
    // B4-D：终态 + done 事件原子提交（§12.2；CAS 失败即他方已终结 → 无孤儿 done）
    const finalized = await execution.finalizeAttemptWithEvent({
      turnId: input.turnId,
      attemptId: input.attemptId,
      status: "Cancelled",
      expectedFencingToken: claimFencingToken,
      sequence: atSequence,
      eventType: "done",
      eventData: { status: "Cancelled", isComplete: false, lastSequence: atSequence },
      safetyDecision: "approved",
    });
    if (!finalized.ok) {
      // 终态 CAS 失败（他方已终结/抢占）→ 不写 done，返回 contested
      return { status: "failed", attemptId: input.attemptId, reason: "cancelled_finalize_contested" };
    }
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
    // B4-D：终态 + done 事件原子提交（§12.2；CAS 失败即他方已终结 → 无孤儿 done）
    const finalized = await execution.finalizeAttemptWithEvent({
      turnId: input.turnId,
      attemptId: input.attemptId,
      status: "Interrupted",
      expectedFencingToken: claimFencingToken,
      sequence: atSequence,
      eventType: "done",
      eventData: { status: "Interrupted", isComplete: false, lastSequence: atSequence, reason },
      safetyDecision: "approved",
    });
    if (!finalized.ok) {
      return { status: "failed", attemptId: input.attemptId, reason: `${reason}_finalize_contested` };
    }
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
    // 4b 续跑：sequence 沿用已存在事件之后（lastSequence+1 起），message 身份事件已有则跳过、
    // 复用原 messageId；全新执行为 nextSequence（stage 1 语义）。
    let sequence = resume ? resume.lastSequence + 1 : await execution.nextSequence(input.turnId);
    const messageId = resume?.messageId ?? `msg_${input.turnId}_assistant`;

    // 1) message 事件：Assistant Message 身份先提交（一次）——仅全新执行时提交
    if (!resume) {
      await execution.appendEvent({
        turnId: input.turnId,
        attemptId: input.attemptId,
        expectedFencingToken: claimFencingToken,
        sequence: sequence++,
        eventType: "message",
        data: { messageId, role: "assistant", contentType: "text", isComplete: false },
        safetyDecision: "approved",
      });
    }

    // 多 Step 共享上下文：随工具结果逐步增长；续跑时以恢复器重建上下文为初始历史
    const history: PromptMessage[] = resume?.history ?? [{ role: "user", content: input.userMessage }];
    const seenToolCalls = new Set<string>();
    let toolCallSeq = 0;
    let streakName: string | undefined;
    let sameToolStreak = 0;
    let textAccumulator: string[] = [];

    // 4b 续跑：Step 从 resume.lastStep 之后继续（executionId=attempt:step:seq 不与已提交冲突）；
    // 全新执行从 1 开始。
    const stepBase = resume?.lastStep ?? 0;
    for (let step = stepBase + 1; step <= maxSteps; step += 1) {
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

      // 阶段 5a：本 Step 可消费的 inbox 项（ADR-017 消费边界；next-step 注入本 Step 输入）
      const stepInboxItems = inbox
        ? await inbox.claimForConsumption({
            sessionId: input.sessionId,
            attemptId: input.attemptId,
            type: "next-step",
            limit: 20, // maxInboxItemsPerStep
          })
        : [];
      const context = await contextBuilder.build({
        turnId: input.turnId,
        sessionId: input.sessionId,
        messages: history,
        inboxItems: stepInboxItems,
      });
      // 读入即消费：注入 context 后 ack（未 ack 项在崩溃恢复后会被重新 claim，安全重放）
      if (stepInboxItems.length > 0 && inbox) {
        await inbox.ack({ itemIds: stepInboxItems.map((i) => i.id) });
      }

      // 收集本 Step 输出（文本增量 + 工具请求）；模型流式可能长于租约 TTL，心跳续租
      const stepStartedAt = Date.now();
      // B4-C：模型调用重试 —— 仅【首个可见片段前且无副作用】时允许（§10 maxModelRetries）
      let canRetryModel = maxModelRetries > 0 && step === stepBase + 1 && textAccumulator.length === 0;
      let midStreamStop: ExecuteResult | null = null;
      let lastMidStreamCheck = 0;
      // 思考型模型（CAP-034）：思考增量节流落 reasoning_delta 进度事件——
      // 长思考期间客户端仍有事件流入（SSE 活性）；不进正文历史与安全片段。
      let reasoningBuffer = "";
      let reasoningEmitted = false;
      let reasoningLastFlushAt = 0;
      const flushReasoning = async (force = false): Promise<void> => {
        const nowMs = Date.now();
        if (!force && reasoningBuffer.length < 200 && nowMs - reasoningLastFlushAt < 400) return;
        const text = reasoningBuffer;
        reasoningBuffer = "";
        reasoningLastFlushAt = nowMs;
        if (!text) return;
        reasoningEmitted = true;
        try {
          await execution.appendEvent({
            turnId: input.turnId,
            attemptId: input.attemptId,
            expectedFencingToken: claimFencingToken,
            sequence: sequence++,
            eventType: "reasoning_delta",
            data: { messageId, text },
            safetyDecision: "approved",
          });
        } catch (err) {
          // 进度事件失败不阻断 Turn；租约丢失除外（上层统一收敛 lease_lost）
          if (err instanceof LeaseLostError) throw err;
        }
      };
      const collectStep = async (): Promise<ModelChunk[]> => {
        const out: ModelChunk[] = [];
        for await (const chunk of provider.stream({
          turnId: input.turnId,
          attemptId: input.attemptId,
          step,
          context,
          tools: tools?.tools,
        })) {
          // B2：心跳检查点 —— 长流期间租约丢失则立即中止本 Step（不再产生新事件/副作用）
          heartbeat?.throwIfLost();
          // B4-B：流式期间取消/删除水位/总时长检查（≥100ms 节流，避免每 chunk 压库）
          const nowMs = Date.now();
          if (nowMs - lastMidStreamCheck >= 100) {
            lastMidStreamCheck = nowMs;
            const stop = await prematureTermination(sequence);
            if (stop) {
              midStreamStop = stop;
              return out; // 提前退出迭代（async iterator 清理由 for-await 保证）
            }
          }
          out.push(chunk);
          if (chunk.reasoning) {
            reasoningBuffer += chunk.reasoning;
            await flushReasoning();
          }
        }
        return out;
      };
      let chunks: ModelChunk[];
      try {
        chunks = await collectStep();
      } catch (err) {
        if (canRetryModel && !reasoningEmitted && !(err instanceof LeaseLostError) && !heartbeat?.lost) {
          canRetryModel = false;
          midStreamStop = null;
          lastMidStreamCheck = 0;
          chunks = await collectStep();
        } else {
          throw err;
        }
      }
      if (midStreamStop) {
        await flushReasoning(true);
        return midStreamStop;
      }
      await flushReasoning(true);
      const stepText = chunks.map((c) => c.text).join("");
      const toolCalls = chunks.flatMap((c) => c.toolCalls ?? []);
      const hasToolCalls = toolCalls.length > 0;
      if (stepText) textAccumulator.push(stepText);

      // 阶段 7（ADR-017）：Step 级 ModelRun 可追溯写入 + 每 Turn 首个 Step 的 ContextManifest 快照。
      // 可观测副作用（同 recordToolExecution）：写入失败不阻断执行（no-op 宿主天然兼容）。
      try {
        const runId = `mr_${input.turnId}_${step}`;
        await execution.recordModelRun({
          runId,
          turnId: input.turnId,
          sessionId: input.sessionId,
          attemptId: input.attemptId,
          stepId: step,
          provider: deps.modelRunMeta?.provider ?? provider.id,
          modelId: deps.modelRunMeta?.modelId ?? "n/a",
          purpose: deps.modelRunMeta?.purpose ?? "agent.loop",
          status: "completed",
          latencyMs: Date.now() - stepStartedAt,
        });
        if (step === stepBase + 1) {
          await execution.recordContextManifest({
            manifestId: `mcm_${input.turnId}`,
            turnId: input.turnId,
            sessionId: input.sessionId,
            attemptId: input.attemptId,
            stepId: step,
            modelRunId: runId,
            purpose: "agent.loop",
            snapshot: context.messages,
          });
        }
      } catch {
        // 可观测写入失败不影响主流程（审计/指标侧写失败收敛）
      }

      // 无工具请求 → 正文完成，终止循环
      if (!hasToolCalls) {
        for (const chunk of chunks) {
          if (chunk.text.length === 0) continue;
          // E2（§12.2）：安全片段 + delta 事件原子提交（可见前缀）
          await execution.recordSafeSegment({
            turnId: input.turnId,
            attemptId: input.attemptId,
            expectedFencingToken: claimFencingToken,
            sequence: sequence++,
            text: chunk.text,
            eventData: { messageId, text: chunk.text, isFinal: true },
            safetyDecision: "approved",
          });
        }
        // 2b：检查点 · 自然完成终态提交前（取消优先，杜绝取消后写 Completed done）
        const finalCancel = await prematureTermination(sequence);
        if (finalCancel) return finalCancel;
        // B4-D：终态 + done 事件原子提交（§12.2）
        await execution.finalizeAttemptWithEvent({
          turnId: input.turnId,
          attemptId: input.attemptId,
          status: "Completed",
          expectedFencingToken: claimFencingToken,
          sequence,
          eventType: "done",
          eventData: { status: "Completed", messageId, isComplete: true, lastSequence: sequence },
          safetyDecision: "approved",
        });
        return { status: "completed", attemptId: input.attemptId, lastSequence: sequence, stepsTaken };
      }

      // 工具请求 → 先落文本 delta（未完成），再逐个执行工具
      for (const chunk of chunks) {
        if (chunk.text.length === 0) continue;
        // E2（§12.2）：安全片段 + delta 事件原子提交（可见前缀）
        await execution.recordSafeSegment({
          turnId: input.turnId,
          attemptId: input.attemptId,
          expectedFencingToken: claimFencingToken,
          sequence: sequence++,
          text: chunk.text,
          eventData: { messageId, text: chunk.text, isFinal: false },
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
            expectedFencingToken: claimFencingToken,
            sequence: sequence++,
            eventType: "tool_request",
            data: { invocationId: call.id, executionId, name: call.name, arguments: call.arguments },
            safetyDecision: "approved",
          });
          await execution.appendEvent({
            turnId: input.turnId,
            attemptId: input.attemptId,
            expectedFencingToken: claimFencingToken,
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
        // B4-D：终态 + error 事件原子提交（§12.2）
        await execution.finalizeAttemptWithEvent({
          turnId: input.turnId,
          attemptId: input.attemptId,
          status: "Failed",
          expectedFencingToken: claimFencingToken,
          sequence,
          eventType: "error",
          eventData: { code: "TOOLS_DISABLED", retryable: true, message: "tools_disabled", lastSequence: sequence },
          safetyDecision: "approved",
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
          expectedFencingToken: claimFencingToken,
          sequence: sequence++,
          eventType: "tool_request",
          data: { invocationId: call.id, executionId, name: call.name, arguments: call.arguments },
          safetyDecision: "approved",
        });

        let result: ToolCallResult;
        if (seenToolCalls.has(dedupeKey(call.name, call.arguments))) {
          result = { id: call.id, name: call.name, ok: false, error: "duplicate_tool_call" };
          // B4-D：duplicate 账本 + tool_result 事件原子提交（事件对模型可见，模型据之收敛）
          await execution.recordToolOutcome({
            turnId: input.turnId,
            attemptId: input.attemptId,
            sequence: sequence++,
            invocationId: executionId,
            name: call.name,
            arguments: call.arguments,
            status: "duplicate",
            error: "duplicate_tool_call",
            startedAt,
            finishedAt: new Date().toISOString(),
            eventData: {
              invocationId: call.id,
              executionId,
              name: call.name,
              ok: false,
              error: "duplicate_tool_call",
            },
            safetyDecision: "approved",
            expectedFencingToken: claimFencingToken,
          });
        } else {
          seenToolCalls.add(dedupeKey(call.name, call.arguments));
          // 2c：幂等预留（§9 idempotency reservation）——意图先于外部副作用持久化（executionId 为 Host 键）
          await execution.reserveToolExecution({
            turnId: input.turnId,
            attemptId: input.attemptId,
            invocationId: executionId,
            name: call.name,
            arguments: call.arguments,
          });
          // 长耗时工具放宽超时：ask_user_question 等待用户交互（默认 120s）；
          // aervox_diary_write 内含一次完整 LLM 日记生成（CAP-009），同样放宽
          const isAskUser = call.name === "ask_user_question";
          const isDiaryWrite = call.name === "aervox_diary_write";
          const effectiveTimeout =
            isAskUser || isDiaryWrite ? Math.max(toolTimeoutMs, 120000) : toolTimeoutMs;
          try {
            // 缺陷 D：工具超时通过 AbortController 传播取消信号，底层可感知并清理挂起副作用
            const cancel = new AbortController();
            // B2：租约丢失（心跳探知）→ abort 在途工具（即使工具不感知 signal，工具返回后检查点也会收敛）
            heartbeat?.onLost(() => cancel.abort());
            const executed = await withTimeout(
              tools.execute({
                turnId: input.turnId,
                attemptId: input.attemptId,
                invocationId: executionId,
                name: call.name,
                arguments: call.arguments,
                sessionId: input.sessionId,
                signal: cancel.signal,
              }),
              effectiveTimeout,
              cancel,
            );
            result = { id: call.id, name: call.name, ok: executed.ok, output: executed.output, error: executed.error, needsApproval: executed.needsApproval };
          } catch (err) {
            // B2：工具执行期间租约已失（心跳探知）→ 立即中止本 Step 交回外层收敛 lease_lost，不写结果事件、不启动新副作用
            if (heartbeat?.lost) {
              throw new LeaseLostError("lease lost during tool execution");
            }
            result = { id: call.id, name: call.name, ok: false, error: err instanceof Error ? err.message : "tool_execution_error" };
          } finally {
          }
          // 2c：以权威结果收口预留行（§9：非幂等副作用失败不自动重试）
          const finalStatus: ToolExecutionStatus = result.needsApproval
            ? "pending_approval"
            : result.ok
              ? "executed"
              : result.error === "tool_timeout"
                ? "timeout_error"
                : "rejected";
          // B4-D：账本收口 + tool_result 事件原子提交（§12.2）——写工具需授权时账本记
          // pending_approval 但不发 tool_result（等待授权），与既有语义一致。
          if (result.needsApproval) {
            await execution.updateToolExecutionResult({
              turnId: input.turnId,
              attemptId: input.attemptId,
              invocationId: executionId,
              status: finalStatus,
              output: result.output,
              error: result.needsApproval ? "requires_approval" : result.error,
            });
          } else {
            await execution.recordToolOutcome({
              turnId: input.turnId,
              attemptId: input.attemptId,
              sequence: sequence++,
              invocationId: executionId,
              name: call.name,
              arguments: call.arguments,
              status: finalStatus,
              output: result.output,
              error: result.error,
              startedAt,
              finishedAt: new Date().toISOString(),
              eventData: {
                invocationId: call.id,
                executionId,
                name: call.name,
                ok: result.ok,
                output: result.output,
                error: result.error,
              },
              safetyDecision: "approved",
              expectedFencingToken: claimFencingToken,
            });
          }
        }
        results.push(result);

        // 阶段 3a：写工具需授权（宿主未执行）→ 记审批待决事件，中断等待授权（预留行已收口为 pending_approval）
        if (result.needsApproval) {
          const info = result.needsApproval;
          await execution.appendEvent({
            turnId: input.turnId,
            attemptId: input.attemptId,
            expectedFencingToken: claimFencingToken,
            sequence: sequence++,
            eventType: "tool_approval_required",
            data: { approvalId: info.approvalId, toolName: info.toolName, argumentsHash: info.argumentsHash },
            safetyDecision: "approved",
          });
          // B4-D：审批路径终态 + done 原子提交（§12.2）
          const approvalFinalized = await execution.finalizeAttemptWithEvent({
            turnId: input.turnId,
            attemptId: input.attemptId,
            status: "Interrupted",
            expectedFencingToken: claimFencingToken,
            sequence,
            eventType: "done",
            eventData: { status: "Interrupted", messageId, isComplete: false, lastSequence: sequence },
            safetyDecision: "approved",
          });
          void approvalFinalized;
          return { status: "failed", attemptId: input.attemptId, reason: "pending_approval" };
        }

      }

      // 工具结果回填上下文（工具消息），模型下一轮可见
      history.push({ role: "assistant", content: stepText, name: toolCalls[0]?.name, toolCallId: toolCalls[0]?.id });
      for (const result of results) {
        // B4-A：§9 工具结果入口校验（大小截断 + Prompt injection 启发式）。
        // 注入命中 → 以受控摘要替代完整内容（fail-closed，不让样本进模型）；
        // 超长 → 回填截断后的 JSON 串。
        const rawJson = JSON.stringify({ ok: result.ok, output: result.output, error: result.error });
        const inspected = inspectToolResult(rawJson);
        const content = inspected.injection
          ? JSON.stringify({
              ok: false,
              output: undefined,
              error: "blocked_tool_injection: 工具输出疑似含提示注入样本，已拦截且不注入完整内容",
            })
          : inspected.text;
        history.push({
          role: "tool",
          content,
          toolCallId: result.id,
          name: result.name,
        });
      }
    }

    // maxSteps 耗尽且仍在请求工具 → 预算终止（Interrupted）；取消优先于预算结论
    // 2b：检查点 · 预算终止前
    const budgetCancel = await prematureTermination(sequence);
    if (budgetCancel) return budgetCancel;
    // B4-D：终态 + done 事件原子提交（§12.2）
    await execution.finalizeAttemptWithEvent({
      turnId: input.turnId,
      attemptId: input.attemptId,
      status: "Interrupted",
      expectedFencingToken: claimFencingToken,
      sequence,
      eventType: "done",
      eventData: {
        status: "Interrupted",
        messageId,
        isComplete: false,
        lastSequence: sequence,
      },
      safetyDecision: "approved",
    });
    return { status: "failed", attemptId: input.attemptId, reason: "max_steps" };
  } catch (err) {
    // B1：事件写入被 fencing CAS 拒绝（Attempt 已被抢占/恢复）→ 立即中止，不再产生新副作用（AVX-HAR-001 §11.2）
    // B2：心跳探知租约已失（含工具 abort 引发的错误）→ 同样收敛 lease_lost
    if (err instanceof LeaseLostError || heartbeat?.lost) {
      return { status: "failed", attemptId: input.attemptId, reason: "lease_lost" };
    }
    // B4-D：终态 + error 事件原子提交（§12.2；失败即他方已终结/锁定 → 静默，无孤儿 error）
    await execution.finalizeAttemptWithEvent({
      turnId: input.turnId,
      attemptId: input.attemptId,
      status: "Failed",
      expectedFencingToken: claimFencingToken,
      sequence: await execution.nextSequence(input.turnId),
      eventType: "error",
      eventData: {
        code: "MODEL_UNAVAILABLE",
        retryable: true,
        message: err instanceof Error ? err.message : "execution failed",
        lastSequence: Math.max(0, (await execution.nextSequence(input.turnId)) - 1),
      },
      safetyDecision: "approved",
    }).catch(() => undefined);
    return { status: "failed", attemptId: input.attemptId, reason: "execution error" };
  } finally {
    // B2：无论正常/中止均停止心跳，避免泄漏定时器或在终态后继续续租
    heartbeat?.stop();
  }
}