/**
 * Aervox｜思隅 @aervox/observability — 内存指标注册表与 Prometheus 序列化
 *
 * 满足 MetricsExporterPort 契约：
 * - 纯内存追踪 counters、gauges 与 histograms；
 * - 直方图采样聚合支持 count, sum, min, max, mean, p50, p90, p99；
 * - 提供 getSnapshot() 快照接口；
 * - 提供 toPrometheusText() 导出标准 Prometheus 监控采集文本；
 * - 严格零外部第三方依赖。
 */
import type { MetricName } from "./metric-names.js";
import type { MetricSample, MetricsExporterPort } from "./interfaces.js";

export interface HistogramStats {
  count: number;
  sum: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p90: number;
  p99: number;
}

export interface MetricsSnapshot {
  timestamp: string;
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<string, HistogramStats>;
}

export interface MetricsRegistryOptions {
  /** 单个直方图保留的最大样本数（默认 1000） */
  maxHistogramSamples?: number;
}

function calculatePercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return sorted[index] ?? 0;
}

export class InMemoryMetricsRegistry implements MetricsExporterPort {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histogramSamples = new Map<string, number[]>();
  private readonly histogramSums = new Map<string, number>();
  private readonly histogramCounts = new Map<string, number>();
  private readonly maxSamples: number;

  constructor(options: MetricsRegistryOptions = {}) {
    this.maxSamples = options.maxHistogramSamples ?? 1000;
  }

  emit(sample: MetricSample): void {
    const { name, type, value } = sample;
    switch (type) {
      case "counter": {
        const current = this.counters.get(name) ?? 0;
        this.counters.set(name, current + value);
        break;
      }
      case "gauge": {
        this.gauges.set(name, value);
        break;
      }
      case "histogram": {
        const samples = this.histogramSamples.get(name) ?? [];
        samples.push(value);
        if (samples.length > this.maxSamples) {
          samples.shift();
        }
        this.histogramSamples.set(name, samples);

        const currentSum = this.histogramSums.get(name) ?? 0;
        this.histogramSums.set(name, currentSum + value);

        const currentCount = this.histogramCounts.get(name) ?? 0;
        this.histogramCounts.set(name, currentCount + 1);
        break;
      }
    }
  }

  async flush(): Promise<void> {
    // 内存注册表无需异步刷盘
  }

  getCounter(name: MetricName | string): number {
    return this.counters.get(name) ?? 0;
  }

  getGauge(name: MetricName | string): number | undefined {
    return this.gauges.get(name);
  }

  getHistogramStats(name: MetricName | string): HistogramStats | undefined {
    const count = this.histogramCounts.get(name);
    if (!count || count === 0) {
      return undefined;
    }
    const sum = this.histogramSums.get(name) ?? 0;
    const samples = (this.histogramSamples.get(name) ?? []).slice().sort((a, b) => a - b);
    const min = samples[0] ?? 0;
    const max = samples[samples.length - 1] ?? 0;
    const mean = Number((sum / count).toFixed(2));
    const p50 = calculatePercentile(samples, 0.5);
    const p90 = calculatePercentile(samples, 0.9);
    const p99 = calculatePercentile(samples, 0.99);

    return {
      count,
      sum,
      min,
      max,
      mean,
      p50,
      p90,
      p99,
    };
  }

  getSnapshot(): MetricsSnapshot {
    const snapshot: MetricsSnapshot = {
      timestamp: new Date().toISOString(),
      counters: {},
      gauges: {},
      histograms: {},
    };

    for (const [key, val] of this.counters.entries()) {
      snapshot.counters[key] = val;
    }
    for (const [key, val] of this.gauges.entries()) {
      snapshot.gauges[key] = val;
    }
    for (const key of this.histogramCounts.keys()) {
      const stats = this.getHistogramStats(key);
      if (stats) {
        snapshot.histograms[key] = stats;
      }
    }

    return snapshot;
  }

  /** 输出 Prometheus 标准文本格式 */
  toPrometheusText(): string {
    const lines: string[] = [];

    // Counters
    for (const [name, value] of this.counters.entries()) {
      const promName = name.replace(/\./g, "_") + "_total";
      lines.push(`# TYPE ${promName} counter`);
      lines.push(`${promName} ${value}`);
    }

    // Gauges
    for (const [name, value] of this.gauges.entries()) {
      const promName = name.replace(/\./g, "_");
      lines.push(`# TYPE ${promName} gauge`);
      lines.push(`${promName} ${value}`);
    }

    // Histograms
    for (const name of this.histogramCounts.keys()) {
      const stats = this.getHistogramStats(name);
      if (!stats) continue;
      const promName = name.replace(/\./g, "_");
      lines.push(`# TYPE ${promName} summary`);
      lines.push(`${promName}{quantile="0.5"} ${stats.p50}`);
      lines.push(`${promName}{quantile="0.9"} ${stats.p90}`);
      lines.push(`${promName}{quantile="0.99"} ${stats.p99}`);
      lines.push(`${promName}_sum ${stats.sum}`);
      lines.push(`${promName}_count ${stats.count}`);
    }

    return lines.length > 0 ? lines.join("\n") + "\n" : "";
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histogramSamples.clear();
    this.histogramSums.clear();
    this.histogramCounts.clear();
  }
}

export function createInMemoryMetricsRegistry(options?: MetricsRegistryOptions): InMemoryMetricsRegistry {
  return new InMemoryMetricsRegistry(options);
}
