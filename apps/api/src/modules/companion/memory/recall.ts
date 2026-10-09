import {
  HybridSearchService,
  SqliteMemoryEmbeddingRepository,
  SqliteMemoryRepository,
  SqliteMemoryVectorSearchAdapter,
  createHybridSearchStorage,
  type LocalContext,
} from "@aervox/repositories";
import type { AervoxDatabase } from "@aervox/repositories";
import type { Client } from "@libsql/client";
import type { MemoryEmbeddingProvider } from "./embedding-provider.js";

export interface RecalledMemory {
  id: string;
  content: string;
  category?: string;
  source: "hybrid" | "fts" | "vector";
}

export interface MemoryRecallPort {
  recall(tenant: LocalContext, query: string): Promise<RecalledMemory[]>;
}

/** SQLite 记忆召回：本地 FTS + 同模型向量通道，经 RRF 排序后回读权威记录。 */
export function createSqliteMemoryRecall(deps: {
  db: AervoxDatabase;
  client: Client;
  embeddingProvider: MemoryEmbeddingProvider | null;
}): MemoryRecallPort {
  const memoryRepo = new SqliteMemoryRepository(deps.db, deps.client);
  const embeddingRepo = new SqliteMemoryEmbeddingRepository(deps.db);
  const vectorPort = new SqliteMemoryVectorSearchAdapter(
    embeddingRepo,
    deps.embeddingProvider?.modelId ?? "embedding-disabled",
  );
  const search = new HybridSearchService(
    createHybridSearchStorage({ domain: "memory", client: deps.client, vectorPort }),
    "memory",
  );

  return {
    async recall(tenant, query) {
      const queryVector = deps.embeddingProvider
        ? await deps.embeddingProvider.embed(query).catch(() => [])
        : [];
      const hits = await search.search(tenant, {
        queryText: query,
        queryVector,
        topK: 12,
        limit: 12,
        // 空向量与不同维度向量的相似度为 0；正阈值保证失败时干净降级到 FTS。
        minVectorScore: 0.15,
      });
      if (hits.length === 0) return [];
      const records = await memoryRepo.getRecordsByIds(tenant, hits.map((h) => h.id));
      const recordMap = new Map(records.map((r) => [r.id, r]));
      const recalled: RecalledMemory[] = [];
      for (const hit of hits) {
        const record = recordMap.get(hit.id);
        if (!record || record.verificationStatus !== "verified" || record.layer !== "long_term") continue;
        // Automatic recall has no grant for sensitive data. Keep history retention independent.
        if (!["public", "normal"].includes(record.sensitivityClass ?? "")) continue;
        if (record.aiRecallUntil != null && !(Date.parse(record.aiRecallUntil) > Date.now())) continue;
        recalled.push({
          id: record.id,
          content: record.content,
          category: record.category,
          source: hit.source,
        });
        if (recalled.length === 5) break;
      }
      return recalled;
    },
  };
}
