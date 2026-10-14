/**
 * Aervox｜思隅 @aervox/host-agent — 模型 Provider 集中解析器
 *
 * 统一为 Worker / AgentHost 提供通用大模型 Provider 装配：
 * - AERVOX_LOOP_PROVIDER=replay: 确定性回放 Provider
 * - AERVOX_LOOP_PROVIDER=llm (或配置了端点): 标准 OpenAI 兼容 Provider（DeepSeek/Ollama/OpenAI/vLLM）
 * - 支持优先读取 SQLite llm_configs 活跃预设
 */
import type { ModelProviderPort } from "@aervox/core";
import { createOpenAICompatProvider, createReplayProvider } from "@aervox/core";
import type { SqliteLLMConfigRepository, LocalContext } from "@aervox/repositories";

export interface ResolveModelProviderOptions {
  llmConfigRepo?: SqliteLLMConfigRepository;
  ctx?: LocalContext;
  defaultMode?: "replay" | "llm";
}

export async function resolveModelProvider(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveModelProviderOptions = {},
): Promise<ModelProviderPort> {
  const mode = env.AERVOX_LOOP_PROVIDER ?? options.defaultMode ?? "replay";

  if (mode === "replay") {
    return createReplayProvider();
  }

  // 1. 如果注入了 llmConfigRepo，优先从数据库获取激活的预设
  if (options.llmConfigRepo) {
    const ctx = options.ctx ?? { workspaceId: "local", subjectUserId: "local" };
    try {
      const active = await options.llmConfigRepo.getConfig(ctx);
      if (active && active.baseUrl && active.modelId) {
        return createOpenAICompatProvider({
          baseUrl: active.baseUrl,
          apiKey: active.apiKey ?? undefined,
          modelId: active.modelId,
          temperature: active.temperature ?? 0.7,
          maxTokens: active.maxTokens ?? 4096,
        });
      }
    } catch {
      // 容错降级
    }
  }

  // 2. 环境变量回退
  const baseUrl = env.AERVOX_LLM_BASE_URL ?? env.OPENAI_BASE_URL ?? "http://localhost:11434/v1";
  const apiKey = env.AERVOX_LLM_API_KEY ?? env.OPENAI_API_KEY ?? "ollama";
  const modelId = env.AERVOX_LLM_MODEL ?? env.OPENAI_MODEL ?? "qwen2.5:latest";

  return createOpenAICompatProvider({
    baseUrl,
    apiKey,
    modelId,
    temperature: 0.7,
    maxTokens: 4096,
  });
}
