/**
 * Aervox｜思隅 @aervox/observability — InMemoryMetricsRegistry 单元测试
 */
import { describe, expect, it } from "vitest";
import { createInMemoryMetricsRegistry } from "../src/metrics-registry.js";

describe("InMemoryMetricsRegistry", () => {
  it("正确累加 counter", () => {
    const registry = createInMemoryMetricsRegistry();
    expect(registry.getCounter("agent.turn.started")).toBe(0);

    registry.emit({ type: "counter", name: "agent.turn.started", value: 1 });
    registry.emit({ type: "counter", name: "agent.turn.started", value: 2 });
    expect(registry.getCounter("agent.turn.started")).toBe(3);
  });

  it("正确设置并读取 gauge", () => {
    const registry = createInMemoryMetricsRegistry();
    expect(registry.getGauge("agent.host.running")).toBeUndefined();

    registry.emit({ type: "gauge", name: "agent.host.running", value: 5 });
    expect(registry.getGauge("agent.host.running")).toBe(5);

    registry.emit({ type: "gauge", name: "agent.host.running", value: 2 });
    expect(registry.getGauge("agent.host.running")).toBe(2);
  });

  it("正确统计 histogram 样本、极值、均值与分位数", () => {
    const registry = createInMemoryMetricsRegistry();
    // 注入 10 个样本：10, 20, 30, ..., 100
    for (let i = 1; i <= 10; i++) {
      registry.emit({
        type: "histogram",
        name: "agent.provider.duration_ms",
        value: i * 10,
      });
    }

    const stats = registry.getHistogramStats("agent.provider.duration_ms");
    expect(stats).toBeDefined();
    expect(stats?.count).toBe(10);
    expect(stats?.sum).toBe(550);
    expect(stats?.min).toBe(10);
    expect(stats?.max).toBe(100);
    expect(stats?.mean).toBe(55);
    expect(stats?.p50).toBe(60); // index 5 of 0..9 is 60
    expect(stats?.p90).toBe(100);
    expect(stats?.p99).toBe(100);
  });

  it("getSnapshot() 返回完整的聚合快照", () => {
    const registry = createInMemoryMetricsRegistry();
    registry.emit({ type: "counter", name: "agent.turn.completed", value: 4 });
    registry.emit({ type: "gauge", name: "agent.turn.status", value: 1 });
    registry.emit({ type: "histogram", name: "agent.provider.ttft_ms", value: 150 });

    const snapshot = registry.getSnapshot();
    expect(snapshot.counters["agent.turn.completed"]).toBe(4);
    expect(snapshot.gauges["agent.turn.status"]).toBe(1);
    expect(snapshot.histograms["agent.provider.ttft_ms"]?.count).toBe(1);
    expect(snapshot.histograms["agent.provider.ttft_ms"]?.p50).toBe(150);
  });

  it("toPrometheusText() 输出标准 Prometheus / OpenMetrics 文本", () => {
    const registry = createInMemoryMetricsRegistry();
    registry.emit({ type: "counter", name: "agent.turn.started", value: 10 });
    registry.emit({ type: "gauge", name: "agent.host.running", value: 3 });
    registry.emit({ type: "histogram", name: "agent.provider.duration_ms", value: 200 });

    const prom = registry.toPrometheusText();
    expect(prom).toContain("# TYPE agent_turn_started_total counter");
    expect(prom).toContain("agent_turn_started_total 10");

    expect(prom).toContain("# TYPE agent_host_running gauge");
    expect(prom).toContain("agent_host_running 3");

    expect(prom).toContain("# TYPE agent_provider_duration_ms summary");
    expect(prom).toContain('agent_provider_duration_ms{quantile="0.5"} 200');
    expect(prom).toContain("agent_provider_duration_ms_sum 200");
    expect(prom).toContain("agent_provider_duration_ms_count 1");
  });

  it("reset() 清空所有指标数据", () => {
    const registry = createInMemoryMetricsRegistry();
    registry.emit({ type: "counter", name: "agent.turn.started", value: 10 });
    registry.reset();
    expect(registry.getCounter("agent.turn.started")).toBe(0);
    expect(registry.toPrometheusText()).toBe("");
  });
});
