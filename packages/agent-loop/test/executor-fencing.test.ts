/**
 * Aervox｜思隅 @aervox/agent-loop — B1：事件写入 fencing 守卫（3c+）
 *
 * 规则依据：AVX-HAR-001 §11.2「事件/工具写入的 fencing 校验」、§12.2。
 * - InMemoryExecutionStore 与生产 SqliteExecutionStore 同语义：携带 expectedFencingToken
 *   时校验 Attempt 未被抢占（fencing 递增）且状态允许，否则抛 LeaseLostError；
 * - executor 捕获 LeaseLostError 后立即收敛为 lease_lost，不再产生任何新副作用，事件流零污染。
 */
import { describe, expect, it } from "vitest";
import {
  createMockToolProvider,
  createScriptedProvider,
  defaultContextBuilder,
  executeTurn,
  InMemoryExecutionStore,
  LeaseLostError,
} from "../src/index.js";

describe("InMemoryExecutionStore 事件写入 fencing 守卫", () => {
  it("claim 后携带正确 fencing 写入通过；被抢占（fencing+1）后旧期望值写入被拒", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_g1", turnId: "turn_g1" });
    const claim = await store.claimTurnAttempt({ turnId: "turn_g1", attemptId: "atp_g1", expectedFencingToken: 0 });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    const ev = await store.appendEvent({
      turnId: "turn_g1",
      attemptId: "atp_g1",
      sequence: 1,
      eventType: "delta",
      data: { text: "ok" },
      safetyDecision: "approved",
      expectedFencingToken: claim.fencingToken,
    });
    expect(ev.eventType).toBe("delta");

    store.simulatePreemption("atp_g1"); // 恢复器抢占：fencing +1
    await expect(
      store.appendEvent({
        turnId: "turn_g1",
        attemptId: "atp_g1",
        sequence: 2,
        eventType: "delta",
        data: { text: "late" },
        safetyDecision: "approved",
        expectedFencingToken: claim.fencingToken,
      }),
    ).rejects.toThrow(LeaseLostError);
  });

  it("未携带期望 fencing 时保持无校验兼容（测试夹具直写）", async () => {
    const store = new InMemoryExecutionStore();
    const ev = await store.appendEvent({
      turnId: "turn_g2",
      attemptId: "atp_g2",
      sequence: 1,
      eventType: "message",
      data: { text: "x" },
      safetyDecision: "approved",
    });
    expect(ev.eventType).toBe("message");
  });

  it("终态后仅收尾 done 放行，普通 delta 拒绝", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_g3", turnId: "turn_g3" });
    const claim = await store.claimTurnAttempt({ turnId: "turn_g3", attemptId: "atp_g3", expectedFencingToken: 0 });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    await store.finalizeAttempt({
      turnId: "turn_g3",
      attemptId: "atp_g3",
      status: "Completed",
      expectedFencingToken: claim.fencingToken,
    });
    await expect(
      store.appendEvent({
        turnId: "turn_g3",
        attemptId: "atp_g3",
        sequence: 2,
        eventType: "delta",
        data: { text: "late" },
        safetyDecision: "approved",
        expectedFencingToken: claim.fencingToken,
      }),
    ).rejects.toThrow(LeaseLostError);
    const done = await store.appendEvent({
      turnId: "turn_g3",
      attemptId: "atp_g3",
      sequence: 3,
      eventType: "done",
      data: { status: "Completed", isComplete: true },
      safetyDecision: "approved",
      expectedFencingToken: claim.fencingToken,
    });
    expect(done.eventType).toBe("done");
  });
});

describe("executeTurn B1：工具执行中被抢占 → 事件写入被拒 → 立即收敛 lease_lost", () => {
  it("fencing 递增后 tool_result 写入被拒：返回 failed(lease_lost)，无迟到事件、不写终态", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_fence", turnId: "turn_fence" });

    const result = await executeTurn(
      {
        execution: store,
        provider: createScriptedProvider([
          {
            text: "我先查一下。",
            toolCalls: [{ id: "call_f", name: "search_notes", arguments: {} }],
          },
          { text: "不应产出。", toolCalls: [] },
        ]),
        contextBuilder: defaultContextBuilder,
        // 工具执行期间模拟恢复器抢占（fencing +1）
        tools: createMockToolProvider({
          search_notes: () => {
            store.simulatePreemption("atp_fence");
            return { ok: true, output: {} };
          },
        }),
      },
      { turnId: "turn_fence", sessionId: "sess_fence", attemptId: "atp_fence", userMessage: "x" },
    );

    expect(result).toMatchObject({ status: "failed", reason: "lease_lost" });

    const events = await store.listEvents("turn_fence");
    const types = events.map((e) => e.eventType);
    // 迟到事件：tool_result（fencing 已递增的写入）被拒、无 done、无 error、无第二步 delta
    expect(types).not.toContain("tool_result");
    expect(types).not.toContain("done");
    expect(types).not.toContain("error");
    expect(types.filter((t) => t === "delta")).toHaveLength(1); // 仅第一步文本 delta
    // 未 finalize：保持 Running（交由恢复器/用户重试）
    expect(store.attemptStatus("atp_fence")).toBe("Running");
  });
});