import { abortableStream } from "./abortable.js";
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
import type { ExecutionStorePort, InboxPort, ModelProviderPort, ToolProviderPort } from "./ports.js";
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

/**
 * 容错序列化：保持原形（键序、字段名不变），仅在遇到循环引用 / 不可序列化值时降级。
 *
 * 缺陷 D-CIRC：模型可能返回自引用的 `arguments`（`{self:{...self}}`）。任何裸
 * `JSON.stringify` 遇之都会抛 `Converting circular structure to JSON`：
 * - 预算计量里抛 → 逃出流式循环，整 Turn 收敛为 `execution error`；
 * - 写 tool_request 事件时抛 → 事件与工具账本双双落不下去，崩溃点前移到
 *   `inspectToolInput` 的入参安全判定之前（该判定本可优雅拒绝循环引用）。
 *
 * 本函数用于**事件载荷与工具账本**：这两者必须留痕（可审计要求不允许静默丢弃），
 * 且必须能承载畸形参数，故不能因序列化失败而抛。策略是原样保留可序列化部分、
 * 对环回引用处写入 `"[Circular]"` 标记 —— 审计者能看见参数里有环，
 * 而不会看到一条「工具被静默丢弃」的空洞记录。
 *
 * 与 `stableSerialize`（去重键用，需键序无关的规范形）的区别：
 * 本函数**不排序键、不改变结构**，只在循环处打标记。
 */
function safeStringify(value: unknown, seen: Set<object> = new Set()): string {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "number") return Number.isFinite(value as number) ? String(value) : "null";
  if (type === "boolean") return String(value);
  if (type === "string") return JSON.stringify(value);
  if (type === "undefined") return "null";
  if (type === "bigint") return `"${String(value)}"`;
  if (type === "function" || type === "symbol") return "[Unserializable]";
  const obj = value as object;
  if (seen.has(obj)) return '"[Circular]"';
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return `[${obj.map((item) => safeStringify(item, seen)).join(",")}]`;
    }
    const entries = Object.entries(obj as Record<string, unknown>).map(
      ([key, val]) => `${JSON.stringify(key)}:${safeStringify(val, seen)}`,
    );
    return `{${entries.join(",")}}`;
  } catch {
    // 兜底：getter 抛异常等极端情况也不得连带整个 Turn 失败
    return '"[Unserializable]"';
  } finally {
    seen.delete(obj);
  }
}

/**
 * 稳定序列化：用于工具调用去重键。
 *
 * 缺陷 D-KEY：原实现为 `JSON.stringify(args)`，对对象键序敏感 ——
 * `{query:"x",limit:10}` 与 `{limit:10,query:"x"}` 语义完全相同却得到不同键，
 * 于是同一逻辑调用被当作两次不同调用执行，幂等账本被绕过、副作用可能重复发生。
 * 真实 LLM 输出中键序不保证稳定，故去重必须建立在规范序列化之上。
 *
 * 规则：
 * - 对象键按字典序排序后递归（键序无关）；
 * - 数组**保序**（`[1,2]` 与 `[2,1]` 语义不同，不可归一化）；
 * - 循环引用以 `"[Circular]"` 标记降级，不抛异常（不得因去重键构造使 Turn 崩溃）；
 * - 其余类型（null / 数字 / 字符串 / 布尔 / undefined）按值序列化。
 */
function stableSerialize(value: unknown, seen: Set<object> = new Set()): string {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "number") return Number.isFinite(value as number) ? String(value) : "null";
  if (type === "boolean") return String(value);
  if (type === "string") return JSON.stringify(value);
  if (type === "undefined") return "undefined";
  if (type === "bigint") return `"${String(value)}"`;
  if (type === "function" || type === "symbol") return "[Unsupported]";
  const obj = value as object;
  if (seen.has(obj)) return '"[Circular]"';
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return `[${obj.map((item) => stableSerialize(item, seen)).join(",")}]`;
    }
    const entries = Object.keys(obj as Record<string, unknown>).sort();
    return `{${entries
      .map((key) => `${JSON.stringify(key)}:${stableSerialize((obj as Record<string, unknown>)[key], seen)}`)
      .join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}

/** 工具调用去重键：name + 参数稳定序列化（键序无关，数组保序） */
const dedupeKey = (name: string, args: unknown): string => `${name}:${stableSerialize(args)}`;

/** 共享 UTF-8 编码器（无状态；模块级复用，避免流式路径每 chunk 分配） */
const utf8 = new TextEncoder();

/** 消息输入计量缓存：key 为消息对象引用。
 *  executor 只向 history 追加新消息对象、不改写既有对象，宿主注入的 inbox/记忆消息
 *  每步亦为新对象，因此引用稳定即序列化结果稳定；按引用缓存使长回合的输入计量从
 *  每步全量重序列化（O(总上下文)，整体 O(n²)）摊销为仅计新增消息。 */
const messageChargeBytes = new WeakMap<object, number>();

/** 单条消息的 UTF-8 序列化字节数（含 +1 数组分隔符余量，保守不欠计） */
function messageCharge(message: PromptMessage): number {
  let n = messageChargeBytes.get(message);
  if (n === undefined) {
    n = utf8.encode(JSON.stringify(message)).length + 1;
    messageChargeBytes.set(message, n);
  }
  return n;
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
        const stop = await prematureTermination(sequence);
        if (stop) { midStreamStop = stop; return out; }
        // B4-B/预算：输入计量按消息引用缓存摊销（长回合 O(n²) → O(新增)）；
        // 工具 schema 每步全量序列化（体积小且 seenToolCalls 会变更集合）
        const inputCharge = context.messages.reduce((sum, m) => sum + messageCharge(m), 0)
          + (tools?.tools ? utf8.encode(JSON.stringify(tools.tools)).length : 0);
        if (control && (control.remainingCalls < 1 || control.remainingTokens <= inputCharge)) {
          midStreamStop = await finalizeInterrupted(sequence, "budget_exhausted");
          return out;
        }
        control?.recordCallUsed();
        control?.recordTokensUsed(inputCharge);
        let charged = inputCharge;
        for await (const chunk of abortableStream(provider.stream({
          turnId: input.turnId,
          attemptId: input.attemptId,
          step,
          context,
          tools: tools?.tools,
          signal: control?.abortSignal,
          maxOutputTokens: control && Number.isFinite(control.remainingTokens) ? control.remainingTokens : undefined,
        }), control?.abortSignal)) {
          // Charge UTF-8 bytes conservatively when provider token usage is absent;
          // cumulative provider usage can only increase the charge, never refund it.
          //
          // 缺陷 D-CIRC：此处原为裸 JSON.stringify(chunk.toolCalls)。模型可能返回自引用
          // arguments，序列化抛Converting circular structure to JSON 会逃出 collectStep，
          //把「计量偏差」放大成整 Turn 的 execution error。计量只用于预算估算，不值得
          // 让整轮执行失败 —— 序列化失败时按 0 计费（保守：charge 少算由 provider usage
          // 分支与budgetExceeded 兜底），真正的入参安全判定由 inspectToolInput 负责。
          let charge = utf8.encode(
            chunk.text + (chunk.reasoning ?? "") + (chunk.toolCalls ? safeStringify(chunk.toolCalls) : ""),
          ).length;
          if (chunk.usage) charge = Math.max(charge, chunk.usage.totalTokens - charged);
          charged += charge;
          control?.recordTokensUsed(charge);
          if (control?.budgetExceeded) {
            midStreamStop = await finalizeInterrupted(sequence, "token_budget_exceeded");
            return out;
          }
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
        const stop = await prematureTermination(sequence);
        if (stop) return stop;
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
        // 终态已在 prematureTermination 内 CAS 提交；缓冲 reasoning 属进度事件，
        // 对终态 Attempt 追加必被 fencing CAS 拒绝（LeaseLostError 会把取消/预算收敛
        // 误报为 *_finalize_contested / lease_lost）——与 catch 路径同样静默丢弃。
        return midStreamStop;
      }
      await flushReasoning(true);
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
