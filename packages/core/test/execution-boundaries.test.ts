import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ControlContext, createComposedContextBuilder, defaultContextBuilder,
  executeTurn, InMemoryExecutionStore,
} from "../src/index.js";
import type { ContextBuilderPort, ExecuteResult, ModelProviderPort, ToolProviderPort } from "../src/index.js";

const input = { turnId: "t", attemptId: "a", sessionId: "s", userMessage: "hello" };
const seeded = () => {
  const store = new InMemoryExecutionStore();
  store.seedAttempt({ id: input.attemptId, turnId: input.turnId });
  return store;
};
const answer: ModelProviderPort = {
  id: "answer",
  async *stream() { yield { text: "answer", isFinal: true }; },
};
const toolCall: ModelProviderPort = {
  id: "tool-call",
  async *stream() {
    yield { text: "", isFinal: true, toolCalls: [{ id: "c", name: "lookup", arguments: {} }] };
  },
};

afterEach(() => vi.useRealTimers());

describe("terminal commit ownership", () => {
  it.each([
    ["completed", "completed_finalize_contested"],
    ["max_steps", "max_steps_finalize_contested"],
    ["pending_approval", "pending_approval_finalize_contested"],
    ["tools_disabled", "tools_disabled_finalize_contested"],
    ["execution error", "execution_error_finalize_contested"],
  ])("reports contested %s without overwriting the winner", async (scenario, reason) => {
    const store = seeded();
    const finalize = store.finalizeAttemptWithEvent.bind(store);
    vi.spyOn(store, "finalizeAttemptWithEvent").mockImplementation(async terminal => {
      // Another runner wins immediately before our final CAS.
      store.seedAttempt({ id: input.attemptId, turnId: input.turnId, status: "Interrupted", fencingToken: 2 });
      return finalize(terminal);
    });
    const tools: ToolProviderPort = {
      tools: [{ name: "lookup", description: "lookup", readOnly: true }],
      execute: async () => scenario === "pending_approval"
        ? { ok: false, needsApproval: { approvalId: "approval", toolName: "lookup", argumentsHash: "hash" } }
        : { ok: true, output: "found" },
    };
    const provider = scenario === "completed" ? answer : scenario === "execution error"
      ? { id: "broken", stream() { throw new Error("provider failed"); } }
      : toolCall;
    const result = await executeTurn({
      execution: store, provider, contextBuilder: defaultContextBuilder,
      tools: scenario === "tools_disabled" ? undefined : tools,
      options: { maxSteps: 1, maxModelRetries: 0 },
    }, input);
    expect(result).toEqual({ status: "failed", attemptId: input.attemptId, reason });
    expect(store.attemptStatus(input.attemptId)).toBe("Interrupted");
    expect((await store.listEvents(input.turnId)).filter(e => e.eventType === "done" || e.eventType === "error")).toEqual([]);
  });
});

describe("cancellable preparation", () => {
  it("preserves deadline termination while a context builder is still pending", async () => {
    vi.useFakeTimers();
    const store = seeded();
    const parent = new ControlContext({ deadlineEpochMs: Date.now() + 25 });
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const stream = vi.fn(answer.stream);
    let result: ExecuteResult | undefined;
    const job = executeTurn({
      execution: store, provider: { id: "answer", stream }, controlContext: parent,
      contextBuilder: { async build(args) { entered.resolve(); await gate.promise; return defaultContextBuilder.build(args); } },
    }, input).then(value => { result = value; });
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(30);
      expect(result).toMatchObject({ status: "interrupted", reason: "deadline_exceeded" });
      expect(store.attemptStatus(input.attemptId)).toBe("Interrupted");
      expect(stream).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await job;
      parent.dispose();
    }
  });

  it.each(["tools", "context", "compaction"] as const)("ends while %s ignores cancellation and discards late completion", async stage => {
    vi.useFakeTimers();
    const store = seeded();
    const parent = new ControlContext();
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let receivedSignal: AbortSignal | undefined;
    const pause = async (signal?: AbortSignal) => {
      receivedSignal = signal;
      entered.resolve();
      await gate.promise;
    };
    const build = vi.fn<ContextBuilderPort["build"]>(async args => {
      if (stage === "context") await pause(args.signal);
      return defaultContextBuilder.build(args);
    });
    const compact = vi.fn(async (args: Parameters<import("../src/index.js").ContextCompactionPort["compact"]>[0]) => {
      if (stage === "compaction") await pause(args.signal);
      return { messages: args.messages };
    });
    const stream = vi.fn(answer.stream);
    const tools: ToolProviderPort = {
      tools: [], execute: vi.fn(),
      listTools: async options => {
        if (stage === "tools") await pause(options?.signal);
        return [];
      },
    };
    let result: ExecuteResult | undefined;
    const job = executeTurn({
      execution: store, provider: { id: "answer", stream }, tools,
      contextBuilder: createComposedContextBuilder({ base: { build }, inbox: true, compaction: { compact } }),
      controlContext: parent,
    }, input).then(value => { result = value; });
    try {
      await entered.promise;
      parent.abort(new Error("cancel preparation"));
      await vi.advanceTimersByTimeAsync(150);
      expect(result).toMatchObject({ status: "cancelled" });
      expect(receivedSignal?.aborted).toBe(true);
      expect(store.attemptStatus(input.attemptId)).toBe("Cancelled");
      expect(stream).not.toHaveBeenCalled();
      gate.resolve();
      await vi.advanceTimersByTimeAsync(0);
      if (stage === "tools") expect(build).not.toHaveBeenCalled();
      if (stage !== "compaction") expect(compact).not.toHaveBeenCalled();
      expect(stream).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await job;
      parent.dispose();
    }
  });
});
