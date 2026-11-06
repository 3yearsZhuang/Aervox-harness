import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app-fixture.js";
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

  it("reads a restored session beyond the first page without changing stored sessions or creating a Turn", async () => {
    for (let index = 0; index < 103; index++) {
      const created = await app.inject({ method: 'POST', url: '/v1/sessions', payload: { id: `page-${index}`, title: `会话 ${index}` } });
      expect(created.statusCode).toBe(201);
      await client.execute({ sql: 'UPDATE sessions SET updated_at = ? WHERE id = ?', args: [String(index).padStart(3, '0'), `page-${index}`] });
    }
    const first = await app.inject({ method: 'GET', url: '/v1/sessions?limit=100&offset=0' });
    expect(first.statusCode).toBe(200);
    expect(first.json().items).toHaveLength(100);
    expect(first.json().items.some((row: { id: string }) => row.id === 'page-0')).toBe(false);
    const old = await app.inject({ method: 'GET', url: '/v1/sessions/page-0' });
    expect(old.statusCode).toBe(200);
    expect(old.json().id).toBe('page-0');
    expect(old.json().executionPolicy).toBeUndefined();
    const next = await app.inject({ method: 'GET', url: '/v1/sessions?limit=100&offset=100' });
    expect(next.statusCode).toBe(200);
    expect(next.json().items.map((row: { id: string }) => row.id)).toEqual(['page-2', 'page-1', 'page-0']);
    expect((await app.inject({ method: 'GET', url: '/v1/sessions/missing' })).statusCode).toBe(404);
    expect((await client.execute('SELECT count(*) AS n FROM sessions')).rows[0]?.n).toBe(103);
    expect((await client.execute('SELECT count(*) AS n FROM turns')).rows[0]?.n).toBe(0);
  });

  it("rejects malformed and duplicate paging parameters with the shared contract", async () => {
    for (const query of ['limit=0', 'limit=101', 'limit=01', 'limit=1.5', 'limit=1&limit=2',
      'offset=-1', 'offset=1e2', 'offset=9007199254740992', 'offset=1&offset=2', 'projectId=', 'unknown=true']) {
      const response = await app.inject({ method: 'GET', url: '/v1/sessions?' + query });
      expect(response.statusCode, query).toBe(400);
      expect(response.json().code).toBe('INVALID_SESSION_QUERY');
    }
    expect((await client.execute('SELECT count(*) AS n FROM sessions')).rows[0]?.n).toBe(0);
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
