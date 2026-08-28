/**
 * Aervox｜思隅 @aervox/host-agent — 内嵌异步 Agent Loop Host（阶段 4a）
 *
 * 轮询领取「可执行 TurnAttempt」→ claim（CAS+fencing）→ executeTurn → 事件/终态。
 * 并发上限（maxConcurrency）、背压（并发槽满则本 tick 不再领取）、优雅停机（drain 运行中）。
 * 执行实现与 API 同步路径一致（同一 executeTurn/同一 ExecutionStore 语义），
 * 客户端契约（turn_stream_events）不因执行侧不同而改变。
 */
import type { ContextBuilderPort, ExecutionStorePort, ModelProviderPort, ToolProviderPort } from "@aervox/agent-loop";
import { defaultContextBuilder, executeTurn } from "@aervox/agent-loop";
import type { Observability } from "@aervox/observability";
import { createNoopObservability } from "@aervox/observability";

/** 可从队列领取的一条 Turn（含执行所需输入） */
export interface ClaimableTurn {
  turnId: string;
  attemptId: string;
  sessionId: string;
  userMessage: string;
  /**
   * 4b 续跑上下文（§11.3 首范式）：候选为「工具结果已权威提交但尚未注入」的过期 Attempt 时，
   * 恢复源重建后携带 —— 宿主据此以占用式 claim 继续原 Attempt，禁止重复副作用。
   */
  resume?: import("@aervox/agent-loop").ExecuteTurnResumeInput;
}

/** 待执行 Turn 来源（宿主实现：数据库候选查询） */
export interface TurnSourcePort {
  listClaimable(limit: number): Promise<ClaimableTurn[]>;
}

export interface AgentHostDeps {
  source: TurnSourcePort;
  /** 每条候选的 ExecutionStore（宿主组合根构造，如 SqliteExecutionStore） */
  createStore(turn: ClaimableTurn): ExecutionStorePort;
  provider: ModelProviderPort;
  contextBuilder?: ContextBuilderPort;
  tools?: ToolProviderPort;
  /** 4a-2：可观测性门面（指标/审计；缺省 Noop，不抛错） */
  observability?: Observability;
  maxConcurrency?: number;
  pollIntervalMs?: number;
}

export interface AgentHost {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 当前运行中任务数 */
  running(): number;
  /** 累计处理数（含跳过） */
  processed(): number;
}

export function createAgentHost(deps: AgentHostDeps): AgentHost {
  const maxConcurrency = deps.maxConcurrency ?? 1;
  const pollIntervalMs = deps.pollIntervalMs ?? 500;
  // 4a-2：宿主级可观测性（缺省 Noop；实现须不抛异常）
  const ob = deps.observability ?? createNoopObservability();
  let runningCount = 0;
  let processedCount = 0;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let pollResolve: (() => void) | null = null;

  const executeOne = async (turn: ClaimableTurn): Promise<void> => {
    const startedAt = Date.now();
    try {
      // claim/finalize 全部委托 executeTurn（CAS + fencing 单一次）
      // 已被领/已终态 → executeTurn 返回 skipped（重复投递安全）
      const result = await executeTurn(
        {
          execution: deps.createStore(turn),
          provider: deps.provider,
          contextBuilder: deps.contextBuilder ?? defaultContextBuilder,
          tools: deps.tools,
          options: turn.resume ? { resume: turn.resume } : undefined,
        },
        { turnId: turn.turnId, sessionId: turn.sessionId, attemptId: turn.attemptId, userMessage: turn.userMessage },
      );
      // 4a-2：宿主与执行侧结果汇总指标 + 审计（failed/skipped 均收敛）
      const durationMs = Date.now() - startedAt;
      const fields = { turnId: turn.turnId, sessionId: turn.sessionId, attemptId: turn.attemptId, durationMs };
      ob.metrics.emit({ type: "histogram", name: "agent.provider.duration_ms", value: durationMs });
      if (result.status === "completed") {
        ob.metrics.emit({ type: "counter", name: "agent.turn.completed", value: 1 });
        ob.log.info({ event: "agent.turn.completed", message: "turn completed", fields });
        void ob.audit.emit({ eventType: "agent.turn.completed", actorId: "agent-host", action: "complete_turn", scope: turn.turnId, payload: fields }).catch(() => undefined);
      } else if (result.status === "skipped") {
        // CAS 失败/已终态：重复投递在宿主层被 fencing 拦截（叠记计数）
        ob.metrics.emit({ type: "counter", name: "agent.fencing.denials", value: 1 });
      } else {
        ob.log.warn({ event: "agent.turn.failed", message: `turn not completed: ${result.status}`, fields });
      }
    } catch (err) {
      ob.log.error({
        event: "agent.turn.error",
        message: `host executeTurn threw: ${err instanceof Error ? err.message : String(err)}`,
        fields: { turnId: turn.turnId, sessionId: turn.sessionId, attemptId: turn.attemptId },
      });
    } finally {
      runningCount -= 1;
      processedCount += 1;
    }
  };

  const tick = async (): Promise<void> => {
    if (stopped || runningCount >= maxConcurrency) return;
    const slots = maxConcurrency - runningCount;
    const candidates = await deps.source.listClaimable(slots);
    for (const turn of candidates) {
      if (runningCount >= maxConcurrency) break; // 背压：槽满不再领取
      if (stopped) break;
      runningCount += 1;
      void executeOne(turn);
    }
  };

  return {
    async start() {
      stopped = false;
      await tick();
      timer = setInterval(() => {
        void tick();
      }, pollIntervalMs);
    },
    async stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      // 优雅停机：等待运行中任务完成（drain）
      while (runningCount > 0) {
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    running: () => runningCount,
    processed: () => processedCount,
  };
}