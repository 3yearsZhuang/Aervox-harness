import { isLiteralLoopbackUrl, type LLMConfigResponse } from "@aervox/contracts";
import { defaultModelProviderRegistry, type ModelProviderPort, type ModelProviderRegistryPort } from "@aervox/core";

type ProviderConfig = Pick<LLMConfigResponse, "enabled" | "providerType" | "baseUrl" | "modelId"> &
  Partial<Pick<LLMConfigResponse, "apiKey" | "temperature" | "maxTokens" | "settings">>;

function positiveInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) throw new Error(`llm_invalid_config: ${label}`);
  return parsed;
}

/** All product execution paths create configured providers through this boundary.
 * Routing chooses a preset and optional tighter output cap; it does not reinterpret settings.
 */
export function createConfiguredModelProvider(
  config: ProviderConfig,
  options: { localOnly?: boolean; requireLocalProvider?: boolean; maxOutputTokens?: number } = {},
  registry: ModelProviderRegistryPort = defaultModelProviderRegistry,
): ModelProviderPort {
  const descriptor = registry.getDescriptor(config.providerType);
  if (!config.enabled) throw new Error("llm_disabled: model configuration is disabled");
  if (descriptor?.protocol !== "openai-compat") {
    const reason = config.providerType === "anthropic" ? "anthropic_unsupported" : "model_protocol_unsupported";
    throw new Error(`llm_disabled: ${reason}: ${config.providerType}`);
  }
  if (options.localOnly && (!isLiteralLoopbackUrl(config.baseUrl) || options.requireLocalProvider && !descriptor.isLocal)) {
    throw new Error("llm_disabled: proactive_local_provider_required: local processing requires a permitted loopback endpoint");
  }
  const contextWindow = positiveInteger(config.settings?.contextWindow, "settings.contextWindow") ??
    positiveInteger(descriptor.capabilities.contextWindowTokens, "provider.contextWindowTokens");
  const configuredMax = positiveInteger(config.maxTokens, "maxTokens") ?? 4096;
  const outputCap = positiveInteger(options.maxOutputTokens, "maxOutputTokens") ?? configuredMax;
  const maxTokens = Math.min(configuredMax, outputCap);
  // Preserve the established Loop reserve, now also applied to all single-shot consumers.
  const effectiveMaxTokens = contextWindow === undefined ? maxTokens : Math.min(maxTokens, Math.max(256, contextWindow - 1024));
  const timeoutMs = positiveInteger(config.settings?.requestTimeoutMs, "settings.requestTimeoutMs", 2_147_483_647);
  const temperature = config.temperature ?? 0.7;
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new Error("llm_invalid_config: temperature");
  return registry.createProvider(config.providerType, {
    baseUrl: config.baseUrl, apiKey: config.apiKey, modelId: config.modelId,
    temperature, maxTokens: effectiveMaxTokens,
    ...(contextWindow === undefined ? {} : { contextWindowTokens: contextWindow }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(options.localOnly ? { redirect: "error" as const } : {}),
  });
}
