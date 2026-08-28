/**
 * Aervox｜思隅 @aervox/agent-loop — Attempt 状态机测试（AVX-HAR-001 §16.1 agent-loop-state-machine）
 *
 * 覆盖 §5.1 Attempt 状态转换与终态唯一性：
 * Running → Completed/Failed/Interrupted/Cancelled；Running → CancelRequested → Cancelled；
 * 任何终态不允许二次提交（非法转换拒绝）。
 */
import { describe, expect, it } from "vitest";
import { InMemoryExecutionStore } from "../src/index.js";

describe("Attempt 状态机（agent-loop-state-machine）", () => {
  it("Running → Completed 合法；Completed 后任何提交被拒（终态唯一）", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_s1", turnId: "turn_s1", fencingToken: 1 });
    expect(await store.finalizeAttempt({ turnId: "turn_s1", attemptId: "atp_s1", status: "Completed", expectedFencingToken: 1 })).toEqual({ ok: true });
    expect(await store.finalizeAttempt({ turnId: "turn_s1", attemptId: "atp_s1", status: "Failed" })).toEqual({ ok: false });
    expect(await store.finalizeAttempt({ turnId: "turn_s1", attemptId: "atp_s1", status: "Cancelled" })).toEqual({ ok: false });
    expect(store.attemptStatus("atp_s1")).toBe("Completed");
  });

  it("Running → CancelRequested → Cancelled 合法，且 CancelRequested 也仅能提交一次", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_s2", turnId: "turn_s2", fencingToken: 1 });
    expect(await store.requestCancelAttempt({ turnId: "turn_s2", attemptId: "atp_s2" })).toEqual({ ok: true });
    // 取消请求位不可重复抢占（已是 CancelRequested）
    expect(await store.requestCancelAttempt({ turnId: "turn_s2", attemptId: "atp_s2" })).toEqual({ ok: false, reason: "already_finalized" });
    expect(await store.finalizeAttempt({ turnId: "turn_s2", attemptId: "atp_s2", status: "Cancelled", expectedFencingToken: 1 })).toEqual({ ok: true });
    expect(await store.finalizeAttempt({ turnId: "turn_s2", attemptId: "atp_s2", status: "Interrupted" })).toEqual({ ok: false });
    expect(store.attemptStatus("atp_s2")).toBe("Cancelled");
  });

  it("退出态断言：Claimed 前被抢占的 Attempt 不可执行（claim 校验状态）", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_s3", turnId: "turn_s3", status: "Interrupted" });
    const claim = await store.claimTurnAttempt({ turnId: "turn_s3", attemptId: "atp_s3", expectedFencingToken: 0 });
    expect(claim.ok).toBe(false);
  });
});