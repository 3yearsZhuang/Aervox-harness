import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createInMemoryDatabase, SqliteConversationRepository, SqliteToolRegistryRepository, type AervoxDatabase } from "@aervox/database";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

const headers = {
  "x-workspace-id": "ws_3a",
  "x-user-id": "usr_3a",
} as const;
const tenant = { workspaceId: "ws_3a", subjectUserId: "usr_3a" } as const;

const turnPayload = {
  message: { content: "保存笔记", contentType: "text" },
  clientVersion: "it-3a",
  references: [],
};

const parseSse = (body: string): Array<{ eventType: string; data: { status?: string; isComplete?: boolean; ok?: boolean; approvalId?: string; error?: string } }> =>
  body
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const data = block.split("\n").find((l) => l.startsWith("data: "));
      return data
        ? (JSON.parse(data.slice(6)) as { eventType: string; data: { status?: string; isComplete?: boolean; ok?: boolean; approvalId?: string; error?: string } })
        : null;
    })
    .filter((x): x is { eventType: string; data: { status?: string; isComplete?: boolean; ok?: boolean; approvalId?: string; error?: string } } => x !== null);

describe("Agent Loop 阶段 3a：写工具审批通道", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let built: Awaited<ReturnType<typeof buildApp>>;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    process.env.AERVOX_LOOP_PROVIDER = "scripted-write";
    const res = await createInMemoryDatabase();
    db = res.db;
    cleanup = res.cleanup;
    built = await buildApp({ db, client: res.client });
    app = built.app;
    await app.ready();

    const registry = new SqliteToolRegistryRepository(db);
    await registry.registerTool({
      id: "aervox_save_note",
      name: "aervox_save_note",
      description: "保存一条学习笔记（需授权）",
      category: "memory",
      safetyLevel: "write_with_approval",
      requiredPermissions: [],
      inputSchema: { type: "object", properties: { content: { type: "string" } } },
      builtin: false,
      gatingConditions: [],
      priority: 20,
    });
    built.toolRuntime.registerHandler("aervox_save_note", {
      call: async (t, args) => ({ saved: true, content: (args as { content?: string }).content ?? "" }),
    });
  });

  afterEach(async () => {
    delete process.env.AERVOX_LOOP_PROVIDER;
    await app.close();
    await cleanup();
  });

  const createTurn = async () =>
    app.inject({ method: "POST", url: "/v1/sessions/ses_3a/turns", headers, payload: turnPayload });

  it("未授权写工具：tool_approval_required + done(Interrupted) + 账本 pending_approval", async () => {
    const created = await createTurn();
    expect(created.statusCode).toBe(201);
    const turnId = created.json().turnId as string;

    const events = parseSse((await app.inject({ method: "GET", url: `/v1/turns/${turnId}/events`, headers })).body);
    expect(events.map((e) => e.eventType)).toContain("tool_approval_required");
    expect(events[events.length - 1].eventType).toBe("done");
    expect(events[events.length - 1].data.status).toBe("Interrupted");

    const repo = new SqliteConversationRepository(db);
    const executions = await repo.listToolExecutionsByTurn(tenant, turnId);
    expect(executions[0]).toMatchObject({ name: "aervox_save_note", status: "pending_approval" });
    const approvals = await repo.listToolApprovalsByTurn(tenant, turnId);
    expect(approvals).toHaveLength(1);
    expect(approvals[0].state).toBe("pending");
  });

  it("授权后重发：grant → 重发命中 granted 并执行成功", async () => {
    const first = await createTurn();
    const firstTurnId = first.json().turnId as string;

    const repo = new SqliteConversationRepository(db);
    const approvals = await repo.listToolApprovalsByTurn(tenant, firstTurnId);
    const approvalId = approvals[0]!.id;

    const decide = await app.inject({
      method: "POST",
      url: `/v1/turns/${firstTurnId}/tool-approvals`,
      headers,
      payload: { approvalId, decision: "granted", decidedBy: "admin_unit_test" },
    });
    expect(decide.statusCode).toBe(200);
    expect(decide.json().state).toBe("granted");

    // 同 turn SSE 可见 granted 事件
    const events = parseSse((await app.inject({ method: "GET", url: `/v1/turns/${firstTurnId}/events`, headers })).body);
    expect(events.map((e) => e.eventType)).toContain("tool_approval_granted");

    // 重发相同请求（新 turn）→ 命中 granted → 执行
    const retried = await createTurn();
    const retriedTurnId = retried.json().turnId as string;
    const retriedEvents = parseSse((await app.inject({ method: "GET", url: `/v1/turns/${retriedTurnId}/events`, headers })).body);
    const toolResult = retriedEvents.find((e) => e.eventType === "tool_result")?.data;
    expect(toolResult?.ok).toBe(true);
    expect(retriedEvents[retriedEvents.length - 1].data.status).toBe("Completed");

    const executions = await repo.listToolExecutionsByTurn(tenant, retriedTurnId);
    expect(executions[0]).toMatchObject({ name: "aervox_save_note", status: "executed" });
  });

  it("拒绝后重发：deny → 无 granted 匹配，仍挂 pending", async () => {
    const first = await createTurn();
    const firstTurnId = first.json().turnId as string;

    const repo = new SqliteConversationRepository(db);
    const approvalId = (await repo.listToolApprovalsByTurn(tenant, firstTurnId))[0]!.id;

    const decide = await app.inject({
      method: "POST",
      url: `/v1/turns/${firstTurnId}/tool-approvals`,
      headers,
      payload: { approvalId, decision: "denied", decidedBy: "admin_unit_test" },
    });
    expect(decide.json().state).toBe("denied");

    const retried = await createTurn();
    const retriedTurnId = retried.json().turnId as string;
    const retriedEvents = parseSse((await app.inject({ method: "GET", url: `/v1/turns/${retriedTurnId}/events`, headers })).body);
    expect(retriedEvents.map((e) => e.eventType)).toContain("tool_approval_required");
    expect(retriedEvents[retriedEvents.length - 1].data.status).toBe("Interrupted");
  });
});