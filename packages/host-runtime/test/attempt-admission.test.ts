import { loadExecutionConfig } from "@aervox/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryDatabase, SqliteConversationRepository } from "@aervox/repositories";
import { executeConversationTurn } from "../src/modules/companion/conversation/execution.js";

const local = { workspaceId: "local", subjectUserId: "local" };
const input = { turnId: "turn", attemptId: "attempt", sessionId: "session", userMessage: "hello" };
describe("Attempt admission cancellation before driver handoff", () => {
  let repo: SqliteConversationRepository;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    const database = await createInMemoryDatabase(); cleanup = database.cleanup;
    repo = new SqliteConversationRepository(database.db);
    await repo.getOrCreateSession(local, input.sessionId, "Admission");
    await repo.createTurnWithOutbox(local, { id: input.turnId, sessionId: input.sessionId, idempotencyKey: "admission" }, { id: "message", content: input.userMessage });
    await repo.createTurnAttempt(local, input.turnId, { id: input.attemptId });
  });
  afterEach(async () => { vi.restoreAllMocks(); await cleanup(); });
  it.each(["caller", "persisted", "shutdown", "deletion"] as const)("stops uncooperative preparation on %s and commits one atomic terminal", async cause => {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const controller = new AbortController(); let blocked = false;
    const update = vi.spyOn(repo, "updateTurnStatus");
    const execution = executeConversationTurn(repo, local, {
      ...input, ...(cause === "caller" ? { signal: controller.signal } : {}),
    }, {
      executionConfig: loadExecutionConfig(),
      signal: cause === "shutdown" ? controller.signal : undefined,
      privacyRepo: cause === "deletion" ? { hasPendingDeletionRequest: async () => blocked } as never : undefined,
      prepareExecution: async () => { entered(); await new Promise<void>(() => {}); },
    });
    await started;
    if (cause === "persisted") await repo.requestCancelTurnAttempt(local, input);
    else if (cause === "deletion") blocked = true;
    else controller.abort(new Error(cause === "shutdown" ? "host_shutdown" : "caller_cancelled"));
    await execution;
    const status = cause === "deletion" ? "Interrupted" : "Cancelled";
    expect((await repo.getTurn(local, input.turnId))?.status).toBe(status);
    expect((await repo.listTurnAttempts(local, input.turnId))[0]?.status).toBe(status);
    expect((await repo.getStreamEvents(local, input.turnId)).filter(event => event.eventType === "done")).toHaveLength(1);
    expect(update).not.toHaveBeenCalled();
  });
});
