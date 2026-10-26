import { loadExecutionConfig } from "@aervox/config";
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
    await repo.acceptTurn(local, { turnId: "turn", sessionId: "session", attemptId: "attempt", idempotencyKey: "same", message: { id: "message", content: "accepted" }, metadata: { mode: "focus" }, toolApprovalMode: "ask", consumeInbox: false, execution: "worker" });
  }
  it("restores immutable accepted input and policy instead of trusting Worker/caller parameters", async () => {
    await accept();
    const execute = vi.fn(async (_ctx: unknown, _input: ConversationTurnInput) => {});
    const application = createConversationApplication(repo, { executionConfig: loadExecutionConfig() }, execute);
    const delegated = await application.queries.loadDelegatedTurn("turn");
    expect(delegated).toMatchObject({ userMessage: "accepted", metadata: { mode: "focus" }, toolApprovalMode: "ask", actorId: "trusted" });
    // A forged Outbox delivery top-level field cannot substitute the persisted intent.
    await database.client.execute("UPDATE outbox_events SET payload=json_set(payload,'$.metadata.mode','forged') WHERE id='outbox_turn'");
    await application.commands.execute({ ...local, actorId: "forged" }, input);
    expect(execute).toHaveBeenCalledWith(local, expect.objectContaining({ userMessage: "accepted", metadata: { mode: "focus" }, toolApprovalMode: "ask", actorId: "trusted" }));
  });
  it('deduplicates one attempt across application adapters while restoring its accepted parameters', async () => {
    await accept();
    let release!: () => void;
    const execute = vi.fn(async (_ctx: unknown, _input: ConversationTurnInput) => new Promise<void>(resolve => {release = resolve;}));
    const http = createConversationApplication(repo, { executionConfig: loadExecutionConfig() }, execute);
    const worker = http;
    const first = http.commands.execute(local, input);
    const repeated = worker.commands.execute({...local, actorId: 'forged'}, input);
    expect(first).toBe(repeated);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(execute).toHaveBeenCalledWith(local, expect.objectContaining({metadata: {mode: 'focus'}, toolApprovalMode: 'ask', actorId: 'trusted'}));
    release(); await Promise.all([first, repeated]);
  });
  it("rejects an API-owned receipt and mismatched event identity before Worker can claim", async () => {
    await repo.acceptTurn(local, { turnId: "api", sessionId: "session", attemptId: "api-attempt", idempotencyKey: "api", execution: "api", consumeInbox: false, message: { id: "api-message", content: "accepted" } });
    const application = createConversationApplication(repo, { executionConfig: loadExecutionConfig() });
    expect(await application.queries.loadDelegatedTurn("api", "outbox_api")).toBeNull();
    await accept();
    expect(await application.queries.loadDelegatedTurn("turn", "outbox_api")).toBeNull();
    expect(await application.queries.loadDelegatedTurn("turn", "outbox_turn")).not.toBeNull();
    expect((await repo.listTurnAttempts(local, "api"))[0]?.fencingToken).toBe(0);
  });
  it("keeps execution snapshots isolated from later environment and caller mutation", async () => {
    const executionConfig = { ...loadExecutionConfig(), turnExecution: "inline" as const, loopDispatch: "api" as const };
    const execute = vi.fn(async () => {});
    const application = createConversationApplication(repo, { executionConfig }, execute);
    const worker = createConversationApplication(repo, { executionConfig: { ...loadExecutionConfig(), loopDispatch: "worker", turnExecution: "background" } }, execute);
    vi.stubEnv("AERVOX_LOOP_DISPATCH", "worker");
    Object.assign(executionConfig, { loopDispatch: "worker", turnExecution: "background" });
    try {
      await application.commands.createTurn(local, { turnId: "inline", sessionId: "session", attemptId: "inline-attempt", idempotencyKey: "inline", message: { id: "inline-message", content: "run" } });
      await worker.commands.createTurn(local, { turnId: "worker", sessionId: "session", attemptId: "worker-attempt", idempotencyKey: "worker", message: { id: "worker-message", content: "run" } });
      expect(execute).toHaveBeenCalledOnce();
      expect(await application.queries.loadDelegatedTurn("inline")).toBeNull();
      expect(await worker.queries.loadDelegatedTurn("worker")).not.toBeNull();
    } finally { vi.unstubAllEnvs(); await application.close(); await worker.close(); }
  });
  it.each(["missing-receipt", "changed-intent", "legacy-hash"])("refuses execution when acceptance evidence is %s", async failure => {
    await accept();
    if (failure === "missing-receipt") await database.client.execute("DELETE FROM outbox_events WHERE id='outbox_turn'");
    if (failure === "changed-intent") await database.client.execute("UPDATE outbox_events SET payload=json_set(payload,'$.intent.toolApprovalMode','full_access') WHERE id='outbox_turn'");
    if (failure === "legacy-hash") await database.client.execute("UPDATE turns SET request_hash=NULL WHERE id='turn'");
    const execute = vi.fn(async () => {});
    const application = createConversationApplication(repo, { executionConfig: loadExecutionConfig() }, execute);
    await expect(application.commands.execute(local, input)).rejects.toMatchObject({ reason: "intent_unavailable" });
    if (failure === "changed-intent") await expect(application.queries.loadDelegatedTurn("turn")).rejects.toMatchObject({ reason: "intent_unavailable" });
    else expect(await application.queries.loadDelegatedTurn("turn")).toBeNull();
    expect(execute).not.toHaveBeenCalled(); expect((await repo.listTurnAttempts(local, "turn"))[0]?.fencingToken).toBe(0);
    expect(await repo.getStreamEvents(local, "turn")).toEqual([]);
  });
  it.each(["soft-deleted", "redacted"])("refuses Worker delegation and execution after accepted input is %s", async failure => {
    await accept();
    if (failure === "soft-deleted") {
      expect(await repo.getMessage(local, "message")).toMatchObject({ sessionId: "session", role: "user", currentVersionId: "message" });
      await repo.softDeleteMessage(local, "message");
    } else await repo.redactTurnMessages(local, "turn");
    const execute = vi.fn(async () => {});
    const application = createConversationApplication(repo, { executionConfig: loadExecutionConfig() }, execute);
    await expect(application.queries.loadDelegatedTurn("turn")).rejects.toMatchObject({ reason: "intent_unavailable" });
    await expect(application.commands.execute(local, input)).rejects.toMatchObject({ reason: "intent_unavailable" });
    expect(execute).not.toHaveBeenCalled();
    expect((await repo.listTurnAttempts(local, "turn"))[0]?.fencingToken).toBe(0);
    expect(await repo.getStreamEvents(local, "turn")).toEqual([]);
  });
});
