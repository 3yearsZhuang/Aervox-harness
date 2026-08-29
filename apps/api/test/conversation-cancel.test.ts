/**
 * Aervox｜思隅 @aervox/api — 阶段 2b 用户取消闭环集成测试
 *
 * 覆盖 AVX-HAR-001 §11.1 路由层语义：
 * - Running Attempt 可被取消（Attempt → CancelRequested，turn → Cancelled，不覆盖终态）；
 * - 已终态 Turn 取消被拒绝（409 turn_already_finalized）；
 * - 不存在 Turn 返回 404。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createInMemoryDatabase, SqliteConversationRepository, type AervoxDatabase, type TenantContext } from "@aervox/database";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type { Client } from "@libsql/client";

const tenant: TenantContext = { workspaceId: "ws_cancelapi", subjectUserId: "usr_cancelapi" };
const headers = {
  "x-workspace-id": tenant.workspaceId,
  "x-user-id": tenant.subjectUserId,
} as const;

describe("阶段 2b 用户取消（POST /v1/turns/:id/cancel）", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let cleanup: () => Promise<void>;
  let repo: SqliteConversationRepository;

  beforeEach(async () => {
    process.env.AERVOX_LOOP_PROVIDER = "replay";
    const res = await createInMemoryDatabase();
    db = res.db;
    cleanup = res.cleanup;
    const built = await buildApp({ db, client: res.client });
    app = built.app;
    repo = new SqliteConversationRepository(db);
    await app.ready();
  });

  afterEach(async () => {
    delete process.env.AERVOX_LOOP_PROVIDER;
    await app.close();
    await cleanup();
  });

  async function seedRunningTurn(turnId: string, sessionId: string) {
    await repo.getOrCreateSession(tenant, sessionId, "取消集成");
    await repo.createTurnWithOutbox(
      tenant,
      { id: turnId, sessionId, idempotencyKey: `idem_${turnId}`, status: "Created" },
      { id: `msg_${turnId}`, content: "x" },
      { id: `ob_${turnId}`, eventType: "turn.created", idempotencyKey: `idem_ob_${turnId}`, payload: { turnId, sessionId } },
    );
    await repo.createTurnAttempt(tenant, turnId, { id: `atp_${turnId}`, attempt: 1 });
  }

  it("Running Attempt 取消成功：Attempt → CancelRequested，turn → Cancelled（未终态不覆盖）", async () => {
    const turnId = "turn_cancel_ok";
    await seedRunningTurn(turnId, "ses_cancel_ok");

    const res = await app.inject({ method: "POST", url: `/v1/turns/${turnId}/cancel`, headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ turnId, status: "Cancelled", cancelled: true });
    const attempts = await repo.listTurnAttempts(tenant, turnId);
    expect(attempts[0]?.status).toBe("CancelRequested");
  });

  it("已终态 Turn 取消被拒：409 turn_already_finalized，终态不被覆盖", async () => {
    // 走真实 Turn 创建 + replay Loop 后台完成（CR-027 background 语义）
    const create = await app.inject({
      method: "POST",
      url: "/v1/sessions/ses_done/turns",
      headers,
      payload: {
        message: { content: "帮我安排复习", contentType: "text", role: "user" },
        clientVersion: "it-cancel",
        references: [],
      },
    });
    expect(create.statusCode).toBe(201);
    const { turnId } = create.json();

    // SSE 活流在 Attempt 终态排空后结束——作为「回合已完成」屏障，规避 background 竞态
    const stream = await app.inject({ method: "GET", url: `/v1/turns/${turnId}/events`, headers });
    expect(stream.statusCode).toBe(200);
    const attempts = await repo.listTurnAttempts(tenant, turnId);
    expect(attempts[0]?.status).toBe("Completed");

    const res = await app.inject({ method: "POST", url: `/v1/turns/${turnId}/cancel`, headers });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("turn_already_finalized");
    const attemptsAfter = await repo.listTurnAttempts(tenant, turnId);
    expect(attemptsAfter[0]?.status).toBe("Completed");
  });

  it("不存在的 Turn 返回 404", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/turns/turn_nope/cancel", headers });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("turn_not_found");
  });
});