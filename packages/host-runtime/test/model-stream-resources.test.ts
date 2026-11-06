import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelChunk, ModelProviderPort, ModelRequest } from "@aervox/core";
import { createModelStreamResources, ModelStreamAdmissionError, ModelStreamDrainError } from "../src/modules/ecosystem/llm/model-resources.js";

const request: ModelRequest = { turnId: "t", attemptId: "a", step: 1, context: { turnId: "t", sessionId: "s", messages: [] } };
const done = { done: true as const, value: undefined };
const chunk = { done: false as const, value: { text: "chunk", isFinal: false } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 6; i++) await Promise.resolve(); }
function controlled() {
  const nextResult = deferred<IteratorResult<ModelChunk>>();
  const returnResult = deferred<IteratorResult<ModelChunk>>();
  const next = vi.fn(() => nextResult.promise);
  const close = vi.fn(() => returnResult.promise);
  const stream = vi.fn((_input: ModelRequest) => ({ [Symbol.asyncIterator]: () => ({ next, return: close }) }));
  const provider: ModelProviderPort = { id: "fixture", capabilities: { toolCalls: true, reasoning: true, maxOutputTokens: 100 }, stream };
  return { provider, stream, next, close, nextResult, returnResult };
}
afterEach(() => vi.useRealTimers());

describe("Host shared model-stream resources", () => {
  it.each([0, 33, 1.5, NaN, Infinity])("refuses an invalid configured limit %s", limit => {
    expect(() => createModelStreamResources(limit)).toThrow("invalid_model_stream_concurrency");
  });
  it("admits lazily and refuses saturation immediately without invoking or queueing another upstream", async () => {
    const resources = createModelStreamResources(1);
    const first = controlled();
    const other = controlled();
    const wrapped = resources.wrap(Object.freeze(first.provider));
    expect(wrapped.id).toBe(first.provider.id);
    expect(wrapped.capabilities).toBe(first.provider.capabilities);
    const active = wrapped.stream(request)[Symbol.asyncIterator]();
    const rejected = resources.wrap(other.provider).stream(request)[Symbol.asyncIterator]();
    expect(resources.snapshot.active).toBe(0);
    const pending = active.next();
    await expect(rejected.next()).rejects.toMatchObject({ name: "ModelStreamAdmissionError", code: "MODEL_STREAM_LIMIT" });
    expect(other.stream).not.toHaveBeenCalled();
    first.nextResult.resolve(done);
    await pending;
    await flush();
    expect(resources.snapshot.active).toBe(0);
    expect(other.stream).not.toHaveBeenCalled();
    await resources.close();
  });
  it.each(["return", "throw", "cancel"] as const)("does not acquire after %s before first next", async action => {
    const resources = createModelStreamResources(1);
    const source = controlled();
    const iterator = resources.wrap(source.provider).stream({ ...request,
      ...(action === "cancel" ? { signal: AbortSignal.abort(new Error("pre_cancelled")) } : {}),
    })[Symbol.asyncIterator]();
    if (action === "return") await iterator.return!();
    else if (action === "throw") await expect(iterator.throw!(new Error("consumer_error"))).rejects.toThrow("consumer_error");
    if (action === "cancel") await expect(iterator.next()).rejects.toThrow("pre_cancelled");
    else expect(await iterator.next()).toEqual(done);
    expect(resources.snapshot.active).toBe(0);
    expect(source.stream).not.toHaveBeenCalled();
    await resources.close();
  });
  it("does not reacquire after synchronous upstream creation failure", async () => {
    const resources = createModelStreamResources(1);
    const stream = vi.fn(() => { throw new Error("creation_failed"); });
    const iterator = resources.wrap({ id: "fixture", stream }).stream(request)[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow("creation_failed");
    expect(await iterator.next()).toEqual(done);
    expect(stream).toHaveBeenCalledOnce();
    expect(resources.snapshot.active).toBe(0);
    await resources.close();
  });
  it.each(["next first", "return first"])("retains capacity until both physical operations finish: %s", async order => {
    const resources = createModelStreamResources(1);
    const source = controlled();
    const abort = new AbortController();
    const iterator = resources.wrap(source.provider).stream({ ...request, signal: abort.signal })[Symbol.asyncIterator]();
    const pending = iterator.next();
    const rejection = expect(pending).rejects.toThrow("cancelled_wait");
    abort.abort(new Error("cancelled_wait"));
    await rejection;
    expect(source.close).toHaveBeenCalledOnce();
    if (order === "next first") source.nextResult.resolve(chunk);
    else source.returnResult.resolve(done);
    await flush();
    expect(resources.snapshot.active).toBe(1);
    const replacement = controlled();
    await expect(resources.wrap(replacement.provider).stream(request)[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(ModelStreamAdmissionError);
    expect(replacement.stream).not.toHaveBeenCalled();
    if (order === "next first") source.returnResult.resolve(done);
    else source.nextResult.resolve(chunk);
    await flush();
    expect(resources.snapshot.active).toBe(0);
    const accepted = resources.wrap(replacement.provider).stream(request)[Symbol.asyncIterator]().next();
    replacement.nextResult.resolve(done);
    await accepted;
    await resources.close();
  });
  it("rejects overlapping next calls instead of adding an iterator queue", async () => {
    const resources = createModelStreamResources(1);
    const source = controlled();
    const iterator = resources.wrap(source.provider).stream(request)[Symbol.asyncIterator]();
    const first = iterator.next();
    await expect(iterator.next()).rejects.toMatchObject({ code: "MODEL_STREAM_BUSY" });
    expect(source.next).toHaveBeenCalledOnce();
    source.nextResult.resolve(done);
    await first;
    await resources.close();
  });
  it.each(["break", "consumer error"])("awaits actual generator cleanup on %s", async action => {
    const resources = createModelStreamResources(1);
    const cleanup = deferred<void>();
    const provider: ModelProviderPort = { id: "generator", async *stream() {
      try { yield chunk.value; } finally { await cleanup.promise; }
    } };
    const work = (async () => {
      for await (const _chunk of resources.wrap(provider).stream(request)) {
        if (action === "consumer error") throw new Error("consumer_failed");
        break;
      }
    })();
    const settled = vi.fn();
    const observed = work.then(settled, error => { settled(); if (action === "consumer error") expect(error.message).toBe("consumer_failed"); else throw error; });
    await flush();
    expect(resources.snapshot.active).toBe(1);
    expect(settled).not.toHaveBeenCalled();
    cleanup.resolve();
    await observed;
    expect(resources.snapshot.active).toBe(0);
    await resources.close();
  });
  it.each(["sync", "async"])("observes %s upstream next failure and waits for cleanup", async kind => {
    const resources = createModelStreamResources(1);
    const cleanup = deferred<IteratorResult<ModelChunk>>();
    const provider: ModelProviderPort = { id: "failure", stream: () => ({ [Symbol.asyncIterator]: () => ({
      next: () => { if (kind === "sync") throw new Error("next_failed"); return Promise.reject(new Error("next_failed")); },
      return: () => cleanup.promise,
    }) }) };
    await expect(resources.wrap(provider).stream(request)[Symbol.asyncIterator]().next()).rejects.toThrow("next_failed");
    expect(resources.snapshot.active).toBe(1);
    cleanup.resolve(done);
    await flush();
    expect(resources.snapshot.active).toBe(0);
    await resources.close();
  });
  it("awaits actual cleanup for an explicit consumer throw and preserves its error", async () => {
    const resources = createModelStreamResources(1);
    const source = controlled();
    const iterator = resources.wrap(source.provider).stream(request)[Symbol.asyncIterator]();
    const next = iterator.next(); source.nextResult.resolve(chunk); await next;
    const thrown = iterator.throw!(new Error("explicit_consumer_failure"));
    const rejected = expect(thrown).rejects.toThrow("explicit_consumer_failure");
    expect(source.close).toHaveBeenCalledOnce();
    expect(resources.snapshot.active).toBe(1);
    source.returnResult.resolve(done); await rejected;
    expect(resources.snapshot.active).toBe(0);
    await resources.close();
  });
  it("revokes admission and closes a consumer paused after a yield", async () => {
    const resources = createModelStreamResources(1);
    const source = controlled();
    const iterator = resources.wrap(source.provider).stream(request)[Symbol.asyncIterator]();
    const next = iterator.next();
    source.nextResult.resolve(chunk);
    await next;
    const closing = resources.close();
    expect(resources.snapshot.closed).toBe(true);
    expect(source.stream.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    expect(source.close).toHaveBeenCalledOnce();
    const other = controlled();
    await expect(resources.wrap(other.provider).stream(request)[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "MODEL_STREAM_CLOSED" });
    source.returnResult.resolve(done);
    await closing;
    expect(await iterator.next()).toEqual(done);
    expect(resources.snapshot.active).toBe(0);
  });
  it("fails drain on its fixed deadline without releasing an unresolved stream; a confirmed late drain can be rechecked", async () => {
    vi.useFakeTimers();
    const resources = createModelStreamResources(1, { drainTimeoutMs: 50 });
    const source = controlled();
    const next = resources.wrap(source.provider).stream(request)[Symbol.asyncIterator]().next();
    const rejectedNext = expect(next).rejects.toThrow("host_shutdown");
    const closing = resources.close();
    expect(resources.close()).toBe(closing);
    const rejectedClose = expect(closing).rejects.toBeInstanceOf(ModelStreamDrainError);
    source.returnResult.resolve(done);
    await vi.advanceTimersByTimeAsync(50);
    await rejectedNext;
    await rejectedClose;
    expect(resources.snapshot.active).toBe(1);
    source.nextResult.reject(new Error("late_next_failure"));
    await flush();
    await resources.close();
    expect(resources.snapshot.active).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["reject", "unfinished", "missing"])("fails closed when upstream cleanup is %s", async failure => {
    const resources = createModelStreamResources(1, { drainTimeoutMs: 50 });
    const provider: ModelProviderPort = { id: "bad_cleanup", stream: () => ({ [Symbol.asyncIterator]: () => ({
      next: async () => chunk,
      ...(failure === "missing" ? {} : { return: async () => { if (failure === "reject") throw new Error("return_failed"); return chunk; } }),
    }) }) };
    const iterator = resources.wrap(provider).stream(request)[Symbol.asyncIterator]();
    await iterator.next();
    await expect(resources.close()).rejects.toBeInstanceOf(ModelStreamDrainError);
    expect(resources.snapshot.active).toBe(1);
    await expect(resources.close()).rejects.toBeInstanceOf(ModelStreamDrainError);
  });
});
