/**
 * Aervox｜思隅 @aervox/api — 记忆向量生成 Provider 门面
 *
 * 统一重定向至 @aervox/host-agent 的通用实现，保持 API 模块既有导出接口不变。
 */
export {
  LocalFeatureHashEmbeddingProvider,
  OpenAiCompatibleEmbeddingProvider,
  resolveEmbeddingProvider,
  type MemoryEmbeddingProvider,
  type OpenAiCompatibleEmbeddingOptions,
} from "@aervox/host-agent";
