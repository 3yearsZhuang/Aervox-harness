/**
 * Aervox｜思隅 @aervox/host-agent — SQLite 持久化可观测性门面（缺陷5）
 *
 * 由编排者（API / Worker / 独立应用）在组合根创建并注入 createAgentHost：
 * - audit：落 @aervox/database 的 audit_logs 表（对齐 AuditEntry；写入失败仅记录不抛错，
 *   与接口约定「实现不抛异常」一致）；
 * - log：结构化输出到 console（实现不依赖具体日志后端）；
 * - metrics：进程内累计采样 + flush no-op（配额/远端导出由后续接入，属于可选增强）。
 */
import type {
  AuditEntry,
  AuditExporterPort,
  LogEntry,
  LoggerPort,
  MetricsExporterPort,
  MetricSample,
  Observability,
} from "@aervox/observability";
import type { AervoxDatabase } from "@aervox/database";
import { auditLogs } from "@aervox/database";

let seqCounter = 0;
const nextAuditId = (): string => `aud_${Date.now().toString(36)}_${(++seqCounter).toString(36)}`;

/** console 结构化日志实现（幂等、不抛错） */
function createSinkLogger(): LoggerPort {
  const log = (level: LogEntry["level"], entry: Omit<LogEntry, "level">): void => {
    const fn =
      level === "debug" ? console.debug
      : level === "warn" ? console.warn
      : level === "error" ? console.error
      : console.info;
    if (entry.fields && Object.keys(entry.fields).length > 0) {
      fn(`[observability] ${level} ${entry.event} ${entry.message}`, entry.fields);
    } else {
      fn(`[observability] ${level} ${entry.event} ${entry.message}`);
    }
  };
  const logger: LoggerPort = {
    debug: (e) => log("debug", e),
    info: (e) => log("info", e),
    warn: (e) => log("warn", e),
    error: (e) => log("error", e),
    child(): LoggerPort {
      return logger;
    },
  };
  return logger;
}

export interface SqliteObservabilityOptions {
  /** metrics 采样数上限（超限丢弃最旧；0=不限，默认 10_000） */
  metricsSampleLimit?: number;
}

/**
 * 构造持久化可观测性门面：audit 落 SQLite，log/metrics 进程内。
 * 调用方必须先执行 initDatabaseSchema（含 audit_logs 表）再注入 Host。
 */
export function createSqliteObservability(
  db: AervoxDatabase,
  options: SqliteObservabilityOptions = {},
): Observability {
  const limit = options.metricsSampleLimit ?? 10_000;
  const samples: MetricSample[] = [];

  const metrics: MetricsExporterPort = {
    emit(sample: MetricSample): void {
      samples.push(sample);
      if (limit > 0 && samples.length > limit) samples.splice(0, samples.length - limit);
    },
    async flush() {
      // 配额/远端导出待接入
    },
  };

  const audit: AuditExporterPort = {
    async emit(entry: AuditEntry): Promise<void> {
      try {
        await db.insert(auditLogs).values({
          id: nextAuditId(),
          eventType: entry.eventType,
          actorId: entry.actorId,
          action: entry.action,
          scope: entry.scope,
          evidenceRef: entry.evidenceRef ?? null,
          payload: entry.payload ? JSON.stringify(entry.payload) : null,
          createdAt: entry.timestamp ?? new Date().toISOString(),
        });
      } catch (err) {
        // 审计写入失败不阻断执行流（与接口约定一致）；保留错误可见
        console.error("[observability] audit insert failed:", err);
      }
    },
  };

  return { log: createSinkLogger(), metrics, audit };
}