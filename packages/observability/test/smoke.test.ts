/**
 * Aervox｜思隅 @aervox/observability — 接口 smoke 测试
 *
 * 契约自检：指标名目录覆盖 AVX-HAR-001 §16.3 指标面；Noop 实现零成本、幂等、不抛错。
 */
import { describe, expect, it } from "vitest";
import {
  COUNTERS,
  GAUGES,
  HISTOGRAMS,
  isRegisteredMetric,
  METRIC_NAMES,
  createNoopObservability,
} from "../src/index.js";

describe("指标名目录（对齐 AVX-HAR-001 §16.3）", () => {
  it("计数器覆盖 Loop/工具/租约/预算/SSE 关键指标", () => {
    const required = [
      "agent.turn.started",
      "agent.turn.completed",
      "agent.tool.executed",
      "agent.tool.timeout",
      "agent.lease.renew_failures",
      "agent.fencing.denials",
      "agent.recovery.count",
      "agent.budget.max_steps",
      "agent.sse.reconnects",
    ];
    for (const name of required) {
      expect(isRegisteredMetric(name)).toBe(true);
    }
  });

  it("直方图覆盖 Provider TTFT 与完整耗时", () => {
    expect(HISTOGRAMS).toContain("agent.provider.ttft_ms");
    expect(HISTOGRAMS).toContain("agent.provider.duration_ms");
  });

  it("目录允许自定义查询（GAUGE/COUNTER 拆分）", () => {
    expect(GAUGES).toContain("agent.turn.status");
    expect(METRIC_NAMES.counters.length).toBeGreaterThan(10);
  });
});

describe("Noop 实现（接口先行默认装）", () => {
  it("调用幂等且不抛错（logger/metrics/audit）", async () => {
    const obs = createNoopObservability();
    expect(() => {
      obs.log.debug({ event: "agent.step.started", message: "x", fields: { step: 1 } });
      obs.log.info({ event: "agent.turn.started", message: "x" });
      obs.log.warn({ event: "agent.budget.timeouts", message: "x" });
      obs.log.error({ event: "agent.lease.renew_failures", message: "x" });
      obs.log.child({ turnId: "t" }).info({ event: "agent.step.started", message: "x" });
      obs.metrics.emit({ type: "counter", name: "agent.tool.executed", value: 1 });
      obs.metrics.emit({ type: "histogram", name: "agent.provider.ttft_ms", value: 42 });
      obs.metrics.emit({ type: "gauge", name: "agent.turn.status", value: 1 });
    }).not.toThrow();
    await expect(
      obs.audit.emit({
        eventType: "agent.tool.completed",
        actorId: "usr_1",
        action: "execute_tool",
        scope: "turn_1",
        evidenceRef: "tex_1",
      }),
    ).resolves.toBeUndefined();
    await expect(obs.metrics.flush?.()).resolves.toBeUndefined();
  });

  it("child 返回可用日志器（幂等）", () => {
    const obs = createNoopObservability();
    const child = obs.log.child({ turnId: "t" });
    expect(() => child.info({ event: "agent.turn.completed", message: "ok" })).not.toThrow();
  });
});