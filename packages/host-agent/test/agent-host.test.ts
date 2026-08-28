/**
 * Aervox｜思隅 @aervox/host-agent — 内嵌异步 Host 编排测试（阶段 4a）
 *
 * 覆盖：轮询领取执行 / 并发上限（背压）/ CAS 失败跳过（重复投递安全）/ 优雅停机 drain。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentHost,
  type AgentHost,
  type ClaimableTurn,
  type TurnSourcePort,
} from "../src/index.js";
import { InMemoryExecutionStore } from "@aervox/agent-loop";
import type { ExecutionStorePort, ModelProviderPort } from "@aervox/agent-loop";
import type { AuditEntry, MetricSample, Observability } from "@aervox/observability";
import { createNoopObservability } from "@aervox/observability";

/** 录制型观测门面：断言宿主打点（不抛错） */
const recordingObservability = (samples: MetricSample[], audits: AuditEntry[]): Observability => ({
  log: {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return this;
    },
  },
  metrics: {
    emit(sample) {
      samples.push(sample);
    },
    async flush() {},
  },
  audit: {
    async emit(entry) {
      audits.push(entry);
    },
  },
});

/** 可手动放行的 model provider（stream 在 gate 前挂起，模拟慢执行/长任务） */
const gatedProvider = (gate: { promise: Promise<void> }): ModelProviderPort => ({
  id: "gated",
  async *stream() {
    await gate.promise;
    yield { text: "ok", isFinal: true };
  },
});

/** 立即完成的 provider */
const immediateProvider: ModelProviderPort = {
  id: "immediate",
  async *stream() {
    yield { text: "ok", isFinal: true };
  },
};

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

/** 按 attemptId 建立内存 store 的宿主工厂 + 候选源 */
function harness(maxConcurrency: number, pollIntervalMs: number) {
  const stores = new Map<string, InMemoryExecutionStore>();
  const claimCounts = new Map<string, number>();
  const queue: ClaimableTurn[] = [];

  const deps = {
    source: {
      listClaimable(limit: number): Promise<ClaimableTurn[]> {
        return Promise.resolve(queue.splice(0, limit));
      },
    } satisfies TurnSourcePort,
    createStore(turn: ClaimableTurn): ExecutionStorePort {
      let store = stores.get(turn.attemptId);
      if (!store) {
        store = new InMemoryExecutionStore();
        store.seedAttempt({ id: turn.attemptId, turnId: turn.turnId });
        stores.set(turn.attemptId, store);
      }
      // 计数 claim 调用（断言背压：领取中的慢任务不应继续领新任务被观察）
      const s = store;
      const orig = s.claimTurnAttempt.bind(s);
      s.claimTurnAttempt = async (input) => {
        claimCounts.set(input.attemptId, (claimCounts.get(input.attemptId) ?? 0) + 1);
        return orig(input);
      };
      return s;
    },
    provider: immediateProvider,
    maxConcurrency,
    pollIntervalMs,
    observability: createNoopObservability(),
  };

  return {
    deps,
    stores,
    claimCounts,
    queue,
    enqueue(...turns: ClaimableTurn[]) {
      queue.push(...turns);
    },
  };
}

const turn = (attemptId: string): ClaimableTurn => ({
  turnId: `turn_${attemptId}`,
  attemptId,
  sessionId: `sess_${attemptId}`,
  userMessage: "你好",
});

let host: AgentHost | undefined;

afterEach(async () => {
  if (host) {
    await host.stop();
    host = undefined;
  }
});

describe("内嵌异步 Host（agent-host）", () => {
  it("轮询领取：候选被 claim + 执行 + 终态提交，processed 递增", async () => {
    const h = harness(1, 10_000); // 长间隔：只依靠 start 的首次 tick
    h.enqueue(turn("atp_a"));
    host = createAgentHost(h.deps);
    await host.start();
    await new Promise((r) => setTimeout(r, 50)); // 等待首 tick 异步完成

    const store = h.stores.get("atp_a")!;
    const attempt = await store.attemptStatus("atp_a");
    expect(attempt).not.toBe("Running"); // 已终态（Completed/Interrupted）
    expect(host.running()).toBe(0);
    expect(host.processed()).toBe(1);
  }, 5_000);

  it("并发上限：慢任务占满槽位时不再领取新候选（背压），释放后继续", async () => {
    const h = harness(1, 10); // 短间隔：多 tick
    const gate = { ...deferred() };
    // 用带 gate 的 provider 使首个任务挂住
    h.deps.provider = gatedProvider(gate);
    h.enqueue(turn("atp_slow"), turn("atp_next"));
    host = createAgentHost(h.deps);
    await host.start();

    // 慢任务执行中：running=1，槽满，atp_next 不应被领取
    await new Promise((r) => setTimeout(r, 60));
    expect(host.running()).toBe(1);
    expect(h.claimCounts.get("atp_slow")).toBe(1);
    expect(h.claimCounts.get("atp_next")).toBeUndefined(); // 背压未领取

    // 放行慢任务 → 下一次 tick 领取 atp_next 并完成
    gate.resolve();
    await new Promise((r) => setTimeout(r, 80));
    expect(host.running()).toBe(0);
    expect(host.processed()).toBe(2);
    expect(h.claimCounts.get("atp_next")).toBe(1);
  }, 5_000);

  it("CAS 失败跳过：attempt 已被他人领取 → 不重复执行，processed 仍计入", async () => {
    const h = harness(1, 10_000);
    // 先手动占住：fencing 已递增，host 再领取必然失败
    const manual = new InMemoryExecutionStore();
    manual.seedAttempt({ id: "atp_taken", turnId: "turn_atp_taken" });
    await manual.claimTurnAttempt({
      turnId: "turn_atp_taken",
      attemptId: "atp_taken",
      expectedFencingToken: 0,
    });
    h.stores.set("atp_taken", manual);

    h.enqueue(turn("atp_taken"));
    const host0 = createAgentHost({
      ...h.deps,
      createStore(t: ClaimableTurn) {
        // 被占住的 attempt 复用预置 store，其余走默认工厂
        return t.attemptId === "atp_taken" ? manual : h.deps.createStore(t);
      },
    });
    host = host0;
    await host0.start();
    await new Promise((r) => setTimeout(r, 50));

    // host 领取被拒（fencing 不匹配）→ 未执行、仍 Running；processed 按尝试计入
    expect(host0.processed()).toBe(1);
    expect(await manual.attemptStatus("atp_taken")).toBe("Running");
  }, 5_000);

  it("优雅停机：stop 等待运行中任务 drain 后才返回（running 归零）", async () => {
    const h = harness(1, 10_000);
    const gate = { ...deferred() };
    h.deps.provider = gatedProvider(gate);
    h.enqueue(turn("atp_drain"));
    host = createAgentHost(h.deps);
    await host.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(host.running()).toBe(1);

    // 放行后 stop：drain 完成再返回
    gate.resolve();
    await host.stop();
    expect(host.running()).toBe(0);
    expect(host.processed()).toBe(1);
  }, 5_000);

  it("观测注入：完成回合记 duration 直方图 + completed 指标 + 审计；Noop 缺省不抛错", async () => {
    const samples: MetricSample[] = [];
    const audits: AuditEntry[] = [];
    const h = harness(1, 10_000);
    h.deps.observability = recordingObservability(samples, audits);
    h.enqueue(turn("atp_obs"));
    host = createAgentHost(h.deps);
    await host.start();
    await new Promise((r) => setTimeout(r, 50));

    expect(samples.some((s) => s.type === "histogram" && s.name === "agent.provider.duration_ms")).toBe(true);
    expect(samples.some((s) => s.type === "counter" && s.name === "agent.turn.completed")).toBe(true);
    expect(audits.some((a) => a.eventType === "agent.turn.completed" && a.scope === "turn_atp_obs")).toBe(true);
  }, 5_000);

  it("CAS 拦截观测：skipped 叠记 agent.fencing.denials", async () => {
    const samples: MetricSample[] = [];
    const audits: AuditEntry[] = [];
    const h = harness(1, 10_000);
    h.deps.observability = recordingObservability(samples, audits);
    const manual = new InMemoryExecutionStore();
    manual.seedAttempt({ id: "atp_fence", turnId: "turn_atp_fence" });
    await manual.claimTurnAttempt({ turnId: "turn_atp_fence", attemptId: "atp_fence", expectedFencingToken: 0 });
    h.stores.set("atp_fence", manual);
    h.enqueue(turn("atp_fence"));
    host = createAgentHost({
      ...h.deps,
      createStore(t: ClaimableTurn) {
        return t.attemptId === "atp_fence" ? manual : h.deps.createStore(t);
      },
    });
    await host.start();
    await new Promise((r) => setTimeout(r, 50));

    expect(samples.some((s) => s.type === "counter" && s.name === "agent.fencing.denials" && s.value === 1)).toBe(true);
  }, 5_000);
});