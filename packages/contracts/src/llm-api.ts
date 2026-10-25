import type { ApiEndpoint } from "./http-api.js";
import { llmProviderCatalogResponseSchema } from "./llm-schemas.js";
export const llmApi = { providers: { method: "get", path: "/v1/llm/providers", operationId: "listModelProviders", summary: "读取模型配置目录与执行可用性", tags: ["LLM"], response: llmProviderCatalogResponseSchema } } as const satisfies Record<string, ApiEndpoint>;
