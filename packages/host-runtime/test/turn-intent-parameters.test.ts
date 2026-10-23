import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryDatabase, SqliteConversationRepository } from "@aervox/repositories";
import { createConversationApplication } from "../src/modules/companion/conversation/application.js";
import type { ConversationTurnInput } from "../src/modules/companion/conversation/execution.js";

const local = { workspaceId: "local", subjectUserId: "local", actorId: "trusted" };
describe("accepted Turn parameters remain the execution authority", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let repo: SqliteConversationRepository;
  beforeEach(async () => {
    database = await createInMemoryDatabase(); repo = new SqliteConversationRepository(database.db);
    await repo.getOrCreateSession(local, "session");
  });
  afterEach(async () => database.cleanup());
  const input = { turnId: "turn", sessionId: "session", attemptId: "attempt", userMessage: "forged", metadata: { mode: "forged" }, toolApprovalMode: "full_access" as const, actorId: "forged" };
  async function accept() {
    await repo.acceptTurn(local, { turnId: "turn", sessionId: "session", attemptId: "attempt", idempotencyKey: "same", message: { id: "message", content: "accepted" }, metadata: { mode: "focus" }, toolApprovalMode: "ask", consumeInbox: false });
  }
  it("restores immutable accepted input and policy instead of trusting Worker/caller parameters", async () => {
    await accept();
    const execute = vi.fn(async (_ctx: unknown, _input: ConversationTurnInput) => {});
    const application = createConversationApplication(repo, {}, execute);
    const delegated = await application.queries.loadDelegatedTurn("turn");
    expect(delegated).toMatchObject({ userMessage: "accepted", metadata: { mode: "focus" }, toolApprovalMode: "ask", actorId: "trusted" });
    // A forged Outbox delivery top-level field cannot substitute the persisted intent.
    await database.client.execute("UPDATE outbox_events SET payload=json_set(payload,'$.metadata.mode','forged') WHERE id='outbox_turn'");
    await application.commands.execute({ ...local, actorId: "forged" }, input);
    expect(execute).toHaveBeenCalledWith(local, expect.objectContaining({ userMessage: "accepted", metadata: { mode: "focus" }, toolApprovalMode: "ask", actorId: "trusted" }));
  });
  it.each(["missing-receipt", "changed-intent", "legacy-hash"])("refuses execution when acceptance evidence is %s", async failure => {
    await accept();
    if (failure === "missing-receipt") await database.client.execute("DELETE FROM outbox_events WHERE id='outbox_turn'");
    if (failure === "changed-intent") await database.client.execute("UPDATE outbox_events SET payload=json_set(payload,'$.intent.toolApprovalMode','full_access') WHERE id='outbox_turn'");
    if (failure === "legacy-hash") await database.client.execute("UPDATE turns SET request_hash=NULL WHERE id='turn'");
    const execute = vi.fn(async () => {});
    const application = createConversationApplication(repo, {}, execute);
    await expect(application.commands.execute(local, input)).rejects.toMatchObject({ reason: "intent_unavailable" });
    await expect(application.queries.loadDelegatedTurn("turn")).rejects.toMatchObject({ reason: "intent_unavailable" });
    expect(execute).not.toHaveBeenCalled(); expect((await repo.listTurnAttempts(local, "turn"))[0]?.fencingToken).toBe(0);
    expect(await repo.getStreamEvents(local, "turn")).toEqual([]);
  });
});
