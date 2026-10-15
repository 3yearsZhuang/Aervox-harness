import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createInMemoryDatabase, SqliteConversationRepository } from "@aervox/repositories";
import { registerBranchRoutes } from "../src/modules/companion/branch/routes.js";

const ctx = { workspaceId: "local", subjectUserId: "local" };

describe("HTTP branch policy inheritance", () => {
  let app: FastifyInstance;
  let repo: SqliteConversationRepository;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    const database = await createInMemoryDatabase();
    cleanup = database.cleanup;
    repo = new SqliteConversationRepository(database.db);
    app = Fastify();
    registerBranchRoutes(app, repo);
  });
  afterEach(async () => { await app.close(); await cleanup(); });

  it("creates a new child with its Bot parent's durable policy, ignoring client policy metadata", async () => {
    await repo.createSession(ctx, "QQ group", { id: "group", executionPolicy: "bot-group-member-v1" });
    const response = await app.inject({
      method: "POST", url: "/v1/sessions/group/branches",
      payload: { childSessionId: "child", title: "Follow-up", executionPolicy: "local-v1" },
    });
    expect(response.statusCode).toBe(201);
    expect(await repo.getSession(ctx, "child")).toMatchObject({ title: "Follow-up", executionPolicy: "bot-group-member-v1" });
    const turn = await repo.acceptTurn(ctx, { turnId: "child_turn", sessionId: "child", idempotencyKey: "child_turn", attemptId: "attempt", message: { id: "message", content: "hello" }, consumeInbox: true });
    expect(turn.turn).toMatchObject({ executionPolicy: "bot-group-member-v1", dispatchTarget: "api" });
  });

  it("rejects linking to an existing child with a different policy without changing either boundary", async () => {
    await repo.createSession(ctx, "QQ group", { id: "group", executionPolicy: "bot-group-member-v1" });
    await repo.createSession(ctx, "Owner", { id: "owner", executionPolicy: "bot-owner-v1" });
    const response = await app.inject({ method: "POST", url: "/v1/sessions/group/branches", payload: { childSessionId: "owner" } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "conversation_execution_policy_mismatch" });
    expect((await repo.getSession(ctx, "owner"))?.executionPolicy).toBe("bot-owner-v1");
    expect(await repo.listBranchesByParent(ctx, "group")).toEqual([]);
  });

  it("does not create an orphan child when the parent is missing", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/sessions/missing/branches", payload: { childSessionId: "child" } });
    expect(response.statusCode).toBe(404);
    expect(await repo.getSession(ctx, "child")).toBeNull();
  });
});
