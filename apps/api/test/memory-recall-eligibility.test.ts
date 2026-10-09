import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createInMemoryDatabase, initDatabaseSchema, indexMemoryFts,
  SqliteMemoryRepository, SqliteMemoryEmbeddingRepository,
} from "@aervox/repositories";
import { createSqliteMemoryRecall } from "../src/modules/companion/memory/recall.js";

const local = { workspaceId: "local", subjectUserId: "local" };

describe("自动记忆召回资格", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  beforeEach(async () => {
    database = await createInMemoryDatabase();
    await initDatabaseSchema(database.client);
  });
  afterEach(async () => database.cleanup());

  it.each([false, true])("FTS/向量均不回传过期、敏感、未知分级、未确认或已删记忆，vector=%s", async (vector) => {
    const memories = new SqliteMemoryRepository(database.db, database.client);
    const embeddings = new SqliteMemoryEmbeddingRepository(database.db);
    const ids = ["valid", "expired", "sensitive", "restricted", "unknown", "invalid-date", "candidate", "deleted"];
    for (const id of ids) {
      await memories.createRecord(local, {
        id, layer: "long_term", type: "user_fact", content: "evidence",
        verificationStatus: id === "candidate" ? "unverified" : "verified",
      });
      await indexMemoryFts(database.client, local, { id, content: "evidence" });
      await embeddings.insertBatch(local, [{ id: `vec-${id}`, memoryId: id, vector: [1, 0], modelId: "test" }]);
    }
    await database.client.execute("UPDATE memory_records SET ai_recall_until = '2000-01-01T00:00:00Z', user_retention_until = '2999-01-01T00:00:00Z' WHERE id = 'expired'");
    await database.client.execute("UPDATE memory_records SET ai_recall_until = 'invalid' WHERE id = 'invalid-date'");
    await database.client.execute("UPDATE memory_records SET sensitivity_class = id WHERE id IN ('sensitive', 'restricted', 'unknown')");
    await database.client.execute("UPDATE memory_records SET is_deleted = 1 WHERE id = 'deleted'");
    const recall = createSqliteMemoryRecall({
      db: database.db, client: database.client,
      embeddingProvider: vector ? { modelId: "test", embed: async () => [1, 0] } : null,
    });
    expect((await recall.recall(local, "evidence")).map((hit) => hit.id)).toEqual(["valid"]);
    // Recall expiry must not delete history retained by the user.
    expect((await memories.getRecord(local, "expired"))?.content).toBe("evidence");
  });
});
