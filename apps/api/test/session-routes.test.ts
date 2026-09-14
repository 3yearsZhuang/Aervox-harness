import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createInMemoryDatabase, type AervoxDatabase } from "@aervox/repositories";
import type { Client } from "@libsql/client";

describe("Session Management Routes (CR-035 / W1)", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;

    const built = await buildApp({ db, client });
    app = built.app;
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
    await cleanup();
  });

  it("GET /v1/sessions initially returns empty list", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/sessions",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body).toEqual({ items: [] });
  });

  it("POST /v1/sessions creates a new session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { title: "微积分导论" },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.id).toMatch(/^ses_/);
    expect(body.title).toBe("微积分导论");
    expect(body.createdAt).toBeDefined();

    // Verify it appears in GET /v1/sessions
    const listRes = await app.inject({
      method: "GET",
      url: "/v1/sessions",
    });
    expect(listRes.statusCode).toBe(200);
    const listBody = JSON.parse(listRes.payload);
    expect(listBody.items.length).toBe(1);
    expect(listBody.items[0].id).toBe(body.id);
  });

  it("POST /v1/sessions with explicit id creates or retrieves session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { id: "custom_session_1", title: "自定义会话" },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.id).toBe("custom_session_1");
    expect(body.title).toBe("自定义会话");

    // Idempotent retrieval
    const res2 = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { id: "custom_session_1", title: "重复调用不覆盖" },
    });
    expect(res2.statusCode).toBe(201);
    const body2 = JSON.parse(res2.payload);
    expect(body2.id).toBe("custom_session_1");
    expect(body2.title).toBe("自定义会话");
  });

  it("PATCH /v1/sessions/:sessionId renames a session", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { title: "旧标题" },
    });
    const { id } = JSON.parse(createRes.payload);

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/v1/sessions/${id}`,
      payload: { title: "新标题" },
    });
    expect(patchRes.statusCode).toBe(200);
    const updated = JSON.parse(patchRes.payload);
    expect(updated.title).toBe("新标题");

    // 404 for nonexistent
    const missingRes = await app.inject({
      method: "PATCH",
      url: "/v1/sessions/non_existent",
      payload: { title: "新标题" },
    });
    expect(missingRes.statusCode).toBe(404);
  });

  it("DELETE /v1/sessions/:sessionId deletes a session", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { title: "将要删除" },
    });
    const { id } = JSON.parse(createRes.payload);

    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/v1/sessions/${id}`,
    });
    expect(deleteRes.statusCode).toBe(204);

    // Should no longer be in list
    const listRes = await app.inject({
      method: "GET",
      url: "/v1/sessions",
    });
    expect(JSON.parse(listRes.payload).items.length).toBe(0);

    // 404 on deleting again
    const missingDelete = await app.inject({
      method: "DELETE",
      url: `/v1/sessions/${id}`,
    });
    expect(missingDelete.statusCode).toBe(404);
  });
});
