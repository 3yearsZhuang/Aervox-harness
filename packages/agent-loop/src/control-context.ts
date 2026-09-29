/**
 * Aervox｜思隅 @aervox/agent-loop — 统一执行控制上下文 (ControlContext)
 *
 * 规范参考：CR-056 §5.6 (BTD-05) 与 ITER-007 / ITER-013 统一控制规范。
 * 作用：为模型调用、执行循环、工具运行及派生子任务提供不可逆收紧的执行控制输入。
 */

export interface TokenBudget {
  readonly maxTokens: number;
  usedTokens: number;
}

export interface CallBudget {
  readonly maxCalls: number;
  usedCalls: number;
}

export interface ControlContextOptions {
  readonly executionId?: string;
  readonly turnId?: string;
  readonly attemptId?: string;
  readonly sessionId?: string;
  readonly parentExecutionId?: string;
  readonly fencingToken?: number;
  readonly abortSignal?: AbortSignal;
  readonly deadlineEpochMs?: number;
  /** 兼容别名 deadline */
  readonly deadline?: number;
  readonly localProcessingOnly?: boolean;
  readonly tokenBudget?: TokenBudget;
  readonly callBudget?: CallBudget;
}

export interface SubtaskDerivationOptions {
  readonly subtaskExecutionId?: string;
  readonly tighterDeadlineEpochMs?: number;
  readonly tighterTokenBudget?: number;
  readonly tighterCallBudget?: number;
  readonly subtaskSignal?: AbortSignal;
  readonly localProcessingOnly?: boolean;
}

export class ControlContext {
  readonly executionId: string;
  readonly turnId?: string;
  readonly attemptId?: string;
  readonly sessionId?: string;
  readonly parentExecutionId?: string;
  readonly fencingToken: number;
  readonly abortSignal: AbortSignal;
  readonly deadlineEpochMs?: number;
  readonly localProcessingOnly: boolean;
  readonly tokenBudget?: TokenBudget;
  readonly callBudget?: CallBudget;

  private readonly abortController: AbortController;
  private parent?: ControlContext;
  private detachSignal?: () => void;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(options: ControlContextOptions = {}) {
    for (const value of [options.tokenBudget?.maxTokens, options.tokenBudget?.usedTokens, options.callBudget?.maxCalls, options.callBudget?.usedCalls]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error("invalid_execution_budget");
    }
    this.executionId = options.executionId ?? (options.attemptId ? `${options.attemptId}:ctrl` : `exec_${Date.now().toString(36)}`);
    this.turnId = options.turnId;
    this.attemptId = options.attemptId;
    this.sessionId = options.sessionId;
    this.parentExecutionId = options.parentExecutionId;
    this.fencingToken = options.fencingToken ?? 0;
    this.deadlineEpochMs = options.deadlineEpochMs ?? options.deadline;
    this.localProcessingOnly = options.localProcessingOnly ?? false;
    this.tokenBudget = options.tokenBudget;
    this.callBudget = options.callBudget;

    this.abortController = new AbortController();

    // 绑定外层传入的 abortSignal
    if (options.abortSignal) {
      if (options.abortSignal.aborted) {
        this.abortController.abort(options.abortSignal.reason);
      } else {
        const onAbort = () => this.abort(options.abortSignal?.reason);
        options.abortSignal.addEventListener("abort", onAbort, { once: true });
        this.detachSignal = () => options.abortSignal?.removeEventListener("abort", onAbort);
      }
    }

    // 绑定截止时间定时器
    if (this.deadlineEpochMs !== undefined) {
      const now = Date.now();
      const delay = Math.max(0, this.deadlineEpochMs - now);
      if (delay === 0) {
        this.abortController.abort(new Error(`ControlContext deadline reached (${this.deadlineEpochMs})`));
      } else {
        this.timer = setTimeout(() => {
          this.abortController.abort(new Error(`ControlContext deadline reached (${this.deadlineEpochMs})`));
        }, delay);
        if (typeof this.timer === "object" && "unref" in this.timer) {
          (this.timer as { unref(): void }).unref();
        }
      }
    }

    this.abortSignal = this.abortController.signal;
  }

  isExpired(): boolean {
    if (this.deadlineEpochMs !== undefined && Date.now() >= this.deadlineEpochMs) {
      return true;
    }
    return false;
  }

  isAborted(): boolean {
    return this.abortSignal.aborted;
  }

  recordTokensUsed(tokens: number): void {
    if (!Number.isFinite(tokens) || tokens < 0) throw new Error("invalid_token_usage");
    this.parent?.recordTokensUsed(tokens);
    if (this.tokenBudget) {
      this.tokenBudget.usedTokens += tokens;
      if (this.tokenBudget.usedTokens > this.tokenBudget.maxTokens) {
        this.abortController.abort(
          new Error(`Token budget exceeded: used ${this.tokenBudget.usedTokens} > max ${this.tokenBudget.maxTokens}`)
        );
      }
    }
  }

  recordCallUsed(): void {
    this.parent?.recordCallUsed();
    if (this.callBudget) {
      this.callBudget.usedCalls += 1;
      if (this.callBudget.usedCalls > this.callBudget.maxCalls) {
        this.abortController.abort(
          new Error(`Call budget exceeded: used ${this.callBudget.usedCalls} > max ${this.callBudget.maxCalls}`)
        );
      }
    }
  }

  get remainingTokens(): number {
    return Math.min(this.tokenBudget ? Math.max(0, this.tokenBudget.maxTokens - this.tokenBudget.usedTokens) : Infinity, this.parent?.remainingTokens ?? Infinity);
  }

  get remainingCalls(): number {
    return Math.min(this.callBudget ? Math.max(0, this.callBudget.maxCalls - this.callBudget.usedCalls) : Infinity, this.parent?.remainingCalls ?? Infinity);
  }

  get budgetExceeded(): boolean {
    return Boolean(this.tokenBudget && this.tokenBudget.usedTokens > this.tokenBudget.maxTokens)
      || Boolean(this.callBudget && this.callBudget.usedCalls > this.callBudget.maxCalls)
      || Boolean(this.parent?.budgetExceeded);
  }

  /** Detach completed operation resources without cancelling its parent. */
  dispose(): void {
    this.detachSignal?.();
    this.detachSignal = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  abort(reason?: unknown): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.dispose();
    this.abortController.abort(reason);
  }

  deriveSubtask(options?: SubtaskDerivationOptions): ControlContext {
    // 派生子任务约束只能更严格，绝不能放松
    // 1. 本地处理限制：父级为 true 则子级必须为 true
    const effectiveLocalOnly = this.localProcessingOnly || Boolean(options?.localProcessingOnly);

    // 2. 截止时间：若父级有截止时间，子级只能更早或相同
    let effectiveDeadline = this.deadlineEpochMs;
    if (options?.tighterDeadlineEpochMs !== undefined) {
      effectiveDeadline =
        this.deadlineEpochMs !== undefined
          ? Math.min(this.deadlineEpochMs, options.tighterDeadlineEpochMs)
          : options.tighterDeadlineEpochMs;
    }

    // 3. Token 预算：子级不能超过父级剩余预算
    let subtaskTokenBudget: TokenBudget | undefined;
    if (options?.tighterTokenBudget !== undefined || this.tokenBudget) {
      const parentRemaining = this.tokenBudget
        ? Math.max(0, this.tokenBudget.maxTokens - this.tokenBudget.usedTokens)
        : Infinity;
      const budgetMax = Math.min(options?.tighterTokenBudget ?? Infinity, parentRemaining);
      subtaskTokenBudget = { maxTokens: budgetMax, usedTokens: 0 };
    }

    // 4. 调用次数预算：子级不能超过父级剩余调用次数
    let subtaskCallBudget: CallBudget | undefined;
    if (options?.tighterCallBudget !== undefined || this.callBudget) {
      const parentRemaining = this.callBudget
        ? Math.max(0, this.callBudget.maxCalls - this.callBudget.usedCalls)
        : Infinity;
      const budgetMax = Math.min(options?.tighterCallBudget ?? Infinity, parentRemaining);
      subtaskCallBudget = { maxCalls: budgetMax, usedCalls: 0 };
    }

    const subtaskId =
      options?.subtaskExecutionId ||
      `${this.executionId}:sub:${Math.random().toString(36).slice(2, 8)}`;

    const child = new ControlContext({
      executionId: subtaskId,
      turnId: this.turnId,
      attemptId: this.attemptId,
      sessionId: this.sessionId,
      parentExecutionId: this.executionId,
      fencingToken: this.fencingToken,
      abortSignal: options?.subtaskSignal ? AbortSignal.any([options.subtaskSignal, this.abortSignal]) : this.abortSignal,
      deadlineEpochMs: effectiveDeadline,
      localProcessingOnly: effectiveLocalOnly,
      tokenBudget: subtaskTokenBudget,
      callBudget: subtaskCallBudget,
    });
    child.parent = this;
    return child;
  }
}

export function createControlContext(options?: ControlContextOptions): ControlContext {
  return new ControlContext(options);
}
