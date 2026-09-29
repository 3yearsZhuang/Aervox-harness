import { describe, expect, it, vi } from "vitest";
import {
  createControlContext,
  executeTurn,
  InMemoryExecutionStore,
  createReplayProvider,
  defaultContextBuilder,
} from "../src/index.js";

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

  describe("executeTurn 与 ControlContext 集成", () => {
    it("传入已中断的 ControlContext 时，executeTurn 应在 Step 首部检查点中止并写入 Cancelled 终态", async () => {
      const store = new InMemoryExecutionStore();
      store.seedAttempt({ id: "att-c1", turnId: "turn-c1" });
      const controller = new AbortController();
      controller.abort();

      const control = createControlContext({
        executionId: "exec-cancelled",
        turnId: "turn-c1",
        attemptId: "att-c1",
        fencingToken: 1,
        abortSignal: controller.signal,
      });

      const res = await executeTurn(
        {
          execution: store,
          provider: createReplayProvider(),
          contextBuilder: defaultContextBuilder,
        },
        {
          turnId: "turn-c1",
          sessionId: "sess-c1",
          attemptId: "att-c1",
          userMessage: "hello",
          controlContext: control,
        }
      );

      expect(res.status).toBe("cancelled");
    });

    it("传入已超时的 ControlContext 时，executeTurn 应收敛为 Interrupted (deadline_exceeded)", async () => {
      const store = new InMemoryExecutionStore();
      store.seedAttempt({ id: "att-e1", turnId: "turn-e1" });
      const control = createControlContext({
        executionId: "exec-expired",
        turnId: "turn-e1",
        attemptId: "att-e1",
        fencingToken: 1,
        deadlineEpochMs: Date.now() - 100,
      });

      const res = await executeTurn(
        {
          execution: store,
          provider: createReplayProvider(),
          contextBuilder: defaultContextBuilder,
        },
        {
          turnId: "turn-e1",
          sessionId: "sess-e1",
          attemptId: "att-e1",
          userMessage: "hello",
          controlContext: control,
        }
      );

      expect(res.status).toBe("failed");
      expect(res.reason).toBe("deadline_exceeded");
    });
  });
});

it("子任务默认继承预算、显式收紧回记父预算，额外 signal 不切断父取消", () => {
  const parent = createControlContext({ tokenBudget: { maxTokens: 12, usedTokens: 0 }, callBudget: { maxCalls: 3, usedCalls: 0 } });
  const first = parent.deriveSubtask({ tighterTokenBudget: 8, subtaskSignal: new AbortController().signal });
  const sibling = parent.deriveSubtask();
  first.recordTokensUsed(7); first.recordCallUsed();
  expect(parent.tokenBudget?.usedTokens).toBe(7);
  expect(parent.callBudget?.usedCalls).toBe(1);
  expect(sibling.remainingTokens).toBe(5);
  expect(sibling.remainingCalls).toBe(2);
  parent.abort("parent");
  expect(first.isAborted()).toBe(true);
  first.dispose(); sibling.dispose(); parent.dispose();
});

it.each([0, 1, 2, 3])("真实执行回路遵守 %s 次派发预算（模型和工具共享）", async (maxCalls) => {
  const store = new InMemoryExecutionStore(); store.seedAttempt({ id: "a", turnId: "t" });
  let modelCalls = 0; let toolCalls = 0;
  const control = createControlContext({ callBudget: { maxCalls, usedCalls: 0 } });
  const result = await executeTurn({ execution: store, contextBuilder: defaultContextBuilder,
    provider: { id: "metered", async *stream({ step }) { modelCalls++; yield step === 1 ? { text: "", isFinal: true, toolCalls: [{ id: "c", name: "read", arguments: {} }] } : { text: "done", isFinal: true }; } },
    tools: { tools: [{ name: "read", description: "read", readOnly: true }], execute: async () => { toolCalls++; return { ok: true }; } },
  }, { turnId: "t", attemptId: "a", userMessage: "hello", controlContext: control });
  expect(modelCalls + toolCalls).toBe(maxCalls);
  expect(control.callBudget?.usedCalls).toBe(maxCalls);
  expect(result.status).toBe(maxCalls === 3 ? "completed" : "failed");
});

it.each([0, 1000])("Token 预算 %s 在派发前/流式输出中执行，超额后不调用工具", async (maxTokens) => {
  const store = new InMemoryExecutionStore(); store.seedAttempt({ id: "a", turnId: "t" });
  const control = createControlContext({ tokenBudget: { maxTokens, usedTokens: 0 } });
  let calls = 0;
  const tool = vi.fn();
  const result = await executeTurn({ execution: store, contextBuilder: defaultContextBuilder,
    provider: { id: "tokens", async *stream(request) { calls++; expect(request.maxOutputTokens).toBeLessThan(maxTokens); yield { text: "x".repeat(1001), isFinal: true, toolCalls: [{ id: "c", name: "read", arguments: {} }] }; } },
    tools: { tools: [{ name: "read", description: "read", readOnly: true }], execute: tool },
  }, { turnId: "t", attemptId: "a", userMessage: "hi", controlContext: control });
  expect(result.status).toBe("failed"); expect(calls).toBe(maxTokens ? 1 : 0); expect(tool).not.toHaveBeenCalled();
  const events = await store.listEvents("t"); expect(events.at(-1)?.data).toMatchObject({ status: "Interrupted" });
});

it("取消不合作的模型时有界返回，不接受迟到内容", async () => {
  const store = new InMemoryExecutionStore(); store.seedAttempt({ id: "a", turnId: "t" });
  const control = createControlContext();
  let release!: () => void; let entered!: () => void;
  const ready = new Promise<void>((r) => { entered = r; });
  const pending = new Promise<void>((r) => { release = r; });
  const run = executeTurn({ execution: store, contextBuilder: defaultContextBuilder,
    provider: { id: "hung", async *stream() { entered(); await pending; yield { text: "late", isFinal: true }; } },
  }, { turnId: "t", attemptId: "a", userMessage: "hi", controlContext: control });
  await ready; control.abort();
  expect((await run).status).toBe("cancelled"); release();
  expect((await store.listEvents("t")).some((e) => e.eventType === "delta")).toBe(false);
});

it("Provider 累计 usage 只向上补计，不因较小后续报数退款", async () => {
  const store = new InMemoryExecutionStore(); store.seedAttempt({ id: "a", turnId: "t" });
  const control = createControlContext({ tokenBudget: { maxTokens: 1500, usedTokens: 0 } });
  const result = await executeTurn({ execution: store, contextBuilder: defaultContextBuilder,
    provider: { id: "usage", async *stream() { yield { text: "", isFinal: false, usage: { totalTokens: 900 } }; yield { text: "", isFinal: true, usage: { totalTokens: 800 } }; } },
  }, { turnId: "t", attemptId: "a", userMessage: "hi", controlContext: control });
  expect(result.status).toBe("completed"); expect(control.tokenBudget?.usedTokens).toBe(900);
});

it("取消发生在工具预留期间时不得进入 handler", async () => {
  const store = new InMemoryExecutionStore(); store.seedAttempt({ id: "a", turnId: "t" });
  const control = createControlContext();
  const reserve = store.reserveToolExecution.bind(store);
  store.reserveToolExecution = async (input) => { const result = await reserve(input); control.abort(); return result; };
  const execute = vi.fn(async () => ({ ok: true }));
  const result = await executeTurn({ execution: store, contextBuilder: defaultContextBuilder,
    provider: { id: "tool", async *stream() { yield { text: "", isFinal: true, toolCalls: [{ id: "c", name: "read", arguments: {} }] }; } },
    tools: { tools: [{ name: "read", description: "read", readOnly: true }], execute },
  }, { turnId: "t", attemptId: "a", userMessage: "hi", controlContext: control });
  expect(result.status).toBe("cancelled"); expect(execute).not.toHaveBeenCalled();
});
