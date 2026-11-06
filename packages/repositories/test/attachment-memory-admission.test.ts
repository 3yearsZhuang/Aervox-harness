import { afterEach, beforeEach, expect, it } from "vitest";
import { createInMemoryDatabase, SqliteConversationRepository, SqliteMemoryRepository, SqliteMemoryEmbeddingRepository,
  SqliteMemoryCompactionRepository, collectDiaryMaterial, indexMemoryFts, searchMemoriesFts, rebuildSearchProjections } from "../src/index.js";
import { corruptReceipt, receiptCorruptions } from "./helpers/receipt-corruption.js";

const ctx = { workspaceId: "local", subjectUserId: "local" };
let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
let conversations: SqliteConversationRepository, memories: SqliteMemoryRepository, embeddings: SqliteMemoryEmbeddingRepository;
beforeEach(async () => {
  database = await createInMemoryDatabase();
  conversations = new SqliteConversationRepository(database.db);
  memories = new SqliteMemoryRepository(database.db, database.client);
  embeddings = new SqliteMemoryEmbeddingRepository(database.db);
  await conversations.getOrCreateSession(ctx, "session");
  for (const id of ["attachment-source", "text-source"]) {
    await conversations.acceptTurn(ctx, { turnId: id, sessionId: "session", idempotencyKey: id, attemptId: `${id}-attempt`,
      message: { id: `${id}-input`, content: `${id} question` }, consumeInbox: false,
      references: id === "text-source" ? [{ sourceId: "fixture", sourceVersion: "v1" }] : undefined });
    await conversations.finalizeAttemptWithEventAtomically(ctx, { turnId: id, attemptId: `${id}-attempt`, expectedFencingToken: 0,
      sequence: 1, status: "Completed", eventType: "done", eventData: { status: "Completed", isComplete: true }, safetyDecision: "approved" });
    await memories.createRecord(ctx, { id: `${id}-memory`, layer: "long_term", type: "user_fact", content: `${id} canary`, sourceTurnId: id });
    await indexMemoryFts(database.client, ctx, { id: `${id}-memory`, content: `${id} canary` });
    await embeddings.insertBatch(ctx, [{ id: `${id}-vector`, memoryId: `${id}-memory`, vector: [1, 0], modelId: "fixture" }]);
  }
});
afterEach(() => database.cleanup());

it.each(["attachment", "invalid-json", ...receiptCorruptions.map(item => item.name)])("refuses new personal derivatives and existing memory recall for %s receipts, keeping text sources usable", async receipt => {
  expect(await searchMemoriesFts(database.client, ctx, "canary")).toHaveLength(2);
  expect(await embeddings.retrieve(ctx, [1, 0])).toHaveLength(2);
  const corruption = receiptCorruptions.find(item => item.name === receipt);
  if (corruption) await corruptReceipt(database.client, "attachment-source", corruption);
  else await database.client.execute(receipt === "attachment"
    ? "UPDATE outbox_events SET payload=json_set(payload,'$.intent.message.attachments',json('[{\"attachmentId\":\"historical-clean\"}]')) WHERE id='outbox_attachment-source'"
    : "UPDATE outbox_events SET payload='{' WHERE id='outbox_attachment-source'");

  expect(await conversations.getTurnUserMessage(ctx, "attachment-source")).toBeNull();
  expect(await conversations.isTurnInputPresent(ctx, "attachment-source")).toBe(false);
  expect(await conversations.getTurnUserMessage(ctx, "text-source")).toBe("text-source question");
  expect(await conversations.isTurnInputPresent(ctx, "text-source")).toBe(true);

  await expect(memories.createRecord(ctx, { id: "late-memory", layer: "long_term", type: "user_fact", content: "late canary", sourceTurnId: "attachment-source" }))
    .rejects.toThrow("personal_derived_data_source_forbidden");
  expect(await memories.getRecord(ctx, "late-memory")).toBeNull();
  const compaction = new SqliteMemoryCompactionRepository(database.db);
  await expect(compaction.upsertMarker(ctx, { id: "late-marker", memoryId: "attachment-source-memory", snapshotId: "fixture", summaryText: "late canary" }))
    .rejects.toThrow("memory_compaction_target_unavailable");
  expect((await memories.getRecord(ctx, "attachment-source-memory"))?.content).toBe("attachment-source canary");
  expect((await memories.getRecordsByIds(ctx, ["attachment-source-memory", "text-source-memory"])).map(row => row.id)).toEqual(["text-source-memory"]);
  expect((await memories.listRecordsByLayer(ctx, "long_term")).map(row => row.id)).toEqual(["text-source-memory"]);
  const material = await collectDiaryMaterial(database.db, ctx, { startIso: "2000", endIso: "9999" });
  expect(material.messages.map(row => row.content)).toEqual(["text-source question"]);
  expect(material.memories.map(row => row.content)).toEqual(["text-source canary"]);
  expect((await searchMemoriesFts(database.client, ctx, "canary")).map(row => row.id)).toEqual(["text-source-memory"]);
  expect((await embeddings.retrieve(ctx, [1, 0])).map(row => row.memoryId)).toEqual(["text-source-memory"]);

  await indexMemoryFts(database.client, ctx, { id: "attachment-source-memory", content: "attachment-source canary" });
  await embeddings.insertBatch(ctx, [{ id: "late-vector", memoryId: "attachment-source-memory", vector: [1, 0], modelId: "fixture" }]);
  expect((await database.client.execute("SELECT id FROM memory_embeddings WHERE id='late-vector'")).rows).toEqual([]);
  await rebuildSearchProjections(database.client);
  expect((await database.client.execute("SELECT id FROM memories_fts")).rows.map(row => row.id)).toEqual(["text-source-memory"]);
  await memories.createRecord(ctx, { id: "new-text-memory", layer: "long_term", type: "user_fact", content: "new text", sourceTurnId: "text-source" });
  await compaction.upsertMarker(ctx, { id: "text-marker", memoryId: "text-source-memory", snapshotId: "fixture", summaryText: "text remains available" });
});

it("keeps canonical empty attachment arrays eligible without inventing legacy source provenance", async () => {
  await database.client.execute("UPDATE outbox_events SET payload=json_set(payload,'$.intent.message.attachments',json('[]')) WHERE id='outbox_attachment-source'");
  expect(await conversations.getTurnUserMessage(ctx, "attachment-source")).toBe("attachment-source question");
  expect((await memories.getRecordsByIds(ctx, ["attachment-source-memory", "text-source-memory"]))).toHaveLength(2);
  expect(await searchMemoriesFts(database.client, ctx, "canary")).toHaveLength(2);
  expect(await embeddings.retrieve(ctx, [1, 0])).toHaveLength(2);
  const material = await collectDiaryMaterial(database.db, ctx, { startIso: "2000", endIso: "9999" });
  expect(material.messages).toHaveLength(2);
  expect(material.memories).toHaveLength(2);
});

it("preserves missing receipts and unlinked memory as the separate legacy provenance scope", async () => {
  await database.client.execute("DELETE FROM outbox_events WHERE id='outbox_attachment-source'");
  await memories.createRecord(ctx, { id: "unlinked-memory", layer: "long_term", type: "user_fact", content: "unlinked canary" });
  expect(await conversations.getTurnUserMessage(ctx, "attachment-source")).toBe("attachment-source question");
  expect((await memories.getRecordsByIds(ctx, ["attachment-source-memory", "text-source-memory", "unlinked-memory"]))).toHaveLength(3);
  expect((await embeddings.retrieve(ctx, [1, 0]))).toHaveLength(2);
});
