import type { LLMProviderType } from "@aervox/contracts";

export interface LLMServiceOptions {
  defaultProviderType?: LLMProviderType;
  defaultBaseUrl?: string;
  defaultModelId?: string;
}

export interface TestConnectionParams {
  providerType: LLMProviderType;
  baseUrl: string;
  apiKey?: string;
  modelId: string;
}

export interface TestConnectionResult {
  ok: boolean;
  latencyMs: number;
  message: string;
  availableModels?: string[];
}
