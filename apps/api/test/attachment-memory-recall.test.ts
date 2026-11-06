import { expect, it } from "vitest";
import { createInMemoryDatabase, SqliteConversationRepository, SqliteMemoryRepository, SqlitePrivacyRepository, indexMemoryFts } from "@aervox/repositories";
import { createSqliteMemoryRecall } from "@aervox/host-runtime-test/modules/companion/memory/recall";
import { corruptReceipt, receiptCorruptions } from "../../../packages/repositories/test/helpers/receipt-corruption.js";

it.each(["attachment", "invalid-json", "empty-intent", "array-message", "hash-drift", "consent-gap"] as const)("rechecks %s receipts after asynchronous scoring and consent before exposing memory content to the model", async receipt => {
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
    let consentReads = 0;
    const recall = createSqliteMemoryRecall({ db: database.db, client: database.client,
      consentCheck: receipt === "consent-gap" ? async () => {
        if (++consentReads === 2) await corruptReceipt(database.client, "attachment", receiptCorruptions.find(item => "historicalAttachmentRemoved" in item)!);
        return true;
      } : undefined,
      embeddingProvider: { modelId: "fixture", embed: async () => [1, 0] }, vectorPort: {
        upsert: async () => {}, delete: async () => {}, clearAll: async () => {},
        search: async () => {
          if (receipt === "hash-drift") await corruptReceipt(database.client, "attachment", receiptCorruptions.find(item => "historicalAttachmentRemoved" in item)!);
          else if (receipt !== "consent-gap") {
          const sql = receipt === "attachment" ? "UPDATE outbox_events SET payload=json_set(payload,'$.intent.message.attachments',json('[{\"attachmentId\":\"historical-clean\"}]')) WHERE id='outbox_attachment'"
            : receipt === "empty-intent" ? "UPDATE outbox_events SET payload=json_set(payload,'$.intent',json('{}')) WHERE id='outbox_attachment'"
            : receipt === "array-message" ? "UPDATE outbox_events SET payload=json_set(payload,'$.intent.message',json('[]')) WHERE id='outbox_attachment'"
            : "UPDATE outbox_events SET payload='{' WHERE id='outbox_attachment'";
          await database.client.execute(sql);
          }
          return [{ id: "attachment-memory", score: 1 }, { id: "text-memory", score: 0.95 }];
        },
      },
    });
    expect((await recall.recall(local, "evidence")).map(hit => ({ id: hit.id, content: hit.content }))).toEqual([{ id: "text-memory", content: "text evidence" }]);
    expect((await memories.getRecord(local, "attachment-memory"))?.content).toBe("attachment evidence");
  } finally { await database.cleanup(); }
});

it("reads the real local consent owner with memory bodies when a check returns its pre-revocation result", async () => {
  const database = await createInMemoryDatabase();
  const local = { workspaceId: "local", subjectUserId: "local" };
  try {
    const memories = new SqliteMemoryRepository(database.db, database.client);
    const privacy = new SqlitePrivacyRepository(database.db);
    await memories.createRecord(local, { id: "eligible", layer: "long_term", type: "user_fact", content: "evidence", verificationStatus: "verified" });
    await indexMemoryFts(database.client, local, { id: "eligible", content: "evidence" });
    await privacy.grantConsent(local, { id: "grant", actorId: "local", purpose: "memory_long", scope: "auto_recall", policyVersion: "privacy-v1" });
    let checks = 0;
    let revoke = false;
    const recall = createSqliteMemoryRecall({ db: database.db, client: database.client, embeddingProvider: null,
      requiredConsent: { purpose: "memory_long", scope: "auto_recall" },
      consentCheck: async (purpose, scope) => {
        const active = await privacy.hasActiveConsent(local, purpose, scope);
        if (++checks === 2 && revoke) await privacy.revokeConsent(local, "grant");
        return active;
      },
    });
    expect((await recall.recall(local, "evidence")).map(row => row.id)).toEqual(["eligible"]);
    checks = 0; revoke = true;
    expect(await recall.recall(local, "evidence")).toEqual([]);
    expect((await memories.getRecord(local, "eligible"))?.content).toBe("evidence");
  } finally { await database.cleanup(); }
});
