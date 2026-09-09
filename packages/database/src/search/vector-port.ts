/**
 * Aervox｜思隅 @aervox/database — 向量检索 Port 接口与适配器
 *
 * 解耦向量检索与具体向量数据库，使得派生向量索引可随意清空、离线重建。
 */

export interface VectorItem {
  readonly id: string;
  readonly vector: number[];
  readonly metadata?: Record<string, unknown>;
}

export interface VectorSearchResult {
  readonly id: string;
  readonly score: number; // 余弦相似度 [-1, 1] 或距离
  readonly metadata?: Record<string, unknown>;
}

/**
 * 向量检索核心 Port 接口
 */
export interface IVectorSearchPort {
  upsert(items: VectorItem[]): Promise<void>;
  search(
    queryVector: number[],
    topK: number,
    minScore?: number,
  ): Promise<VectorSearchResult[]>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

/**
 * 计算两向量的余弦相似度
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const valA = a[i]!;
    const valB = b[i]!;
    dot += valA * valB;
    normA += valA * valA;
    normB += valB * valB;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * 内存向量检索适配器（用于单机轻量运行、快速测试与零外部依赖环境）
 */
export class InMemoryVectorSearchAdapter implements IVectorSearchPort {
  private store = new Map<string, VectorItem>();

  async upsert(items: VectorItem[]): Promise<void> {
    for (const item of items) {
      this.store.set(item.id, item);
    }
  }

  async search(
    queryVector: number[],
    topK: number = 10,
    minScore: number = 0.0,
  ): Promise<VectorSearchResult[]> {
    const results: VectorSearchResult[] = [];

    for (const [id, item] of this.store.entries()) {
      const score = cosineSimilarity(queryVector, item.vector);
      if (score >= minScore) {
        results.push({ id, score, metadata: item.metadata });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}
