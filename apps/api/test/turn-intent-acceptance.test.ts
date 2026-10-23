import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { loadExecutionConfig } from "@aervox/config";
import { createInMemoryDatabase, SqliteConversationRepository } from "@aervox/repositories";
import { registerConversationRoutes } from "./conversation-fixture.js";
import { setRequestLocalContext } from "@aervox/host-runtime-test/shared/local-context";
import { replayTurnResponseSchema, turnAcceptanceConflictSchema } from "@aervox/contracts";

const local = { workspaceId: "local", subjectUserId: "local" };
const body = { message: { content: "original", contentType: "text" }, clientVersion: "one" };
describe("HTTP Turn intent acceptance", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let repo: SqliteConversationRepository;
  let app: ReturnType<typeof Fastify>;
  let actor = "trusted";
  const execute = vi.fn(async (_input: unknown) => {});
  beforeEach(async () => {
    database = await createInMemoryDatabase(); repo = new SqliteConversationRepository(database.db);
    app = Fastify(); actor = "trusted"; execute.mockClear();
    app.addHook("onRequest", async request => { setRequestLocalContext(request, actor); });
    registerConversationRoutes(app, repo, { executionConfig: { ...loadExecutionConfig(), turnExecution: "inline", loopDispatch: "api" } }, execute);
  });
  afterEach(async () => { await app.close(); await database.cleanup(); });
  const post = (payload: unknown = body, session = "session") => app.inject({ method: "POST", url: `/v1/sessions/${session}/turns`, headers: { "idempotency-key": "same" }, payload });

  it("reuses exact effective defaults and client-version changes without dispatching again", async () => {
    const first = await post(); expect(first.statusCode, first.body).toBe(201);
    const replay = await post({ ...body, clientVersion: "two", references: [], metadata: {}, toolApprovalMode: "ask" });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replayTurnResponseSchema.parse(replay.json())).toEqual(replay.json());
    expect(replay.json().turnId).toBe(first.json().turnId); expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ metadata: {}, toolApprovalMode: "ask", actorId: "trusted", userMessage: "original" });
  });
  it("replays the current terminal status without dispatching again", async () => {
    const first = await post();
    await database.client.execute({ sql: "UPDATE turns SET status='Completed' WHERE id=?", args: [first.json().turnId] });
    const replay = await post();
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replayTurnResponseSchema.parse(replay.json())).toMatchObject({ turnId: first.json().turnId, status: "Completed" });
    expect(execute).toHaveBeenCalledOnce();
  });
  it.each([
    { message: { content: "changed", contentType: "text" } },
    { message: { content: "original", contentType: "markdown" } },
    { message: { content: "original", contentType: "text", attachments: [{ attachmentId: "a" }] } },
    { references: [{ sourceId: "source", sourceVersion: "v1" }] }, { metadata: { mode: "focus" } }, { toolApprovalMode: "full_access" },
  ])("rejects changed same-key intent without extra work: %j", async patch => {
    const first = await post(); const conflict = await post({ ...body, ...patch });
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(turnAcceptanceConflictSchema.parse(conflict.json())).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", reason: "intent_mismatch", retryable: false });
    expect(execute).toHaveBeenCalledOnce(); expect(await repo.listTurnAttempts(local, first.json().turnId)).toHaveLength(1);
  });
  it("binds the server-authenticated actor", async () => {
    await post(); actor = "other";
    expect((await post()).json()).toMatchObject({ reason: "intent_mismatch" });
    expect(execute).toHaveBeenCalledOnce();
  });
  it("returns an explicit conflict for an existing legacy Turn without guessing the intent", async () => {
    await repo.getOrCreateSession(local, "session");
    await repo.createTurnWithOutbox(local, { id: "legacy", sessionId: "session", idempotencyKey: "same" }, { id: "old", content: "original" });
    const conflict = await post();
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(conflict.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", reason: "intent_unavailable" });
    expect(execute).not.toHaveBeenCalled(); expect((await repo.getTurn(local, "legacy"))?.requestHash).toBeNull();
  });
  it("keeps structured attachments distinct from a colliding rendered text", async () => {
    await post({ ...body, message: { ...body.message, attachments: [{ attachmentId: "a", name: "paper" }] } });
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ userMessage: "original\n\n[附件清单]\n- paper [id: a]" });
    const conflict = await post({ ...body, message: { ...body.message, content: "original\n\n[附件清单]\n- paper [id: a]" } });
    expect(conflict.statusCode, conflict.body).toBe(409);
  });
  it("maps cross-session concurrent reuse to one acceptance and one conflict", async () => {
    await repo.getOrCreateSession(local, "session"); await repo.getOrCreateSession(local, "other");
    const responses = await Promise.all([post(), post(body, "other")]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([201, 409]);
    expect(responses.find(response => response.statusCode === 409)?.json()).toMatchObject({ reason: "session_mismatch" });
    expect(execute).toHaveBeenCalledOnce();
  });
});
