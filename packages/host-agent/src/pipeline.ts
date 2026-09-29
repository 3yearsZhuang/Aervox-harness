/**
 * Aervox｜思隅 @aervox/host-agent — 通用执行管道与中间件系统 (Host Execution Pipeline)
 *
 * 依据 aervox_core_decoupling_plan.md Phase 1：
 * 采用洋葱模型（Onion Middleware Model），将生命周期钩子、降级策略、主动智能、
 * 安全拦截与性能遥测从宿主核心逻辑中解耦，形成即插即用的通用执行管道。
 */

import type { ControlContext, ExecuteResult } from "@aervox/agent-loop";

/** 单次回合中间件上下文 */
export interface TurnMiddlewareContext {
  turnId: string;
  sessionId: string;
  attemptId: string;
  userMessage?: string;
  controlContext: ControlContext;
  metadata?: Record<string, unknown>;
  /** 允许各中间件在调用链路上安全挂载并传递自定义上下文（如插件快照、耗时统计、策略判定） */
  attributes: Map<string, unknown>;
}

/** 洋葱模型下游推进函数 */
export type TurnMiddlewareNext = () => Promise<ExecuteResult>;

/** 单次回合中间件定义 */
export type TurnMiddleware = (
  ctx: TurnMiddlewareContext,
  next: TurnMiddlewareNext,
) => Promise<ExecuteResult>;

export interface ExecutionPipelineOptions {
  middlewares?: TurnMiddleware[];
}

/**
 * 通用执行管道（ExecutionPipeline）
 *
 * 维护可扩展的中间件链，按注册次序进行洋葱模型拦截与调度，终点为核心执行器（Core Handler）。
 */
export class ExecutionPipeline {
  private readonly middlewares: TurnMiddleware[] = [];

  constructor(options: ExecutionPipelineOptions = {}) {
    if (options.middlewares) {
      this.middlewares.push(...options.middlewares);
    }
  }

  /** 注册一个中间件至管道尾部 */
  use(middleware: TurnMiddleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  /**
   * 按洋葱模型执行流水线调度，并在核心执行器收敛
   *
   * @param ctx 回合中间件上下文
   * @param coreHandler 核心执行函数（通常为底层 executeTurn 的接入包装）
   */
  async execute(
    ctx: TurnMiddlewareContext,
    coreHandler: (ctx: TurnMiddlewareContext) => Promise<ExecuteResult>,
  ): Promise<ExecuteResult> {
    const dispatch = async (index: number): Promise<ExecuteResult> => {
      // 已遍历完所有中间件，执行核心处理器
      if (index === this.middlewares.length) {
        return coreHandler(ctx);
      }
      const middleware = this.middlewares[index]!;
      return middleware(ctx, () => dispatch(index + 1));
    };

    return dispatch(0);
  }
}

/**
 * 管道错误兜底中间件工厂：
 * 捕获中间件与核心执行未预期的异常，并结合 ControlContext 状态安全转化为标准 ExecuteResult
 */
export function createErrorRecoveryMiddleware(): TurnMiddleware {
  return async (ctx, next) => {
    try {
      return await next();
    } catch (err) {
      if (ctx.controlContext.budgetExceeded) {
        return { status: "failed", attemptId: ctx.attemptId, reason: "token_or_call_budget_exceeded" };
      }
      if (ctx.controlContext.isExpired()) {
        return { status: "failed", attemptId: ctx.attemptId, reason: "deadline_exceeded" };
      }
      if (ctx.controlContext.isAborted()) {
        return { status: "cancelled", attemptId: ctx.attemptId, lastSequence: 0, stepsTaken: 0 };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { status: "failed", attemptId: ctx.attemptId, reason: `unhandled_pipeline_error: ${message}` };
    }
  };
}
