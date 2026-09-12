/**
 * Aervox｜思隅 @aervox/api — 可观测性与结构化日志集成测试
 *
 * 覆盖 AVX-HAR-001 §16.3 + OPS-REL-001：
 * 1. GET /v1/metrics 暴露 Prometheus 文本格式指标；
 * 2. GET /v1/metrics 支持 application/json 返回指标快照；
 * 3. HTTP 请求生命周期捕获结构化日志（包含 method、url、statusCode、durationMs）；
 * 4. HTTP 异常处理捕获结构化错误日志；
 * 5. Agent 回合执行捕获回合指标与结构化生命周期事件。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createInMemoryDatabase,
  type AervoxDatabase,
  type LocalContext,
} from "@aervox/repositories";
import {
  createStandardLogger,
  createInMemoryMetricsRegistry,
  noopAudit,
  type LogRecord,
} from "@aervox/observability";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

const tenant: LocalContext = { workspaceId: "ws_obs", subjectUserId: "usr_obs" };
const headers = {
  "x-workspace-id": tenant.workspaceId,
  "x-user-id": tenant.subjectUserId,
} as const;

describe("API 可观测性与结构化指标/日志 (AVX-HAR-001 §16.3 / OPS-REL-001)", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let cleanup: () => Promise<void>;
  let capturedLogs: string[] = [];
  let metricsRegistry = createInMemoryMetricsRegistry();

  beforeEach(async () => {
    process.env.AERVOX_LOOP_PROVIDER = "replay";
    capturedLogs = [];
    metricsRegistry = createInMemoryMetricsRegistry();

    const inMemoryDb = await createInMemoryDatabase();
    db = inMemoryDb.db;
    cleanup = inMemoryDb.cleanup;

    const customLogger = createStandardLogger({
      level: "debug",
      format: "json",
      destination: {
        write(chunk: string) {
          capturedLogs.push(chunk.trim());
        },
      },
    });

    const built = await buildApp({
      db,
      client: inMemoryDb.client,
      observability: {
        log: customLogger,
        metrics: metricsRegistry,
        audit: noopAudit,
      },
    });
    app = built.app;

    // 添加一条测试用抛错路由以验证 setErrorHandler 捕获与结构化日志
    app.get("/v1/test-error-trigger", async () => {
      throw new Error("Simulated unhandled exception for observability test");
    });

    await app.ready();
  });

  afterEach(async () => {
    delete process.env.AERVOX_LOOP_PROVIDER;
    await app.close();
    await cleanup();
  });

  it("GET /v1/metrics 返回 Prometheus OpenMetrics 格式文本", async () => {
    metricsRegistry.emit({ type: "counter", name: "agent.turn.started", value: 1 });
    metricsRegistry.emit({ type: "gauge", name: "agent.host.running", value: 42 });
    metricsRegistry.emit({ type: "histogram", name: "agent.provider.duration_ms", value: 75 });

    const res = await app.inject({
      method: "GET",
      url: "/v1/metrics",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    const body = res.body;
    expect(body).toContain("# TYPE agent_turn_started_total counter");
    expect(body).toContain("agent_turn_started_total 1");
    expect(body).toContain("# TYPE agent_host_running gauge");
    expect(body).toContain("agent_host_running 42");
    expect(body).toContain("# TYPE agent_provider_duration_ms summary");
    expect(body).toContain('agent_provider_duration_ms{quantile="0.5"} 75');
    expect(body).toContain("agent_provider_duration_ms_count 1");
  });

  it("GET /v1/metrics 支持 JSON 格式查询快照 (Accept: application/json)", async () => {
    metricsRegistry.emit({ type: "counter", name: "agent.step.started", value: 3 });

    const res = await app.inject({
      method: "GET",
      url: "/v1/metrics",
      headers: {
        accept: "application/json",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    const json = JSON.parse(res.body);
    expect(json.counters).toBeDefined();
    expect(json.counters["agent.step.started"]).toBe(3);
  });

  it("HTTP 请求生命周期正常记录结构化访问日志", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/personas",
      headers,
    });

    expect(res.statusCode).toBe(200);
    const parsedLogs = capturedLogs.map((line) => {
      try {
        return JSON.parse(line) as LogRecord;
      } catch {
        return null;
      }
    }).filter(Boolean) as LogRecord[];

    const accessLog = parsedLogs.find(
      (log) => log.event === "http.request.completed" && log.fields?.url === "/v1/personas",
    );
    expect(accessLog).toBeDefined();
    expect(accessLog?.fields?.method).toBe("GET");
    expect(accessLog?.fields?.statusCode).toBe(200);
    expect(typeof accessLog?.fields?.durationMs).toBe("number");
  });

  it("HTTP 异常抛出被 setErrorHandler 捕获并输出结构化错误日志", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/test-error-trigger",
      headers,
    });

    expect(res.statusCode).toBe(500);
    const parsedLogs = capturedLogs.map((line) => {
      try {
        return JSON.parse(line) as LogRecord;
      } catch {
        return null;
      }
    }).filter(Boolean) as LogRecord[];

    const errorLog = parsedLogs.find((log) => log.event === "http.request.error");
    expect(errorLog).toBeDefined();
    expect(errorLog?.fields?.method).toBe("GET");
    expect(errorLog?.fields?.statusCode).toBe(500);
    expect(errorLog?.message).toContain("Simulated unhandled exception");
  });

  it("Agent 回合生命周期记录 agent.turn.started 与 agent.turn.completed 结构化事件", async () => {
    const sessionId = "ses_obs_turn_1";
    const turnRes = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/turns`,
      headers,
      payload: {
        message: {
          content: "你好，这是一条可观测性测试消息",
          contentType: "text",
        },
        clientVersion: "1.0.0",
      },
    });
    expect(turnRes.statusCode).toBe(201);

    const parsedLogs = capturedLogs.map((line) => {
      try {
        return JSON.parse(line) as LogRecord;
      } catch {
        return null;
      }
    }).filter(Boolean) as LogRecord[];

    const startEvent = parsedLogs.find((log) => log.event === "agent.turn.started");
    expect(startEvent).toBeDefined();
    expect(startEvent?.fields?.sessionId).toBe(sessionId);

    const completedEvent = parsedLogs.find((log) => log.event === "agent.turn.completed");
    expect(completedEvent).toBeDefined();
    expect(completedEvent?.fields?.sessionId).toBe(sessionId);
    expect(typeof completedEvent?.fields?.durationMs).toBe("number");
  });
});
