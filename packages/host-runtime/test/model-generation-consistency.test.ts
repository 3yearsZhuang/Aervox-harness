import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultModelProviderRegistry, ModelProviderRegistry, type ModelChunk, type ModelProviderPort } from "@aervox/core";
import type { ExecutionConfig } from "@aervox/config";
import type { LLMConfigResponse, ModelRoutingSnapshot } from "@aervox/contracts";
import { buildLoopProvider, createLLMCallable } from "../src/modules/companion/conversation/llm-adapter.js";
import { createModelGenerationPort } from "../src/modules/ecosystem/llm/generation.js";
import { createConfiguredModelProvider } from "../src/modules/ecosystem/llm/provider-config.js";

const context = { workspaceId: "local", subjectUserId: "local" };
const config: LLMConfigResponse = { enabled: true, providerType: "ollama", baseUrl: "http://127.0.0.1:11434/v1", modelId: "test", temperature: .7, maxTokens: 4096, settings: {} };
const executionConfig = { loopProvider: "llm", modelRoutingFeatureFlags: new Set() } as ExecutionConfig;
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function consumer(kind: "domain" | "plugin", provider: ModelProviderPort) {
  if (kind === "plugin") {
    const callable = createLLMCallable(provider);
    return (user = "user", signal?: AbortSignal) => callable.generate(user, { systemPrompt: "system", signal });
  }
  const registry = new ModelProviderRegistry(true);
  registry.register(registry.getDescriptor("ollama")!, () => provider);
  const generation = createModelGenerationPort({ getConfig: async () => config }, registry);
  return (user = "user", signal?: AbortSignal) => generation.generate({ context, system: "system", user, signal });
}

describe.each(["domain", "plugin"] as const)("single-shot %s contract", kind => {
  function fixture(chunks: ModelChunk[], maxOutputTokens?: number) {
    const stream = vi.fn(async function* () { yield* chunks; });
    const provider: ModelProviderPort = { id: "fixture", stream,
      ...(maxOutputTokens === undefined ? {} : { capabilities: { toolCalls: true, reasoning: true, maxOutputTokens } }),
    };
    return { generate: consumer(kind, provider), stream };
  }
  it("accepts a complete answer and trailing usage", async () => {
    const { generate } = fixture([{ text: "answer", isFinal: true, stopReason: "stop" }, { text: "", isFinal: false, usage: { totalTokens: 3, completionTokens: 1 } }]);
    expect(await generate()).toBe("answer");
  });
  it.each(["length", "content_filter", "tool_calls", "incomplete"])("refuses %s partial output", async stopReason => {
    await expect(fixture([{ text: "partial", isFinal: true, stopReason }]).generate()).rejects.toThrow("llm_incomplete_output");
  });
  it("refuses early EOF, empty final output and post-final content", async () => {
    await expect(fixture([{ text: "partial", isFinal: false }]).generate()).rejects.toThrow("llm_incomplete_output");
    await expect(fixture([{ text: " ", isFinal: true }]).generate()).rejects.toThrow("llm_empty_output");
    await expect(fixture([{ text: "answer", isFinal: true }, { text: "late", isFinal: false }]).generate()).rejects.toThrow("llm_incomplete_output");
  });
  it("refuses tool intent even when a provider incorrectly labels it as a normal stop", async () => {
    await expect(fixture([{ text: "answer", isFinal: true, stopReason: "stop", toolCalls: [{ id: "t", name: "write", arguments: {} }] }]).generate()).rejects.toThrow("llm_incomplete_output");
  });
  it("bounds UTF-8 prompt bytes before invoking the stream", async () => {
    const { generate, stream } = fixture([{ text: "answer", isFinal: true }]);
    await expect(generate("汉".repeat(85_334))).rejects.toThrow("llm_input_limit");
    expect(stream).not.toHaveBeenCalled();
  });
  it("bounds text and reasoning by UTF-8 bytes rather than JavaScript character count", async () => {
    await expect(fixture([{ text: "汉".repeat(85_334), isFinal: true }]).generate()).rejects.toThrow("llm_output_limit");
    await expect(fixture([{ text: "answer", reasoning: "汉".repeat(85_334), isFinal: true }]).generate()).rejects.toThrow("llm_output_limit");
  });
  it("checks reported output usage even when it arrives after the final choice", async () => {
    await expect(fixture([{ text: "answer", isFinal: true }, { text: "", isFinal: false, usage: { totalTokens: 11, completionTokens: 11 } }], 10).generate()).rejects.toThrow("llm_output_limit");
  });
  it("rejects pre-cancellation before invoking the provider", async () => {
    const { generate, stream } = fixture([{ text: "answer", isFinal: true }]);
    await expect(generate("user", AbortSignal.abort(new Error("cancelled")))).rejects.toThrow("cancelled");
    expect(stream).not.toHaveBeenCalled();
  });
  it("cancels a silent uncooperative provider and closes its iterator", async () => {
    const next = vi.fn(() => new Promise<IteratorResult<ModelChunk>>(() => {}));
    const close = vi.fn(async () => ({ done: true as const, value: undefined }));
    const generate = consumer(kind, { id: "silent", stream: () => ({ [Symbol.asyncIterator]: () => ({ next, return: close }) }) });
    const controller = new AbortController();
    const promise = generate("user", controller.signal);
    const rejection = expect(promise).rejects.toThrow("cancelled_silent");
    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
    controller.abort(new Error("cancelled_silent"));
    await rejection;
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("shared provider configuration for Loop and single-shot generation", () => {
  it.each([
    { ...config, enabled: false },
    { ...config, providerType: "anthropic" },
    { ...config, providerType: "unregistered_provider" },
  ])("refuses unavailable configurations before provider creation on both paths: $providerType $enabled", async found => {
    const create = vi.spyOn(defaultModelProviderRegistry, "createProvider");
    await expect(buildLoopProvider(context, { getConfig: async () => found } as never, { executionConfig })).rejects.toThrow("llm_disabled");
    await expect(createModelGenerationPort({ getConfig: async () => found }).generate({ context, system: "system", user: "user" })).rejects.toThrow("llm_disabled");
    expect(create).not.toHaveBeenCalled();
  });
  it("uses identical discovered context, output reserve and idle timeout for ordinary Loop and domain calls", async () => {
    const found = { ...config, settings: { contextWindow: 2048, requestTimeoutMs: 90_000 } };
    const create = vi.spyOn(defaultModelProviderRegistry, "createProvider").mockImplementation(() => ({ id: "fixture", async *stream() { yield { text: "answer", isFinal: true }; } }));
    await buildLoopProvider(context, { getConfig: async () => found } as never, { executionConfig });
    await createModelGenerationPort({ getConfig: async () => found }).generate({ context, system: "system", user: "user" });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
    expect(create.mock.calls[0]?.[1]).toMatchObject({ contextWindowTokens: 2048, maxTokens: 1024, timeoutMs: 90_000 });
  });
  it("preserves routing output tier limits while applying the same preset settings", async () => {
    const snapshot = { tier: "L1", providerType: "ollama", baseUrl: config.baseUrl, modelId: "routed", presetId: "preset", localAttestation: true } as ModelRoutingSnapshot;
    const preset = { ...config, id: "preset", name: "preset", isActive: true, settings: { contextWindow: 8192, requestTimeoutMs: 90_000 } };
    const create = vi.spyOn(defaultModelProviderRegistry, "createProvider").mockImplementation(() => ({ id: "fixture", async *stream() {} }));
    const provider = await buildLoopProvider(context, { listPresets: async () => ({ presets: [preset], activeId: preset.id }) } as never, {
      executionConfig: { ...executionConfig, modelRoutingFeatureFlags: new Set(["model_routing", "capability_tiering"]) },
      modelRoutingService: { getRoutingSnapshot: async () => snapshot } as never, requireLocalOnly: true,
    });
    expect(create.mock.calls[0]?.[1]).toMatchObject({ contextWindowTokens: 8192, maxTokens: 2048, timeoutMs: 90_000, redirect: "error" });
    expect((provider as unknown as { routingSnapshot: ModelRoutingSnapshot }).routingSnapshot).toBe(snapshot);
  });
  it.each(["missing attestation", "remote endpoint", "disabled preset", "unsupported protocol"])("preserves routing admission for %s", async failure => {
    const snapshot = {
      tier: "L1", providerType: failure === "unsupported protocol" ? "anthropic" : "ollama",
      baseUrl: failure === "remote endpoint" ? "https://model.example/v1" : config.baseUrl,
      modelId: "routed", presetId: "preset", localAttestation: failure !== "missing attestation",
    } as ModelRoutingSnapshot;
    const preset = { ...config, enabled: failure !== "disabled preset", id: "preset", name: "preset", isActive: true };
    const create = vi.spyOn(defaultModelProviderRegistry, "createProvider");
    await expect(buildLoopProvider(context, { listPresets: async () => ({ presets: [preset], activeId: preset.id }) } as never, {
      executionConfig: { ...executionConfig, modelRoutingFeatureFlags: new Set(["model_routing", "capability_tiering"]) },
      modelRoutingService: { getRoutingSnapshot: async () => snapshot } as never, requireLocalOnly: true,
    })).rejects.toThrow(failure === "missing attestation" || failure === "remote endpoint" ? "proactive_local_provider_required" : "llm_disabled");
    expect(create).not.toHaveBeenCalled();
  });
  it("never widens a small configured output allowance to the context reserve minimum", () => {
    const create = vi.spyOn(defaultModelProviderRegistry, "createProvider");
    createConfiguredModelProvider({ ...config, maxTokens: 32, settings: { contextWindow: 2048 } });
    expect(create.mock.calls[0]?.[1]?.maxTokens).toBe(32);
  });
  it.each([{ contextWindow: 0 }, { contextWindow: 1.5 }, { requestTimeoutMs: 2_147_483_648 }])("rejects malformed explicit limits without creating a provider: %j", settings => {
    const create = vi.spyOn(defaultModelProviderRegistry, "createProvider");
    expect(() => createConfiguredModelProvider({ ...config, settings })).toThrow("llm_invalid_config");
    expect(create).not.toHaveBeenCalled();
  });
  it("preserves stricter local-provider classification for domain generation and endpoint attestation for Loop", async () => {
    const found = { ...config, providerType: "openai" };
    await expect(createModelGenerationPort({ getConfig: async () => found }).generate({ context, system: "system", user: "user", localOnly: true })).rejects.toThrow("llm_disabled");
    expect(createConfiguredModelProvider(found, { localOnly: true }).id).toBe("openai-compat");
    expect(() => createConfiguredModelProvider({ ...found, baseUrl: "https://example.com" }, { localOnly: true })).toThrow("proactive_local_provider_required");
  });
  it("applies discovered context checks before network I/O for both one-shot adapters", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const found = { ...config, settings: { contextWindow: 2048 } };
    const provider = createConfiguredModelProvider(found);
    await expect(createLLMCallable(provider).generate("x".repeat(1600))).rejects.toThrow("context_window_exceeded");
    await expect(createModelGenerationPort({ getConfig: async () => found }).generate({ context, system: "system", user: "x".repeat(1600) })).rejects.toThrow("context_window_exceeded");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("applies the configured Core idle timeout to both one-shot adapters", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")), { once: true });
    }));
    vi.stubGlobal("fetch", fetch);
    const found = { ...config, settings: { requestTimeoutMs: 90_000 } };
    const plugin = createLLMCallable(createConfiguredModelProvider(found)).generate("user");
    const domain = createModelGenerationPort({ getConfig: async () => found }).generate({ context, system: "system", user: "user" });
    const rejections = [expect(plugin).rejects.toThrow("llm_timeout"), expect(domain).rejects.toThrow("llm_timeout")];
    await vi.advanceTimersByTimeAsync(89_999);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(rejections);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["domain", "plugin"] as const)("keeps %s generation alive on raw SSE heartbeats past the idle duration", async kind => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
    const found = { ...config, settings: { requestTimeoutMs: 90_000 } };
    const provider = createConfiguredModelProvider(found);
    const promise = kind === "plugin"
      ? createLLMCallable(provider).generate("user")
      : createModelGenerationPort({ getConfig: async () => found }).generate({ context, system: "system", user: "user" });
    let settled = false;
    void promise.then(() => { settled = true; }, () => { settled = true; });
    const heartbeat = setInterval(() => controller.enqueue(encoder.encode(": alive\n\n")), 80_000);
    await vi.advanceTimersByTimeAsync(170_000);
    expect(settled).toBe(false);
    clearInterval(heartbeat);
    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
    controller.close();
    expect(await promise).toBe("answer");
    expect(vi.getTimerCount()).toBe(0);
  });
});
