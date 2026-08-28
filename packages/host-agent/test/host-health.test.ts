/**
 * Aervox｜思隅 @aervox/host-agent — 健康检查测试（阶段 4d）
 *
 * 覆盖 AVX-HAR-001 §13 阶段 4 第 545 行「健康检查」：
 * - liveness：starting/healthy/draining/stopped/stalled 五态
 * - readiness：依赖探针 ready=true/false、探针抛错收敛
 * - 容量：running/processed/uptimeMs 上报 gauge
 * 健康检查须不抛异常（Noop 观测缺省、探针故障收敛为 not ready）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentHost,
  type AgentHost,
  type ClaimableTurn,
  type HostDependencyProbe,
  type TurnSourcePort,
} from "../src/index.js";
import { InMemoryExecutionStore } from "@aervox/agent-loop";
import type { ExecutionStorePort, ModelProviderPort } from "@aervox/agent-loop";
import type { AuditEntry, MetricSample, Observability } from "@aervox/observability";
import { createNoopObservability } from "@aervox/observability";

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

const immediateProvider: ModelProviderPort = {
  id: "immediate",
  async *stream() {
    yield { text: "ok", isFinal: true };
  },
};

const gatedProvider = (gate: { promise: Promise<void> }): ModelProviderPort => ({
  id: "gated",
  async *stream() {
    await gate.promise;
    yield { text: "ok", isFinal: true };
  },
});

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

function harness(maxConcurrency: number, pollIntervalMs: number) {
  const stores = new Map<string, InMemoryExecutionStore>();
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
      return store;
    },
    provider: immediateProvider,
    maxConcurrency,
    pollIntervalMs,
    observability: createNoopObservability(),
  };
  return {
    deps,
    stores,
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
  vi.useRealTimers();
  if (host) {
    await host.stop();
    host = undefined;
  }
});

describe("Host 健康检查（health）", () => {
  it("未启动：status=starting、startedAt=null、ready=false、依赖空", async () => {
    const h = harness(1, 10_000);
    host = createAgentHost(h.deps);
    const health = await host.health();
    expect(health.status).toBe("starting");
    expect(health.startedAt).toBeNull();
    expect(health.lastTickAt).toBeNull();
    expect(health.uptimeMs).toBe(0);
    expect(health.dependencies).toEqual([]);
    expect(health.ready).toBe(false);
  });

  it("启动后：status=healthy、startedAt/lastTickAt 非空、ready=true（无探针）", async () => {
    const h = harness(1, 10_000);
    h.enqueue(turn("atp_h1"));
    host = createAgentHost(h.deps);
    await host.start();
    await new Promise((r) => setTimeout(r, 50));

    const health = await host.health();
    expect(health.status).toBe("healthy");
    expect(health.startedAt).not.toBeNull();
    expect(health.lastTickAt).not.toBeNull();
    expect(health.running).toBe(0);
    expect(health.processed).toBe(1);
    expect(health.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(health.dependencies).toEqual([]);
    expect(health.ready).toBe(true);
  }, 5_000);

  it("依赖探针 ready=true：ready=true 且 dependencies 含探针项", async () => {
    const h = harness(1, 10_000);
    const probes: HostDependencyProbe[] = [
      { name: "source", ready: true },
      { name: "provider", ready: true },
    ];
    h.deps.probeDeps = async () => probes;
    h.enqueue(turn("atp_probe_ok"));
    host = createAgentHost(h.deps);
    await host.start();
    await new Promise((r) => setTimeout(r, 50));

    const health = await host.health();
    expect(health.status).toBe("healthy");
    expect(health.dependencies).toEqual(probes);
    expect(health.ready).toBe(true);
  }, 5_000);

  it("依赖探针 ready=false：ready=false（status 仍 healthy，liveness 不受 readiness 影响）", async () => {
    const h = harness(1, 10_000);
    h.deps.probeDeps = async () => [{ name: "provider", ready: false, reason: "no_api_key" }];
    h.enqueue(turn("atp_probe_down"));
    host = createAgentHost(h.deps);
    await host.start();
    await new Promise((r) => setTimeout(r, 50));

    const health = await host.health();
    expect(health.status).toBe("healthy");
    expect(health.ready).toBe(false);
    expect(health.dependencies[0].name).toBe("provider");
    expect(health.dependencies[0].ready).toBe(false);
  }, 5_000);

  it("探针抛错：health 不抛异常，dependencies 收敛为 probeDeps 故障项，ready=false", async () => {
    const h = harness(1, 10_000);
    h.deps.probeDeps = async () => {
      throw new Error("probe_boom");
    };
    h.enqueue(turn("atp_probe_throw"));
    host = createAgentHost(h.deps);
    await host.start();
    await new Promise((r) => setTimeout(r, 50));

    const health = await host.health();
    expect(health.status).toBe("healthy");
    expect(health.ready).toBe(false);
    expect(health.dependencies).toHaveLength(1);
    expect(health.dependencies[0].name).toBe("probeDeps");
    expect(health.dependencies[0].ready).toBe(false);
    expect(health.dependencies[0].reason).toBe("probe_boom");
  }, 5_000);

  it("draining：运行中 stop 时 status=draining；完成后 status=stopped", async () => {
    const h = harness(1, 10_000);
    const gate = { ...deferred() };
    h.deps.provider = gatedProvider(gate);
    h.enqueue(turn("atp_drain"));
    host = createAgentHost(h.deps);
    await host.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(host.running()).toBe(1);

    // stop 不 await，先在 drain 中采样
    const stopP = host.stop();
    // 让事件循环推进到 draining 分支
    await new Promise((r) => setTimeout(r, 5));
    const drainingHealth = await host.health();
    expect(drainingHealth.status).toBe("draining");
    expect(drainingHealth.running).toBe(1);

    gate.resolve();
    await stopP;
    const stoppedHealth = await host.health();
    expect(stoppedHealth.status).toBe("stopped");
    expect(stoppedHealth.running).toBe(0);
  }, 5_000);

  it("stalled：tick 超过 3×pollInterval 未推进 → status=stalled（liveness 死锁探针）", async () => {
    vi.useFakeTimers();
    const h = harness(1, 100); // stalledAfterMs = 300
    // 首次 listClaimable 快速 resolve（让 start() 的首次 tick 完成并记录 lastTickAt）；
    // 后续 setInterval 触发的 tick 返回不 resolve 的 promise，模拟 source 卡死 → lastTickAt 不再推进。
    let callCount = 0;
    const pendingResolvers: Array<(v: ClaimableTurn[]) => void> = [];
    h.deps.source = {
      listClaimable(): Promise<ClaimableTurn[]> {
        callCount += 1;
        if (callCount === 1) return Promise.resolve([]);
        return new Promise<ClaimableTurn[]>((resolve) => {
          pendingResolvers.push(resolve);
        });
      },
    };
    host = createAgentHost(h.deps);
    await host.start(); // 首次 tick 完成，lastTickAt 已记录

    // 推进时间超过 stalledAfterMs（300ms）；期间 setInterval 触发的 tick 全部挂起
    vi.advanceTimersByTime(400);
    const health = await host.health();
    expect(health.status).toBe("stalled");
    expect(health.ready).toBe(false);
    // 清理挂起的 promise，避免 afterEach stop 时遗留
    for (const r of pendingResolvers) r([]);
  }, 5_000);

  it("容量上报：health() 触发 agent.host.running/processed/uptime_ms gauge", async () => {
    const samples: MetricSample[] = [];
    const audits: AuditEntry[] = [];
    const h = harness(1, 10_000);
    h.deps.observability = recordingObservability(samples, audits);
    h.enqueue(turn("atp_gauge"));
    host = createAgentHost(h.deps);
    await host.start();
    await new Promise((r) => setTimeout(r, 50));

    samples.length = 0;
    await host.health();
    expect(samples.some((s) => s.type === "gauge" && s.name === "agent.host.running")).toBe(true);
    expect(samples.some((s) => s.type === "gauge" && s.name === "agent.host.processed")).toBe(true);
    expect(samples.some((s) => s.type === "gauge" && s.name === "agent.host.uptime_ms")).toBe(true);
  }, 5_000);

  it("未注入 observability 时 fail-fast（审计不可静默丢失）", () => {
    const h = harness(1, 10_000);
    h.enqueue(turn("atp_noop"));
    h.deps.observability = undefined;
    expect(() => createAgentHost(h.deps)).toThrow(/observability_required/);
  });
});
