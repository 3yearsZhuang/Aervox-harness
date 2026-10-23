import { randomUUID } from "node:crypto";
import { abortableStream, awaitWithSignal, defaultModelProviderRegistry, type ModelProviderPort, type ModelProviderRegistryPort } from "@aervox/core";
import type { LocalContext } from "@aervox/repositories";
import type { LLMConfigPort } from "./index.js";

export interface ModelGenerationInput {
  context: LocalContext;
  system: string;
  user: string;
  task?: string;
  signal?: AbortSignal;
  localOnly?: boolean;
}

export interface ModelGenerationPort {
  generate(input: ModelGenerationInput): Promise<string>;
}

/** One owner for provider selection and one-shot generation; domains only supply prompts. */
export function createModelGenerationPort(
  source: Pick<LLMConfigPort, "getConfig">,
  registry: ModelProviderRegistryPort = defaultModelProviderRegistry,
): ModelGenerationPort {
  return {
    async generate(input) {
      input.signal?.throwIfAborted();
      const config = await awaitWithSignal(source.getConfig(input.context), input.signal);
      const descriptor = registry.getDescriptor(config.providerType);
      if (!config.enabled || descriptor?.protocol !== "openai-compat") {
        throw new Error("llm_disabled: model configuration is disabled or its protocol is unsupported");
      }
      if (input.localOnly) {
        let localEndpoint = false;
        try { localEndpoint = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(config.baseUrl).hostname); } catch { /* invalid endpoint is unavailable */ }
        if (!descriptor.isLocal || !localEndpoint) throw new Error("llm_disabled: local processing requires a local provider endpoint");
      }
      const provider: ModelProviderPort = registry.createProvider(config.providerType, {
        baseUrl: config.baseUrl, apiKey: config.apiKey, modelId: config.modelId,
        temperature: config.temperature, maxTokens: config.maxTokens,
        ...(input.localOnly ? { redirect: "error" as const } : {}),
      });
      const turnId = `${input.task ?? "generation"}_${randomUUID()}`;
      let text = "";
      let completed = false;
      for await (const chunk of abortableStream(provider.stream({
        turnId, attemptId: turnId, step: 1, signal: input.signal,
        context: { turnId, sessionId: input.task ?? "generation", messages: [
          { role: "system", content: input.system }, { role: "user", content: input.user },
        ] },
      }), input.signal)) {
        input.signal?.throwIfAborted();
        text += chunk.text ?? "";
        if (text.length > 256_000) throw new Error("llm_output_limit: generated text exceeds the output budget");
        if (chunk.isFinal) {
          if (chunk.stopReason && chunk.stopReason !== "stop") throw new Error(`llm_incomplete_output: ${chunk.stopReason}`);
          completed = true;
        }
      }
      input.signal?.throwIfAborted();
      if (!completed) throw new Error("llm_incomplete_output: provider ended without a final response");
      if (!text.trim()) throw new Error("llm_empty_output: model returned no content");
      return text;
    },
  };
}
