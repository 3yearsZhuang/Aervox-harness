/**
 * Aervox｜思隅 @aervox/observability — 标准结构化日志实现
 *
 * 满足 LoggerPort 契约：
 * - 严格零外部第三方依赖；
 * - 支持 json (NDJSON) 与 pretty (高亮/控制台) 格式；
 * - 遵守日志级别过滤（debug < info < warn < error）；
 * - child() 具备不可变上下文继承；
 * - 保证不抛异常（循环引用与 Error 堆栈安全序列化）。
 */
import type { LogEntry, LogLevel, LoggerPort } from "./interfaces.js";

export interface LogDestination {
  write(chunk: string): void;
}

export interface StandardLoggerOptions {
  level?: LogLevel;
  format?: "json" | "pretty";
  destination?: LogDestination;
  defaultFields?: Record<string, unknown>;
  timestampGenerator?: () => string;
}

const LEVEL_PRIORITIES: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const defaultDestination: LogDestination = {
  write(chunk: string) {
    const globalProcess = (
      globalThis as { process?: { stdout?: { write?: (s: string) => boolean } } }
    ).process;
    if (globalProcess?.stdout?.write) {
      globalProcess.stdout.write(chunk);
    } else {
      console.log(chunk.replace(/\n$/, ""));
    }
  },
};

/** 安全处理循环引用与 Error 对象的 JSON 字符串化 */
export function safeJsonStringify(obj: unknown, space?: number): string {
  const seen = new WeakSet();
  return JSON.stringify(
    obj,
    (_key, value) => {
      if (value instanceof Error) {
        const errObj: Record<string, unknown> = {
          name: value.name,
          message: value.message,
          stack: value.stack,
        };
        for (const prop of Object.getOwnPropertyNames(value)) {
          if (!(prop in errObj)) {
            errObj[prop] = (value as unknown as Record<string, unknown>)[prop];
          }
        }
        return errObj;
      }
      if (typeof value === "bigint") {
        return value.toString();
      }
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) {
          return "[Circular]";
        }
        seen.add(value);
      }
      return value;
    },
    space,
  );
}

/** 格式化 pretty 输出 */
function formatPretty(
  level: LogLevel,
  event: string,
  message: string,
  timestamp: string,
  fields?: Record<string, unknown>,
): string {
  const levelTag = level.toUpperCase().padEnd(5);
  const prefix = `[${timestamp}] ${levelTag} [${event}] ${message}`;
  if (!fields || Object.keys(fields).length === 0) {
    return `${prefix}\n`;
  }
  const fieldStr = safeJsonStringify(fields);
  return `${prefix} ${fieldStr}\n`;
}

/** 格式化 json (NDJSON) 输出 */
function formatJson(
  level: LogLevel,
  event: string,
  message: string,
  timestamp: string,
  fields?: Record<string, unknown>,
): string {
  const entry: LogEntry = {
    level,
    event,
    message,
    timestamp,
  };
  if (fields && Object.keys(fields).length > 0) {
    entry.fields = fields;
  }
  return `${safeJsonStringify(entry)}\n`;
}

export class StandardLogger implements LoggerPort {
  private readonly minPriority: number;
  private readonly format: "json" | "pretty";
  private readonly destination: LogDestination;
  private readonly defaultFields: Record<string, unknown>;
  private readonly getTimestamp: () => string;

  constructor(options: StandardLoggerOptions = {}) {
    const level = options.level ?? "info";
    this.minPriority = LEVEL_PRIORITIES[level] ?? LEVEL_PRIORITIES.info;
    this.format = options.format ?? "pretty";
    this.destination = options.destination ?? defaultDestination;
    this.defaultFields = options.defaultFields ? { ...options.defaultFields } : {};
    this.getTimestamp = options.timestampGenerator ?? (() => new Date().toISOString());
  }

  private writeLog(level: LogLevel, entry: Omit<LogEntry, "level">): void {
    if (LEVEL_PRIORITIES[level] < this.minPriority) {
      return;
    }
    try {
      const timestamp = entry.timestamp ?? this.getTimestamp();
      const mergedFields =
        this.defaultFields || entry.fields ?
          { ...this.defaultFields, ...entry.fields }
        : undefined;

      const formatted =
        this.format === "json"
          ? formatJson(level, entry.event, entry.message, timestamp, mergedFields)
          : formatPretty(level, entry.event, entry.message, timestamp, mergedFields);

      this.destination.write(formatted);
    } catch {
      // 保证日志输出不抛出异常打垮业务流程
    }
  }

  debug(entry: Omit<LogEntry, "level">): void {
    this.writeLog("debug", entry);
  }

  info(entry: Omit<LogEntry, "level">): void {
    this.writeLog("info", entry);
  }

  warn(entry: Omit<LogEntry, "level">): void {
    this.writeLog("warn", entry);
  }

  error(entry: Omit<LogEntry, "level">): void {
    this.writeLog("error", entry);
  }

  child(fields: Record<string, unknown>): LoggerPort {
    return new StandardLogger({
      level: (Object.keys(LEVEL_PRIORITIES) as LogLevel[]).find(
        (lvl) => LEVEL_PRIORITIES[lvl] === this.minPriority,
      ) ?? "info",
      format: this.format,
      destination: this.destination,
      defaultFields: { ...this.defaultFields, ...fields },
      timestampGenerator: this.getTimestamp,
    });
  }
}

export function createStandardLogger(options?: StandardLoggerOptions): LoggerPort {
  return new StandardLogger(options);
}
