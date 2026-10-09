import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAICompatProvider, defaultContextBuilder, executeTurn, InMemoryExecutionStore } from "../src/index.js";
import type { ModelChunk, ModelProviderPort } from "../src/index.js";

afterEach(() => vi.unstubAllGlobals());

function providerResponse(reason: string | null, argumentsText = '{"path":"notes.txt"}') {
  const events = [
    { choices: [{ delta: { content: "准备写入", tool_calls: [
      { index: 0, id: "c1", function: { name: "write_note", arguments: argumentsText } },
    ] }, finish_reason: reason }] },
  ];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
  )));
  return createOpenAICompatProvider({ baseUrl: "http://model.invalid/v1", modelId: "test" });
}

async function run(provider: ModelProviderPort) {
  const store = new InMemoryExecutionStore();
  store.seedAttempt({ id: "attempt", turnId: "turn" });
  const execute = vi.fn(async () => ({ ok: true, output: "written" }));
  const result = await executeTurn({
    execution: store, provider, contextBuilder: defaultContextBuilder,
    tools: { tools: [{ name: "write_note", readOnly: false }], execute },
    options: { maxModelRetries: 0 },
  }, { turnId: "turn", attemptId: "attempt", sessionId: "session", userMessage: "write" });
  return { store, result, execute, events: await store.listEvents("turn") };
}

describe("abnormal model termination", () => {
  it.each(["length", "content_filter", "incomplete"])("%s never executes a valid-looking tool fragment", async (reason) => {
    const { result, execute, events, store } = await run(providerResponse(reason === "incomplete" ? null : reason));
    expect(result).toMatchObject({ status: "interrupted", reason: `model_${reason}` });
    expect(execute).not.toHaveBeenCalled();
    expect(store.toolExecutionRecords()).toHaveLength(0);
    expect(events.filter((event) => event.eventType === "done")).toHaveLength(1);
    expect(events.at(-1)?.data).toMatchObject({ status: "Interrupted", isComplete: false });
    if (reason === "content_filter") expect(events.some((event) => event.eventType === "delta")).toBe(false);
  });

  it("a custom provider's early tool calls are invalidated by its later length terminal", async () => {
    const provider: ModelProviderPort = { id: "custom", async *stream(): AsyncIterable<ModelChunk> {
      yield { text: "", isFinal: false, toolCalls: [{ id: "c", name: "write_note", arguments: { path: "notes.txt" } }] };
      yield { text: "", isFinal: true, stopReason: "length" };
    } };
    const { result, execute } = await run(provider);
    expect(result).toMatchObject({ status: "interrupted", reason: "model_length" });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['{"path":', '"notes.txt"', "null", "[]"])("rejects malformed/non-object arguments: %s", async (args) => {
    const { result, execute } = await run(providerResponse("tool_calls", args));
    expect(result).toMatchObject({ status: "interrupted", reason: "model_invalid_tool_arguments" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("accumulated tools at a normal text terminal fail closed as incomplete", async () => {
    const { result, execute } = await run(providerResponse("stop"));
    expect(result).toMatchObject({ status: "interrupted", reason: "model_incomplete" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("damaged SSE frames never permit tool effects", async () => {
    const damaged = "data: {broken json}\n\n";
    const validCall = { choices: [{ delta: { tool_calls: [
      { index: 0, id: "c1", function: { name: "write_note", arguments: "{}" } },
    ] }, finish_reason: "tool_calls" }] };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      `data: ${JSON.stringify(validCall)}\n\n` + damaged,
    )));
    const { result, execute } = await run(createOpenAICompatProvider({ baseUrl: "http://model.invalid", modelId: "test" }));
    expect(result.status).toBe("failed");
    expect(execute).not.toHaveBeenCalled();
  });

  it("cache tokens remain a subset of input usage, not additional token usage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [], usage: { total_tokens: 130, prompt_tokens: 100, completion_tokens: 30,
        prompt_tokens_details: { cached_tokens: 80 }, cache_creation_input_tokens: 10 } })}\n\n` + "data: [DONE]\n\n",
    )));
    const chunks: ModelChunk[] = [];
    const provider = createOpenAICompatProvider({ baseUrl: "http://model.invalid", modelId: "test" });
    for await (const chunk of provider.stream({ turnId: "t", attemptId: "a", step: 1,
      context: { turnId: "t", sessionId: "s", messages: [] }, maxOutputTokens: 40 })) chunks.push(chunk);
    expect(chunks.find((chunk) => chunk.usage)?.usage).toEqual({
      totalTokens: 130, promptTokens: 100, completionTokens: 30, cacheReadTokens: 80, cacheWriteTokens: 10,
    });
  });
});
