import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDatabase, SqliteConversationRepository } from "@aervox/repositories";
import { createSimAdapterDriver, defaultContextBuilder, executeTurn } from "@aervox/core";
import { SqliteExecutionStore } from "../src/sqlite-execution-store.js";
import { runAdapterTurn } from "../src/adapter-turn.js";
const ctx = { workspaceId: "local", subjectUserId: "local" };
const input = { turnId: "turn", sessionId: "session", attemptId: "attempt", userMessage: "question" };
for (const mode of ["native", "adapter"] as const) describe(`${mode} durable assistant message`, () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let repo: SqliteConversationRepository;
  beforeEach(async () => {
    database = await createInMemoryDatabase(); repo = new SqliteConversationRepository(database.db);
    await repo.getOrCreateSession(ctx, input.sessionId);
    await repo.acceptTurn(ctx, { ...input, idempotencyKey: "turn", message: { id: "user", content: input.userMessage }, consumeInbox: false });
  });
  afterEach(async () => { await database.cleanup(); });
  it("preserves the actual committed answer after replay events and segments are cleaned", async () => {
    const store = new SqliteExecutionStore(repo, ctx);
    const result = mode === "native"
      ? await executeTurn({ execution: store, contextBuilder: defaultContextBuilder,
          provider: { id: "test", async *stream() { yield { text: "answer", isFinal: true }; } } }, input)
      : await runAdapterTurn(store, createSimAdapterDriver({
          manifest: { adapterId: "dsh", version: "test", sha256: "test", license: "MIT", terminationPolicy: "every" },
          script: [{ type: "delta", text: "answer" }, { type: "batch", concludes: [true] }],
        }), input);
    expect(result.status.toLowerCase()).toBe("completed");
    const durableHighWater = (await repo.getTurn(ctx, input.turnId))!.lastSequence;
    expect(durableHighWater).toBeGreaterThan(0);
    await database.client.execute("DELETE FROM turn_stream_events");
    await database.client.execute("DELETE FROM safe_segments");
    expect(await store.nextSequence(input.turnId)).toBe(durableHighWater + 1);
    const identity = await repo.getMessage(ctx, "msg_turn_assistant");
    const current = (await repo.listMessageVersions(ctx, "msg_turn_assistant")).find(version => version.id === identity?.currentVersionId);
    expect(current).toMatchObject({ content: "answer", messageId: "msg_turn_assistant", role: "assistant" });
  });
});
