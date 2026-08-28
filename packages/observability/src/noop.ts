/**
 * Aervox｜思隅 @aervox/observability — Noop 实现（接口先行默认装）
 *
 * 供尚未接线采集端的宿主/测试使用；保证调用零成本、幂等、永不抛错。
 */
import type { AuditEntry, AuditExporterPort, LoggerPort, MetricsExporterPort, Observability } from "./interfaces.js";

const noopLogger: LoggerPort = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child(): LoggerPort {
    return noopLogger;
  },
};

const noopMetrics: MetricsExporterPort = {
  emit() {},
  async flush() {},
};

const noopAudit: AuditExporterPort = {
  async emit(_entry: AuditEntry) {},
};

export function createNoopObservability(): Observability {
  return { log: noopLogger, metrics: noopMetrics, audit: noopAudit };
}

export { noopLogger, noopMetrics, noopAudit };