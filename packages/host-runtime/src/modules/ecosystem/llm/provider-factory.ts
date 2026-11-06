import { defaultModelProviderRegistry, type ModelProviderPort, type ModelProviderRegistryPort } from "@aervox/core";
import { createConfiguredModelProvider, type ConfiguredModelProviderConfig, type ConfiguredModelProviderOptions } from "./provider-config.js";
import type { ModelStreamResourcePort } from "./model-resources.js";

export interface ConfiguredProviderFactoryPort {
  create(config: ConfiguredModelProviderConfig, options?: ConfiguredModelProviderOptions): ModelProviderPort;
}

/** Configuration, routing and domains share the Host's one upstream owner. */
export function createConfiguredProviderFactory(
  resources: ModelStreamResourcePort,
  registry: ModelProviderRegistryPort = defaultModelProviderRegistry,
): ConfiguredProviderFactoryPort {
  return { create: (config, options) => resources.wrap(createConfiguredModelProvider(config, options, registry)) };
}
