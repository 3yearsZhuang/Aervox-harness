/**
 * Aervox｜思隅 @aervox/worker — 模块化 Worker 任务调度宿主（WorkerHost）
 *
 * 核心设计（ITER-027 演进）：
 * - JobContribution 契约：任务以独立 Contribution 形式挂载，声明 name 与 run 逻辑；
 * - 错峰首次执行（initialStaggerMs）：避免多任务在启动瞬间同时争抢 SQLite 写入锁；
 * - 动态自适应退避（Adaptive Backoff）：空轮询时自动按指数递增退避间隔，消灭无意义 CPU 与 SQLite 空读；
 * - 写入压力协调（Write Pressure Backoff）：密集会话/流式写入期间按任务基准间隔成倍拉长轮询（不低于
 *   pressureMinIntervalMs），且**只延长不缩短**——进入压力模式绝不会把已退避的任务拉回高频，压力窗口
 *   到期时间单调递增，避免并发会话互相截断；
 * - 本地跨进程 IPC 秒级唤醒（Worker IPC Channel）：API/仓储层新入任务即刻唤醒，消灭轮询等待时延；
 * - 独立防自重叠锁与单任务故障隔离：保证高并发下调度稳定与异常自愈；
 * - 优雅启停生命周期：清理 timers、ipcServer 并支持优雅退出（stop() 可重复调用）。
 */
import type { LoggerPort } from "@aervox/observability";
import {
  isSqliteBusyError,
  MAX_WORKER_PRESSURE_DURATION_MS,
  WorkerIpcServer,
} from "@aervox/repositories";
import { resolveWorkerTaskInterval, DEFAULT_WORKER_TICK_MS } from "./task-scheduling.js";

export interface JobContributionContext {
  workerId: string;
  logger: LoggerPort;
}

export interface JobContribution {
  /** 唯一任务名（对应调度与日志标识，如 "outbox", "review"） */
  readonly name: string;
  /** 可选的任务特定默认间隔（ms），未指定时按系统默认表匹配 */
  readonly defaultIntervalMs?: number;
  /** 执行一轮周期任务，返回处理项数量（>0 时触发 INFO 日志） */
  run(ctx: JobContributionContext): Promise<number>;
}

export interface AdaptiveBackoffOptions {
  /** 是否启用自适应退避，默认 true */
  readonly enabled?: boolean;
  /** 空轮询递增系数，默认 1.5 */
  readonly idleMultiplier?: number;
  /** 最大退避轮询间隔（ms），默认 30_000 */
  readonly maxIntervalMs?: number;
  /**
   * 写入压力模式下轮询间隔的**绝对下限**（ms），默认 3_000。
   * 注意：它只保证"不低于"，若任务自身的基准间隔已经 >= 该值，则真正生效的是
   * pressureBackoffFactor 带来的成倍拉长。可在启动日志中确认是否发生钳制。
   */
  readonly pressureMinIntervalMs?: number;
  /**
   * 写入压力模式下按任务基准间隔拉长的倍数，默认 2。
   * 最终压力间隔 = max(pressureMinIntervalMs, 基准间隔 × 本倍数)。
   * 之所以需要本倍数：出厂任务表中最短的 outbox 基准间隔恰为 3000ms，若只比较
   * pressureMinIntervalMs，压力模式对该任务将完全失效（评审发现的空操作缺陷）。
   */
  readonly pressureBackoffFactor?: number;
}

export interface WorkerHostOptions {
  workerId: string;
  defaultTickMs?: number;
  intervalOverrides?: Readonly<Record<string, number>>;
  initialStaggerMs?: number;
  logger: LoggerPort;
  /** 自适应退避策略 */
  adaptiveBackoff?: AdaptiveBackoffOptions;
  /** 是否启用本地 IPC 唤醒服务，默认 false（单元测试中按需开启，避免真实端口/Socket 占用） */
  enableIpc?: boolean;
  /** 自定义 IPC Socket 路径 */
  ipcSocketPath?: string;
}

export interface RegisteredJobInfo {
  name: string;
  intervalMs: number;
}

interface JobRunnerState {
  job: JobContribution;
  baseIntervalMs: number;
  currentIntervalMs: number;
  idleStreak: number;
  isTaskRunning: boolean;
  hasPendingWakeup: boolean;
  /** 当前已排期的延时（ms）；用于保证压力模式只延长、不缩短既有排期 */
  scheduledIntervalMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  runOnce: () => Promise<void>;
}

export class WorkerHost {
  private readonly workerId: string;
  private readonly defaultTickMs: number;
  private readonly intervalOverrides: Readonly<Record<string, number>>;
  private readonly initialStaggerMs: number;
  private readonly logger: LoggerPort;

  // 自适应退避参数
  private readonly adaptiveEnabled: boolean;
  private readonly idleMultiplier: number;
  private readonly maxIntervalMs: number;
  private readonly pressureMinIntervalMs: number;
  private readonly pressureBackoffFactor: number;

  // IPC 配置
  private readonly enableIpc: boolean;
  private readonly ipcSocketPath?: string;
  private ipcServer: WorkerIpcServer | null = null;

  // 运行状态
  private readonly jobStates: JobRunnerState[] = [];
  private readonly startupTimeouts: Array<ReturnType<typeof setTimeout>> = [];
  private running = false;
  private pressureMode = false;
  private pressureWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  /** 压力窗口的到期时间戳（ms）；单调递增，避免并发会话互相截断 */
  private pressureExpiresAt: number | null = null;

  constructor(options: WorkerHostOptions) {
    this.workerId = options.workerId;
    this.defaultTickMs = options.defaultTickMs ?? DEFAULT_WORKER_TICK_MS;
    this.intervalOverrides = options.intervalOverrides ?? {};
    this.initialStaggerMs = options.initialStaggerMs ?? 250;
    this.logger = options.logger;

    this.adaptiveEnabled = options.adaptiveBackoff?.enabled ?? true;
    this.idleMultiplier = options.adaptiveBackoff?.idleMultiplier ?? 1.5;
    this.maxIntervalMs = options.adaptiveBackoff?.maxIntervalMs ?? 30_000;
    this.pressureMinIntervalMs = options.adaptiveBackoff?.pressureMinIntervalMs ?? 3_000;
    this.pressureBackoffFactor = Math.max(1, options.adaptiveBackoff?.pressureBackoffFactor ?? 2);

    this.enableIpc = options.enableIpc ?? false;
    this.ipcSocketPath = options.ipcSocketPath;
  }

  /** 单个任务在压力模式下的目标轮询间隔（只延长，不缩短） */
  private pressureIntervalFor(state: JobRunnerState): number {
    return Math.max(
      this.pressureMinIntervalMs,
      Math.round(state.baseIntervalMs * this.pressureBackoffFactor),
    );
  }

  /** 注册一项任务 Contribution */
  registerJob(job: JobContribution): this {
    if (this.running) {
      throw new Error(`Cannot register job "${job.name}" after WorkerHost has started`);
    }
    // 间隔优先级：显式环境覆盖 > Contribution 自带的 defaultIntervalMs > 系统默认表/tick。
    // defaultIntervalMs 曾经只声明不生效（评审发现的死字段），这里让它真正参与解析。
    const normalizedName = job.name.replaceAll("-", "_");
    const explicitOverride =
      this.intervalOverrides[job.name] ?? this.intervalOverrides[normalizedName];
    const baseIntervalMs =
      explicitOverride ??
      job.defaultIntervalMs ??
      resolveWorkerTaskInterval(job.name, this.defaultTickMs, {});

    const state: JobRunnerState = {
      job,
      baseIntervalMs,
      currentIntervalMs: baseIntervalMs,
      idleStreak: 0,
      isTaskRunning: false,
      hasPendingWakeup: false,
      scheduledIntervalMs: 0,
      timer: null,
      runOnce: async () => {},
    };

    state.runOnce = async (): Promise<void> => {
      if (!this.running) return;
      if (state.isTaskRunning) {
        state.hasPendingWakeup = true;
        return;
      }
      state.isTaskRunning = true;

      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }

      const startTime = Date.now();
      let processed = 0;
      try {
        processed = await state.job.run({
          workerId: this.workerId,
          logger: this.logger,
        });
        const durationMs = Date.now() - startTime;
        if (processed > 0) {
          state.idleStreak = 0;
          state.currentIntervalMs = state.baseIntervalMs;
          this.logger.info({
            event: "worker.task.completed",
            message: `Task ${state.job.name} processed ${processed} items (${durationMs}ms)`,
            fields: {
              task: state.job.name,
              processed,
              durationMs,
            },
          });
        } else {
          state.idleStreak += 1;
          if (this.adaptiveEnabled) {
            state.currentIntervalMs = Math.min(
              this.maxIntervalMs,
              Math.round(state.baseIntervalMs * (this.idleMultiplier ** Math.min(state.idleStreak, 6))),
            );
          }
        }
      } catch (err) {
        const errorObj = err instanceof Error ? err : new Error(String(err));
        if (isSqliteBusyError(err)) {
          this.logger.warn({
            event: "worker.task.busy_conflict",
            message: `Task ${state.job.name} encountered SQLite busy write conflict; engaging adaptive backoff`,
            fields: {
              task: state.job.name,
              error: errorObj.message,
            },
          });
          // 遭遇锁冲突时自动启动 5 秒写入压力退避，减少锁竞争。
          // 压力窗口为单调延长语义：若已有 API 下发的更长窗口在途，这里不会把它截断。
          this.setPressureMode(true, 5000);
          state.currentIntervalMs = Math.max(state.currentIntervalMs, this.pressureMinIntervalMs);
        } else {
          this.logger.error({
            event: "worker.task.failed",
            message: `Task ${state.job.name} tick failed: ${errorObj.message}`,
            fields: {
              task: state.job.name,
              error: errorObj.name,
              stack: errorObj.stack,
            },
          });
        }
      } finally {
        state.isTaskRunning = false;
        if (!this.running) return;

        if (state.hasPendingWakeup && !this.pressureMode) {
          state.hasPendingWakeup = false;
          state.scheduledIntervalMs = 0;
          state.timer = setTimeout(() => {
            void state.runOnce();
          }, 0);
          return;
        }

        const effectiveInterval = this.pressureMode
          ? Math.max(state.currentIntervalMs, this.pressureIntervalFor(state))
          : state.currentIntervalMs;

        state.scheduledIntervalMs = effectiveInterval;
        state.timer = setTimeout(() => {
          void state.runOnce();
        }, effectiveInterval);
      }
    };

    this.jobStates.push(state);
    return this;
  }

  /** 获取已注册的任务列表元信息 */
  listJobs(): RegisteredJobInfo[] {
    return this.jobStates.map((item) => ({
      name: item.job.name,
      intervalMs: item.baseIntervalMs,
    }));
  }

  /** 获取任务当前运行时调度状态（用于测试断言与观测） */
  getJobState(name: string):
    | {
        currentIntervalMs: number;
        baseIntervalMs: number;
        scheduledIntervalMs: number;
        idleStreak: number;
        isTaskRunning: boolean;
        hasPendingWakeup: boolean;
      }
    | undefined {
    const state = this.jobStates.find((s) => s.job.name === name);
    if (!state) return undefined;
    return {
      currentIntervalMs: state.currentIntervalMs,
      baseIntervalMs: state.baseIntervalMs,
      scheduledIntervalMs: state.scheduledIntervalMs,
      idleStreak: state.idleStreak,
      isTaskRunning: state.isTaskRunning,
      hasPendingWakeup: state.hasPendingWakeup,
    };
  }

  /** 是否已启动 */
  isRunning(): boolean {
    return this.running;
  }

  /** 当前是否处于写入压力退避模式 */
  isPressureMode(): boolean {
    return this.pressureMode;
  }

  /**
   * 唤醒特定后台任务（秒级立即执行，重置空闲退避）。
   * 常用于 API 产生 Outbox 事件后直接唤醒消费。
   */
  wakeJob(name: string): boolean {
    const state = this.jobStates.find((s) => s.job.name === name);
    if (!state) return false;

    state.currentIntervalMs = state.baseIntervalMs;
    state.idleStreak = 0;

    // 写入压力模式下（如前台会话密集写入），不进行瞬时抢占，标记待压力释放后即刻处理
    if (this.pressureMode) {
      state.hasPendingWakeup = true;
      return true;
    }

    if (state.isTaskRunning) {
      state.hasPendingWakeup = true;
      return true;
    }

    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    if (this.running) {
      state.scheduledIntervalMs = 0;
      void state.runOnce();
      return true;
    }
    return false;
  }

  /**
   * 设置写入压力退避模式。
   *
   * 语义（评审修复后）：
   * - 激活时按任务基准间隔成倍拉长轮询，目标间隔 = max(pressureMinIntervalMs, 基准 × factor)；
   * - **只延长不缩短**：进入压力模式不会把已自适应退避到更长的任务拉回高频（旧实现会把
   *   退避到 30s 的任务重排到 3s，反而在密集写入期间把轮询频率提高 10 倍）；
   * - **窗口单调**：重复激活只会把到期时间往后推，较短的请求不会截断较长的在途窗口
   *   （旧实现下 busy 自愈的 5s 窗口会截断 API 下发的 15s 窗口）；
   * - 未指定 durationMs 时按 MAX_WORKER_PRESSURE_DURATION_MS 兜底，保证任何激活都有界，
   *   本地任意进程无法无限期抑制后台任务。
   */
  setPressureMode(active: boolean, durationMs?: number): void {
    if (!active) {
      this.clearPressureWatchdog();
      this.pressureMode = false;
      this.pressureExpiresAt = null;

      this.logger.info({
        event: "worker.pressure_mode.exited",
        message: "Worker exited write pressure mode; resumed adaptive cadence",
      });

      // 退出压力模式时：若在压力期间累积了待处理唤醒，立即启动消费；其余任务恢复正常周期
      for (const state of this.jobStates) {
        if (state.isTaskRunning) continue;
        if (state.hasPendingWakeup) {
          state.hasPendingWakeup = false;
          if (state.timer) clearTimeout(state.timer);
          state.scheduledIntervalMs = 0;
          void state.runOnce();
        } else if (state.timer) {
          clearTimeout(state.timer);
          state.scheduledIntervalMs = state.currentIntervalMs;
          state.timer = setTimeout(() => {
            void state.runOnce();
          }, state.currentIntervalMs);
        }
      }
      return;
    }

    const now = Date.now();
    const requestedMs =
      typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0
        ? Math.min(durationMs, MAX_WORKER_PRESSURE_DURATION_MS)
        : MAX_WORKER_PRESSURE_DURATION_MS;
    const requestedExpiry = now + requestedMs;
    const previousExpiry = this.pressureMode ? this.pressureExpiresAt : null;
    const targetExpiry =
      previousExpiry === null ? requestedExpiry : Math.max(previousExpiry, requestedExpiry);

    this.pressureMode = true;
    this.pressureExpiresAt = targetExpiry;
    this.clearPressureWatchdog();
    this.pressureWatchdogTimer = setTimeout(
      () => this.setPressureMode(false),
      Math.max(0, targetExpiry - now),
    );

    this.logger.info({
      event: "worker.pressure_mode.entered",
      message: `Worker entered write pressure mode (per-task interval >= max(${this.pressureMinIntervalMs}ms, base x ${this.pressureBackoffFactor}))`,
      fields: {
        pressureMinIntervalMs: this.pressureMinIntervalMs,
        pressureBackoffFactor: this.pressureBackoffFactor,
        requestedMs,
        windowRemainingMs: targetExpiry - now,
      },
    });

    // 只把**排期短于**压力目标的任务延后；已退避更长的任务保持原排期不动。
    for (const state of this.jobStates) {
      if (!state.timer || state.isTaskRunning) continue;
      const target = this.pressureIntervalFor(state);
      if (state.scheduledIntervalMs < target) {
        clearTimeout(state.timer);
        state.scheduledIntervalMs = target;
        state.timer = setTimeout(() => {
          void state.runOnce();
        }, target);
      }
    }
  }

  /**
   * 启动期自检：若压力模式对最短任务的目标间隔并不大于该任务自身间隔，
   * 说明当前配置无法产生预期的退避效果，显式告警而不是静默空操作。
   */
  private warnIfPressureFloorIneffective(): void {
    if (this.jobStates.length === 0) return;
    const shortest = this.jobStates.reduce((min, state) => Math.min(min, state.baseIntervalMs), Infinity);
    if (!Number.isFinite(shortest)) return;
    const targetForShortest = Math.max(
      this.pressureMinIntervalMs,
      Math.round(shortest * this.pressureBackoffFactor),
    );
    if (targetForShortest <= shortest) {
      this.logger.warn({
        event: "worker.pressure_mode.ineffective",
        message:
          `Pressure mode cannot reduce polling for the shortest job: target interval ` +
          `${targetForShortest}ms <= shortest job interval ${shortest}ms ` +
          `(pressureMinIntervalMs=${this.pressureMinIntervalMs}, pressureBackoffFactor=${this.pressureBackoffFactor})`,
        fields: {
          pressureMinIntervalMs: this.pressureMinIntervalMs,
          pressureBackoffFactor: this.pressureBackoffFactor,
          shortestIntervalMs: shortest,
        },
      });
    }
  }

  private clearPressureWatchdog(): void {
    if (this.pressureWatchdogTimer) {
      clearTimeout(this.pressureWatchdogTimer);
      this.pressureWatchdogTimer = null;
    }
  }

  /** 启动 Worker 宿主 */
  start(): void {
    if (this.running) return;
    this.running = true;

    this.logger.info({
      event: "worker.started",
      message: `Worker ${this.workerId} started with ${this.jobStates.length} tasks`,
      fields: {
        workerId: this.workerId,
        defaultTickMs: this.defaultTickMs,
        taskCount: this.jobStates.length,
        tasks: this.listJobs(),
        adaptiveEnabled: this.adaptiveEnabled,
        enableIpc: this.enableIpc,
      },
    });

    if (this.enableIpc) {
      this.ipcServer = new WorkerIpcServer({
        socketPath: this.ipcSocketPath,
        handlers: {
          // 返回 wakeJob 结果，使服务端能对未注册的任务名回执 ok:false，
          // 客户端不再把"写出去"误判为"已投递"。
          onWake: (task) => this.wakeJob(task),
          onPressure: (active, durationMs) => {
            this.setPressureMode(active, durationMs);
          },
        },
      });
      void this.ipcServer.start().catch((err) => {
        this.logger.warn({
          event: "worker.ipc.start_failed",
          message: `Worker IPC server failed to start: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
    }

    this.warnIfPressureFloorIneffective();

    for (const [index, state] of this.jobStates.entries()) {
      const initialDelay = Math.min(index * this.initialStaggerMs, Math.max(0, state.baseIntervalMs - 1));
      if (initialDelay === 0) {
        void state.runOnce();
      } else {
        const timeout = setTimeout(() => {
          void state.runOnce();
        }, initialDelay);
        this.startupTimeouts.push(timeout);
      }
    }
  }

  /** 停止宿主调度（清理全部定时器与 IPC 服务）；可重复调用，可 await 等待 socket 清理完成 */
  async stop(): Promise<void> {
    this.running = false;

    this.clearPressureWatchdog();
    this.pressureMode = false;
    this.pressureExpiresAt = null;

    for (const timeout of this.startupTimeouts) {
      clearTimeout(timeout);
    }
    this.startupTimeouts.length = 0;

    for (const state of this.jobStates) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      state.scheduledIntervalMs = 0;
      state.hasPendingWakeup = false;
    }

    const ipcServer = this.ipcServer;
    this.ipcServer = null;
    if (ipcServer) {
      try {
        await ipcServer.stop();
      } catch {
        // 关闭失败不应阻断退出流程
      }
    }
  }
}
