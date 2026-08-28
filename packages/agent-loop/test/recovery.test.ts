/**
 * Aervox｜思隅 @aervox/agent-loop — 恢复与投递三重场景测试（AVX-HAR-001 §16.1 agent-loop-recovery）
 *
 * 阶段 3 退出条件机器化：在进程崩溃、网络超时与重复投递下，写工具副作用至多一次：
 * - crash：预留后崩溃（pending 未收口）→ 恢复器标记 outcome_unknown，不自动重放；
 * - timeout：工具超时 → timeout_error 收口一次，不自动重试；
 * - redelivery：同 Attempt 重复领取被拒（fencing），同调用重复预留已存在（副作用不重复）。
 */
import { describe, expect, it } from "vitest";
import { defaultContextBuilder, executeTurn, InMemoryExecutionStore } from "../src/index.js";
import type { ModelChunk, ModelProviderPort, ToolProviderPort } from "../src/index.js";

const toolProvider = (name: string, executionLog: { name: string; invocationId: string }[]): ToolProviderPort => ({
  tools: [{ name, description: "x", readOnly: true }],
  async execute(input) {
    executionLog.push({ name: input.name, invocationId: input.invocationId });
    return { ok: true, output: "ok" };
  },
});

const singleToolProvider = (name: string): ModelProviderPort => ({
  id: "single",
  async *stream(): AsyncIterable<ModelChunk> {
    yield { text: "", isFinal: true, toolCalls: [{ id: "call_x", name, arguments: {} }] };
  },
});

describe("恢复三重场景（agent-loop-recovery）", () => {
  it("crash：预留未收口 → outcome_unknown，不自动重放；新 Attempt 独立执行", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_crash", turnId: "turn_c" });
    // 崩溃前：预留已写入 pending，未收口（进程随后终止）
    await store.reserveToolExecution({
      turnId: "turn_c",
      attemptId: "atp_crash",
      invocationId: "atp_crash:1:1",
      name: "notes_write",
      arguments: {},
    });
    // 恢复器（worker）标记 unknown outcome
    store.markAllPendingUnknown("atp_crash");
    const afterCrash = store.toolExecutionRecords();
    expect(afterCrash[0]?.status).toBe("outcome_unknown");

    // 用户重试 → 新 Attempt（不同 attemptId）独立执行，副作用按新 Host 键产生
    store.seedAttempt({ id: "atp_retry", turnId: "turn_c" });
    const log: { name: string; invocationId: string }[] = [];
    await executeTurn(
      {
        execution: store,
        provider: singleToolProvider("notes_write"),
        contextBuilder: defaultContextBuilder,
        tools: toolProvider("notes_write", log),
        options: { maxSteps: 1 },
      },
      { turnId: "turn_c", sessionId: "sess_c", attemptId: "atp_retry", userMessage: "x" },
    );
    expect(log).toHaveLength(1);
    expect(log[0]?.invocationId).toMatch(/^atp_retry:1:1$/);
    // 旧 crash 预留仍为 outcome_unknown（未被新 Attempt 消费/改写）
    const rows = store.toolExecutionRecords().filter((r) => r.attemptId === "atp_crash");
    expect(rows[0]?.status).toBe("outcome_unknown");
  });

  it("timeout：工具超时 → timeout_error 收口一次，不自动重试（副作用至多一次）", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_to", turnId: "turn_to" });
    let calls = 0;
    const slowTools: ToolProviderPort = {
      tools: [{ name: "slow_op", description: "x", readOnly: false }],
      async execute(input) {
        calls += 1;
        await new Promise((r) => setTimeout(r, 50));
        return { ok: true, output: "late" };
      },
    };

    await executeTurn(
      {
        execution: store,
        provider: singleToolProvider("slow_op"),
        contextBuilder: defaultContextBuilder,
        tools: slowTools,
        options: { maxSteps: 1, toolTimeoutMs: 5 },
      },
      { turnId: "turn_to", sessionId: "sess_to", attemptId: "atp_to", userMessage: "x" },
    );

    expect(calls).toBe(1); // 不自动重试
    const records = store.toolExecutionRecords();
    expect(records[0]?.status).toBe("timeout_error");
    // 工具执行返回"迟到"结果不落库（结果以执行器收口为准）
    expect(records[0]?.output).toBeUndefined();
  });

  it("redelivery：同 Attempt 重复领取被拒（fencing）；同调用重复预留已存在（副作用不重复）", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_rd", turnId: "turn_rd" });
    const log: { name: string; invocationId: string }[] = [];

    const first = await executeTurn(
      {
        execution: store,
        provider: singleToolProvider("notes_write"),
        contextBuilder: defaultContextBuilder,
        tools: toolProvider("notes_write", log),
        options: { maxSteps: 1 },
      },
      { turnId: "turn_rd", sessionId: "sess_rd", attemptId: "atp_rd", userMessage: "x" },
    );
    expect(first.status).toBe("failed"); // 单批后预算收敛

    // 重复投递：同一 Turn 重放执行被 claim 拒绝（不产生第二次执行）
    const redelivery = await executeTurn(
      {
        execution: store,
        provider: singleToolProvider("notes_write"),
        contextBuilder: defaultContextBuilder,
        tools: toolProvider("notes_write", log),
        options: { maxSteps: 1 },
      },
      { turnId: "turn_rd", sessionId: "sess_rd", attemptId: "atp_rd", userMessage: "x" },
    );
    expect(redelivery.status).toBe("skipped");
    expect((redelivery as { reason: string }).reason).toBe("not_runnable"); // 已终态（预算收敛 Interrupted）拒绝重放
    expect(log).toHaveLength(1); // 副作用至多一次

    // 同 executionId 二次预留 → alreadyReserved（即使绕过 seenToolCalls 也不会重复副作用）
    const res = await store.reserveToolExecution({
      turnId: "turn_rd",
      attemptId: "atp_rd",
      invocationId: "atp_rd:1:1",
      name: "notes_write",
      arguments: {},
    });
    expect(res.alreadyReserved).toBe(true);
  });
});