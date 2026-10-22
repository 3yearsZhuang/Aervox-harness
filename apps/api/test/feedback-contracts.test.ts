import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryDatabase, SqliteFeedbackRepository } from "@aervox/repositories";
import { buildApp } from "./app-fixture.js";

const token = "feedback-test-token";
const authorization = { authorization: `Bearer ${token}` };
const valid = { subjectType: "plugin:extension", subjectId: "subject", type: "plugin:quality" };
const ctx = { workspaceId: "local", subjectUserId: "local" };

describe("feedback API ownership and contracts", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  const fixture = async (mode: "token" | "open" = "token") => {
    const main = await createInMemoryDatabase(); const vault = await createInMemoryDatabase();
    cleanups.push(main.cleanup, vault.cleanup);
    const { app } = await buildApp({ db: main.db, client: main.client, proactiveDb: vault.db,
      proactiveClient: vault.client, proactiveAccessToken: null,
      auth: mode === "token" ? { mode, token, actorId: "server_actor" } : { mode } });
    cleanups.push(async () => { await app.close(); }); await app.ready();
    return { app, main, vault, repo: new SqliteFeedbackRepository(main.db) };
  };
  const stored = async (main: Awaited<ReturnType<typeof createInMemoryDatabase>>) =>
    (await main.client.execute("SELECT actor_id, subject_type, subject_id, type, note FROM feedback")).rows;

  it("rejects missing or wrong Token before reading or writing feedback", async () => {
    const { app, main } = await fixture();
    const writes = vi.spyOn(SqliteFeedbackRepository.prototype, "createFeedback");
    const reads = vi.spyOn(SqliteFeedbackRepository.prototype, "listFeedback");
    for (const headers of [{}, { authorization: "Bearer wrong-token" }]) {
      for (const method of ["GET", "POST"] as const) {
        const response = await app.inject({ method, url: "/v1/feedback", headers, ...(method === "POST" ? { payload: valid } : {}) });
        expect(response.statusCode).toBe(401);
      }
    }
    expect(writes).not.toHaveBeenCalled(); expect(reads).not.toHaveBeenCalled(); expect(await stored(main)).toEqual([]);
  });

  it("ignores spoofed actor identifiers and persists the configured Token audit actor", async () => {
    const { app, main, vault } = await fixture();
    const response = await app.inject({ method: "POST", url: "/v1/feedback",
      headers: { ...authorization, "x-actor-id": "header_spoof", "x-user-id": "user_spoof", "x-workspace-id": "workspace_spoof" },
      payload: { ...valid, actorId: "body_spoof", workspaceId: "body_workspace", subjectUserId: "body_user" } });
    expect(response.statusCode).toBe(201);
    expect(await stored(main)).toMatchObject([{ actor_id: "server_actor", subject_type: valid.subjectType, subject_id: valid.subjectId }]);
    expect(response.json()).toMatchObject({ ...valid, actorId: "server_actor", note: null });
    expect((await vault.client.execute("SELECT COUNT(*) AS n FROM feedback")).rows[0]!.n).toBe(0);
  });

  it("uses the local subject fallback in open mode and never accepts body/header actor", async () => {
    const { app, main } = await fixture("open");
    const response = await app.inject({ method: "POST", url: "/v1/feedback",
      headers: { "x-actor-id": "header_spoof", "x-user-id": "user_spoof" }, payload: { ...valid, actorId: "body_spoof" } });
    expect(response.statusCode).toBe(201);
    expect(await stored(main)).toMatchObject([{ actor_id: "local" }]);
    expect(response.json().actorId).toBe("local");
  });

  it("rejects malformed strings, arrays, objects and notes with 400 before any repository write", async () => {
    const { app, main } = await fixture(); const writes = vi.spyOn(SqliteFeedbackRepository.prototype, "createFeedback");
    const invalid = [null, [], [valid], {},
      ...["subjectType", "subjectId", "type"].flatMap(key => [0, 1, true, {}, ["value"], "", null].map(value => ({ ...valid, [key]: value }))),
      ...[false, 42, {}, ["note"]].map(note => ({ ...valid, note }))];
    for (const payload of invalid) {
      const response = await app.inject({ method: "POST", url: "/v1/feedback", headers: authorization, payload });
      expect(response.statusCode, JSON.stringify({ payload, response: response.body })).toBe(400);
    }
    expect((await app.inject({ method: "POST", url: "/v1/feedback", headers: authorization })).statusCode).toBe(400);
    expect(writes).not.toHaveBeenCalled(); expect(await stored(main)).toEqual([]);
  });

  it("accepts extension strings and nullable notes, returns a created row and a 200 items list", async () => {
    const { app, main } = await fixture();
    const response = await app.inject({ method: "POST", url: "/v1/feedback", headers: authorization, payload: { ...valid, note: null } });
    expect(response.statusCode).toBe(201);
    const row = response.json();
    expect(row).toEqual({ ...valid, id: expect.any(String), actorId: "server_actor", note: null, createdAt: expect.any(String) });
    expect(await stored(main)).toHaveLength(1);
    const listed = await app.inject({ method: "GET", url: "/v1/feedback", headers: authorization });
    expect(listed.statusCode).toBe(200); expect(listed.json()).toEqual({ items: [row] });
  });

  it("preserves whitespace-only extension strings and an empty note without trimming", async () => {
    const { app, main } = await fixture(); const whitespace = { subjectType: " ", subjectId: "\t", type: "\n", note: "" };
    const response = await app.inject({ method: "POST", url: "/v1/feedback", headers: authorization, payload: whitespace });
    expect(response.statusCode).toBe(201); expect(response.json()).toMatchObject(whitespace);
    expect(await stored(main)).toMatchObject([{ subject_type: " ", subject_id: "\t", type: "\n", note: "" }]);
  });

  it("preserves all-list behavior for missing, empty or single filters and applies a paired filter", async () => {
    const { app, repo } = await fixture();
    for (const [id, subjectType, subjectId] of [["one", "plugin", "a"], ["two", "plugin", "b"], ["three", "turn", "a"]]) {
      await repo.createFeedback(ctx, { id: id!, actorId: "stored_actor", subjectType: subjectType!, subjectId: subjectId!, type: "quality" });
    }
    for (const query of ["", "?subjectType=", "?subjectId=", "?subjectType=&subjectId=", "?subjectType=plugin", "?subjectId=a", "?subjectType=plugin&subjectId=", "?subjectType=&subjectId=a"]) {
      const response = await app.inject({ method: "GET", url: `/v1/feedback${query}`, headers: authorization });
      expect(response.statusCode).toBe(200); expect(response.json().items.map(row => row.id).sort()).toEqual(["one", "three", "two"]);
    }
    const filtered = await app.inject({ method: "GET", url: "/v1/feedback?subjectType=plugin&subjectId=a", headers: authorization });
    expect(filtered.statusCode).toBe(200); expect(filtered.json().items.map(row => row.id)).toEqual(["one"]);
  });

  it("rejects repeated filter parameters with 400 before querying the repository", async () => {
    const { app } = await fixture(); const reads = vi.spyOn(SqliteFeedbackRepository.prototype, "listFeedback");
    for (const query of ["subjectType=a&subjectType=b", "subjectId=a&subjectId=b", "subjectType=&subjectType=a&subjectId=b"]) {
      const response = await app.inject({ method: "GET", url: `/v1/feedback?${query}`, headers: authorization });
      expect(response.statusCode, response.body).toBe(400);
    }
    expect(reads).not.toHaveBeenCalled();
  });

  it("keeps repository failure details out of both 500 responses", async () => {
    const { app } = await fixture(); const secret = "private-sqlite-path/secret-token";
    vi.spyOn(SqliteFeedbackRepository.prototype, "createFeedback").mockRejectedValue(new Error(secret));
    vi.spyOn(SqliteFeedbackRepository.prototype, "listFeedback").mockRejectedValue(new Error(secret));
    const responses = await Promise.all([
      app.inject({ method: "POST", url: "/v1/feedback", headers: authorization, payload: valid }),
      app.inject({ method: "GET", url: "/v1/feedback", headers: authorization }),
    ]);
    for (const response of responses) {
      expect(response.statusCode).toBe(500); expect(response.body).not.toContain(secret);
    }
  });

  it("rejects malformed create and list responses with a sanitized 500", async () => {
    const { app } = await fixture();
    vi.spyOn(SqliteFeedbackRepository.prototype, "createFeedback").mockResolvedValue({ id: "sensitive-invalid-row" } as never);
    vi.spyOn(SqliteFeedbackRepository.prototype, "listFeedback").mockResolvedValue([{ id: "sensitive-invalid-row" }] as never);
    const responses = await Promise.all([
      app.inject({ method: "POST", url: "/v1/feedback", headers: authorization, payload: valid }),
      app.inject({ method: "GET", url: "/v1/feedback", headers: authorization }),
    ]);
    for (const response of responses) {
      expect(response.statusCode).toBe(500); expect(response.body).not.toContain("sensitive-invalid-row");
    }
  });

  it("describes required create/list response fields and omits actorId from the public request schema", async () => {
    const { app } = await fixture();
    const response = await app.inject({ method: "GET", url: "/openapi.json", headers: authorization });
    expect(response.statusCode).toBe(200); const spec = response.json();
    const deref = (schema: any): any => schema.$ref ? spec.components.schemas[schema.$ref.split("/").at(-1)] : schema;
    const endpoint = spec.paths["/v1/feedback"]; expect(endpoint).toBeDefined();
    const request = deref(endpoint.post.requestBody.content["application/json"].schema);
    expect(request.required.sort()).toEqual(["subjectId", "subjectType", "type"]);
    expect(request.properties).not.toHaveProperty("actorId");
    const created = deref(endpoint.post.responses["201"].content["application/json"].schema);
    expect(created.required.sort()).toEqual(["actorId", "createdAt", "id", "note", "subjectId", "subjectType", "type"]);
    const listed = deref(endpoint.get.responses["200"].content["application/json"].schema);
    expect(listed.required).toEqual(["items"]); expect(listed.properties.items.type).toBe("array");
    expect(deref(listed.properties.items.items).required.sort()).toEqual(created.required.sort());
  });
});
