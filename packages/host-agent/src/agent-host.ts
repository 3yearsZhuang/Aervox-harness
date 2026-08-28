/**
 * Aervox｜思隅 @aervox/host-agent — 内嵌异步 Agent Loop Host（阶段 4a）
 *
 * 轮询领取「可执行 TurnAttempt」→ claim（CAS+fencing）→ executeTurn → 事件/终态。
 * 并发上限（maxConcurrency）、背压（并发槽满则本 tick 不再领取）、优雅停机（drain 运行中）。
 * 执行实现与 API 同步路径一致（同一 executeTurn/同一 ExecutionStore 语义），
 * 客户端契约（turn_stream_events）不因执行侧不同而改变。
 */
import type {
  ContextBuilderPort,
  ExecutionStorePort,
  InboxPort,
  ModelProviderPort,
  ToolProviderPort,
} from "@aervox/agent-loop";
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
  /** 阶段 5a：受控收件箱（ADR-017）；执行时 claim/inject/ack next-step 项 */
  inbox?: InboxPort;
  /** 4a-2：可观测性门面（指标/审计；缺省 Noop，不抛错） */
  observability?: Observability;
  maxConcurrency?: number;
  pollIntervalMs?: number;
  /**
   * 4d：依赖探针（readiness）。宿主注入回调检测 source/provider 是否可用；
   * 缺省视为 always-ready。探针实现须不抛异常（失败返回 false 即可）。
   */
  probeDeps?: () => Promise<HostDependencyProbe[]>;
}

/** 4d：依赖探针结果（readiness 用） */
export interface HostDependencyProbe {
  /** 依赖名（source / provider / store / …） */
  readonly name: string;
  /** true=可用；false=不可用（readiness 视为未就绪） */
  readonly ready: boolean;
  /** 不可用原因（ready=false 时填） */
  readonly reason?: string;
}

/** 4d：Host 健康状态（liveness + readiness + 容量） */
export type HostStatus = "starting" | "healthy" | "draining" | "stopped" | "stalled";

export interface HostHealth {
  /** liveness 主判定：starting/healthy（活）/draining（停机中）/stopped（已停）/stalled（死锁疑点） */
  readonly status: HostStatus;
  /** 当前运行中任务数 */
  readonly running: number;
  /** 累计处理数（含跳过） */
  readonly processed: number;
  /** Host 启动时间戳（ms since epoch）；未启动为 null */
  readonly startedAt: number | null;
  /** 最后一次完成 tick 的时间戳（ms since epoch）；未 tick 过为 null */
  readonly lastTickAt: number | null;
  /** 启动至今时长（ms）；未启动为 0 */
  readonly uptimeMs: number;
  /** 依赖探针结果（readiness）；未配置 probeDeps 时为空数组 */
  readonly dependencies: readonly HostDependencyProbe[];
  /** readiness：status=healthy 且依赖全部 ready */
  readonly ready: boolean;
}

export interface AgentHost {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 当前运行中任务数 */
  running(): number;
  /** 累计处理数（含跳过） */
  processed(): number;
  /** 4d：健康检查（liveness/readiness/容量）；不抛异常 */
  health(): Promise<HostHealth>;
}

export function createAgentHost(deps: AgentHostDeps): AgentHost {
  const maxConcurrency = deps.maxConcurrency ?? 1;
  const pollIntervalMs = deps.pollIntervalMs ?? 500;
  // 4a-2：宿主级可观测性（缺省 Noop；实现须不抛异常）
  const ob = deps.observability ?? createNoopObservability();
  let runningCount = 0;
  let processedCount = 0;
  let stopped = false;
  let draining = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let pollResolve: (() => void) | null = null;
  // 4d：健康检查状态
  let startedAt: number | null = null;
  let lastTickAt: number | null = null;
  // stalled 阈值：3 倍轮询间隔未完成 tick 视为死锁疑点（liveness）
  const stalledAfterMs = pollIntervalMs * 3;
  const now = (): number => Date.now();

  const executeOne = async (turn: ClaimableTurn): Promise<void> => {
    const turnStartedAt = Date.now();
    try {
      // claim/finalize 全部委托 executeTurn（CAS + fencing 单一次）
      // 已被领/已终态 → executeTurn 返回 skipped（重复投递安全）
      const result = await executeTurn(
        {
          execution: deps.createStore(turn),
          provider: deps.provider,
          contextBuilder: deps.contextBuilder ?? defaultContextBuilder,
          tools: deps.tools,
          inbox: deps.inbox,
          options: turn.resume ? { resume: turn.resume } : undefined,
        },
        { turnId: turn.turnId, sessionId: turn.sessionId, attemptId: turn.attemptId, userMessage: turn.userMessage },
      );
      // 4a-2：宿主与执行侧结果汇总指标 + 审计（failed/skipped 均收敛）
      const durationMs = Date.now() - turnStartedAt;
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
    if (stopped || runningCount >= maxConcurrency) {
      lastTickAt = now();
      return;
    }
    const slots = maxConcurrency - runningCount;
    const candidates = await deps.source.listClaimable(slots);
    for (const turn of candidates) {
      if (runningCount >= maxConcurrency) break; // 背压：槽满不再领取
      if (stopped) break;
      runningCount += 1;
      void executeOne(turn);
    }
    // 4d：tick 完成推进水位（liveness 探测依据）
    lastTickAt = now();
  };

  // 4d：计算 liveness status（不抛异常）
  // stalled 判定：距最近一次 tick 完成（或启动）超过 stalledAfterMs 未推进 → 死锁疑点。
  // 首次 tick 未完成时（lastTickAt=null）以 startedAt 兜底，避免永久误判为 healthy。
  const computeStatus = (): HostStatus => {
    if (stopped) return draining ? "draining" : "stopped";
    if (startedAt === null) return "starting";
    const ref = lastTickAt ?? startedAt;
    if (now() - ref > stalledAfterMs) return "stalled";
    return "healthy";
  };

  return {
    async start() {
      stopped = false;
      draining = false;
      startedAt = now();
      lastTickAt = null;
      await tick();
      timer = setInterval(() => {
        void tick();
      }, pollIntervalMs);
    },
    async stop() {
      draining = true;
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      // 优雅停机：等待运行中任务完成（drain）
      while (runningCount > 0) {
        await new Promise((r) => setTimeout(r, 20));
      }
      draining = false;
    },
    running: () => runningCount,
    processed: () => processedCount,
    async health(): Promise<HostHealth> {
      const status = computeStatus();
      const uptimeMs = startedAt === null ? 0 : Math.max(0, now() - startedAt);
      // 依赖探针：缺省视为 always-ready；探针实现不抛异常（catch 收敛为 not ready）
      let dependencies: readonly HostDependencyProbe[] = [];
      if (deps.probeDeps) {
        try {
          const probed = await deps.probeDeps();
          dependencies = Array.isArray(probed) ? probed : [];
        } catch (err) {
          // 探针自身故障：视为未就绪，但不让 health() 抛错
          dependencies = [
            { name: "probeDeps", ready: false, reason: err instanceof Error ? err.message : "probe_error" },
          ];
        }
      }
      const ready = status === "healthy" && dependencies.every((d) => d.ready);
      // 4d：health() 上报容量 gauge（不抛错；Noop 实现 no-op）
      ob.metrics.emit({ type: "gauge", name: "agent.host.running", value: runningCount });
      ob.metrics.emit({ type: "gauge", name: "agent.host.processed", value: processedCount });
      ob.metrics.emit({ type: "gauge", name: "agent.host.uptime_ms", value: uptimeMs });
      return {
        status,
        running: runningCount,
        processed: processedCount,
        startedAt,
        lastTickAt,
        uptimeMs,
        dependencies,
        ready,
      };
    },
  };
}