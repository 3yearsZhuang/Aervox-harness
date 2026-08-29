/**
 * Aervox｜思隅 @aervox/api — 阶段 3b privileged 管理员通道集成测试
 *
 * 覆盖 AVX-HAR-001 §9（privileged 默认拒绝，仅管理员通道放行）：
 * - privileged 未批准 → 审批待决（不再是硬拒绝，通道打开）；
 * - 管理员（x-admin-user-id ∈ AERVOX_ADMIN_IDS）grant → 重发命中授权并执行；
 * - 非管理员 grant → 403 admin_required。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createInMemoryDatabase, SqliteToolRegistryRepository, type AervoxDatabase } from "@aervox/database";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

const headers = {
  "x-workspace-id": "ws_3b",
  "x-user-id": "usr_3b",
} as const;

const turnPayload = {
  message: { content: "执行特权操作", contentType: "text" },
  clientVersion: "it-3b",
  references: [],
};

interface ApprovalEventData {
  eventType: string;
  data: { status?: string; ok?: boolean; approvalId?: string; error?: string };
}

const parseSse = (body: string): ApprovalEventData[] =>
  body
    .split("\n\n")
    .filter(Boolean)
    .map((block) => JSON.parse(block.split("\n").find((l) => l.startsWith("data: "))!.slice(6)) as ApprovalEventData);

describe("阶段 3b：privileged 管理员通道", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let built: Awaited<ReturnType<typeof buildApp>>;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    process.env.AERVOX_LOOP_PROVIDER = "scripted-privileged";
    process.env.AERVOX_ADMIN_IDS = "admin_3b";
    const res = await createInMemoryDatabase();
    db = res.db;
    cleanup = res.cleanup;
    built = await buildApp({ db, client: res.client });
    app = built.app;
    await app.ready();

    const registry = new SqliteToolRegistryRepository(db);
    await registry.registerTool({
      id: "aervox_privileged_op",
      name: "aervox_privileged_op",
      description: "特权操作（仅管理员通道）",
      category: "system",
      safetyLevel: "privileged",
      requiredPermissions: [],
      inputSchema: { type: "object", properties: { op: { type: "string" } } },
      builtin: false,
      gatingConditions: [],
      priority: 10,
    });
    built.toolRuntime.registerHandler("aervox_privileged_op", {
      call: async (_t, args) => ({ exported: true, op: (args as { op?: string }).op ?? "" }),
    });
  });

  afterEach(async () => {
    delete process.env.AERVOX_LOOP_PROVIDER;
    delete process.env.AERVOX_ADMIN_IDS;
    await app.close();
    await cleanup();
  });

  it("未批准：privileged → 审批待决（tool_approval_required + Interrupted + 账本 pending_approval）", async () => {
    const created = await app.inject({ method: "POST", url: "/v1/sessions/ses_3b/turns", headers, payload: turnPayload });
    expect(created.statusCode).toBe(201);
    const turnId = created.json().turnId as string;

    const events = parseSse((await app.inject({ method: "GET", url: `/v1/turns/${turnId}/events`, headers })).body);
    const approval = events.find((e) => e.eventType === "tool_approval_required");
    expect(approval?.data.approvalId).toBeTruthy();
    expect(events.at(-1)?.data.status).toBe("Interrupted");
  });

  it("完全访问不放行 privileged，仍进入管理员审批通道", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions/ses_3b/turns",
      headers,
      payload: { ...turnPayload, toolApprovalMode: "full_access" },
    });
    const turnId = created.json().turnId as string;
    const events = parseSse((await app.inject({ method: "GET", url: `/v1/turns/${turnId}/events`, headers })).body);
    expect(events.map((event) => event.eventType)).toContain("tool_approval_required");
    expect(events.at(-1)?.data.status).toBe("Interrupted");
  });

  it("非管理员 grant → 403 admin_required，未产生授权", async () => {
    const created = await app.inject({ method: "POST", url: "/v1/sessions/ses_3b/turns", headers, payload: turnPayload });
    const turnId = created.json().turnId as string;
    const events = parseSse((await app.inject({ method: "GET", url: `/v1/turns/${turnId}/events`, headers })).body);
    const approvalId = events.find((e) => e.eventType === "tool_approval_required")!.data.approvalId!;

    const denied = await app.inject({
      method: "POST",
      url: `/v1/turns/${turnId}/tool-approvals`,
      headers: { ...headers, "x-admin-user-id": "not_admin" },
      payload: { approvalId, decision: "granted" },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toContain("admin_required");
  });

  it("管理员 grant → 重发同参数命中授权并执行成功", async () => {
    const created = await app.inject({ method: "POST", url: "/v1/sessions/ses_3b/turns", headers, payload: turnPayload });
    const turnId = created.json().turnId as string;
    const events = parseSse((await app.inject({ method: "GET", url: `/v1/turns/${turnId}/events`, headers })).body);
    const approvalId = events.find((e) => e.eventType === "tool_approval_required")!.data.approvalId!;

    const granted = await app.inject({
      method: "POST",
      url: `/v1/turns/${turnId}/tool-approvals`,
      headers: { ...headers, "x-admin-user-id": "admin_3b" },
      payload: { approvalId, decision: "granted", decidedBy: "admin_3b" },
    });
    expect(granted.statusCode).toBe(200);
    expect(granted.json().state).toBe("granted");

    // 客户端重发相同请求（同轮工具调用 + 参数）→ 命中 granted → 执行
    const retry = await app.inject({ method: "POST", url: "/v1/sessions/ses_3b/turns", headers, payload: turnPayload });
    expect(retry.statusCode).toBe(201);
    const retryTurnId = retry.json().turnId as string;
    const retryEvents = parseSse((await app.inject({ method: "GET", url: `/v1/turns/${retryTurnId}/events`, headers })).body);
    const toolResult = retryEvents.find((e) => e.eventType === "tool_result");
    expect(toolResult?.data.ok).toBe(true);
  });
});
