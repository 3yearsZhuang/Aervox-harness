import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDatabase, SqliteConversationRepository } from "@aervox/repositories";
import { contextManifests, modelRuns, sessions, toolApprovals, toolExecutions, turnAttempts, turns, turnStreamEvents } from "@aervox/schema";
import { turnDiagnosticsSchema } from "@aervox/contracts";
import { buildApp } from "./app-fixture.js";

describe("read-only Turn diagnostics", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let built: Awaited<ReturnType<typeof buildApp>>;
  const headers = { authorization: "Bearer diagnostics-test" };
  const now = new Date().toISOString();
  const url = "/v1/turns/turn_diag/diagnostics";
  beforeEach(async () => {
    database = await createInMemoryDatabase();
    built = await buildApp({ db: database.db, client: database.client, auth: { mode: "token", token: "diagnostics-test" } });
    await built.app.ready();
    const db = database.db;
    await db.insert(sessions).values({ id: "ses_diag", title: "SECRET title" });
    await db.insert(turns).values({ id: "turn_diag", sessionId: "ses_diag", idempotencyKey: "diag", status: "Completed" });
    await db.insert(turnAttempts).values([
      { id: "at_old", turnId: "turn_diag", attempt: 1, status: "Interrupted", startedAt: now, finishedAt: now },
      { id: "at_new", turnId: "turn_diag", attempt: 2, status: "Completed", startedAt: now, finishedAt: now },
    ]);
    await db.insert(modelRuns).values([
      { id: "mr_old", attemptId: "at_old", stepId: 1, purpose: "SECRET purpose", provider: "rule", modelId: "rule", status: "failed" },
      { id: "mr_failed", attemptId: "at_new", stepId: 1, purpose: "SECRET purpose", provider: "rule", modelId: "rule", status: "failed", latencyMs: 3 },
      { id: "mr_completed", attemptId: "at_new", stepId: 1, purpose: "SECRET purpose", provider: "rule", modelId: "rule", status: "completed", latencyMs: 5, contextManifestId: "cm_actual", tokenUsage: { SECRET: "usage" } },
    ]);
    await db.insert(contextManifests).values({ id: "cm_actual", modelRunId: "mr_completed", purpose: "SECRET purpose", sourceArtifactId: "SECRET source", sourceRevisionId: "1", snapshotJson: { messages: [{ role: "user", content: "SECRET prompt" }] } });
    await db.insert(toolExecutions).values({ id: "te_old", turnId: "turn_diag", attemptId: "at_old", invocationId: "call_old", name: "save", argumentsJson: { content: "SECRET arguments" }, outputJson: { SECRET: "output" }, error: "SECRET error", status: "pending_approval", startedAt: now, finishedAt: now });
    await db.insert(toolApprovals).values({ id: "ta_old", turnId: "turn_diag", attemptId: "at_old", toolName: "save", argumentsHash: "SECRET hash", requester: "SECRET requester", state: "granted", decidedBy: "SECRET actor", decidedAt: now });
    await db.insert(turnStreamEvents).values({ id: "ev_old", turnId: "turn_diag", attemptId: "at_old", sequence: 1, eventType: "done", data: { reason: "pending_approval", text: "SECRET body" }, occurredAt: now });
  });
  afterEach(async () => { await built.app.close(); await database.cleanup(); });

  it("defaults to the latest Attempt, preserves retry IDs and actual context references without raw content", async () => {
    const res = await built.app.inject({ method: "GET", url, headers });
    expect(res.statusCode).toBe(200); expect(res.headers["cache-control"]).toBe("no-store");
    const value = turnDiagnosticsSchema.parse(res.json());
    expect(value.selectedAttemptId).toBe("at_new");
    expect(value.modelRuns.map(run => run.id).sort()).toEqual(["mr_completed", "mr_failed"]);
    expect(value.modelRuns.find(run => run.id === "mr_completed")?.contextManifestId).toBe("cm_actual");
    expect(value.tools).toEqual([]); expect(value.approvals).toEqual([]); expect(value.terminationReason).toBeNull();
    expect(res.body).not.toContain("SECRET");
    expect((await database.db.select().from(modelRuns))).toHaveLength(3);
    expect((await database.db.select().from(contextManifests))[0].snapshotJson).toHaveProperty("messages");
  });
  it("selects an older Attempt explicitly and keeps approvals and pending tool outcomes together", async () => {
    const res = await built.app.inject({ method: "GET", url: url + "?attemptId=at_old", headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ selectedAttemptId: "at_old", terminationReason: "pending_approval",
      modelRuns: [{ id: "mr_old", status: "failed" }], tools: [{ invocationId: "call_old", status: "pending_approval" }], approvals: [{ id: "ta_old", state: "granted" }] });
    expect(res.body).not.toContain("SECRET");
  });
  it("requires authentication and validates the Attempt against its Turn", async () => {
    await database.db.insert(turns).values({ id: "turn_foreign", sessionId: "ses_diag", idempotencyKey: "foreign" });
    await database.db.insert(turnAttempts).values({ id: "foreign", turnId: "turn_foreign", status: "Running", startedAt: now });
    expect((await built.app.inject({ method: "GET", url })).statusCode).toBe(401);
    expect((await built.app.inject({ method: "GET", url: url + "?attemptId=foreign", headers })).statusCode).toBe(404);
    expect((await built.app.inject({ method: "GET", url: url + "?attemptId=", headers })).statusCode).toBe(400);
    expect((await built.app.inject({ method: "GET", url: url + "?includeRaw=true", headers })).statusCode).toBe(400);
    const spec = (await built.app.inject({ method: "GET", url: "/openapi.json", headers })).json();
    expect(spec.paths["/v1/turns/{turnId}/diagnostics"].get.operationId).toBe("getTurnDiagnostics");
  });
  it("returns an explicit waiting state before any Attempt or telemetry exists", async () => {
    await database.db.insert(turns).values({ id: "turn_waiting", sessionId: "ses_diag", idempotencyKey: "waiting", status: "Created" });
    const res = await built.app.inject({ method: "GET", url: "/v1/turns/turn_waiting/diagnostics", headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "Created", selectedAttemptId: null, attempts: [], modelRuns: [], tools: [], approvals: [], terminationReason: null });
  });
  it("survives host reconstruction and refuses deleted Turns even when model telemetry remains", async () => {
    await built.app.close();
    built = await buildApp({ db: database.db, client: database.client, auth: { mode: "token", token: "diagnostics-test" } });
    await built.app.ready();
    expect((await built.app.inject({ method: "GET", url, headers })).statusCode).toBe(200);
    const repo = new SqliteConversationRepository(database.db);
    await repo.deleteSession({ workspaceId: "local", subjectUserId: "local" }, "ses_diag");
    expect((await database.db.select().from(modelRuns)).length).toBeGreaterThan(0);
    expect((await built.app.inject({ method: "GET", url, headers })).statusCode).toBe(404);
  });
  it("reports bounded truncation and does not claim missing telemetry as successful execution", async () => {
    await database.db.insert(modelRuns).values(Array.from({ length: 201 }, (_, i) => ({ id: `bounded_${i}`, attemptId: "at_new", stepId: i + 2, provider: "rule", modelId: "rule", purpose: "loop", status: "failed" })));
    const res = await built.app.inject({ method: "GET", url, headers });
    expect(res.statusCode).toBe(200); expect(res.json().modelRuns).toHaveLength(200);
    expect(res.json().truncated.modelRuns).toBe(true);
    expect(res.json().unavailable).toContain("context_pruning");
  });
});
