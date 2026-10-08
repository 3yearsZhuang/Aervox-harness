/**
 * Aervox｜思隅 @aervox/core — Step 流式收集器（ITER-041 第四段）
 *
 * 从 `executor.ts` 按职责切出的第四段：把「一次模型调用从发起到流结束」这段抽出 ——
 * 输入计量、预算守卫、心跳检查点、取消节流、思考增量节流落事件。
 *
 * 原实现里这段是一个 90行的闭包，内部有 5 个可变状态（midStreamStop /
 * reasoningBuffer / reasoningEmitted / charged / lastMidStreamCheck）在外层闭包间
 * 共享：`collectStep` 写、retry 路径与 `flushReasoning(true)` 读。状态跨三个闭包共享
 * 是这类代码最易出错的形态—— 改一处忘另��处，症状是「重试后reasoning 重复落事件」
 * 或「预算已收敛却继续计费」，且都只能靠端到端用例偶然撞见。
 *
 * 抽出后状态收敛为收集器实例私有，对外只暴露「收集结果 + 终止原因」，
 * retry 决策所需的 `reasoningEmitted` 由结果对象显式回传。
 *
 * 行为等价性（ITER-041 gate）：本段为纯搬迁。判定顺序、节流阈值（200 字符 / 400ms /
 * 100ms）、计量口径、预算守卫位置与retry 条件均未改动。
 */
import { streamWithTicks } from "./abortable.js";
import { safeStringify } from "./safe-serialize.js";
import { LeaseLostError } from "./errors.js";
import type { ExecuteResult, ModelChunk, PromptContext, ToolSpec } from "./types.js";
import type { ModelProviderPort, ToolSafetyLevel } from "./ports.js";
import type { ControlContext } from "./control-context.js";
import type { LeaseHeartbeat } from "./lease-heartbeat.js";

/** 共享 UTF-8 编码器（无状态；模块级复用，避免流式路径每 chunk 分配） */
const utf8 = new TextEncoder();

/** 消息输入计量缓存：key 为消息对象引用（同引用即同序列化结果，摊销 O(n²) → O(新增)） */
const messageChargeBytes = new WeakMap<object, number>();

/** 单条消息的 UTF-8 序列化字节数（含 +1 数组分隔符余量，保守不欠计） */
function messageCharge(message: object): number {
  let n = messageChargeBytes.get(message);
  if (n === undefined) {
    n = utf8.encode(JSON.stringify(message)).length + 1;
    messageChargeBytes.set(message, n);
  }
  return n;
}

/** 思考增量节流阈值：累计 200 字符或间隔 400ms 即落一次 reasoning_delta 进度事件 */
const REASONING_FLUSH_MIN_CHARS = 200;
const REASONING_FLUSH_INTERVAL_MS = 400;
/** 流式期间取消/删除水位/总时长检查的节流间隔（避免每 chunk 压库） */
const MID_STREAM_CHECK_INTERVAL_MS = 100;
export const MAX_STEP_RESPONSE_BYTES = 8 * 1024 * 1024;
export const TEXT_WINDOW_BYTES = 4096;

function textPieces(text: string): string[] {
  if (utf8.encode(text).length <= TEXT_WINDOW_BYTES) return [text];
  const pieces: string[] = [];
  let piece = "", size = 0;
  for (const char of text) {
    const bytes = utf8.encode(char).length;
    if (size + bytes > TEXT_WINDOW_BYTES) { pieces.push(piece); piece = ""; size = 0; }
    piece += char; size += bytes;
  }
  if (piece) pieces.push(piece);
  return pieces;
}

/** 收集器构造参数 */
export interface StepCollectorOptions {
  provider: ModelProviderPort;
  /** 本 Step 组装好的上下文 */
  context: PromptContext;
  /** 工具 schema（计量与模型请求用） */
  tools?: ToolSpec[];
  turnId: string;
  attemptId: string;
  step: number;
  /** 消息身份（reasoning_delta 事件载荷用） */
  messageId: string;
  /** 统一执行控制上下文（预算/ 截止 / 取消） */
  control?: ControlContext;
  /** 租约心跳：流式期间丢失即中止本 Step */
  heartbeat?: LeaseHeartbeat | null;
  /**
   * Step 边界守卫：返回非 null 即中止本 Step（取消 / 预算 / 删除水位）。
   * 由 executor 注入 —— 守卫涉及事件序号与终态提交，不属本模块职责。
   */
  prematureTermination: () => Promise<ExecuteResult | null>;
  /** 预算/环境原因收敛（由 executor 注入以复用其终态提交路径） */
  finalizeInterrupted: (reason: string) => Promise<ExecuteResult>;
  /** 落 reasoning_delta 进度事件（序号分配与 fencing 由 executor 侧持有） */
  appendReasoningDelta: (text: string) => Promise<void>;
  appendTextWindow?: (chunks: ModelChunk[]) => Promise<void>;
}

/** 一次收集的结果 */
export interface StepCollection {
  /** 本 Step 的模型输出分块 */
  chunks: ModelChunk[];
  /** 非 null 表示已收敛（终态已在 prematureTermination / finalizeInterrupted 内提交） */
  stop: ExecuteResult | null;
  /**
   * 是否已落过 reasoning_delta 进度事件 —— retry 决策据此判断
   * 「首个可见片段前且无副作用」是否仍成立（AVX-HAR-001 §10 maxModelRetries）。
   */
  reasoningEmitted: boolean;
}

/**
 * Step 流式收集器：发起一次模型调用并流式收集，直到流自然结束或命中守卫。
 *
 * 每次调用产生一个新的收集器实例（持有本Step 的缓冲与计量状态）。
 */
export class StepCollector {
  private readonly options: StepCollectorOptions;
  private reasoningBuffer = "";
  private reasoningEmitted = false;
  private reasoningLastFlushAt = 0;
  private lastMidStreamCheck = 0;
  private stop: ExecuteResult | null = null;

  constructor(options: StepCollectorOptions) {
    this.options = options;
  }

  /** 思考增量节流落事件（CAP-034：长思考期间保持 SSE 活性，不进正文历史） */
  private async flushReasoning(force = false): Promise<void> {
    const nowMs = Date.now();
    if (
      !force &&
      this.reasoningBuffer.length < REASONING_FLUSH_MIN_CHARS &&
      nowMs - this.reasoningLastFlushAt < REASONING_FLUSH_INTERVAL_MS
    ) {
      return;
    }
    const text = this.reasoningBuffer;
    this.reasoningBuffer = "";
    this.reasoningLastFlushAt = nowMs;
    if (!text) return;
    this.reasoningEmitted = true;
    try {
      await this.options.appendReasoningDelta(text);
    } catch (err) {
      // 进度事件失败不阻断 Turn；租约丢失除外（上层统一收敛 lease_lost）
      if (err instanceof LeaseLostError) throw err;
    }
  }

  /** 强制 flush 剩余思考增量（Step 正常收尾时调用） */
  async flushPendingReasoning(): Promise<void> {
    await this.flushReasoning(true);
  }

  /** 本Step 是否已落过 reasoning 进度事件 */
  get hasEmittedReasoning(): boolean {
    return this.reasoningEmitted;
  }

  /**
   * 收集一次模型调用的全部分块。
   *
   * 计量口径（勿改，影响预算判定与既有精确断言）：
   * - 输入：按消息引用缓存摊销（长回合 O(n²) → O(新增)），工具 schema 每步全量序列化；
   * - 输出：UTF-8 字节保守计量；provider 给出累计 usage 时取 `max(字节, usage 增量)`，
   *   累计 usage 只增不减故永不退款。
   */
  async collect(): Promise<StepCollection> {
    const { provider, context, tools, control, heartbeat, turnId, attemptId, step, messageId } = this.options;
    const out: ModelChunk[] = [];

    const stop = await this.options.prematureTermination();
    if (stop) {
      this.stop = stop;
      return this.result(out);
    }

    // B4-B/预算：输入计量按消息引用缓存摊销；工具 schema 每步全量序列化
    const inputCharge =
      context.messages.reduce((sum, m) => sum + messageCharge(m), 0) +
      (tools ? utf8.encode(JSON.stringify(tools)).length : 0);
    if (control && (control.remainingCalls < 1 || control.remainingTokens <= inputCharge)) {
      this.stop = await this.options.finalizeInterrupted("budget_exhausted");
      return this.result(out);
    }
    control?.recordCallUsed();
    control?.recordTokensUsed(inputCharge);

    let charged = inputCharge;
    let pendingWindow: ModelChunk[] = [];
    let pendingBytes = 0;
    let outputBytes = 0;
    const flushWindow = async () => {
      if (!pendingWindow.length || !this.options.appendTextWindow) return;
      await this.options.appendTextWindow(pendingWindow);
      pendingWindow = []; pendingBytes = 0;
    };
    for await (const chunk of streamWithTicks(
      provider.stream({
        turnId,
        attemptId,
        step,
        context,
        tools,
        signal: control?.abortSignal,
        maxOutputTokens:
          control && Number.isFinite(control.remainingTokens) ? control.remainingTokens : undefined,
      }),
      control?.abortSignal,
    )) {
      if (chunk === null) { await flushWindow(); continue; }
      outputBytes += utf8.encode(safeStringify(chunk)).length;
      if (outputBytes > MAX_STEP_RESPONSE_BYTES) throw new Error("model_response_limit");
      // 缺陷 D-CIRC：safeStringify 遇循环引用降级为标记而非抛 —— 计量只用于预算
      // 估算，不值得让整轮执行失败；真正的入参安全判定由 inspectToolInput 负责。
      let charge = utf8.encode(
        chunk.text + (chunk.reasoning ?? "") + (chunk.toolCalls ? safeStringify(chunk.toolCalls) : ""),
      ).length;
      if (chunk.usage) charge = Math.max(charge, chunk.usage.totalTokens - charged);
      charged += charge;
      control?.recordTokensUsed(charge);
      if (control?.budgetExceeded) {
        this.stop = await this.options.finalizeInterrupted("token_budget_exceeded");
        return this.result(out);
      }

      // B2：心跳检查点 —— 长流期间租约丢失则立即中止本 Step（不再产生新事件/副作用）
      heartbeat?.throwIfLost();

      // B4-B：流式期间取消/删除水位/总时长检查（≥100ms 节流，避免每 chunk 压库）
      const nowMs = Date.now();
      if (nowMs - this.lastMidStreamCheck >= MID_STREAM_CHECK_INTERVAL_MS) {
        this.lastMidStreamCheck = nowMs;
        const stopMid = await this.options.prematureTermination();
        if (stopMid) {
          this.stop = stopMid;
          return this.result(out); // 提前退出（async iterator 清理由 for-await 保证）
        }
      }

      const pieces = textPieces(chunk.text);
      for (let i = 0; i < pieces.length; i++) {
        const part: ModelChunk = i === pieces.length - 1 ? { ...chunk, text: pieces[i]! } : { text: pieces[i]!, isFinal: false };
        const bytes = utf8.encode(part.text).length;
        if (pendingBytes + bytes > TEXT_WINDOW_BYTES) await flushWindow();
        out.push(part);
        pendingWindow.push(part);
        pendingBytes += bytes;
        if (pendingBytes >= TEXT_WINDOW_BYTES) await flushWindow();
      }
      if (chunk.reasoning) {
        this.reasoningBuffer += chunk.reasoning;
        await this.flushReasoning();
      }
    }
    return this.result(out);
  }

  private result(chunks: ModelChunk[]): StepCollection {
    return { chunks, stop: this.stop, reasoningEmitted: this.reasoningEmitted };
  }
}
