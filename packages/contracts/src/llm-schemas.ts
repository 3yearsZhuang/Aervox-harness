import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const llmProviderTypeSchema = z.enum([
  "ollama",
  "deepseek",
  "openai",
  "anthropic",
  "custom_openai",
]);

/** 大语言模型与供应商配置（WebUI 设置「模型与服务」读写；CR-012） */
export const llmConfigSchema = z.object({
  enabled: z.boolean(),
  providerType: llmProviderTypeSchema,
  baseUrl: z.string().min(1),
  apiKey: z.string().optional(),
  modelId: z.string().min(1),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().positive().optional().default(4096),
  settings: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
});

/** 大语言模型配置读取响应 */
export const llmConfigResponseSchema = z.object({
  enabled: z.boolean(),
  providerType: llmProviderTypeSchema,
  baseUrl: z.string().min(1),
  apiKey: z.string().optional(),
  modelId: z.string().min(1),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().positive().default(4096),
  settings: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .default({}),
});

/** 连通性测试请求 */
export const llmTestConnectionRequestSchema = z.object({
  providerType: llmProviderTypeSchema,
  baseUrl: z.string().min(1),
  apiKey: z.string().optional(),
  modelId: z.string().min(1),
});

/** 连通性测试响应 */
export const llmTestConnectionResponseSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int().nonnegative(),
  message: z.string(),
  availableModels: z.array(z.string()).optional(),
});

/** LLM 配置预设条目（多预设：含名称与激活标记） */
export const llmPresetSchema = llmConfigResponseSchema.extend({
  id: z.string().min(1),
  name: z.string().min(1),
  isActive: z.boolean(),
});

/** LLM 配置预设列表响应 */
export const llmPresetListResponseSchema = z.object({
  presets: z.array(llmPresetSchema),
  activeId: z.string().nullable(),
});

/** 新建 LLM 配置预设请求 */
export const llmCreatePresetRequestSchema = z.object({
  name: z.string().min(1).max(32),
  config: llmConfigSchema,
});

export type LLMPreset = z.infer<typeof llmPresetSchema>;
export type LLMPresetListResponse = z.infer<typeof llmPresetListResponseSchema>;
export type LLMCreatePresetRequest = z.infer<typeof llmCreatePresetRequestSchema>;

export type LLMProviderType = z.infer<typeof llmProviderTypeSchema>;
export type LLMConfig = z.infer<typeof llmConfigSchema>;
export type LLMConfigResponse = z.infer<typeof llmConfigResponseSchema>;
export type LLMTestConnectionRequest = z.infer<typeof llmTestConnectionRequestSchema>;
export type LLMTestConnectionResponse = z.infer<typeof llmTestConnectionResponseSchema>;
