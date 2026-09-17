import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

  it("禁止在启动后注册新任务", () => {
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

    host.stop();
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

    host.stop();
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

    host.stop();
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

    host.stop();
  });
});
