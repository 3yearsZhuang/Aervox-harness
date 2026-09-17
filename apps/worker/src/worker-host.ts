/**
 * Aervox｜思隅 @aervox/worker — 模块化 Worker 任务调度宿主（WorkerHost）
 *
 * 核心设计：
 * - JobContribution 契约：任务以独立 Contribution 形式挂载，声明 name 与 run 逻辑；
 * - 错峰首次执行（initialStaggerMs）：避免多任务在启动瞬间同时争抢 SQLite 写入锁；
 * - 独立节拍器与防自重叠锁：上一轮未结束时静默跳过本轮，防止任务堆积与重入；
 * - 单任务故障隔离：单任务执行异常仅记录错误日志，不影响后续轮次或其它任务；
 * - 优雅启停生命周期：提供 start() 与 stop()，清理 timers 并支持优雅退出。
 */
import type { LoggerPort } from "@aervox/observability";
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

export interface WorkerHostOptions {
  workerId: string;
  defaultTickMs?: number;
  intervalOverrides?: Readonly<Record<string, number>>;
  initialStaggerMs?: number;
  logger: LoggerPort;
}

export interface RegisteredJobInfo {
  name: string;
  intervalMs: number;
}

export class WorkerHost {
  private readonly workerId: string;
  private readonly defaultTickMs: number;
  private readonly intervalOverrides: Readonly<Record<string, number>>;
  private readonly initialStaggerMs: number;
  private readonly logger: LoggerPort;

  private readonly jobs: Array<{ job: JobContribution; intervalMs: number }> = [];
  private readonly timers: Array<ReturnType<typeof setInterval>> = [];
  private readonly startupTimeouts: Array<ReturnType<typeof setTimeout>> = [];
  private running = false;

  constructor(options: WorkerHostOptions) {
    this.workerId = options.workerId;
    this.defaultTickMs = options.defaultTickMs ?? DEFAULT_WORKER_TICK_MS;
    this.intervalOverrides = options.intervalOverrides ?? {};
    this.initialStaggerMs = options.initialStaggerMs ?? 250;
    this.logger = options.logger;
  }

  /** 注册一项任务 Contribution */
  registerJob(job: JobContribution): this {
    if (this.running) {
      throw new Error(`Cannot register job "${job.name}" after WorkerHost has started`);
    }
    const intervalMs = resolveWorkerTaskInterval(
      job.name,
      this.defaultTickMs,
      this.intervalOverrides,
    );
    this.jobs.push({ job, intervalMs });
    return this;
  }

  /** 获取已注册的任务列表元信息 */
  listJobs(): RegisteredJobInfo[] {
    return this.jobs.map((item) => ({
      name: item.job.name,
      intervalMs: item.intervalMs,
    }));
  }

  /** 是否已启动 */
  isRunning(): boolean {
    return this.running;
  }

  /** 启动 Worker 宿主 */
  start(): void {
    if (this.running) return;
    this.running = true;

    this.logger.info({
      event: "worker.started",
      message: `Worker ${this.workerId} started with ${this.jobs.length} tasks`,
      fields: {
        workerId: this.workerId,
        defaultTickMs: this.defaultTickMs,
        taskCount: this.jobs.length,
        tasks: this.listJobs(),
      },
    });

    for (const [index, { job, intervalMs }] of this.jobs.entries()) {
      let isTaskRunning = false;

      const runOnce = async (): Promise<void> => {
        if (!this.running) return;
        if (isTaskRunning) return; // 防重叠锁
        isTaskRunning = true;
        const startTime = Date.now();
        try {
          const processed = await job.run({
            workerId: this.workerId,
            logger: this.logger,
          });
          const durationMs = Date.now() - startTime;
          if (processed > 0) {
            this.logger.info({
              event: "worker.task.completed",
              message: `Task ${job.name} processed ${processed} items (${durationMs}ms)`,
              fields: {
                task: job.name,
                processed,
                durationMs,
              },
            });
          }
        } catch (err) {
          const errorObj = err instanceof Error ? err : new Error(String(err));
          this.logger.error({
            event: "worker.task.failed",
            message: `Task ${job.name} tick failed: ${errorObj.message}`,
            fields: {
              task: job.name,
              error: errorObj.name,
              stack: errorObj.stack,
            },
          });
        } finally {
          isTaskRunning = false;
        }
      };

      const initialDelay = Math.min(index * this.initialStaggerMs, Math.max(0, intervalMs - 1));
      if (initialDelay === 0) {
        void runOnce();
      } else {
        const timeout = setTimeout(() => {
          void runOnce();
        }, initialDelay);
        this.startupTimeouts.push(timeout);
      }

      const timer = setInterval(() => {
        void runOnce();
      }, intervalMs);
      this.timers.push(timer);
    }
  }

  /** 停止宿主调度（清理全部定时器） */
  stop(): void {
    this.running = false;
    for (const timeout of this.startupTimeouts) {
      clearTimeout(timeout);
    }
    this.startupTimeouts.length = 0;
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers.length = 0;
  }
}
