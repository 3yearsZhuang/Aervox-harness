import { defaultModelProviderRegistry, type ModelProviderRegistryPort } from "@aervox/core";
import { llmProviderCatalogResponseSchema, type LLMProviderCatalogEntry } from "@aervox/contracts";

// Compatibility configuration is visible but never presented as executable support.
const legacyAnthropic: LLMProviderCatalogEntry = { id: "anthropic", name: "Anthropic Claude", description: "Anthropic API", protocol: "anthropic", defaultBaseUrl: "https://api.anthropic.com/v1", recommendedModels: ["claude-3-5-sonnet-20241022"], requiresApiKey: true, isLocal: false, available: false, unavailableReason: "anthropic_unsupported" };

export function modelProviderCatalog(registry: ModelProviderRegistryPort = defaultModelProviderRegistry) {
  const providers: LLMProviderCatalogEntry[] = registry.listDescriptors().filter(d => !["replay", "faux"].includes(d.protocol)).map(d => ({
    id: d.id, name: d.name, description: d.isLocal ? "Local model provider" : "Remote model provider", protocol: d.protocol,
    defaultBaseUrl: d.defaultBaseUrl ?? "", recommendedModels: [...d.recommendedModels ?? []], requiresApiKey: !d.isLocal, isLocal: d.isLocal,
    available: d.protocol === "openai-compat", ...(d.protocol === "openai-compat" ? {} : { unavailableReason: "model_protocol_unsupported" }),
  }));
  if (!providers.some(p => p.id === legacyAnthropic.id)) providers.push(legacyAnthropic);
  return llmProviderCatalogResponseSchema.parse({ generation: registry.generation, providers });
}

export function configuredProviderDescriptor(id: string) {
  const descriptor = modelProviderCatalog().providers.find(p => p.id === id);
  if (!descriptor || !descriptor.available && id !== "anthropic") throw new Error(`unknown_model_provider: ${id}`);
  return descriptor;
}
