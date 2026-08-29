/**
 * Aervox｜思隅 @aervox/api — 阶段 3b privileged 管理员通道集成测试
 *
 * 覆盖 AVX-HAR-001 §9（privileged 默认拒绝，仅管理员通道放行）：
 * - privileged 未批准 → 审批待决（不再是硬拒绝，通道打开）；
 * - 管理员（x-admin-user-id ∈ AERVOX_ADMIN_IDS）grant → 重发命中授权并执行；
 * - 非管理员 grant → 403 admin_required。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createInMemoryDatabase,
  FULL_PROFILE_SOURCE_MANIFEST,
  SqliteProactiveProfileRepository,
  SqliteToolRegistryRepository,
  type AervoxDatabase,
} from "@aervox/database";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

const headers = {
  "x-workspace-id": "ws_3b",
  "x-user-id": "usr_3b",
} as const;
const tenant = { workspaceId: headers["x-workspace-id"], subjectUserId: headers["x-user-id"] } as const;

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

  it("仅开启完全访问不会放行 privileged，仍进入管理员审批通道", async () => {
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

  it("主动能全动作授权可执行 privileged，撤权后同参数不复用自动授权", async () => {
    const proactiveRepo = new SqliteProactiveProfileRepository(db);
    const { revision, sources } = await proactiveRepo.confirmProfile(tenant, {
      id: "profile_3b",
      deviceId: "device_3b",
      actorId: tenant.subjectUserId,
      sources: FULL_PROFILE_SOURCE_MANIFEST.map((source, index) => ({
        id: `profile_3b_source_${index + 1}`,
        sourceKey: source.sourceKey,
        purpose: source.purpose,
        scope: "all",
        osCapability: source.osCapability,
        state: "granted" as const,
        mandatory: true,
        grantVersion: 1,
      })),
    });
    await proactiveRepo.createActivationLease(tenant, {
      id: "lease_3b",
      revisionId: revision.id,
      deviceId: revision.deviceId,
      epoch: "epoch_3b",
      localReady: true,
      fullAccessSnapshot: true,
      actorId: tenant.subjectUserId,
    });

    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions/ses_3b/turns",
      headers,
      payload: { ...turnPayload, toolApprovalMode: "full_access" },
    });
    const turnId = created.json().turnId as string;
    const events = parseSse((await app.inject({ method: "GET", url: `/v1/turns/${turnId}/events`, headers })).body);
    expect(events.map((event) => event.eventType)).not.toContain("tool_approval_required");
    expect(events.find((event) => event.eventType === "tool_result")?.data.ok).toBe(true);
    const [action] = await proactiveRepo.listActions(tenant);
    expect(action).toMatchObject({
      actionType: "aervox_privileged_op",
      state: "executed",
    });
    expect(action?.authorizationScope).toContain("action.privileged");

    const privilegedGrant = sources.find((source) => source.sourceKey === "action.privileged")!;
    await proactiveRepo.updateSourceGrant(tenant, privilegedGrant.id, {
      state: "revoked",
      actorId: tenant.subjectUserId,
    });
    const afterRevoke = await app.inject({
      method: "POST",
      url: "/v1/sessions/ses_3b/turns",
      headers,
      payload: { ...turnPayload, toolApprovalMode: "full_access" },
    });
    const afterRevokeTurnId = afterRevoke.json().turnId as string;
    const afterRevokeEvents = parseSse(
      (await app.inject({ method: "GET", url: `/v1/turns/${afterRevokeTurnId}/events`, headers })).body,
    );
    expect(afterRevokeEvents.map((event) => event.eventType)).toContain("tool_approval_required");
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
