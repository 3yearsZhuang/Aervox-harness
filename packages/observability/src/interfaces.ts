/**
 * Aervox｜思隅 @aervox/observability — 可观测性 Port 接口
 *
 * Kernel Substrate「Observability/Recovery」的接口面：结构化日志、指标与审计导出。
 * 接口先行：当前仅为契约 + Noop 实现；采集端（executor/host/SSE）在阶段 4 接线。
 * 所有实现必须满足：不抛异常、调用幂等、不依赖具体导出后端（stdout/OLTP/文件由宿主提供）。
 */
import type { MetricName } from "./metric-names.js";

/** 日志级别 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** 结构化日志条目 */
export interface LogEntry {
  level: LogLevel;
  /** 固定事件名（如 agent.step.started），便于检索 */
  event: string;
  message: string;
  /** 结构化字段（租户、turnId、attemptId、耗时等），禁止记录 Restricted 原始内容 */
  fields?: Record<string, unknown>;
  timestamp?: string;
}

/** 结构化日志 Port（AVX-HAR-001 §16.3 日志默认不记录完整 Prompt/敏感工具结果） */
export interface LoggerPort {
  debug(entry: Omit<LogEntry, "level">): void;
  info(entry: Omit<LogEntry, "level">): void;
  warn(entry: Omit<LogEntry, "level">): void;
  error(entry: Omit<LogEntry, "level">): void;
  /** 带回退上下文的子日志器（traceId / turnId 等） */
  child(fields: Record<string, unknown>): LoggerPort;
}

/** 指标采样目标 */
export type MetricSample =
  | { type: "counter"; name: MetricName; value: number }
  | { type: "gauge"; name: MetricName; value: number }
  | { type: "histogram"; name: MetricName; value: number };

/** 指标导出 Port（计数/当前值/分布；采集语义由调用方决定） */
export interface MetricsExporterPort {
  emit(sample: MetricSample): void;
  /** 展示名可读性辅助（可选），实现可不做任何事 */
  flush?(): Promise<void>;
}

/** 审计条目（§12 Outbox/Audit 的导出面；actor 与动作不可变） */
export interface AuditEntry {
  eventType: string; // 内部领域事件名（agent.turn.completed 等）
  actorId: string;
  action: string; // 人事可读动作（approve_tool / cancel_turn / lease_expired）
  scope: string; // 受影响的资源维度（turnId / attemptId / sessionId）
  evidenceRef?: string; // 关联证据（execution 行 id / outbox id）
  payload?: Record<string, unknown>;
  timestamp?: string;
}

/** 审计导出 Port（不可变事件流；实现须保证顺序与幂等至少一次） */
export interface AuditExporterPort {
  emit(entry: AuditEntry): Promise<void>;
}

/** 完整可观测性门面（宿主组合根获得一个实例并注入） */
export interface Observability {
  log: LoggerPort;
  metrics: MetricsExporterPort;
  audit: AuditExporterPort;
}