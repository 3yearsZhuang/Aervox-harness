/**
 * Aervox｜思隅 @aervox/worker — 记忆向量迁移（T-05 接线）
 *
 * 扫描「尚无 embedding 的记忆记录」，经注入的 EmbeddingProvider 生成向量后
 * 批量写入 memory_embeddings（幂等 upsert，按 model_id 分版本）。
 * 可中止（AbortController）+ 进度回调，避免长迁移阻塞 Worker 主循环。
 *
 * 规则依据：docs/reference/ARCHITECTURE.md §14.1 T-05（可中止 + 断点续跑）。
 * provider 未注入时本循环直接返回 0（诚实降级，不伪造向量）。
 */
import type { Client } from "@libsql/client";
import { createHash } from "node:crypto";
import {
  SqliteMemoryEmbeddingRepository,
  type AervoxDatabase,
  type LocalContext,
} from "@aervox/repositories";

import type { MemoryEmbeddingProvider } from "@aervox/host-agent";

export interface EmbeddingMigrationContext {
  db: AervoxDatabase;
  client: Client;
  embeddingRepo: SqliteMemoryEmbeddingRepository;
  provider?: MemoryEmbeddingProvider | null;
  workerId: string;
  /** 每轮最多迁移的记录数，默认 50 */
  limit?: number;
  /** 可中止控制（例如 Worker 停机 / 迁移请求取消） */
  abortSignal?: AbortSignal;
  /** 进度回调 */
  onProgress?: (progress: { current: number; total: number }) => void;
}

interface MissingMemoryRow {
  memory_id: string;
  content: string;
  created_at: string;
}

/** 扫描缺向量记忆：memory_records LEFT JOIN memory_embeddings（按 memory_id 关联） */
async function findMemoriesMissingEmbeddings(
  client: Client,
  modelId: string,
  limit: number,
): Promise<MissingMemoryRow[]> {
  const res = await client.execute({
    sql: `
      SELECT r.id AS memory_id, r.content, r.created_at
      FROM memory_records r
      LEFT JOIN memory_embeddings e
        ON e.memory_id = r.id
        AND e.model_id = ?
      WHERE r.is_deleted = 0
        AND r.layer IN ('short_term', 'long_term')
        AND e.id IS NULL
      ORDER BY r.created_at ASC
      LIMIT ?;
    `,
    args: [modelId, limit],
  });
  return res.rows.map((row) => ({
    memory_id: String(row.memory_id),
    content: String(row.content),
    created_at: String(row.created_at),
  }));
}

/** 单次迁移扫描；返回成功写入向量的记忆数 */
export async function runEmbeddingMigrationCycle(
  ctx: EmbeddingMigrationContext,
): Promise<number> {
  if (!ctx.provider || ctx.abortSignal?.aborted) return 0;

  const missing = await findMemoriesMissingEmbeddings(ctx.client, ctx.provider.modelId, ctx.limit ?? 50);
  if (missing.length === 0) return 0;

  const localCtx: LocalContext = { workspaceId: "local", subjectUserId: "local" };
  const total = missing.length;
  let migrated = 0;

  let vectors: number[][];
  if (typeof ctx.provider.embedBatch === "function") {
    vectors = await ctx.provider.embedBatch(missing.map((r) => r.content));
  } else {
    vectors = await Promise.all(
      missing.map((row) => ctx.provider!.embed(row.content)),
    );
  }

  if (vectors.length !== missing.length || vectors.some(vector =>
    !Array.isArray(vector) || vector.length === 0 || !vector.every(Number.isFinite) || vector.length !== vectors[0]?.length)) {
    throw new Error("Invalid embedding batch: expected one finite, non-empty vector of equal dimension per memory");
  }
  const items = missing.map((row, idx) => ({
    id: `emb_${createHash("sha256").update(JSON.stringify([ctx.provider!.modelId, row.memory_id])).digest("hex")}`,
    memoryId: row.memory_id,
    vector: vectors[idx]!,
    modelId: ctx.provider!.modelId,
    sourceCreatedAt: row.created_at,
  }));

  if (ctx.abortSignal?.aborted) return 0;

  await ctx.embeddingRepo.insertBatch(localCtx, items, {
    batchSize: 25,
    maxRetries: 3,
  });
  migrated += items.length;
  ctx.onProgress?.({ current: migrated, total });

  return migrated;
}
