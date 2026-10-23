import { describe, expect, it, vi } from "vitest";
import { ModelProviderRegistry, type ModelChunk } from "@aervox/core";
import { LLMConfigService } from "../src/modules/ecosystem/llm/service.js";
import { createModelGenerationPort } from "../src/modules/ecosystem/llm/generation.js";

const tenant = { workspaceId: "local", subjectUserId: "local" };
const input = { context: tenant, system: "system", user: "user" };
const config = { enabled: 1, providerType: "ollama", baseUrl: "http://127.0.0.1:11434/v1", modelId: "test", temperature: .7, maxTokens: 1024, settingsJson: {} };
function fixture(found: typeof config | null, chunks: ModelChunk[] = [{ text: "output", isFinal: true, stopReason: "stop" }]) {
  const service = new LLMConfigService({ getConfig: async () => found } as never);
  const registry = new ModelProviderRegistry(true);
  const stream = vi.fn(async function* () { yield* chunks; });
  for (const descriptor of registry.listDescriptors()) {
    if (descriptor.protocol === "openai-compat") registry.register(descriptor, () => ({ id: descriptor.id, stream }));
  }
  return { generation: createModelGenerationPort(service, registry), stream };
}
describe("shared generation provider selection", () => {
  it.each(["ollama", "custom_openai", "openai"])("both triggers use the supported %s protocol", async providerType => {
    const { generation, stream } = fixture({ ...config, providerType });
    expect(await generation.generate({ ...input, task: "diary_generation" })).toBe("output");
    expect(await generation.generate({ ...input, task: "proactive_compose" })).toBe("output");
    expect(stream).toHaveBeenCalledTimes(2);
  });
  it("empty configuration uses the shared host default", async () => {
    const { generation, stream } = fixture(null);
    expect(await generation.generate(input)).toBe("output");
    expect(stream).toHaveBeenCalledTimes(1);
  });
  it.each([{ ...config, enabled: 0 }, { ...config, providerType: "anthropic", baseUrl: "https://api.anthropic.com/v1" }])("disabled or unsupported providers never send requests", async found => {
    const { generation, stream } = fixture(found);
    await expect(generation.generate(input)).rejects.toThrow("llm_disabled");
    expect(stream).not.toHaveBeenCalled();
  });
  it("local-only generation refuses a remote endpoint before network IO", async () => {
    const { generation, stream } = fixture({ ...config, baseUrl: "https://example.com/v1" });
    await expect(generation.generate({ ...input, localOnly: true })).rejects.toThrow("llm_disabled");
    expect(stream).not.toHaveBeenCalled();
  });
  it.each(["length", "content_filter", "tool_calls", "incomplete"])("incomplete %s output is not published as complete", async stopReason => {
    const { generation } = fixture(config, [{ text: "partial", isFinal: true, stopReason }]);
    await expect(generation.generate(input)).rejects.toThrow("llm_incomplete_output");
  });
  it("EOF without final signal and empty output remain failures", async () => {
    await expect(fixture(config, [{ text: "partial", isFinal: false }]).generation.generate(input)).rejects.toThrow("llm_incomplete_output");
    await expect(fixture(config, [{ text: "", isFinal: true, stopReason: "stop" }]).generation.generate(input)).rejects.toThrow("llm_empty_output");
  });
  it("a cancelled generation does not invoke the provider", async () => {
    const { generation, stream } = fixture(config);
    await expect(generation.generate({ ...input, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(stream).not.toHaveBeenCalled();
  });
  it("cancellation stops waiting for an uncooperative configuration query", async () => {
    const generation = createModelGenerationPort({ getConfig: () => new Promise(() => {}) });
    const controller = new AbortController();
    const result = generation.generate({ ...input, signal: controller.signal });
    controller.abort(new Error("cancelled_configuration"));
    await expect(result).rejects.toThrow("cancelled_configuration");
  });
  it("cancellation stops waiting for a silent provider and closes its iterator", async () => {
    const registry = new ModelProviderRegistry(true);
    const descriptor = registry.getDescriptor("ollama")!;
    const next = vi.fn(() => new Promise<IteratorResult<ModelChunk>>(() => {}));
    const close = vi.fn(async () => ({ done: true as const, value: undefined }));
    registry.register(descriptor, () => ({ id: "ollama", stream: () => ({ [Symbol.asyncIterator]: () => ({ next, return: close }) }) }));
    const generation = createModelGenerationPort({ getConfig: async () => config } as never, registry);
    const controller = new AbortController();
    const result = generation.generate({ ...input, signal: controller.signal });
    const rejected = expect(result).rejects.toThrow("cancelled_stream");
    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
    controller.abort(new Error("cancelled_stream"));
    await rejected;
    expect(close).toHaveBeenCalledOnce();
  });
});
