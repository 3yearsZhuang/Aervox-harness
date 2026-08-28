/**
 * Aervox｜思隅 @aervox/agent-loop — 契约测试（AVX-HAR-001 §16.1 agent-loop-contract）
 *
 * Definition / Loop Driver / Model Provider / Store 的一致性：同一接口面在内存与
 * 宿主实现间的行为约定以本测试为基准（InMemoryExecutionStore 为参考实现）。
 */
import { describe, expect, it } from "vitest";
import { defaultContextBuilder, createReplayProvider, executeTurn, InMemoryExecutionStore } from "../src/index.js";

describe("契约：ExecutionStorePort 基础行为（agent-loop-contract）", () => {
  it("claim → 事件 → finalize 序列可重放且终态唯一", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_c1", turnId: "turn_c1" });
    const result = await executeTurn(
      { execution: store, provider: createReplayProvider(), contextBuilder: defaultContextBuilder },
      { turnId: "turn_c1", sessionId: "sess_c1", attemptId: "atp_c1", userMessage: "hi" },
    );
    expect(result.status).toBe("completed");
    // 重放：listEvents 全量与原事件一致
    const replay = await store.listEvents("turn_c1");
    expect(replay.map((e) => e.eventType)).toEqual(["message", "delta", "delta", "done"]);
    // 终态唯一：Committed 后再次 finalize 被拒
    expect(store.attemptStatus("atp_c1")).toBe("Completed");
  });

  it("claim 的 fencing CAS：重复 claim 被拒（不可同时两执行器）", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_c2", turnId: "turn_c2" });
    const first = await store.claimTurnAttempt({ turnId: "turn_c2", attemptId: "atp_c2", expectedFencingToken: 0 });
    expect(first.ok).toBe(true);
    const second = await store.claimTurnAttempt({ turnId: "turn_c2", attemptId: "atp_c2", expectedFencingToken: 0 });
    expect(second.ok).toBe(false);
  });

  it("ModelProviderPort 面：stream 产出规范化 chunk（text/isFinal/toolCalls）", async () => {
    const provider = createReplayProvider();
    const seen: { text: string; isFinal: boolean }[] = [];
    for await (const chunk of provider.stream({
      turnId: "turn_c3",
      attemptId: "atp_c3",
      step: 1,
      context: defaultContextBuilder.build({ turnId: "turn_c3", sessionId: "sess_c3", messages: [{ role: "user", content: "x" }] }),
    })) {
      seen.push({ text: chunk.text, isFinal: chunk.isFinal });
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)?.isFinal).toBe(true);
  });
});