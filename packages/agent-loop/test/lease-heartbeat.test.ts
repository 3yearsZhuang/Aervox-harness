/**
 * Aervox｜思隅 @aervox/agent-loop — B2：长调用周期心跳续租（3c+）
 *
 * 规则依据：AVX-HAR-001 §11.2「长模型/工具调用期间由 Host 续租」「续租失败立即停止
 * 产生新副作用」。
 * - LeaseHeartbeat 单元语义：续租 ok=false（CAS 丢失）→ lost + 订阅回调；
 * - executor 集成：长工具调用期间周期续租发生（防租约超时被恢复器误判僵尸）；
 *   调用中途被抢占（fencing+1）→ 心跳续租失败 → 在途工具被 abort → 收敛 lease_lost。
 */
import { describe, expect, it } from "vitest";
import {
  createScriptedProvider,
  defaultContextBuilder,
  executeTurn,
  InMemoryExecutionStore,
  LeaseHeartbeat,
} from "../src/index.js";
import type { ToolProviderPort } from "../src/index.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("LeaseHeartbeat 单元语义", () => {
  it("续租 ok=false（CAS 丢失）→ lost=true 且订阅回调触发", async () => {
    const hb = new LeaseHeartbeat({ renew: async () => ({ ok: false }), intervalMs: 5 });
    let fired = 0;
    hb.onLost(() => { fired += 1; });
    hb.start();
    await sleep(25);
    expect(hb.lost).toBe(true);
    expect(fired).toBe(1); // 幂等：不重复多播
    hb.stop();
  });

  it("续租持续 ok → 不判定丢失；stop 后不再续租", async () => {
    let renews = 0;
    const hb = new LeaseHeartbeat({ renew: async () => { renews += 1; return { ok: true }; }, intervalMs: 5 });
    hb.start();
    await sleep(25);
    expect(hb.lost).toBe(false);
    expect(renews).toBeGreaterThanOrEqual(2);
    hb.stop();
    const afterStop = renews;
    await sleep(15);
    expect(renews).toBe(afterStop);
  });
});

describe("executeTurn B2：长调用周期心跳续租", () => {
  it("长工具调用期间心跳续租发生（防自抢），Turn 正常完成", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_hb_ok", turnId: "turn_hb_ok" });

    const tools: ToolProviderPort = {
      tools: [{ name: "slow", description: "长调用工具", inputSchema: {} }],
      execute: async () => {
        await sleep(120); // 120ms 长调用（超过 15ms 心跳间隔数倍）
        return { ok: true, output: {} };
      },
    };

    const result = await executeTurn(
      {
        execution: store,
        provider: createScriptedProvider([
          { text: "开始。", toolCalls: [{ id: "call_slow", name: "slow", arguments: {} }] },
          { text: "完成。", toolCalls: [] },
        ]),
        contextBuilder: defaultContextBuilder,
        tools,
        options: { leaseTtlMs: 1_000, leaseHeartbeatIntervalMs: 15 },
      },
      { turnId: "turn_hb_ok", sessionId: "sess_hb_ok", attemptId: "atp_hb_ok", userMessage: "x" },
    );

    expect(result).toMatchObject({ status: "completed" });
    // Step 首部探活(2) + 120ms 长调用期间心跳(≈7) → 显著 > 2，证明周期续租发生
    expect(store.leaseRenewals()).toBeGreaterThanOrEqual(3);
  });

  it("长调用中途被抢占：心跳续租失败 → 在途工具 abort → 收敛 failed(lease_lost)、无迟到事件", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_hb_lost", turnId: "turn_hb_lost" });

    const tools: ToolProviderPort = {
      tools: [{ name: "slow_lost", description: "长调用工具", inputSchema: {} }],
      execute: async (input) => {
        await sleep(60);
        store.simulatePreemption("atp_hb_lost"); // beat@15/30/45 正常续租；此后续租将 CAS 失败
        // abort 与完成竞速：心跳丢失 → signal abort → 工具以 aborted 拒绝（B2 语义收敛 lease_lost）
        await Promise.race([
          sleep(120),
          new Promise<never>((_, reject) => {
            input.signal?.addEventListener("abort", () => reject(new Error("aborted_by_heartbeat")));
          }),
        ]);
        return { ok: true, output: {} };
      },
    };

    const result = await executeTurn(
      {
        execution: store,
        provider: createScriptedProvider([
          { text: "开始。", toolCalls: [{ id: "call_lost", name: "slow_lost", arguments: {} }] },
          { text: "不应产出。", toolCalls: [] },
        ]),
        contextBuilder: defaultContextBuilder,
        tools,
        options: { leaseTtlMs: 1_000, leaseHeartbeatIntervalMs: 15 },
      },
      { turnId: "turn_hb_lost", sessionId: "sess_hb_lost", attemptId: "atp_hb_lost", userMessage: "x" },
    );
    // 心跳探知 lost → abort 在途工具 → 顶层收敛 lease_lost（aborted 错误本身被 B2 语义覆盖）
    expect(result).toMatchObject({ status: "failed", reason: "lease_lost" });

    const events = await store.listEvents("turn_hb_lost");
    const types = events.map((e) => e.eventType);
    // 无迟到事件：tool_result / done / error 均不写入
    expect(types).not.toContain("tool_result");
    expect(types).not.toContain("done");
    expect(types).not.toContain("error");
    // 未 finalize：保持 Running（交由恢复器/用户重试）
    expect(store.attemptStatus("atp_hb_lost")).toBe("Running");
  });

  it("心跳关闭（leaseHeartbeatIntervalMs=0）：保持既有 Step 首部探活语义", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_hb_off", turnId: "turn_hb_off" });

    const result = await executeTurn(
      {
        execution: store,
        provider: createScriptedProvider([{ text: "直接完成。", toolCalls: [] }]),
        contextBuilder: defaultContextBuilder,
        options: { leaseTtlMs: 1_000, leaseHeartbeatIntervalMs: 0 },
      },
      { turnId: "turn_hb_off", sessionId: "sess_hb_off", attemptId: "atp_hb_off", userMessage: "x" },
    );

    expect(result).toMatchObject({ status: "completed" });
    expect(store.leaseRenewals()).toBe(1); // 仅 Step 首部探活
  });
});