/**
 * Aervox｜思隅 @aervox/agent-loop — 阶段 1 契约测试
 *
 * 覆盖 AVX-HAR-001 §15 阶段 0/1 退出条件：
 * - 同一 replay 输入产生确定的事件序列与终态；
 * - claim 的 CAS/fencing 防重复执行；
 * - 原始 Provider chunk 先持久化（message → delta* → done），不直达客户端。
 */
import { describe, expect, it } from "vitest";
import {
  defaultContextBuilder,
  createReplayProvider,
  executeTurn,
  InMemoryExecutionStore,
} from "../src/index.js";
import type { ModelProviderPort } from "../src/index.js";

const deps = (store: InMemoryExecutionStore) => ({
  execution: store,
  provider: createReplayProvider(),
  contextBuilder: defaultContextBuilder,
});

describe("executeTurn（阶段 1 无工具单 Step）", () => {
  it("产出确定的事件序列 message → delta* → done，且序号连续", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_1", turnId: "turn_1" });

    const result = await executeTurn(deps(store), {
      turnId: "turn_1",
      sessionId: "sess_1",
      attemptId: "atp_1",
      userMessage: "帮我安排复习",
    });

    expect(result.status).toBe("completed");
    const events = await store.listEvents("turn_1");
    expect(events.map((e) => e.eventType)).toEqual(["message", "delta", "delta", "done"]);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
    expect(events[1].sequence).toBe(events[0].sequence + 1);

    // message 身份事件
    const message = events[0].data as { messageId: string; contentType: string; isComplete: boolean };
    expect(message.contentType).toBe("text");
    expect(message.isComplete).toBe(false);
    expect(message.messageId).toContain("turn_1");

    // delta 内容来自 fixture，末块 isFinal=true
    const deltas = events.filter((e) => e.eventType === "delta").map((e) => e.data as { text: string; isFinal: boolean });
    expect(deltas.map((d) => d.text)).toEqual(["收到！这个问题我记下了。", "（阶段 1 回放回答）我会帮你把复习计划排好。"]);
    expect(deltas[1].isFinal).toBe(true);

    // done 终态
    const done = events[3].data as { status: string; isComplete: boolean; lastSequence: number };
    expect(done.status).toBe("Completed");
    expect(done.isComplete).toBe(true);
    expect(done.lastSequence).toBe(4);

    expect(store.attemptStatus("atp_1")).toBe("Completed");
    // 3b-B：Step 首部探活续租一次（单 Step 也校验一次租约持有）
    expect(store.leaseRenewals()).toBe(1);
  });

  it("同一输入两次执行产生相同事件序列（确定性）", async () => {
    const run = async () => {
      const store = new InMemoryExecutionStore();
      store.seedAttempt({ id: "atp_2", turnId: "turn_2" });
      await executeTurn(deps(store), {
        turnId: "turn_2",
        sessionId: "sess_2",
        attemptId: "atp_2",
        userMessage: "x",
      });
      return (await store.listEvents("turn_2")).map((e) => `${e.sequence}:${e.eventType}:${e.eventType === "delta" ? (e.data as { text: string }).text : ""}`);
    };
    expect(await run()).toEqual(await run());
  });

  it("claim 后 fencing 递增，第二次执行跳过（防重复执行）", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_3", turnId: "turn_3" });

    const first = await executeTurn(deps(store), {
      turnId: "turn_3",
      sessionId: "sess_3",
      attemptId: "atp_3",
      userMessage: "y",
    });
    expect(first.status).toBe("completed");

    const second = await executeTurn(deps(store), {
      turnId: "turn_3",
      sessionId: "sess_3",
      attemptId: "atp_3",
      userMessage: "y",
    });
    expect(second.status).toBe("skipped");
    expect((await store.listEvents("turn_3")).length).toBe(4); // 未追加事件
  });

  it("fixture 为 3 块时产出 3 个 delta", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_4", turnId: "turn_4" });
    const result = await executeTurn(
      {
        execution: store,
        provider: createReplayProvider(["a", "b", "c"]),
        contextBuilder: defaultContextBuilder,
      },
      { turnId: "turn_4", sessionId: "sess_4", attemptId: "atp_4", userMessage: "z" },
    );
    expect(result.status).toBe("completed");
    const events = await store.listEvents("turn_4");
    expect(events.filter((e) => e.eventType === "delta")).toHaveLength(3);
  });

  it("attempt 不可执行（非 Running）时跳过", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_5", turnId: "turn_5", status: "Completed" });
    const result = await executeTurn(deps(store), {
      turnId: "turn_5",
      sessionId: "sess_5",
      attemptId: "atp_5",
      userMessage: "w",
    });
    expect(result.status).toBe("skipped");
    expect(result).toMatchObject({ reason: "not_runnable" });
  });
});

describe("executeTurn（CR-027 思考增量 reasoning_delta）", () => {
  /** 思考型模型桩：先吐 reasoning 增量，再吐正文 */
  const thinkingProvider = (): ModelProviderPort => ({
    id: "thinking-stub",
    async *stream() {
      yield { text: "", isFinal: false, reasoning: "先想一步" };
      yield { text: "", isFinal: false, reasoning: "再想一步" };
      yield { text: "最终回答", isFinal: true };
    },
  });

  it("reasoning 增量以 reasoning_delta 事件落库（不占正文 delta），序号连续", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_t1", turnId: "turn_t1" });

    const result = await executeTurn(
      { execution: store, provider: thinkingProvider(), contextBuilder: defaultContextBuilder },
      { turnId: "turn_t1", sessionId: "sess_t1", attemptId: "atp_t1", userMessage: "q" },
    );

    expect(result.status).toBe("completed");
    const events = await store.listEvents("turn_t1");
    expect(events.map((e) => e.eventType)).toEqual([
      "message",
      "reasoning_delta",
      "reasoning_delta",
      "delta",
      "done",
    ]);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    const reasoning = events.filter((e) => e.eventType === "reasoning_delta").map((e) => e.data as { text: string });
    expect(reasoning.map((r) => r.text)).toEqual(["先想一步", "再想一步"]);
    expect(reasoning[0].messageId).toBe((events[0].data as { messageId: string }).messageId);
    // 正文不受思考增量影响
    const deltas = events.filter((e) => e.eventType === "delta").map((e) => e.data as { text: string });
    expect(deltas.map((d) => d.text)).toEqual(["最终回答"]);
  });
});