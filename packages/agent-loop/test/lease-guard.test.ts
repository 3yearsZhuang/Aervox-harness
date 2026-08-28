/**
 * Aervox｜思隅 @aervox/agent-loop — 阶段 3b-B 契约测试（租约抢占守卫 + 单一终态）
 *
 * - 租约被抢占后，执行器 Step 首部探活失败 → 立即中止（lease_lost），迟到事件不写；
 * - finalize 单一终态：仅 Running 可提交，重复/过期提交被拒绝。
 */
import { describe, expect, it } from "vitest";
import { createMockToolProvider, createScriptedProvider, defaultContextBuilder, executeTurn, InMemoryExecutionStore } from "../src/index.js";

describe("executeTurn 阶段 3b-B：租约抢占守卫", () => {
  it("租约被抢占：下一 Step 探活失败 → failed(lease_lost)，不写 done、迟到事件丢弃", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_lost", turnId: "turn_lost" });

    const result = await executeTurn(
      {
        execution: store,
        provider: createScriptedProvider([
          {
            text: "第一步。",
            toolCalls: [{ id: "call_1", name: "search_notes", arguments: {} }],
          },
          { text: "第二步正文（不应产出）。", toolCalls: [] },
        ]),
        contextBuilder: defaultContextBuilder,
        // step1 工具执行时抢占租约（模拟崩溃后被 worker 恢复/他人接管）
        tools: createMockToolProvider({
          search_notes: () => {
            store.simulateLeaseLoss("atp_lost");
            return { ok: true, output: {} };
          },
        }),
      },
      { turnId: "turn_lost", sessionId: "sess_lost", attemptId: "atp_lost", userMessage: "x" },
    );

    expect(result).toMatchObject({ status: "failed", reason: "lease_lost" });

    const events = await store.listEvents("turn_lost");
    const types = events.map((e) => e.eventType);
    // 迟到事件：不写 done / 第二步 delta
    expect(types).not.toContain("done");
    expect(types.filter((t) => t === "delta")).toHaveLength(1); // 仅第一步 delta
    // 未 finalize：attempt 保持 Running（交由恢复器/用户重试）
    expect(store.attemptStatus("atp_lost")).toBe("Running");
  });

  it("finalize 单一终态：已提交的 attempt 拒绝再次终态提交", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_once", turnId: "turn_once" });
    const claim = await store.claimTurnAttempt({ turnId: "turn_once", attemptId: "atp_once", expectedFencingToken: 0 });
    expect(claim.ok).toBe(true);

    const first = await store.finalizeAttempt({
      turnId: "turn_once",
      attemptId: "atp_once",
      status: "Completed",
      expectedFencingToken: claim.ok ? claim.fencingToken : 1,
    });
    expect(first.ok).toBe(true);

    const second = await store.finalizeAttempt({
      turnId: "turn_once",
      attemptId: "atp_once",
      status: "Failed",
      expectedFencingToken: claim.ok ? claim.fencingToken : 1,
    });
    expect(second.ok).toBe(false);
  });
});