import { describe, expect, it, vi } from "vitest";
import { ControlContext, defaultContextBuilder, executeTurn, InMemoryExecutionStore } from "../src/index.js";
import type { ModelChunk, ModelProviderPort } from "../src/index.js";
const input = { turnId: "t", attemptId: "a", sessionId: "s", userMessage: "hello" };
const seeded = () => { const s = new InMemoryExecutionStore(); s.seedAttempt({ id: "a", turnId: "t" }); return s; };
const pendingProvider: ModelProviderPort = { id: "silent", stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }) };

describe("bounded streaming", () => {
  it.each(["cancel", "timeout", "deletion"])("quiet provider terminates for %s", async kind => {
    const store = seeded(); let blocked = false;
    const job = executeTurn({ execution: store, provider: pendingProvider, contextBuilder: defaultContextBuilder,
      deletionGate: { isBlocked: async () => blocked }, options: { maxTurnDurationMs: kind === "timeout" ? 20 : 0 },
    }, input);
    if (kind === "cancel") await store.requestCancelAttempt(input);
    if (kind === "deletion") blocked = true;
    const result = await job;
    expect(result).toMatchObject(kind === "cancel" ? { status: "cancelled" } : { status: "interrupted", reason: kind === "timeout" ? "turn_timeout" : "deletion_blocked" });
  });

  it("persists text while the provider waits and never repeats the visible prefix on error", async () => {
    const store = seeded(); let reject!: (reason: Error) => void;
    const gate = new Promise<void>((_, r) => { reject = r; });
    const stream = vi.fn(async function* () { yield { text: "early", isFinal: false }; await gate; });
    const job = executeTurn({ execution: store, contextBuilder: defaultContextBuilder, provider: { id: "slow", stream } }, input);
    await vi.waitFor(async () => expect((await store.listEvents("t")).filter(e => e.eventType === "delta")).toHaveLength(1));
    reject(new Error("stream broke")); await job;
    expect(stream).toHaveBeenCalledTimes(1);
    expect((await store.listEvents("t")).filter(e => e.eventType === "delta").map(e => e.data.text).join("")).toBe("early");
  });

  it("a partial host batch failure cannot retry an already visible prefix", async () => {
    const store = seeded();
    const original = store.recordSafeSegments.bind(store);
    vi.spyOn(store, "recordSafeSegments").mockImplementation(async inputs => {
      await original(inputs.slice(0, 1));
      throw new Error("commit acknowledgement lost");
    });
    const stream = vi.fn(async function* () { yield { text: "x".repeat(4096), isFinal: true }; });
    const result = await executeTurn({ execution: store, contextBuilder: defaultContextBuilder, provider: { id: "partial-store", stream } }, input);
    expect(result.status).toBe("failed"); expect(stream).toHaveBeenCalledOnce();
    expect((await store.listEvents("t")).filter(e => e.eventType === "delta")).toHaveLength(1);
  });

  it("large Unicode chunks are persisted in <= 4096 byte transactions without splitting characters", async () => {
    const store = seeded(); const batches: number[] = [];
    const original = store.recordSafeSegments.bind(store);
    vi.spyOn(store, "recordSafeSegments").mockImplementation(async inputs => { batches.push(inputs.reduce((n, i) => n + new TextEncoder().encode(i.text).length, 0)); await original(inputs); });
    const content = "🎵你".repeat(2000);
    await executeTurn({ execution: store, contextBuilder: defaultContextBuilder, provider: { id: "large", async *stream() { yield { text: content, isFinal: true }; } } }, input);
    expect(Math.max(...batches)).toBeLessThanOrEqual(4096);
    expect((await store.listEvents("t")).filter(e => e.eventType === "delta").map(e => e.data.text).join("")).toBe(content);
  });

  it("enforces a response ceiling for custom providers", async () => {
    const calls = vi.fn(async () => ({ ok: true }));
    const result = await executeTurn({ execution: seeded(), contextBuilder: defaultContextBuilder, tools: { tools: [], execute: calls },
      provider: { id: "oversize", async *stream() { yield { text: "x".repeat(8 * 1024 * 1024), isFinal: true }; } }, options: { maxModelRetries: 0 },
    }, input);
    expect(result.status).toBe("failed"); expect(calls).not.toHaveBeenCalled();
  });

  it("incomplete custom streams cannot execute tool calls", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const result = await executeTurn({ execution: seeded(), contextBuilder: defaultContextBuilder, tools: { tools: [], execute },
      provider: { id: "incomplete", async *stream(): AsyncIterable<ModelChunk> { yield { text: "", isFinal: false, toolCalls: [{ id: "c", name: "write", arguments: {} }] }; } },
    }, input);
    expect(result).toMatchObject({ status: "interrupted", reason: "model_incomplete" }); expect(execute).not.toHaveBeenCalled();
  });

  it("execution cancellation does not abort the parent control", async () => {
    const parent = new ControlContext(); const store = seeded();
    const job = executeTurn({ execution: store, contextBuilder: defaultContextBuilder, provider: pendingProvider, controlContext: parent }, input);
    await store.requestCancelAttempt(input); await job;
    expect(parent.isAborted()).toBe(false); parent.dispose();
  });
});
