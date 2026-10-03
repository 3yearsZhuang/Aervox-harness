import { abortableStream } from "./abortable.js";
import { dedupeKey } from "./stable-serialize.js";
/**
 * Aervox｜思隅 @aervox/core — Turn 执行器（阶段 2：只读工具多 Step Loop）
 *
 * 算法对齐 AVX-HAR-001 §6 单次 Turn 执行 + §9 工具执行管线最小路径：
 * - claim（CAS+fencing）只发生一次，多 Step 共享同一 Attempt；
 * - 模型输出文本逐块持久化（分段安全门 approved），原始 chunk 不直达客户端；
 * - 模型请求工具时：写 tool_request → 白名单校验 + 去重 + 超时执行 → 写 tool_result，
 *   工具结果以 tool 消息回填下一轮上下文；
 * - 终止：自然完成（无工具请求）→ done Completed；maxSteps 内始终请求工具 → done Interrupted；
 *   未配置工具却出现工具请求，或执行错误 → fail-closed。
 */
import type { DeletionGatePort, ExecutionStorePort, InboxPort, ModelProviderPort, ToolProviderPort } from "./ports.js";
import type { ContextBuilderPort } from "./ports.js";
import type {
  ExecuteResult,
  ModelChunk,
  PromptMessage,
  ToolCallResult,
} from "./types.js";
import { LeaseLostError } from "./errors.js";
import { LeaseHeartbeat } from "./lease-heartbeat.js";
import { inspectToolResult } from "./tool-result-safe.js";
import { createTurnTerminator } from "./turn-terminator.js";
import { settleDuplicateToolCall, settleToolLedger } from "./tool-ledger.js";
import { runToolExecution, ToolExecutionAborted } from "./tool-pipeline.js";
import { StepCollector } from "./step-collector.js";
import type { StepCollection } from "./step-collector.js";

export interface ExecuteTurnInput {
  turnId: string;
  sessionId: string;
  attemptId: string;
  /** 阶段 1/2：用户输入即上下文来源（历史消息组装留后续阶段） */
  userMessage: string;
  /** BTD-05 / ITER-007：统一执行控制上下文（含取消、超时截止、预算与本地处理限制） */
  controlContext?: import("./control-context.js").ControlContext;
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

export interface ExecuteTurnDeps {
  execution: ExecutionStorePort;
  provider: ModelProviderPort;
  contextBuilder: ContextBuilderPort;
  /** 阶段 2：只读工具提供者；缺省则工具请求被 fail-closed 拒绝 */
  tools?: ToolProviderPort;
  /** Phase 2: 工具执行权限审批策略端口 (HITL & Approval SPI) */
  approvalPolicy?: import("./ports.js").ApprovalPolicyPort;
  /** 2d：删除/撤权未追平闸门；缺省不启用 */
  deletionGate?: DeletionGatePort;
  /** 阶段 5a：受控收件箱（ADR-017）；缺省不启用 Inbox 消费 */
  inbox?: InboxPort;
  /**
   * 阶段 7（ADR-017）：ModelRun 元数据（provider/modelId/purpose；缺省用 provider.id + 占位）。
   * 写入为可观测副作用（recordModelRun/recordContextManifest），不影响控制流。
   */
  modelRunMeta?: { provider?: string; modelId?: string; purpose?: string };
  /** BTD-05 / ITER-007：统一执行控制上下文（可在 deps 或 input 中注入） */
  controlContext?: import("./control-context.js").ControlContext;
  options?: ExecuteTurnOptions;
}

/** 3a：Host 幂等键重生成（AVX-HAR-001 §9：上游 callId 不可信，副作用标识由 Host 生成） */
const hostExecutionId = (attemptId: string, step: number, seq: number): string => `${attemptId}:${step}:${seq}`;


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
  const control = input.controlContext ?? deps.controlContext;

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

  // ITER-041：终态收敛器已切至 turn-terminator.ts（取消 / 预算 / 删除闸门 / 租约丢失
  // 四条收敛路径与主循环解耦）。stepsTaken 以 getter 传入，保持与主循环同步递增。
  const terminator = createTurnTerminator({
    execution,
    turnId: input.turnId,
    attemptId: input.attemptId,
    sessionId: input.sessionId,
    claimFencingToken,
    get stepsTaken() {
      return stepsTaken;
    },
    deletionGate,
    control,
    maxTurnDurationMs,
    startedAt,
  });
  const { finalizeCancelled, finalizeInterrupted, prematureTermination } = terminator;

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
      // ITER-041 第四段：流式收集（计量 / 预算守卫 / 心跳检查点 / 取消节流 /
      // 思考增量节流）已切至 step-collector.ts。StepCollector 持有本Step 的缓冲与
      // 计量状态，对外只回传「分块 + 终止原因 + 是否已落 reasoning 进度事件」。
      //
      // 思考增量落进度事件（CAP-034）：序号分配与 fencing 在此与主循环共享计数器，
      // 故以闭包注入而非由收集器自行分配。
      const appendReasoningDelta = async (text: string): Promise<void> => {
        await execution.appendEvent({
          turnId: input.turnId,
          attemptId: input.attemptId,
          expectedFencingToken: claimFencingToken,
          sequence: sequence++,
          eventType: "reasoning_delta",
          data: { messageId, text },
          safetyDecision: "approved",
        });
      };
      // 每次收集尝试一个新收集器：重试须重置「已落过 reasoning 进度事件」与节流缓冲，
      // 失败 attempt 的未落缓冲随旧实例一并丢弃，不得串入重试 attempt。
      const makeCollector = (): StepCollector =>
        new StepCollector({
          provider,
          context,
          tools: tools?.tools,
          turnId: input.turnId,
          attemptId: input.attemptId,
          step,
          messageId,
          control,
          heartbeat,
          prematureTermination: () => prematureTermination(sequence),
          finalizeInterrupted: (reason) => finalizeInterrupted(sequence, reason),
          appendReasoningDelta,
        });
      let activeCollector = makeCollector();
      let collected: StepCollection;
      try {
        collected = await activeCollector.collect();
      } catch (err) {
        const stop = await prematureTermination(sequence);
        if (stop) return stop;
        // B4-C：仅【首个可见片段前且无副作用】时允许重试（§10 maxModelRetries）
        const canRetry = canRetryModel && !activeCollector.hasEmittedReasoning
          && !(err instanceof LeaseLostError) && !heartbeat?.lost;
        if (!canRetry) throw err;
        canRetryModel = false;
        activeCollector = makeCollector();
        collected = await activeCollector.collect();
      }
      if (collected.stop) {
        // 终态已在 prematureTermination / finalizeInterrupted 内 CAS 提交；缓冲
        // reasoning 属进度事件，对终态 Attempt 追加必被 fencing CAS 拒绝
        //（LeaseLostError 会把取消/预算收敛误报为 *_finalize_contested / lease_lost）
        //——与 catch 路径同样静默丢弃。
        return collected.stop;
      }
      // 收尾 flush 必须落在产生 collected 的实例上，否则重试 attempt 的尾部增量会随旧实例丢失
      await activeCollector.flushPendingReasoning();
      const chunks = collected.chunks;
      const stepText = chunks.map((c) => c.text).join("");
      const toolCalls = chunks.flatMap((c) => c.toolCalls ?? []);
      const hasToolCalls = toolCalls.length > 0;
      if (stepText) textAccumulator.push(stepText);

      // Providers commonly split one model response into many tiny chunks.
      // Keep one durable delta per chunk for replay fidelity, but let hosts
      // commit the whole step in a bounded transaction to avoid a SQLite
      // BEGIN/fencing round-trip for every token-sized chunk.
      const persistSafeSegments = async (isFinal: boolean): Promise<void> => {
        const inputs = chunks
          .filter((chunk) => chunk.text.length > 0)
          .map((chunk) => ({
            turnId: input.turnId,
            attemptId: input.attemptId,
            sequence: sequence++,
            text: chunk.text,
            eventData: { messageId, text: chunk.text, isFinal },
            safetyDecision: "approved" as const,
            expectedFencingToken: claimFencingToken,
          }));
        if (inputs.length === 0) return;
        if (execution.recordSafeSegments) {
          await execution.recordSafeSegments(inputs);
          return;
        }
        for (const segment of inputs) {
          await execution.recordSafeSegment(segment);
        }
      };

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
        // E2（§12.2）：安全片段 + delta 事件原子提交（可见前缀）
        await persistSafeSegments(true);
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
      // E2（§12.2）：安全片段 + delta 事件原子提交（可见前缀）
      await persistSafeSegments(false);

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

        let result: ToolCallResult | undefined;
        if (seenToolCalls.has(dedupeKey(call.name, call.arguments))) {
          result = { id: call.id, name: call.name, ok: false, error: "duplicate_tool_call" };
          // B4-D：duplicate 账本 + tool_result 事件原子提交（事件对模型可见，模型据之收敛）
          await settleDuplicateToolCall({
            execution,
            turnId: input.turnId,
            attemptId: input.attemptId,
            invocationId: executionId,
            expectedFencingToken: claimFencingToken,
            nextSequence: () => sequence++,
            call,
            startedAt,
          });
        } else {
          if (control && (control.remainingCalls < 1 || control.remainingTokens <= 0)) return finalizeInterrupted(sequence, "budget_exhausted");
          seenToolCalls.add(dedupeKey(call.name, call.arguments));
          // 2c：幂等预留（§9 idempotency reservation）——意图先于外部副作用持久化（executionId 为 Host 键）
          await execution.reserveToolExecution({
            turnId: input.turnId,
            attemptId: input.attemptId,
            invocationId: executionId,
            name: call.name,
            arguments: call.arguments,
          });
          // ITER-041 第三段：入参校验 → 审批 → 子任务派生 → 执行 → 异常归类已切至
          // tool-pipeline.ts。账本收口与事件序号仍留本侧（须与主循环共享 sequence）。
          try {
            result = await runToolExecution({
              turnId: input.turnId,
              attemptId: input.attemptId,
              sessionId: input.sessionId,
              executionId,
              call,
              tools,
              approvalPolicy: deps.approvalPolicy,
              control,
              heartbeat,
              toolTimeoutMs,
              prematureTermination: () => prematureTermination(sequence),
              finalizeInterrupted: (reason) => finalizeInterrupted(sequence, reason),
            });
          } catch (err) {
            // 中止信号（Step 守卫 / 预算耗尽）与租约丢失交回主循环收敛：
            // 前者已完成终态提交、后者须立即中止且不写结果事件
            if (err instanceof ToolExecutionAborted) return err.result;
            throw err;
          }
          // ITER-041：结果分类 + 账本收口已切至 tool-ledger.ts。
          // 序号以 getter 传入（原先是 `sequence++` 内联）——收口会消耗一个事件序号，
          // 必须与主循环共享同一计数器，不能在此快照。
          //
          // 2c：以权威结果收口预留行（§9：非幂等副作用失败不自动重试）
          // B4-D：账本收口 + tool_result 事件原子提交（§12.2）——写工具需授权时账本记
          // pending_approval 但不发 tool_result（等待授权），与既有语义一致。
          await settleToolLedger({
            execution,
            turnId: input.turnId,
            attemptId: input.attemptId,
            invocationId: executionId,
            expectedFencingToken: claimFencingToken,
            nextSequence: () => sequence++,
            call,
            result,
            startedAt,
          });
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
    if (control?.budgetExceeded) return finalizeInterrupted(await execution.nextSequence(input.turnId), "token_or_call_budget_exceeded");
    if (control?.isExpired()) {
      const atSeq = await execution.nextSequence(input.turnId);
      return finalizeInterrupted(atSeq, "deadline_exceeded");
    }
    if (control?.isAborted()) {
      const atSeq = await execution.nextSequence(input.turnId);
      return finalizeCancelled(atSeq);
    }
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
