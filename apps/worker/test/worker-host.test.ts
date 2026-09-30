import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MAX_WORKER_PRESSURE_DURATION_MS } from "@aervox/repositories";
import { WorkerHost, type JobContribution } from "../src/worker-host.js";

describe("WorkerHost (模块化后台任务调度器)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createMockLogger = () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  });

  it("正确注册任务并解析调度间隔（继承系统默认与配置覆盖）", () => {
    const logger = createMockLogger();
    const host = new WorkerHost({
      workerId: "test-worker-1",
      defaultTickMs: 5_000,
      intervalOverrides: {
        outbox: 1_500,
      },
      logger: logger as any,
    });

    const outboxJob: JobContribution = {
      name: "outbox",
      run: vi.fn().mockResolvedValue(0),
    };
    const reviewJob: JobContribution = {
      name: "review",
      run: vi.fn().mockResolvedValue(0),
    };

    host.registerJob(outboxJob);
    host.registerJob(reviewJob);

    const jobs = host.listJobs();
    expect(jobs).toEqual([
      { name: "outbox", intervalMs: 1_500 }, // 覆盖
      { name: "review", intervalMs: 10_000 }, // 系统默认 review 间隔
    ]);
  });

  it("禁止在启动后注册新任务", async () => {
    const logger = createMockLogger();
    const host = new WorkerHost({
      workerId: "test-worker-2",
      logger: logger as any,
    });

    host.start();
    expect(host.isRunning()).toBe(true);

    expect(() => {
      host.registerJob({
        name: "late-job",
        run: vi.fn().mockResolvedValue(0),
      });
    }).toThrow('Cannot register job "late-job" after WorkerHost has started');

    await host.stop();
  });

  it("错峰启动与任务生命周期驱动，处理数量 > 0 时记录完成日志", async () => {
    const logger = createMockLogger();
    const host = new WorkerHost({
      workerId: "test-worker-3",
      defaultTickMs: 2_000,
      initialStaggerMs: 100,
      logger: logger as any,
    });

    const runFirst = vi.fn().mockResolvedValue(3);
    const runSecond = vi.fn().mockResolvedValue(0);

    host.registerJob({ name: "first", run: runFirst });
    host.registerJob({ name: "second", run: runSecond });

    host.start();

    // 启动即记录 worker.started
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "worker.started",
        message: expect.stringContaining("Worker test-worker-3 started with 2 tasks"),
      }),
    );

    // 第一个任务 initialDelay = 0，立即触发
    await vi.advanceTimersByTimeAsync(10);
    expect(runFirst).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "worker.task.completed",
        message: expect.stringContaining("Task first processed 3 items"),
      }),
    );

    // 第二个任务 initialDelay = 100ms
    expect(runSecond).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(runSecond).toHaveBeenCalledTimes(1);

    await host.stop();
    expect(host.isRunning()).toBe(false);
  });

  it("防重叠锁保护：上一轮任务未完成时跳过本轮执行", async () => {
    const logger = createMockLogger();
    const host = new WorkerHost({
      workerId: "test-worker-4",
      defaultTickMs: 1_000,
      initialStaggerMs: 0,
      logger: logger as any,
    });

    let resolveSlowRun: () => void;
    const slowRunPromise = new Promise<number>((resolve) => {
      resolveSlowRun = () => resolve(1);
    });

    const slowJobRun = vi.fn().mockImplementation(() => slowRunPromise);
    host.registerJob({ name: "slow-job", run: slowJobRun });

    host.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(slowJobRun).toHaveBeenCalledTimes(1);

    // 步进一个 interval（1_000ms），由于 slowJobRun 仍在挂起，不应再次进入
    await vi.advanceTimersByTimeAsync(1_000);
    expect(slowJobRun).toHaveBeenCalledTimes(1);

    // 完成 slow run
    resolveSlowRun!();
    await vi.advanceTimersByTimeAsync(10);

    // 再次步进一个 interval，此时锁已释放，进入下一轮
    await vi.advanceTimersByTimeAsync(1_000);
    expect(slowJobRun).toHaveBeenCalledTimes(2);

    await host.stop();
  });

  it("异常隔离保护：单任务抛出错误不拖垮其它任务与后续轮次", async () => {
    const logger = createMockLogger();
    const host = new WorkerHost({
      workerId: "test-worker-5",
      defaultTickMs: 1_000,
      initialStaggerMs: 50,
      logger: logger as any,
    });

    const failingJobRun = vi
      .fn()
      .mockRejectedValueOnce(new Error("Database write locked"))
      .mockResolvedValueOnce(2);

    const normalJobRun = vi.fn().mockResolvedValue(1);

    host.registerJob({ name: "failing-job", run: failingJobRun });
    host.registerJob({ name: "normal-job", run: normalJobRun });

    host.start();

    // 触发 failing job 首次执行 (delay = 0)
    await vi.advanceTimersByTimeAsync(10);
    expect(failingJobRun).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "worker.task.failed",
        message: expect.stringContaining("Database write locked"),
      }),
    );

    // 触发 normal job (delay = 50ms)
    await vi.advanceTimersByTimeAsync(50);
    expect(normalJobRun).toHaveBeenCalledTimes(1);

    // 下一轮 failing job 再次触发 (1_000ms interval) 并自愈恢复
    await vi.advanceTimersByTimeAsync(1_000);
    expect(failingJobRun).toHaveBeenCalledTimes(2);

    await host.stop();
  });

  it("ITER-027: 空轮询自适应退避与唤醒即刻重置（消灭高频空读）", async () => {
    const logger = createMockLogger();
    const host = new WorkerHost({
      workerId: "test-adaptive-worker",
      defaultTickMs: 1_000,
      initialStaggerMs: 0,
      adaptiveBackoff: {
        enabled: true,
        idleMultiplier: 2.0,
        maxIntervalMs: 8_000,
      },
      logger: logger as any,
    });

    const idleJobRun = vi.fn().mockResolvedValue(0);
    host.registerJob({ name: "idle-job", run: idleJobRun });

    host.start();
    // 首次执行 (t=0)
    await vi.advanceTimersByTimeAsync(10);
    expect(idleJobRun).toHaveBeenCalledTimes(1);
    // idleStreak = 1: 1000 * 2^1 = 2000ms
    expect(host.getJobState("idle-job")?.currentIntervalMs).toBe(2_000);

    // 步进 1000ms: 不应触发
    await vi.advanceTimersByTimeAsync(1_000);
    expect(idleJobRun).toHaveBeenCalledTimes(1);

    // 再步进 1000ms (共 2000ms): 触发第 2 次
    await vi.advanceTimersByTimeAsync(1_000);
    expect(idleJobRun).toHaveBeenCalledTimes(2);
    // idleStreak = 2: 1000 * 2^2 = 4000ms
    expect(host.getJobState("idle-job")?.currentIntervalMs).toBe(4_000);

    // 唤醒任务：wakeJob 即刻重置间隔并触发执行
    const woke = host.wakeJob("idle-job");
    expect(woke).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(idleJobRun).toHaveBeenCalledTimes(3);
    // 间隔重置回 baseIntervalMs (1000ms)
    expect(host.getJobState("idle-job")?.currentIntervalMs).toBe(2_000); // 再次运行且返回0后进入下一次退避

    await host.stop();
  });

  it("ITER-027: 写入压力模式（pressureMode）强制抬高轮询底线至 3000ms+", async () => {
    const logger = createMockLogger();
    const host = new WorkerHost({
      workerId: "test-pressure-worker",
      defaultTickMs: 500,
      initialStaggerMs: 0,
      adaptiveBackoff: {
        pressureMinIntervalMs: 3_000,
      },
      logger: logger as any,
    });

    const fastJobRun = vi.fn().mockResolvedValue(1);
    host.registerJob({ name: "fast-job", run: fastJobRun });

    host.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(fastJobRun).toHaveBeenCalledTimes(1);

    // 开启写入压力模式（如会话流式进行中）
    host.setPressureMode(true, 5_000);
    expect(host.isPressureMode()).toBe(true);

    // 在 500ms 时不应触发，因为压力模式保底 >= 3000ms
    await vi.advanceTimersByTimeAsync(500);
    expect(fastJobRun).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_500); // 累积 3000ms
    expect(fastJobRun).toHaveBeenCalledTimes(2);

    // 退出压力模式
    host.setPressureMode(false);
    expect(host.isPressureMode()).toBe(false);

    // 恢复正常 500ms 周期
    await vi.advanceTimersByTimeAsync(500);
    expect(fastJobRun).toHaveBeenCalledTimes(3);

    await host.stop();
  });

  it("ITER-027: 遭遇 SQLite BUSY 锁冲突时自愈进入退避模式", async () => {
    const logger = createMockLogger();
    const host = new WorkerHost({
      workerId: "test-busy-worker",
      defaultTickMs: 500,
      initialStaggerMs: 0,
      adaptiveBackoff: {
        pressureMinIntervalMs: 3_000,
      },
      logger: logger as any,
    });

    const busyJobRun = vi
      .fn()
      .mockRejectedValueOnce(new Error("SQLITE_BUSY: database is locked"))
      .mockResolvedValueOnce(1);

    host.registerJob({ name: "busy-job", run: busyJobRun });

    host.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(busyJobRun).toHaveBeenCalledTimes(1);

    // 遭遇 SQLITE_BUSY 后，自动触发写入压力退避
    expect(host.isPressureMode()).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "worker.task.busy_conflict",
      }),
    );

    // 经过 3000ms 压力退避后再重试
    await vi.advanceTimersByTimeAsync(3_000);
    expect(busyJobRun).toHaveBeenCalledTimes(2);

    await host.stop();
  });

  it("ITER-027: 压力模式只延长不缩短——不会把已退避任务拉回高频", async () => {
    const logger = createMockLogger();
    const host = new WorkerHost({
      workerId: "test-pressure-monotonic",
      defaultTickMs: 1_000,
      initialStaggerMs: 0,
      adaptiveBackoff: {
        enabled: true,
        idleMultiplier: 2,
        maxIntervalMs: 30_000,
        pressureMinIntervalMs: 3_000,
        pressureBackoffFactor: 2,
      },
      logger: logger as any,
    });

    const idleJobRun = vi.fn().mockResolvedValue(0);
    host.registerJob({ name: "idle-job", run: idleJobRun });

    host.start();
    await vi.advanceTimersByTimeAsync(10);
    // 连续空轮询退避：1000 → 2000 → 4000 → 8000 → 16000
    for (let index = 0; index < 3; index += 1) {
      await vi.advanceTimersByTimeAsync(host.getJobState("idle-job")!.scheduledIntervalMs);
    }

    const backedOffInterval = host.getJobState("idle-job")!.scheduledIntervalMs;
    expect(backedOffInterval).toBeGreaterThanOrEqual(8_000);

    host.setPressureMode(true, 5_000);

    // 旧实现会把该任务重排到 pressureMinIntervalMs(3000ms)，在密集写入期间反而把
    // 轮询频率提高约 5~10 倍；修复后只延长、不缩短。
    expect(host.getJobState("idle-job")!.scheduledIntervalMs).toBe(backedOffInterval);

    await host.stop();
  });

  it("ITER-027: 压力模式对出厂 outbox 间隔（3000ms）真正生效", async () => {
    const logger = createMockLogger();
    const host = new WorkerHost({
      workerId: "test-pressure-effective",
      // 保持默认 tick，让 outbox 走内置任务级默认值 3000ms
      initialStaggerMs: 0,
      adaptiveBackoff: {
        pressureMinIntervalMs: 3_000,
        pressureBackoffFactor: 2,
      },
      logger: logger as any,
    });

    const outboxRun = vi.fn().mockResolvedValue(1);
    host.registerJob({ name: "outbox", run: outboxRun });

    host.start();
    expect(host.listJobs()).toEqual([{ name: "outbox", intervalMs: 3_000 }]);
    await vi.advanceTimersByTimeAsync(10);
    expect(outboxRun).toHaveBeenCalledTimes(1);

    host.setPressureMode(true, 30_000);

    // 压力目标 = max(3000, 3000 × 2) = 6000ms。
    // 旧实现目标为 max(3000, 3000) = 3000ms，此处会在 3000ms 就再次触发（压力模式形同空操作）。
    await vi.advanceTimersByTimeAsync(3_000);
    expect(outboxRun).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(outboxRun).toHaveBeenCalledTimes(2);

    await host.stop();
  });

  it("ITER-027: 压力窗口单调——较短的后续请求不会截断较长在途窗口", async () => {
    const logger = createMockLogger();
    const host = new WorkerHost({
      workerId: "test-pressure-window",
      defaultTickMs: 1_000,
      initialStaggerMs: 0,
      logger: logger as any,
    });
    host.registerJob({ name: "job", run: vi.fn().mockResolvedValue(1) });

    host.start();
    await vi.advanceTimersByTimeAsync(10);

    host.setPressureMode(true, 20_000);
    // busy 自愈路径会下发较短的 5s 窗口；旧实现会截断在途的 20s 窗口
    host.setPressureMode(true, 5_000);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(host.isPressureMode()).toBe(true);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(host.isPressureMode()).toBe(false);

    await host.stop();
  });

  it("ITER-027: 未指定时长时压力窗口按上限兜底，不会无限期抑制后台任务", async () => {
    const logger = createMockLogger();
    const host = new WorkerHost({
      workerId: "test-pressure-bounded",
      defaultTickMs: 1_000,
      initialStaggerMs: 0,
      logger: logger as any,
    });
    host.registerJob({ name: "job", run: vi.fn().mockResolvedValue(1) });

    host.start();
    await vi.advanceTimersByTimeAsync(10);

    host.setPressureMode(true);
    expect(host.isPressureMode()).toBe(true);

    await vi.advanceTimersByTimeAsync(MAX_WORKER_PRESSURE_DURATION_MS - 1);
    expect(host.isPressureMode()).toBe(true);

    await vi.advanceTimersByTimeAsync(2);
    expect(host.isPressureMode()).toBe(false);

    await host.stop();
  });

  it("ITER-027: registerJob 的 defaultIntervalMs 生效，显式环境覆盖优先", () => {
    const host = new WorkerHost({
      workerId: "test-default-interval",
      defaultTickMs: 5_000,
      intervalOverrides: { review: 1_500 },
      logger: createMockLogger() as any,
    });

    host.registerJob({
      name: "custom",
      defaultIntervalMs: 700,
      run: vi.fn().mockResolvedValue(0),
    });
    host.registerJob({
      name: "review",
      defaultIntervalMs: 700,
      run: vi.fn().mockResolvedValue(0),
    });

    // defaultIntervalMs 过去只声明不生效（死字段），此处让它真正参与间隔解析。
    expect(host.listJobs()).toEqual([
      { name: "custom", intervalMs: 700 },
      { name: "review", intervalMs: 1_500 },
    ]);
  });

  it("ITER-027: 压力下限无法生效时在启动期告警（不再静默空操作）", async () => {
    const logger = createMockLogger();
    const host = new WorkerHost({
      workerId: "test-pressure-ineffective",
      defaultTickMs: 5_000,
      initialStaggerMs: 0,
      adaptiveBackoff: {
        pressureMinIntervalMs: 1_000,
        pressureBackoffFactor: 1,
      },
      logger: logger as any,
    });
    host.registerJob({ name: "outbox", run: vi.fn().mockResolvedValue(0) });

    host.start();
    await vi.advanceTimersByTimeAsync(10);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "worker.pressure_mode.ineffective" }),
    );

    await host.stop();
  });

  it("ITER-027: stop() 幂等并重置压力模式与排期", async () => {
    const logger = createMockLogger();
    const host = new WorkerHost({
      workerId: "test-stop-idempotent",
      defaultTickMs: 1_000,
      initialStaggerMs: 0,
      logger: logger as any,
    });
    host.registerJob({ name: "job", run: vi.fn().mockResolvedValue(1) });

    host.start();
    await vi.advanceTimersByTimeAsync(10);
    host.setPressureMode(true, 5_000);
    expect(host.isPressureMode()).toBe(true);

    await host.stop();
    expect(host.isRunning()).toBe(false);
    expect(host.isPressureMode()).toBe(false);
    expect(host.getJobState("job")!.scheduledIntervalMs).toBe(0);
    expect(host.getJobState("job")!.hasPendingWakeup).toBe(false);

    await expect(host.stop()).resolves.toBeUndefined();
  });
});
