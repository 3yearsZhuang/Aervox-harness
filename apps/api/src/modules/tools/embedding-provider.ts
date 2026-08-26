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