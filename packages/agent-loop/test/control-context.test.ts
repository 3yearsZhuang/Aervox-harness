import { describe, expect, it, vi } from "vitest";
import { createControlContext } from "../src/control-context.js";

describe("ControlContext", () => {
  it("应正确初始化基础属性", () => {
    const ctx = createControlContext({
      executionId: "exec-1",
      turnId: "turn-1",
      attemptId: "att-1",
      sessionId: "sess-1",
      fencingToken: 42,
      localProcessingOnly: true,
    });

    expect(ctx.executionId).toBe("exec-1");
    expect(ctx.turnId).toBe("turn-1");
    expect(ctx.attemptId).toBe("att-1");
    expect(ctx.sessionId).toBe("sess-1");
    expect(ctx.fencingToken).toBe(42);
    expect(ctx.localProcessingOnly).toBe(true);
    expect(ctx.isExpired()).toBe(false);
    expect(ctx.isAborted()).toBe(false);
  });

  it("应在外部 AbortSignal 触发时同步中断", () => {
    const controller = new AbortController();
    const ctx = createControlContext({
      executionId: "exec-1",
      turnId: "turn-1",
      attemptId: "att-1",
      fencingToken: 1,
      abortSignal: controller.signal,
    });

    expect(ctx.isAborted()).toBe(false);
    controller.abort(new Error("用户主动取消"));
    expect(ctx.isAborted()).toBe(true);
  });

  it("应在截止时间到达时中断并标记已过期", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      const ctx = createControlContext({
        executionId: "exec-1",
        turnId: "turn-1",
        attemptId: "att-1",
        fencingToken: 1,
        deadlineEpochMs: now + 1000,
      });

      expect(ctx.isExpired()).toBe(false);
      expect(ctx.isAborted()).toBe(false);

      vi.advanceTimersByTime(1001);

      expect(ctx.isExpired()).toBe(true);
      expect(ctx.isAborted()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("应在超额使用 Token 预算时自动中断", () => {
    const ctx = createControlContext({
      executionId: "exec-1",
      turnId: "turn-1",
      attemptId: "att-1",
      fencingToken: 1,
      tokenBudget: { maxTokens: 1000, usedTokens: 0 },
    });

    ctx.recordTokensUsed(600);
    expect(ctx.isAborted()).toBe(false);
    expect(ctx.tokenBudget?.usedTokens).toBe(600);

    ctx.recordTokensUsed(500);
    expect(ctx.isAborted()).toBe(true);
    expect(ctx.tokenBudget?.usedTokens).toBe(1100);
  });

  it("应在超额使用调用次数预算时自动中断", () => {
    const ctx = createControlContext({
      executionId: "exec-1",
      turnId: "turn-1",
      attemptId: "att-1",
      fencingToken: 1,
      callBudget: { maxCalls: 2, usedCalls: 0 },
    });

    ctx.recordCallUsed();
    ctx.recordCallUsed();
    expect(ctx.isAborted()).toBe(false);

    ctx.recordCallUsed();
    expect(ctx.isAborted()).toBe(true);
    expect(ctx.callBudget?.usedCalls).toBe(3);
  });

  describe("deriveSubtask (派生子任务控制)", () => {
    it("父级 localProcessingOnly 为 true 时，子级必须保持 true", () => {
      const parent = createControlContext({
        executionId: "parent-1",
        turnId: "turn-1",
        attemptId: "att-1",
        fencingToken: 1,
        localProcessingOnly: true,
      });

      const child = parent.deriveSubtask({ localProcessingOnly: false });
      expect(child.localProcessingOnly).toBe(true);
      expect(child.parentExecutionId).toBe("parent-1");
    });

    it("子任务截止时间只能收紧，不能比父级更宽松", () => {
      const now = Date.now();
      const parent = createControlContext({
        executionId: "parent-1",
        turnId: "turn-1",
        attemptId: "att-1",
        fencingToken: 1,
        deadlineEpochMs: now + 5000,
      });

      // 尝试传入更晚的截止时间，必须被截断为父级截止时间
      const child1 = parent.deriveSubtask({ tighterDeadlineEpochMs: now + 10000 });
      expect(child1.deadlineEpochMs).toBe(now + 5000);

      // 传入更早的截止时间，允许收紧
      const child2 = parent.deriveSubtask({ tighterDeadlineEpochMs: now + 2000 });
      expect(child2.deadlineEpochMs).toBe(now + 2000);
    });

    it("子任务预算不能超过父级剩余预算", () => {
      const parent = createControlContext({
        executionId: "parent-1",
        turnId: "turn-1",
        attemptId: "att-1",
        fencingToken: 1,
        tokenBudget: { maxTokens: 1000, usedTokens: 400 }, // 剩余 600
        callBudget: { maxCalls: 5, usedCalls: 2 }, // 剩余 3
      });

      const child = parent.deriveSubtask({
        tighterTokenBudget: 800, // 超过剩余 600，应截断为 600
        tighterCallBudget: 4, // 超过剩余 3，应截断为 3
      });

      expect(child.tokenBudget?.maxTokens).toBe(600);
      expect(child.callBudget?.maxCalls).toBe(3);
    });

    it("父级中断应连锁导致子级中断", () => {
      const parentController = new AbortController();
      const parent = createControlContext({
        executionId: "parent-1",
        turnId: "turn-1",
        attemptId: "att-1",
        fencingToken: 1,
        abortSignal: parentController.signal,
      });

      const child = parent.deriveSubtask();
      expect(child.isAborted()).toBe(false);

      parentController.abort();
      expect(child.isAborted()).toBe(true);
    });
  });
});
