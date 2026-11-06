import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Client, InStatement, Transaction } from "@libsql/client";
import { createInMemoryDatabase, SqliteConversationRepository, SqlitePrivacyRepository } from "../src/index.js";
import { createInjectedDatabase } from "../src/database.js";

const ctx = { workspaceId: "local", subjectUserId: "local" };
const privateBody = "PRIVATE_TERMINAL_BODY\0tail";
const payload = { code: privateBody, message: privateBody, reason: privateBody,
  retryable: true, status: privateBody, isComplete: true, nested: { output: privateBody } };
const paths = ["append-running", "append-terminal", "finalize"] as const;
type Path = typeof paths[number];

describe("terminal events after conversation source deletion", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let repo: SqliteConversationRepository;
  async function accepted(turnId = "turn") {
    await repo.acceptTurn(ctx, { turnId, sessionId: "session", idempotencyKey: turnId,
      attemptId: `attempt_${turnId}`, message: { id: `user_${turnId}`, content: "source" }, consumeInbox: false });
    await repo.appendStreamEvent(ctx, { id: `message_${turnId}`, turnId, attemptId: `attempt_${turnId}`,
      expectedFencingToken: 0, sequence: 1, eventType: "message", data: { messageId: `assistant_${turnId}`, role: "assistant" } });
    await repo.recordSafeSegmentAtomically(ctx, { turnId, attemptId: `attempt_${turnId}`, expectedFencingToken: 0,
      sequence: 2, text: "existing prefix", eventData: { messageId: `assistant_${turnId}`, text: "existing prefix" }, safetyDecision: "approved" });
  }
  beforeEach(async () => {
    database = await createInMemoryDatabase();
    repo = new SqliteConversationRepository(database.db);
    await repo.getOrCreateSession(ctx, "session");
    await accepted();
  });
  afterEach(async () => { await database.cleanup(); });

  async function terminal(path: Path, eventType: "done" | "error", turnId = "turn") {
    const status = eventType === "error" ? "Failed" : "Cancelled";
    if (path === "append-terminal") await repo.finalizeTurnAttempt(ctx, {
      turnId, attemptId: `attempt_${turnId}`, expectedFencingToken: 0, status,
    });
    if (path === "finalize") return repo.finalizeAttemptWithEventAtomically(ctx, {
      turnId, attemptId: `attempt_${turnId}`, expectedFencingToken: 0, status,
      sequence: 3, eventType, eventData: payload,
    });
    return repo.appendStreamEvent(ctx, { id: `terminal_${turnId}`, turnId, attemptId: `attempt_${turnId}`,
      expectedFencingToken: 0, sequence: 3, eventType, data: payload });
  }
  async function lastEvent(turnId = "turn") { return (await repo.getStreamEvents(ctx, turnId)).at(-1)!; }

  it.each(paths.flatMap(path => (["done", "error"] as const).flatMap(eventType =>
    (["user", "assistant", "physical-input"] as const).map(target => ({ path, eventType, target }))))
  )("$path $eventType keeps control metadata without a new body after $target deletion", async ({ path, eventType, target }) => {
    if (target === "physical-input") await repo.deleteMessage(ctx, "user_turn");
    else await repo.softDeleteMessage(ctx, `${target}_turn`);
    expect(await terminal(path, eventType)).toBeTruthy();
    const event = await lastEvent();
    expect(event).toMatchObject({ eventType, sequence: 3, attemptId: "attempt_turn" });
    expect(JSON.stringify(event.data)).not.toContain("PRIVATE_TERMINAL_BODY");
    expect(event.data).toMatchObject(eventType === "error"
      ? { code: "PERMISSION_REVOKED", retryable: false, lastSequence: 3 }
      : { reason: "source_unavailable", isComplete: false, lastSequence: 3 });
    expect(await repo.isTurnStreamDisclosable(ctx, "turn")).toBe(false);
    if (path !== "append-running") {
      expect((await repo.listTurnAttempts(ctx, "turn"))[0]?.status).toBe(eventType === "error" ? "Failed" : "Cancelled");
      expect((await repo.getTurn(ctx, "turn"))?.lastSequence).toBe(3);
    }
  });

  it.each(["done", "error"] as const)("an unrelated Turn retains its %s payload", async eventType => {
    await accepted("other");
    await repo.softDeleteMessage(ctx, "user_turn");
    expect(await terminal("finalize", eventType, "other")).toBe(true);
    expect((await lastEvent("other")).data).toEqual(payload);
    expect(await repo.isTurnStreamDisclosable(ctx, "other")).toBe(true);
  });

  it.each(["done", "error"] as const)("a pending deletion gate minimizes %s without preventing finalization", async eventType => {
    const privacy = new SqlitePrivacyRepository(database.db);
    await privacy.createDeletionRequest(ctx, { id: "pending", idempotencyKey: "pending", scope: "unknown", ownerModule: "unknown" });
    expect(await terminal("finalize", eventType)).toBe(true);
    expect(JSON.stringify((await lastEvent()).data)).not.toContain("PRIVATE_TERMINAL_BODY");
    expect(await privacy.hasPendingDeletionRequest(ctx)).toBe(true);
  });

  it("an event insert failure rolls back terminal status and watermarks", async () => {
    await repo.softDeleteMessage(ctx, "user_turn");
    await database.client.execute("CREATE TRIGGER reject_terminal BEFORE INSERT ON turn_stream_events WHEN NEW.event_type='error' BEGIN SELECT RAISE(ABORT, 'terminal write failed'); END");
    await expect(terminal("finalize", "error")).rejects.toThrow();
    expect((await repo.listTurnAttempts(ctx, "turn"))[0]?.status).toBe("Running");
    expect((await repo.getTurn(ctx, "turn"))?.lastSequence).toBe(0);
    expect((await lastEvent()).sequence).toBe(2);
  });

  it("an admission query failure rolls back instead of becoming a generic terminal success", async () => {
    await repo.softDeleteMessage(ctx, "user_turn");
    function failingSourceRead<T extends Client | Transaction>(target: T): T {
      return new Proxy(target, { get(owner, property) {
        if (property === "execute") return async (input: InStatement) => {
          const sql = typeof input === "string" ? input : input.sql;
          if (sql.startsWith("select") && sql.includes('"visibility_turn"')) throw new Error("source_read_unavailable");
          return owner.execute(input);
        };
        if (property === "transaction" && "transaction" in owner) return async (...input: Parameters<Client["transaction"]>) => failingSourceRead(await owner.transaction(...input));
        const value: unknown = Reflect.get(owner, property, owner);
        return typeof value === "function" ? value.bind(owner) : value;
      } });
    }
    const failing = new SqliteConversationRepository(createInjectedDatabase(failingSourceRead(database.client)));
    await expect(failing.finalizeAttemptWithEventAtomically(ctx, { turnId: "turn", attemptId: "attempt_turn",
      expectedFencingToken: 0, status: "Failed", sequence: 3, eventType: "error", eventData: payload })).rejects.toThrow();
    expect((await repo.listTurnAttempts(ctx, "turn"))[0]?.status).toBe("Running");
    expect((await repo.getTurn(ctx, "turn"))?.lastSequence).toBe(0);
    expect((await lastEvent()).sequence).toBe(2);
  });

  it("the extraction-redacted fixed-response path keeps its terminal payload", async () => {
    await repo.redactTurnMessages(ctx, "turn");
    expect(await terminal("finalize", "done")).toBe(true);
    expect((await lastEvent()).data).toEqual(payload);
    expect(await repo.isTurnStreamDisclosable(ctx, "turn")).toBe(true);
  });

  it("an obsolete fencing token cannot append even a minimized terminal event", async () => {
    const claim = await repo.claimTurnAttempt(ctx, { turnId: "turn", attemptId: "attempt_turn",
      expectedFencingToken: 0, leaseId: "current", ttlMs: 60_000 });
    expect(claim.ok).toBe(true);
    await repo.softDeleteMessage(ctx, "user_turn");
    await expect(terminal("append-running", "error")).rejects.toThrow();
    expect(await terminal("finalize", "error")).toBe(false);
    expect((await lastEvent()).sequence).toBe(2);
  });
});
