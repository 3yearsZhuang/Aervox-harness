/**
 * Aervox｜思隅 @aervox/database — 记忆向量 SQLite 仓储（T-05）
 *
 * memory_embeddings 独立表：按 model_id 分版本存储向量，换模型不迁移业务表。
 * 检索走 JS 行扫描 + 余弦（SQLite 无原生向量扩展的兜底），后续 pgvector 仅替换
 * 本实现，接口不变（对照 AST-02 的 Port 语义：批量 + 重试 + 进度回调 + topK 检索）。
 */
import { eq, and } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { memoryEmbeddings } from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
import { cosineSimilarity } from "../../search/vector-port.js";
import type { IMemoryEmbeddingRepository } from "../types.js";

/** 把 JSON 字符串还原为 number[]；非法数据视为空向量 */
function parseVector(json: string | null): number[] {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? (value as number[]) : [];
  } catch {
    return [];
  }
}

export class SqliteMemoryEmbeddingRepository implements IMemoryEmbeddingRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async insertBatch(
    tenant: TenantContext,
    items: Array<{
      id: string;
      memoryId: string;
      vector: number[];
      modelId: string;
      sourceCreatedAt?: string | null;
      indexVersion?: number;
    }>,
    options: {
      batchSize?: number;
      maxRetries?: number;
      progressCallback?: (progress: { current: number; total: number }) => void;
    } = {},
  ): Promise<void> {
    assertTenantContext(tenant);
    const batchSize = options.batchSize ?? 50;
    const maxRetries = options.maxRetries ?? 3;
    const total = items.length;

    for (let offset = 0; offset < total; offset += batchSize) {
      const chunk = items.slice(offset, offset + batchSize);
      const now = new Date().toISOString();

      // 分批 upsert：单条失败（busy/约束）整批重试（maxRetries 内）
      let lastError: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
          await this.db.transaction(async (tx) => {
            for (const item of chunk) {
              await tx
                .insert(memoryEmbeddings)
                .values({
                  id: item.id,
                  workspaceId: tenant.workspaceId,
                  subjectUserId: tenant.subjectUserId,
                  memoryId: item.memoryId,
                  dimension: item.vector.length,
                  modelId: item.modelId,
                  embeddingJson: JSON.stringify(item.vector),
                  sourceCreatedAt: item.sourceCreatedAt ?? null,
                  indexVersion: item.indexVersion ?? 1,
                  createdAt: now,
                  updatedAt: now,
                })
                .onConflictDoUpdate({
                  target: memoryEmbeddings.id,
                  set: {
                    memoryId: item.memoryId,
                    dimension: item.vector.length,
                    modelId: item.modelId,
                    embeddingJson: JSON.stringify(item.vector),
                    sourceCreatedAt: item.sourceCreatedAt ?? null,
                    indexVersion: item.indexVersion ?? 1,
                    updatedAt: now,
                  },
                });
            }
          });
          break;
        } catch (error) {
          lastError = error;
          if (attempt === maxRetries) throw error;
        }
      }
      void lastError;

      options.progressCallback?.({ current: Math.min(offset + batchSize, total), total });
    }
  }

  async retrieve(
    tenant: TenantContext,
    queryVector: number[],
    topK: number = 10,
    minScore: number = 0,
    modelId?: string,
  ): Promise<Array<{ memoryId: string; score: number }>> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(memoryEmbeddings)
      .where(
        and(
          eq(memoryEmbeddings.workspaceId, tenant.workspaceId),
          eq(memoryEmbeddings.subjectUserId, tenant.subjectUserId),
          modelId !== undefined ? eq(memoryEmbeddings.modelId, modelId) : undefined,
        ),
      );

    const scored: Array<{ memoryId: string; score: number }> = [];
    for (const row of rows) {
      const vector = parseVector((row as { embeddingJson: string }).embeddingJson);
      const score = cosineSimilarity(queryVector, vector);
      if (score >= minScore) scored.push({ memoryId: String(row.memoryId), score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  async deleteByMemoryId(tenant: TenantContext, memoryId: string): Promise<void> {
    assertTenantContext(tenant);
    await this.db
      .delete(memoryEmbeddings)
      .where(
        and(
          eq(memoryEmbeddings.memoryId, memoryId),
          eq(memoryEmbeddings.workspaceId, tenant.workspaceId),
          eq(memoryEmbeddings.subjectUserId, tenant.subjectUserId),
        ),
      );
  }

  async clearTenant(tenant: TenantContext): Promise<void> {
    assertTenantContext(tenant);
    await this.db
      .delete(memoryEmbeddings)
      .where(
        and(
          eq(memoryEmbeddings.workspaceId, tenant.workspaceId),
          eq(memoryEmbeddings.subjectUserId, tenant.subjectUserId),
        ),
      );
  }
}

/**
 * 将 memory_embeddings 落库向量对标 IVectorSearchPort，供 T-02 混合检索直接使用：
 * id = memoryId。这也是 pgvector 切换时的替换边界。
 */
export class SqliteMemoryVectorSearchAdapter {
  constructor(
    private readonly repo: IMemoryEmbeddingRepository,
    private readonly modelId: string,
  ) {}

  async upsert(
    tenant: TenantContext,
    items: Array<{ id: string; vector: number[]; metadata?: Record<string, unknown> }>,
  ): Promise<void> {
    await this.repo.insertBatch(tenant, [
      ...items.map((item) => ({
        id: `vec_${item.id}`,
        memoryId: item.id,
        vector: item.vector,
        modelId: this.modelId,
        sourceCreatedAt: (item.metadata?.sourceCreatedAt as string | undefined) ?? null,
      })),
    ]);
  }

  async search(
    tenant: TenantContext,
    queryVector: number[],
    topK: number,
    minScore = 0,
  ): Promise<Array<{ id: string; score: number; metadata?: Record<string, unknown> }>> {
    const hits = await this.repo.retrieve(tenant, queryVector, topK, minScore, this.modelId);
    return hits.map((h) => ({ id: h.memoryId, score: h.score }));
  }

  async delete(tenant: TenantContext, id: string): Promise<void> {
    await this.repo.deleteByMemoryId(tenant, id);
  }

  async clearTenant(tenant: TenantContext): Promise<void> {
    await this.repo.clearTenant(tenant);
  }
}