/**
 * Aervox｜思隅 @aervox/observability — 指标名目录
 *
 * 对齐 AVX-HAR-001 §16.3 可观测性指标面。任何新增指标先登记于此，
 * 再在采集端（阶段 4 host/executor 接线）实现 Counter/Gauge/Histogram。
 * 命名约定：`agent.<领域>.<事件>`，单位后缀：`_ms` / `_count`。
 */

/** Counter（单调累计） */
export const COUNTERS = [
  "agent.turn.started",
  "agent.turn.completed",
  "agent.step.started",
  "agent.provider.retries",
  "agent.tool.executed",
  "agent.tool.blocked",
  "agent.tool.timeout",
  "agent.tool.requeued",
  "agent.lease.renew_failures",
  "agent.fencing.denials",
  "agent.recovery.count",
  "agent.budget.max_steps",
  "agent.budget.timeouts",
  "agent.budget.repeat_tool",
  "agent.context.truncations",
  "agent.sse.reconnects",
  "agent.sse.slow_consumers",
  "agent.sse.cursor_expired",
] as const;

/** Gauge（当前值） */
export const GAUGES = [
  "agent.turn.status", // 值域：AttemptStatus（Running/Completed/…，编码为 0/1 位阶）
  "agent.provider.cost",
] as const;

/** Histogram（分布） */
export const HISTOGRAMS = [
  "agent.provider.ttft_ms", // Time-to-first-token
  "agent.provider.duration_ms",
] as const;

export const METRIC_NAMES = {
  counters: COUNTERS,
  gauges: GAUGES,
  histograms: HISTOGRAMS,
} as const;

export type CounterMetric = (typeof COUNTERS)[number];
export type GaugeMetric = (typeof GAUGES)[number];
export type HistogramMetric = (typeof HISTOGRAMS)[number];
export type MetricName = CounterMetric | GaugeMetric | HistogramMetric;

/** 指标名是否已登记（接口自检/测试用） */
export function isRegisteredMetric(name: string): boolean {
  return (
    (COUNTERS as readonly string[]).includes(name) ||
    (GAUGES as readonly string[]).includes(name) ||
    (HISTOGRAMS as readonly string[]).includes(name)
  );
}