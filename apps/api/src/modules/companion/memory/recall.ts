import {
  HybridSearchService,
  SqliteMemoryEmbeddingRepository,
  SqliteMemoryRepository,
  SqliteMemoryVectorSearchAdapter,
  createHybridSearchStorage,
  isAutoRecallEligible,
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

/** 自动召回候选池（过采样）：不合格命中不挤占合格结果的名额 */
const AUTO_RECALL_CANDIDATES = 24;
/** 单次召回注入上限 */
const AUTO_RECALL_LIMIT = 5;
/** 自动召回用途与作用域（DATA_PRIVACY §4 的 memory_long 用途；宿主可按契约注入其它取值） */
export const AUTO_RECALL_CONSENT_PURPOSE = "memory_long";
export const AUTO_RECALL_CONSENT_SCOPE = "auto_recall";

/** SQLite 记忆召回：本地 FTS + 同模型向量通道，经 RRF 排序后回读权威记录并逐条做资格判定。 */
export function createSqliteMemoryRecall(deps: {
  db: AervoxDatabase;
  client: Client;
  embeddingProvider: MemoryEmbeddingProvider | null;
  /**
   * 用途闸门：注入后每次召回前核对（无有效授权即不召回，fail-closed；读取失败同样拒绝）。
   * 缺省不启用（兼容既有测试与未接线的宿主）；历史保留与导出不受该闸门影响。
   */
  consentCheck?: (purpose: string, scope: string) => Promise<boolean>;
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
      if (deps.consentCheck) {
        const granted = await deps
          .consentCheck(AUTO_RECALL_CONSENT_PURPOSE, AUTO_RECALL_CONSENT_SCOPE)
          .catch(() => false);
        if (!granted) return [];
      }
      const queryVector = deps.embeddingProvider
        ? await deps.embeddingProvider.embed(query).catch(() => [])
        : [];
      const hits = await search.search(tenant, {
        queryText: query,
        queryVector,
        topK: AUTO_RECALL_CANDIDATES,
        limit: AUTO_RECALL_CANDIDATES,
        // 空向量与不同维度向量的相似度为 0；正阈值保证失败时干净降级到 FTS。
        minVectorScore: 0.15,
      });
      if (hits.length === 0) return [];
      const records = await memoryRepo.getRecordsByIds(tenant, hits.map((h) => h.id));
      const recordMap = new Map(records.map((r) => [r.id, r]));
      const recalled: RecalledMemory[] = [];
      for (const hit of hits) {
        const record = recordMap.get(hit.id);
        // 资格真源：verified 长期记忆 + 分级允许 + 期限有效（主对话与主动回合共用同一谓词）
        if (!record || !isAutoRecallEligible(record)) continue;
        recalled.push({
          id: record.id,
          content: record.content,
          category: record.category,
          source: hit.source,
        });
        if (recalled.length === AUTO_RECALL_LIMIT) break;
      }
      return recalled;
    },
  };
}
