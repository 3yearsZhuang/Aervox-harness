/**
 * Aervox｜思隅 @aervox/api — 阶段 2d 删除/撤权 fail-closed 集成测试
 *
 * 覆盖 AVX-HAR-001 §11.3：删除/撤权水位未追平 → Loop fail-closed。
 * - 存在未完成 deletion request 时：Turn 不产出模型片段/工具执行，收敛 Interrupted（deletion_blocked）；
 * - 追平（request completed）后：新 Turn 正常完成。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createInMemoryDatabase, SqliteConversationRepository, SqlitePrivacyRepository, type AervoxDatabase, type TenantContext } from "@aervox/database";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type { Client } from "@libsql/client";

const tenant: TenantContext = { workspaceId: "ws_delapi", subjectUserId: "usr_delapi" };
const headers = {
  "x-workspace-id": tenant.workspaceId,
  "x-user-id": tenant.subjectUserId,
} as const;

const turnPayload = {
  message: { content: "帮我查复习笔记", contentType: "text", role: "user" },
  clientVersion: "it-del",
  references: [],
};

interface ParsedEvent {
  eventType: string;
  data: { status?: string; reason?: string };
}

const parseSse = (body: string): ParsedEvent[] =>
  body
    .split("\n\n")
    .filter(Boolean)
    .map((block) => JSON.parse(block.split("\n").find((l) => l.startsWith("data: "))!.slice(6)) as ParsedEvent);

describe("阶段 2d 删除/撤权未追平 → Loop fail-closed", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let cleanup: () => Promise<void>;
  let conversationRepo: SqliteConversationRepository;
  let privacyRepo: SqlitePrivacyRepository;

  beforeEach(async () => {
    process.env.AERVOX_LOOP_PROVIDER = "replay";
    const res = await createInMemoryDatabase();
    db = res.db;
    cleanup = res.cleanup;
    const built = await buildApp({ db, client: res.client });
    app = built.app;
    conversationRepo = new SqliteConversationRepository(db);
    privacyRepo = new SqlitePrivacyRepository(db);
    await app.ready();
  });

  afterEach(async () => {
    delete process.env.AERVOX_LOOP_PROVIDER;
    await app.close();
    await cleanup();
  });

  it("未追平删除请求：Turn 零产出，收敛 Interrupted(deletion_blocked)", async () => {
    await privacyRepo.createDeletionRequest(tenant, {
      id: "delreq_pending",
      scope: "all",
      idempotencyKey: "idem_del_pending",
      ownerModule: "privacy",
    });

    const create = await app.inject({
      method: "POST",
      url: "/v1/sessions/ses_del/turns",
      headers,
      payload: turnPayload,
    });
    expect(create.statusCode).toBe(201);
    const { turnId } = create.json();

    const eventsRes = await app.inject({ method: "GET", url: `/v1/turns/${turnId}/events`, headers });
    const events = parseSse(eventsRes.body);
    const types = events.map((e) => e.eventType);
    expect(types).toEqual(["message", "done"]); // 无 delta / 工具事件
    const done = events[1];
    expect(done.data.status).toBe("Interrupted");
    expect(done.data.reason).toBe("deletion_blocked");

    const attempts = await conversationRepo.listTurnAttempts(tenant, turnId);
    expect(attempts[0]?.status).toBe("Interrupted");
  });

  it("追平后新 Turn 正常完成", async () => {
    const req = await privacyRepo.createDeletionRequest(tenant, {
      id: "delreq_then_done",
      scope: "all",
      idempotencyKey: "idem_del_then_done",
      ownerModule: "privacy",
    });
    await privacyRepo.updateDeletionRequestStatus(tenant, req.id, "completed");

    const create = await app.inject({
      method: "POST",
      url: "/v1/sessions/ses_del2/turns",
      headers,
      payload: turnPayload,
    });
    expect(create.statusCode).toBe(201);
    const { turnId } = create.json();

    const eventsRes = await app.inject({ method: "GET", url: `/v1/turns/${turnId}/events`, headers });
    const events = parseSse(eventsRes.body);
    expect(events.at(-1)?.data.status).toBe("Completed");
    const attempts = await conversationRepo.listTurnAttempts(tenant, turnId);
    expect(attempts[0]?.status).toBe("Completed");
  });
});