/**
 * Aervox｜思隅 @aervox/worker — 模块化 Worker 任务调度宿主（WorkerHost）
 *
 * 核心设计（ITER-027 演进）：
 * - JobContribution 契约：任务以独立 Contribution 形式挂载，声明 name 与 run 逻辑；
 * - 错峰首次执行（initialStaggerMs）：避免多任务在启动瞬间同时争抢 SQLite 写入锁；
 * - 动态自适应退避（Adaptive Backoff）：空轮询时自动按指数递增退避间隔，消灭无意义 CPU 与 SQLite 空读；
 * - 写入压力协调（Write Pressure Backoff）：密集会话/流式写入期间主动退避至低频轮询（>=3s），杜绝写锁冲突；
 * - 本地跨进程 IPC 秒级唤醒（Worker IPC Channel）：API/仓储层新入任务即刻唤醒，消灭轮询等待时延；
 * - 独立防自重叠锁与单任务故障隔离：保证高并发下调度稳定与异常自愈；
 * - 优雅启停生命周期：清理 timers、ipcServer 并支持优雅退出。
 */
import type { LoggerPort } from "@aervox/observability";
import { isSqliteBusyError, WorkerIpcServer } from "@aervox/repositories";
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
  /** 写入压力/密集会话模式下的最低轮询间隔（ms），默认 3_000 */
  readonly pressureMinIntervalMs?: number;
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

    this.enableIpc = options.enableIpc ?? false;
    this.ipcSocketPath = options.ipcSocketPath;
  }

  /** 注册一项任务 Contribution */
  registerJob(job: JobContribution): this {
    if (this.running) {
      throw new Error(`Cannot register job "${job.name}" after WorkerHost has started`);
    }
    const baseIntervalMs = resolveWorkerTaskInterval(
      job.name,
      this.defaultTickMs,
      this.intervalOverrides,
    );

    const state: JobRunnerState = {
      job,
      baseIntervalMs,
      currentIntervalMs: baseIntervalMs,
      idleStreak: 0,
      isTaskRunning: false,
      hasPendingWakeup: false,
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
          // 遭遇锁冲突时自动启动 5 秒写入压力退避，减少锁竞争
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
          state.timer = setTimeout(() => {
            void state.runOnce();
          }, 0);
          return;
        }

        const effectiveInterval = this.pressureMode
          ? Math.max(state.currentIntervalMs, this.pressureMinIntervalMs)
          : state.currentIntervalMs;

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
  getJobState(name: string): { currentIntervalMs: number; idleStreak: number; isTaskRunning: boolean } | undefined {
    const state = this.jobStates.find((s) => s.job.name === name);
    if (!state) return undefined;
    return {
      currentIntervalMs: state.currentIntervalMs,
      idleStreak: state.idleStreak,
      isTaskRunning: state.isTaskRunning,
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
      void state.runOnce();
      return true;
    }
    return false;
  }

  /**
   * 设置写入压力退避模式。
   * 当 active 为 true 时，Worker 将后台任务轮询下限提高至 pressureMinIntervalMs（如 3000ms+），杜绝写锁冲突。
   */
  setPressureMode(active: boolean, durationMs?: number): void {
    if (this.pressureWatchdogTimer) {
      clearTimeout(this.pressureWatchdogTimer);
      this.pressureWatchdogTimer = null;
    }

    this.pressureMode = active;

    if (active) {
      this.logger.info({
        event: "worker.pressure_mode.entered",
        message: `Worker entered write pressure mode (polling floor >= ${this.pressureMinIntervalMs}ms)`,
        fields: { pressureMinIntervalMs: this.pressureMinIntervalMs, durationMs },
      });

      // 立即将所有已排期但尚未执行的任务推迟至 pressureMinIntervalMs，杜绝即刻开火的锁冲突
      for (const state of this.jobStates) {
        if (state.timer && !state.isTaskRunning) {
          clearTimeout(state.timer);
          state.timer = setTimeout(() => {
            void state.runOnce();
          }, this.pressureMinIntervalMs);
        }
      }

      if (durationMs && durationMs > 0) {
        this.pressureWatchdogTimer = setTimeout(() => {
          this.setPressureMode(false);
        }, durationMs);
      }
    } else {
      this.logger.info({
        event: "worker.pressure_mode.exited",
        message: "Worker exited write pressure mode; resumed adaptive cadence",
      });

      // 退出压力模式时：若在压力期间累积了待处理唤醒，立即启动消费；其余任务恢复正常周期
      for (const state of this.jobStates) {
        if (state.hasPendingWakeup && !state.isTaskRunning) {
          state.hasPendingWakeup = false;
          if (state.timer) clearTimeout(state.timer);
          void state.runOnce();
        } else if (state.timer && !state.isTaskRunning) {
          clearTimeout(state.timer);
          state.timer = setTimeout(() => {
            void state.runOnce();
          }, state.currentIntervalMs);
        }
      }
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
          onWake: (task) => {
            this.wakeJob(task);
          },
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

  /** 停止宿主调度（清理全部定时器与 IPC 服务） */
  stop(): void {
    this.running = false;

    if (this.pressureWatchdogTimer) {
      clearTimeout(this.pressureWatchdogTimer);
      this.pressureWatchdogTimer = null;
    }

    for (const timeout of this.startupTimeouts) {
      clearTimeout(timeout);
    }
    this.startupTimeouts.length = 0;

    for (const state of this.jobStates) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    }

    if (this.ipcServer) {
      void this.ipcServer.stop();
      this.ipcServer = null;
    }
  }
}
