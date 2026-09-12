/**
 * Aervox｜思隅 @aervox/observability — StandardLogger 单元测试
 */
import { describe, expect, it } from "vitest";
import { createStandardLogger, safeJsonStringify } from "../src/logger.js";
import type { LogDestination } from "../src/logger.js";

function createMemoryDestination(): LogDestination & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    write(chunk: string) {
      lines.push(chunk);
    },
  };
}

describe("StandardLogger", () => {
  it("遵守日志级别过滤：低于当前级别的日志被忽略", () => {
    const dest = createMemoryDestination();
    const logger = createStandardLogger({
      level: "warn",
      format: "json",
      destination: dest,
      timestampGenerator: () => "2026-09-13T00:00:00.000Z",
    });

    logger.debug({ event: "dbg", message: "debug message" });
    logger.info({ event: "inf", message: "info message" });
    expect(dest.lines).toHaveLength(0);

    logger.warn({ event: "wrn", message: "warn message" });
    logger.error({ event: "err", message: "error message" });
    expect(dest.lines).toHaveLength(2);

    const warnEntry = JSON.parse(dest.lines[0]!);
    expect(warnEntry).toMatchObject({
      level: "warn",
      event: "wrn",
      message: "warn message",
      timestamp: "2026-09-13T00:00:00.000Z",
    });

    const errEntry = JSON.parse(dest.lines[1]!);
    expect(errEntry).toMatchObject({
      level: "error",
      event: "err",
      message: "error message",
    });
  });

  it("JSON 格式正确输出结构化字段与 NDJSON 换行", () => {
    const dest = createMemoryDestination();
    const logger = createStandardLogger({
      level: "info",
      format: "json",
      destination: dest,
      timestampGenerator: () => "2026-09-13T00:00:00.000Z",
    });

    logger.info({
      event: "http.request.completed",
      message: "GET /v1/turns completed",
      fields: { method: "GET", statusCode: 200, durationMs: 42.5 },
    });

    expect(dest.lines).toHaveLength(1);
    expect(dest.lines[0]?.endsWith("\n")).toBe(true);

    const parsed = JSON.parse(dest.lines[0]!);
    expect(parsed).toEqual({
      level: "info",
      event: "http.request.completed",
      message: "GET /v1/turns completed",
      timestamp: "2026-09-13T00:00:00.000Z",
      fields: {
        method: "GET",
        statusCode: 200,
        durationMs: 42.5,
      },
    });
  });

  it("Pretty 格式正确生成包含时间戳与方括号标签的文本", () => {
    const dest = createMemoryDestination();
    const logger = createStandardLogger({
      level: "info",
      format: "pretty",
      destination: dest,
      timestampGenerator: () => "2026-09-13T00:00:00.000Z",
    });

    logger.info({
      event: "worker.tick",
      message: "Outbox processed",
      fields: { count: 3 },
    });

    expect(dest.lines).toHaveLength(1);
    expect(dest.lines[0]).toContain("[2026-09-13T00:00:00.000Z]");
    expect(dest.lines[0]).toContain("INFO");
    expect(dest.lines[0]).toContain("[worker.tick] Outbox processed");
    expect(dest.lines[0]).toContain('{"count":3}');
  });

  it("child() 创建的子日志器继承并合并上下文", () => {
    const dest = createMemoryDestination();
    const parent = createStandardLogger({
      level: "info",
      format: "json",
      destination: dest,
      defaultFields: { service: "api", env: "test" },
    });

    const child = parent.child({ turnId: "turn_123", workerId: "w_1" });
    child.info({
      event: "agent.step.started",
      message: "Step 1 started",
      fields: { stepIndex: 1 },
    });

    const parsed = JSON.parse(dest.lines[0]!);
    expect(parsed.fields).toEqual({
      service: "api",
      env: "test",
      turnId: "turn_123",
      workerId: "w_1",
      stepIndex: 1,
    });
  });

  it("safeJsonStringify 防御循环引用与序列化 Error 对象", () => {
    const cyclicObj: Record<string, unknown> = { name: "test" };
    cyclicObj.self = cyclicObj;

    const result = safeJsonStringify(cyclicObj);
    expect(result).toContain('"self":"[Circular]"');

    const err = new Error("something went wrong");
    const errJson = safeJsonStringify({ error: err });
    expect(errJson).toContain('"name":"Error"');
    expect(errJson).toContain('"message":"something went wrong"');
  });
});
