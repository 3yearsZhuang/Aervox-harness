import { describe, expect, it, vi } from "vitest";
import {
  LocalFeatureHashEmbeddingProvider,
  OpenAiCompatibleEmbeddingProvider,
  resolveEmbeddingProvider,
} from "../src/modules/companion/memory/embedding-provider.js";

describe("Memory Embedding Providers", () => {
  describe("LocalFeatureHashEmbeddingProvider", () => {
    it("生成确定性的 256 维向量", async () => {
      const provider = new LocalFeatureHashEmbeddingProvider();
      expect(provider.modelId).toBe("aervox-local-feature-hash-v1-256");

      const vec1 = await provider.embed("你好世界，这是测试文本");
      const vec2 = await provider.embed("你好世界，这是测试文本");

      expect(vec1).toHaveLength(256);
      expect(vec1).toEqual(vec2);

      // 验证模长归一化近似为 1
      const norm = Math.sqrt(vec1.reduce((s, v) => s + v * v, 0));
      expect(norm).toBeCloseTo(1, 5);
    });

    it("空文本返回空向量", async () => {
      const provider = new LocalFeatureHashEmbeddingProvider();
      expect(await provider.embed("")).toEqual([]);
      expect(await provider.embed("   ")).toEqual([]);
    });
  });

  describe("OpenAiCompatibleEmbeddingProvider", () => {
    it("正确向标准 /v1/embeddings 发送请求并解析向量", async () => {
      const mockEmbedding = [0.1, 0.2, 0.3, 0.4];
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          object: "list",
          data: [{ object: "embedding", index: 0, embedding: mockEmbedding }],
        }),
      });

      const provider = new OpenAiCompatibleEmbeddingProvider({
        baseUrl: "https://api.openai.com/v1",
        apiKey: "test-sk",
        model: "text-embedding-3-small",
        fetch: mockFetch as unknown as typeof fetch,
      });

      expect(provider.modelId).toBe("text-embedding-3-small");

      const result = await provider.embed("学习计划与复习安排");
      expect(result).toEqual(mockEmbedding);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [calledUrl, calledInit] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(calledUrl).toBe("https://api.openai.com/v1/embeddings");
      expect(calledInit.method).toBe("POST");
      expect(calledInit.headers).toMatchObject({
        "Content-Type": "application/json",
        Authorization: "Bearer test-sk",
      });
      expect(JSON.parse(calledInit.body as string)).toEqual({
        model: "text-embedding-3-small",
        input: "学习计划与复习安排",
      });
    });

    it("支持无 apiKey 的本地服务（如 Ollama）", async () => {
      const mockEmbedding = Array(384).fill(0.05);
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ embedding: mockEmbedding }],
        }),
      });

      const provider = new OpenAiCompatibleEmbeddingProvider({
        baseUrl: "http://localhost:11434/v1",
        model: "bge-small-zh-v1.5",
        fetch: mockFetch as unknown as typeof fetch,
      });

      const result = await provider.embed("猫咪很可爱");
      expect(result).toHaveLength(384);

      const [, calledInit] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((calledInit.headers as Record<string, string>)["Authorization"]).toBeUndefined();
    });

    it("空文本直接返回空数组，不发送网络请求", async () => {
      const mockFetch = vi.fn();
      const provider = new OpenAiCompatibleEmbeddingProvider({
        fetch: mockFetch as unknown as typeof fetch,
      });
      expect(await provider.embed("  ")).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("服务端返回非 200 状态码时抛出可诊断异常", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      const provider = new OpenAiCompatibleEmbeddingProvider({
        fetch: mockFetch as unknown as typeof fetch,
      });

      await expect(provider.embed("测试报错")).rejects.toThrow("Embedding request failed with status 500");
    });
  });

  describe("resolveEmbeddingProvider", () => {
    it("默认无环境变量时回退至本地特征哈希", () => {
      const provider = resolveEmbeddingProvider({});
      expect(provider).toBeInstanceOf(LocalFeatureHashEmbeddingProvider);
      expect(provider.modelId).toBe("aervox-local-feature-hash-v1-256");
    });

    it("配置 AERVOX_EMBEDDING_URL 时解析为 OpenAI 兼容 Provider", () => {
      const provider = resolveEmbeddingProvider({
        AERVOX_EMBEDDING_URL: "http://127.0.0.1:11434/v1",
        AERVOX_EMBEDDING_MODEL: "bge-small",
      });
      expect(provider).toBeInstanceOf(OpenAiCompatibleEmbeddingProvider);
      expect(provider.modelId).toBe("bge-small");
    });

    it("配置 AERVOX_EMBEDDING_PROVIDER=openai 时解析为 OpenAI Provider", () => {
      const provider = resolveEmbeddingProvider({
        AERVOX_EMBEDDING_PROVIDER: "openai",
        AERVOX_EMBEDDING_API_KEY: "sk-xyz",
      });
      expect(provider).toBeInstanceOf(OpenAiCompatibleEmbeddingProvider);
      expect(provider.modelId).toBe("text-embedding-3-small");
    });
  });
});
