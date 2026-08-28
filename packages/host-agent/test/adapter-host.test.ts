/**
 * Aervox｜思隅 @aervox/host-agent — 阶段 6b Host Adapter 整 Turn 执行测试
 *
 * 覆盖：
 * - runAdapterTurn：claim → sim adapter（dsh-any / pi-every）整 Turn 事件映射为既有
 *   事件契约（message/delta/done 等）落库；all-results-conclude 收紧：
 *   concluded→Completed、mixed_batch→Interrupted+error、异常→Failed；重复 claim→skipped；
 * - createAgentHost({ adapter })：轮询驱动 adapter 整 Turn，宿主健康/计数不回归；无 adapter 原生路径不变。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createAgentHost, runAdapterTurn } from "../src/index.js";
import {
  InMemoryExecutionStore,
  createSimAdapterDriver,
} from "@aervox/agent-loop";
import type { AdapterManifest } from "@aervox/agent-loop";
import { createNoopObservability } from "@aervox/observability";

const dshManifest: AdapterManifest = {
  adapterId: "dsh",
  version: "sim-1.0",
  sha256: "sim-sha",
  license: "MIT",
  terminationPolicy: "any",
};

const input = {
  turnId: "turn_ad",
  sessionId: "session_ad",
  attemptId: "attempt_ad",
  userMessage: "帮我总结",
};

const eventsOf = async (store: InMemoryExecutionStore, turnId: string) =>
  store.listEvents(turnId);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("阶段 6b runAdapterTurn（Adapter 整 Turn 执行路径）", () => {
  const seed = (store: InMemoryExecutionStore) =>
    store.seedAttempt({ id: input.attemptId, turnId: input.turnId });

  it("concluded → Completed：message → delta → done 有序落库（映射既有事件契约）", async () => {
    const store = new InMemoryExecutionStore();
    seed(store);
    const sim = createSimAdapterDriver({
      manifest: dshManifest,
      script: [
        { type: "delta", text: "DSH 子代理完成总结" },
        { type: "batch", concludes: [true, true] },
      ],
    });
    const result = await runAdapterTurn(store, sim, input);

    expect(result.status).toBe("Completed");
    const events = await eventsOf(store, input.turnId);
    const types = events.map((e) => e.eventType);
    expect(types).toEqual(["message", "delta", "done"]);
    expect((events[events.length - 1].data as { status?: string }).status).toBe("Completed");
    expect((events[1].data as { isFinal?: boolean }).isFinal).toBe(true);
  });

  it("mixed_batch（dsh-any 声明）→ Interrupted + error（ADAPTER_NOT_CONCLUDED）", async () => {
    const store = new InMemoryExecutionStore();
    seed(store);
    const sim = createSimAdapterDriver({
      manifest: dshManifest,
      script: [
        { type: "delta", text: "部分工具已结算" },
        { type: "batch", concludes: [true, false] },
      ],
    });
    const result = await runAdapterTurn(store, sim, input);

    expect(result.status).toBe("Interrupted");
    expect(result.reason).toContain("adapter_mixed_batch");
    const events = await eventsOf(store, input.turnId);
    const types = events.map((e) => e.eventType);
    expect(types).toContain("error");
    expect(types[types.length - 1]).toBe("done");
    expect((events[events.length - 1].data as { status?: string }).status).toBe("Interrupted");
  });

  it("已 claim（重复投递）→ skipped", async () => {
    const store = new InMemoryExecutionStore();
    seed(store);
    const sim = createSimAdapterDriver({ manifest: dshManifest, declaresEnds: [true, true] });
    const first = await runAdapterTurn(store, sim, input);
    expect(first.status).toBe("Completed");
    const second = await runAdapterTurn(store, sim, input);
    expect(second.status).toBe("skipped");
  });

  it("协议缺陷（未声明批次）→ Interrupted（batch_not_declared），不产生 done Completed", async () => {
    const store = new InMemoryExecutionStore();
    seed(store);
    const sim = createSimAdapterDriver({ manifest: dshManifest, script: [{ type: "delta", text: "无批次" }] });
    const result = await runAdapterTurn(store, sim, input);
    expect(result.status).toBe("Interrupted");
    const events = await eventsOf(store, input.turnId);
    expect(events.map((e) => e.eventType)).toContain("error");
    const done = events[events.length - 1];
    expect(done.eventType).toBe("done");
    expect((done.data as { status?: string }).status).toBe("Interrupted");
  });

  it("adapter 抛错 → Failed + error（ADAPTER_UNAVAILABLE）", async () => {
    const store = new InMemoryExecutionStore();
    seed(store);
    const sim = createSimAdapterDriver({
      manifest: dshManifest,
      script: [{ type: "delta", text: "x" }],
    });
    // 覆写 run 为抛错（模拟进程崩溃/协议违约）
    const broken = { ...sim, run: async function* () { throw new Error("adapter_boom"); } };
    const result = await runAdapterTurn(store, broken, input);
    expect(result.status).toBe("Failed");
    const events = await eventsOf(store, input.turnId);
    expect(events.map((e) => e.eventType)).toContain("error");
    expect((events[events.length - 1].data as { ok?: boolean }).ok).toBeUndefined();
  });
});

describe("阶段 6b createAgentHost（adapter 接入宿主循环）", () => {
  let hosts: ReturnType<typeof createAgentHost>[] = [];

  afterEach(async () => {
    for (const h of hosts) await h.stop();
    hosts = [];
  });

  it("adapter 存在 → 轮询驱动 adapter 整 Turn 至 Completed（事件映射既有契约）", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: input.attemptId, turnId: input.turnId });
    let served = false;
    const sim = createSimAdapterDriver({
      manifest: dshManifest,
      script: [
        { type: "delta", text: "Host 代理 DSH 执行完成" },
        { type: "batch", concludes: [true] },
      ],
    });
    const host = createAgentHost({
      source: {
        listClaimable: async () => {
          if (served) return [];
          served = true;
          return [
            { turnId: input.turnId, sessionId: input.sessionId, attemptId: input.attemptId, userMessage: input.userMessage },
          ];
        },
      },
      createStore: () => store,
      provider: { id: "unused", async *stream() { /* adapter 路径不消费 */ } },
      adapter: sim,
      observability: createNoopObservability(),
      pollIntervalMs: 20,
    });
    hosts.push(host);
    await host.start();
    await sleep(150);

    expect(host.processed()).toBe(1);
    const events = await eventsOf(store, input.turnId);
    const types = events.map((e) => e.eventType);
    expect(types[0]).toBe("message");
    expect(types[types.length - 1]).toBe("done");
    expect((events[events.length - 1].data as { status?: string }).status).toBe("Completed");
    expect(host.health()).resolves.toBeTruthy();
  });

  it("无 adapter → 原生 executeTurn 路径不受影响（回归）", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: input.attemptId, turnId: input.turnId });
    let served = false;
    const host = createAgentHost({
      source: {
        listClaimable: async () => {
          if (served) return [];
          served = true;
          return [
            { turnId: input.turnId, sessionId: input.sessionId, attemptId: input.attemptId, userMessage: input.userMessage },
          ];
        },
      },
      createStore: () => store,
      provider: {
        id: "replay",
        async *stream() {
          yield { text: "原生回复", isFinal: true };
        },
      },
      observability: createNoopObservability(),
      pollIntervalMs: 20,
    });
    hosts.push(host);
    await host.start();
    await sleep(150);

    expect(host.processed()).toBe(1);
    const events = await eventsOf(store, input.turnId);
    expect(events.map((e) => e.eventType)).toEqual(["message", "delta", "done"]);
    expect((events[events.length - 1].data as { status?: string }).status).toBe("Completed");
  });
});