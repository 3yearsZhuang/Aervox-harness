import { randomUUID } from "node:crypto";
import { abortableStream, awaitWithSignal, defaultModelProviderRegistry, type ModelProviderPort, type ModelProviderRegistryPort } from "@aervox/core";
import type { LocalContext } from "@aervox/repositories";
import type { LLMConfigPort } from "./index.js";
import { createConfiguredModelProvider } from "./provider-config.js";

export interface ModelGenerationInput {
  context: LocalContext;
  system: string;
  user: string;
  task?: string;
  signal?: AbortSignal;
  localOnly?: boolean;
  temperature?: number;
}

export interface ModelGenerationPort {
  generate(input: ModelGenerationInput): Promise<string>;
}

const MAX_GENERATION_BYTES = 256_000;
const utf8 = new TextEncoder();

/** A single-shot call has no tool execution or partial-success result.
 * Core owns the wire-level context check and idle timer; these byte budgets also
 * bound injected providers without pretending to know their tokenizer.
 */
export async function generateModelText(provider: ModelProviderPort, input: Omit<ModelGenerationInput, "context" | "localOnly">): Promise<string> {
  input.signal?.throwIfAborted();
  if (input.temperature !== undefined && (!Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2)) throw new Error("llm_invalid_input: temperature");
  const messages = [
    ...(input.system ? [{ role: "system" as const, content: input.system }] : []),
    { role: "user" as const, content: input.user },
  ];
  if (utf8.encode(JSON.stringify(messages)).length > MAX_GENERATION_BYTES) throw new Error("llm_input_limit: prompt exceeds the input byte budget");
  const turnId = `${input.task ?? "generation"}_${randomUUID()}`;
  let text = "";
  let outputBytes = 0;
  let completed = false;
  for await (const chunk of abortableStream(provider.stream({
    turnId, attemptId: turnId, step: 1, signal: input.signal, temperature: input.temperature,
    maxOutputTokens: provider.capabilities?.maxOutputTokens,
    context: { turnId, sessionId: input.task ?? "generation", messages },
  }), input.signal)) {
    input.signal?.throwIfAborted();
    if (completed && (chunk.text || chunk.reasoning || chunk.isFinal || chunk.toolCalls?.length)) throw new Error("llm_incomplete_output: content after final response");
    outputBytes += utf8.encode(chunk.text ?? "").length + utf8.encode(chunk.reasoning ?? "").length;
    if (outputBytes > MAX_GENERATION_BYTES ||
      chunk.usage?.completionTokens !== undefined && provider.capabilities?.maxOutputTokens !== undefined && chunk.usage.completionTokens > provider.capabilities.maxOutputTokens) {
      throw new Error("llm_output_limit: generated output exceeds the output budget");
    }
    if (chunk.toolCalls?.length || chunk.stopReason && chunk.stopReason !== "stop") throw new Error(`llm_incomplete_output: ${chunk.stopReason ?? "unexpected tool calls"}`);
    text += chunk.text ?? "";
    if (chunk.isFinal) completed = true;
  }
  input.signal?.throwIfAborted();
  if (!completed) throw new Error("llm_incomplete_output: provider ended without a final response");
  if (!text.trim()) throw new Error("llm_empty_output: model returned no content");
  return text;
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
      const provider = createConfiguredModelProvider(config, { localOnly: input.localOnly, requireLocalProvider: true }, registry);
      return generateModelText(provider, input);
    },
  };
}
