/**
 * Aervox｜思隅 @aervox/api — 记忆向量生成 Provider 抽象（工具模块）
 *
 * MemoryStoreTool / embedding 迁移 Worker 依赖的向量生成边界：
 * - 生产环境注入真实 embedding 服务（如 OpenAI embeddings / 本地模型）；
 * - 未注入时工具与迁移链路诚实降级（embeddingStatus = skipped），不伪造向量。
 *
 * 规则依据：docs/explanation/reference-design-transfer.md §3.5 T-05。
 */

/** 向量生成能力：文本 → 向量数组（维度由实现决定） */
export interface MemoryEmbeddingProvider {
  /** 模型标识（写 memory_embeddings.model_id，用于按模型分版本） */
  readonly modelId: string;
  /** 生成向量 */
  embed(text: string): Promise<number[]>;
}

const LOCAL_DIMENSIONS = 256;

function hashToken(token: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function localFeatures(text: string): string[] {
  const normalized = text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const compact = normalized.replace(/\s/g, "");
  const features = normalized.split(" ").filter(Boolean);
  for (let width = 1; width <= 3; width += 1) {
    for (let index = 0; index + width <= compact.length; index += 1) {
      features.push(compact.slice(index, index + width));
    }
  }
  return features;
}

/**
 * 默认本地向量实现：用带符号特征哈希把词项及 1~3 字符片段映射到固定维度。
 * 它不触网且可稳定复算，适合作为开箱即用的词面相似度通道；生产可注入语义
 * embedding provider 替换，存储会按 modelId 隔离不同向量空间。
 */
export class LocalFeatureHashEmbeddingProvider implements MemoryEmbeddingProvider {
  readonly modelId = "aervox-local-feature-hash-v1-256";

  async embed(text: string): Promise<number[]> {
    const vector = Array<number>(LOCAL_DIMENSIONS).fill(0);
    for (const feature of localFeatures(text)) {
      const hash = hashToken(feature);
      const index = hash % LOCAL_DIMENSIONS;
      vector[index] = (vector[index] ?? 0) + ((hash & 0x100) === 0 ? 1 : -1);
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return norm === 0 ? [] : vector.map((value) => value / norm);
  }
}
