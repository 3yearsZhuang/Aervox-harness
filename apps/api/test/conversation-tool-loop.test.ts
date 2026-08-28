import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createInMemoryDatabase, SqliteConversationRepository, SqliteToolRegistryRepository, type AervoxDatabase } from "@aervox/database";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type { Client } from "@libsql/client";

const headers = {
  "x-workspace-id": "ws_loop2d",
  "x-user-id": "usr_loop2d",
} as const;

const turnPayload = {
  message: { content: "帮我排复习计划", contentType: "text" },
  clientVersion: "it-2d",
  references: [],
};

interface ParsedEvent {
  sequence: number;
  eventType: string;
  data: {
    ok?: boolean;
    error?: string;
    name?: string;
    status?: string;
    isComplete?: boolean;
  };
}

const parseSse = (body: string): ParsedEvent[] =>
  body
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const data = block.split("\n").find((l) => l.startsWith("data: "));
      return data ? (JSON.parse(data.slice(6)) as ParsedEvent) : null;
    })
    .filter((x): x is ParsedEvent => x !== null);

describe("Agent Loop 阶段 2d：工具事件透传 + tool_executions 副作用账本", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let client: Client;
  let built: Awaited<ReturnType<typeof buildApp>>;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    process.env.AERVOX_LOOP_PROVIDER = "scripted";
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
    built = await buildApp({ db, client });
    app = built.app;
    await app.ready();

    // 注册只读工具 + 注入 handler（模拟 read_only 白名单工具）
    const registry = new SqliteToolRegistryRepository(db);
    await registry.registerTool({
      id: "aervox_notes_search",
      name: "aervox_notes_search",
      description: "检索学习笔记（只读）",
      category: "memory",
      safetyLevel: "read_only",
      requiredPermissions: [],
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
      builtin: false,
      gatingConditions: [],
      priority: 10,
    });
    built.toolRuntime.registerHandler("aervox_notes_search", {
      call: async () => ({ matches: ["复习计划：今天复习三角函数"] }),
    });
  });

  afterEach(async () => {
    delete process.env.AERVOX_LOOP_PROVIDER;
    await app.close();
    await cleanup();
  });

  const createTurn = async (sessionId = "ses_2d") =>
    app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/turns`,
      headers,
      payload: turnPayload,
    });

  it("scripted 工具链：SSE 透传 tool_request/tool_result，且 tool_executions 记录 executed", async () => {
    const created = await createTurn();
    expect(created.statusCode).toBe(201);
    const turnId = created.json().turnId as string;

    const eventsRes = await app.inject({ method: "GET", url: `/v1/turns/${turnId}/events`, headers });
    const parsed = parseSse(eventsRes.body);
    const types = parsed.map((e) => e.eventType);

    expect(types).toContain("tool_request");
    expect(types).toContain("tool_result");
    expect(types[types.length - 1]).toBe("done");

    const toolResult = parsed.find((e) => e.eventType === "tool_result")?.data;
    expect(toolResult?.ok).toBe(true);
    const done = parsed[parsed.length - 1]?.data;
    expect(done?.status).toBe("Completed");
    expect(done?.isComplete).toBe(true);

    // 副作用账本：一条 executed 记录
    const repo = new SqliteConversationRepository(db);
    const executions = await repo.listToolExecutionsByTurn({ workspaceId: "ws_loop2d", subjectUserId: "usr_loop2d" }, turnId);
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      turnId,
      name: "aervox_notes_search",
      status: "executed",
    });
    expect(executions[0].outputJson).toBeTruthy();
  });

  it("停用（enabled=0）的工具 fail-closed：tool_result 拒绝 + 账本 rejected", async () => {
    const registry = new SqliteToolRegistryRepository(db);
    await registry.setEnabled("aervox_notes_search", 0);

    const created = await createTurn();
    expect(created.statusCode).toBe(201);
    const turnId = created.json().turnId as string;

    const eventsRes = await app.inject({ method: "GET", url: `/v1/turns/${turnId}/events`, headers });
    const parsed = parseSse(eventsRes.body);
    const toolResult = parsed.find((e) => e.eventType === "tool_result")?.data;
    expect(toolResult?.ok).toBe(false);
    expect(toolResult?.error).toContain("unregistered_tool");

    const repo = new SqliteConversationRepository(db);
    const executions = await repo.listToolExecutionsByTurn({ workspaceId: "ws_loop2d", subjectUserId: "usr_loop2d" }, turnId);
    expect(executions[0]).toMatchObject({ status: "rejected" });
  });
});