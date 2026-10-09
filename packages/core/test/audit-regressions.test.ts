import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlContext, createComposedContextBuilder, createOpenAICompatProvider, createScriptedProvider, defaultContextBuilder, executeTurn, InMemoryExecutionStore, InMemoryInbox } from "../src/index.js";
import { runToolExecution } from "../src/tool-pipeline.js";
import { classifyToolOutcome } from "../src/tool-ledger.js";
import type { ModelChunk } from "../src/types.js";

const input = { turnId: "t", attemptId: "a", sessionId: "s", userMessage: "start" };
const seeded = () => { const store = new InMemoryExecutionStore(); store.seedAttempt({ id: "a", turnId: "t" }); return store; };
afterEach(() => vi.unstubAllGlobals());

describe("audit: execution boundaries", () => {
  it("approval cannot authorize a write after cancellation", async () => {
    const store = seeded(); const execute = vi.fn(async () => ({ ok: true }));
    const result = await executeTurn({ execution: store, contextBuilder: defaultContextBuilder,
      provider: createScriptedProvider([{ text: "", toolCalls: [{ id: "c", name: "write", arguments: {} }] }]),
      tools: { tools: [{ name: "write", readOnly: false, description: "write" }], execute },
      approvalPolicy: { async evaluate() { await store.requestCancelAttempt(input); return { action: "allow" }; } },
    }, input);
    expect(result.status).toBe("cancelled"); expect(execute).not.toHaveBeenCalled();
  });

  it.each(["length", "content_filter", "invalid_tool_arguments"])("%s never executes any tools", async reason => {
    const execute = vi.fn(async () => ({ ok: true }));
    const chunks: ModelChunk[] = [{ text: "partial", isFinal: false, toolCalls: [{ id: "c", name: "write", arguments: {} }] }, { text: "", isFinal: true, stopReason: reason }];
    const result = await executeTurn({ execution: seeded(), contextBuilder: defaultContextBuilder,
      provider: { id: "fixture", async *stream() { yield* chunks; } }, tools: { tools: [], execute },
    }, input);
    expect(result).toMatchObject({ status: "interrupted", reason: `model_${reason}` }); expect(execute).not.toHaveBeenCalled();
  });

  it.each(["length", "content_filter", "tool_calls", null])("OpenAI malformed arguments and %s are fail closed", async finish_reason => {
    const payload = { choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "write", arguments: '{"value":' } }] }, finish_reason }] };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`)));
    const chunks: ModelChunk[] = [];
    for await (const chunk of createOpenAICompatProvider({ baseUrl: "http://fixture/v1", modelId: "test" }).stream({ ...input, step: 1, context: { turnId: "t", sessionId: "s", messages: [] } })) chunks.push(chunk);
    expect(chunks.flatMap(c => c.toolCalls ?? [])).toEqual([]);
    expect(chunks.at(-1)?.stopReason).toBe(finish_reason === "tool_calls" ? "invalid_tool_arguments" : finish_reason ?? "incomplete");
  });

  it("DONE releases a stream even if HTTP remains open", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')); }, cancel });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
    const chunks = [];
    for await (const c of createOpenAICompatProvider({ baseUrl: "http://fixture/v1", modelId: "test", timeoutMs: 30 }).stream({ ...input, step: 1, context: { turnId: "t", sessionId: "s", messages: [] } })) chunks.push(c);
    expect(chunks.at(-1)?.stopReason).toBe("stop"); expect(cancel).toHaveBeenCalled();
  });

  it("acknowledged steer reaches the actual provider request", async () => {
    const inbox = new InMemoryInbox();
    await inbox.enqueue({ sessionId: "s", attemptId: "a", type: "steer", sourceActor: "user", payload: { text: "FOCUS_THIS" }, idempotencyKey: "steer" });
    let messages = "";
    await executeTurn({ execution: seeded(), inbox, contextBuilder: createComposedContextBuilder({ inbox: true }),
      provider: { id: "capture", async *stream(request) { messages = JSON.stringify(request.context.messages); yield { text: "ok", isFinal: true }; } },
    }, input);
    expect(messages).toContain("FOCUS_THIS"); expect(inbox.list()[0]?.status).toBe("acknowledged");
  });

  it("tool deadline remains timeout in the ledger with ControlContext enabled", async () => {
    const control = new ControlContext();
    try {
      const result = await runToolExecution({ ...input, executionId: "a:1:1", call: { id: "c", name: "slow", arguments: {} }, control, toolTimeoutMs: 5,
        tools: { tools: [], execute: () => new Promise(() => {}) }, prematureTermination: async () => null,
        finalizeInterrupted: async reason => ({ status: "interrupted", attemptId: "a", reason }),
      });
      expect(classifyToolOutcome(result)).toBe("timeout_error");
    } finally { control.dispose(); }
  });
});
