/**
 * Aervox｜思隅 @aervox/api — 记忆向量生成 Provider 抽象（工具模块）
 *
 * MemoryStoreTool / embedding 迁移 Worker 依赖的向量生成边界：
 * - 生产环境注入真实 embedding 服务（如 OpenAI embeddings / 本地模型）；
 * - 未注入时工具与迁移链路诚实降级（embeddingStatus = skipped），不伪造向量。
 *
 * 规则依据：docs/reference/ARCHITECTURE.md §14.1 T-05 T-05。
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

export interface OpenAiCompatibleEmbeddingOptions {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

/**
 * 生产/本地兼容的语义 Embedding Provider：
 * 对接标准 OpenAI / Ollama / 本地推理服务的 /v1/embeddings 接口。
 * 支持传入自定义 fetch（方便测试与隔离），并带有超时控制与格式健壮性保障。
 */
export class OpenAiCompatibleEmbeddingProvider implements MemoryEmbeddingProvider {
  readonly modelId: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: OpenAiCompatibleEmbeddingOptions = {}) {
    this.modelId = options.model ?? "text-embedding-3-small";
    const rawUrl = options.baseUrl ?? process.env.AERVOX_EMBEDDING_URL ?? "http://localhost:11434/v1";
    this.baseUrl = rawUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? process.env.AERVOX_EMBEDDING_API_KEY;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  async embed(text: string): Promise<number[]> {
    const trimmed = text.trim();
    if (!trimmed) return [];

    const url = this.baseUrl.endsWith("/embeddings")
      ? this.baseUrl
      : `${this.baseUrl}/embeddings`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (this.apiKey) {
        headers["Authorization"] = `Bearer ${this.apiKey}`;
      }

      const response = await this.fetchFn(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.modelId,
          input: trimmed,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Embedding request failed with status ${response.status}`);
      }

      const json = (await response.json()) as {
        data?: Array<{ embedding?: number[] }>;
      };

      const embedding = json.data?.[0]?.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new Error("Invalid embedding response: missing or empty embedding array");
      }

      return embedding;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 解析环境配置生成对应的 Embedding Provider */
export function resolveEmbeddingProvider(
  env: Record<string, string | undefined> = process.env,
  overrides?: OpenAiCompatibleEmbeddingOptions,
): MemoryEmbeddingProvider {
  const url = overrides?.baseUrl ?? env.AERVOX_EMBEDDING_URL;
  const isExplicit = env.AERVOX_EMBEDDING_PROVIDER === "openai" || Boolean(url);
  if (isExplicit) {
    return new OpenAiCompatibleEmbeddingProvider({
      baseUrl: url,
      apiKey: overrides?.apiKey ?? env.AERVOX_EMBEDDING_API_KEY,
      model: overrides?.model ?? env.AERVOX_EMBEDDING_MODEL,
      fetch: overrides?.fetch,
      timeoutMs: overrides?.timeoutMs,
    });
  }
  return new LocalFeatureHashEmbeddingProvider();
}
