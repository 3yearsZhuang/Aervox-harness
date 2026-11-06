import { expect, it } from "vitest";
import { createInMemoryDatabase, SqliteConversationRepository, SqliteMemoryRepository, indexMemoryFts } from "@aervox/repositories";
import { createSqliteMemoryRecall } from "@aervox/host-runtime-test/modules/companion/memory/recall";

it.each(["attachment", "invalid-json"] as const)("rechecks %s receipts after asynchronous vector scoring before exposing memory content to the model", async receipt => {
  const database = await createInMemoryDatabase();
  const local = { workspaceId: "local", subjectUserId: "local" };
  try {
    const conversations = new SqliteConversationRepository(database.db);
    const memories = new SqliteMemoryRepository(database.db, database.client);
    await conversations.getOrCreateSession(local, "session");
    for (const id of ["attachment", "text"]) {
      await conversations.acceptTurn(local, { turnId: id, sessionId: "session", idempotencyKey: id, attemptId: `${id}-attempt`,
        message: { id: `${id}-input`, content: "question" }, consumeInbox: false });
      await memories.createRecord(local, { id: `${id}-memory`, layer: "long_term", type: "user_fact", content: `${id} evidence`, sourceTurnId: id, verificationStatus: "verified" });
      await indexMemoryFts(database.client, local, { id: `${id}-memory`, content: `${id} evidence` });
    }
    const recall = createSqliteMemoryRecall({ db: database.db, client: database.client,
      embeddingProvider: { modelId: "fixture", embed: async () => [1, 0] }, vectorPort: {
        upsert: async () => {}, delete: async () => {}, clearAll: async () => {},
        search: async () => {
          await database.client.execute(receipt === "attachment"
            ? "UPDATE outbox_events SET payload=json_set(payload,'$.intent.message.attachments',json('[{\"attachmentId\":\"historical-clean\"}]')) WHERE id='outbox_attachment'"
            : "UPDATE outbox_events SET payload='{' WHERE id='outbox_attachment'");
          return [{ id: "attachment-memory", score: 1 }, { id: "text-memory", score: 0.95 }];
        },
      },
    });
    expect((await recall.recall(local, "evidence")).map(hit => ({ id: hit.id, content: hit.content }))).toEqual([{ id: "text-memory", content: "text evidence" }]);
    expect((await memories.getRecord(local, "attachment-memory"))?.content).toBe("attachment evidence");
  } finally { await database.cleanup(); }
});
