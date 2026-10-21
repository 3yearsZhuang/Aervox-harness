import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ControlContext, defaultContextBuilder, executeTurn, InMemoryExecutionStore,
  withApprovalPolicy,
} from "../src/index.js";
import type { ModelProviderPort, ToolProviderPort, ToolSpec } from "../src/index.js";
import { runToolExecution } from "../src/tool-pipeline.js";

const input = { turnId: "t", attemptId: "a", sessionId: "s", userMessage: "run tool" };
const spec: ToolSpec = {
  name: "lookup", description: "lookup", readOnly: true,
  parameters: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] },
};
function store() {
  const execution = new InMemoryExecutionStore();
  execution.seedAttempt({ id: "a", turnId: "t" });
  return execution;
}
function model(args: unknown = { count: 1 }, inspect?: (tools: ToolSpec[]) => void): ModelProviderPort {
  return {
    id: "fixture",
    async *stream(request) {
      if (request.step === 1) {
        inspect?.(request.tools ?? []);
        yield { text: "", isFinal: true, toolCalls: [{ id: "c", name: "lookup", arguments: args }] };
      } else yield { text: "done", isFinal: true };
    },
  };
}
afterEach(() => vi.useRealTimers());

describe("tool contract execution boundaries", () => {
  it.each(["static", "dynamic"] as const)("rejects invalid %s parameters before approval and records rejection", async kind => {
    const execution = store();
    const execute = vi.fn(async () => ({ ok: true }));
    const evaluate = vi.fn(async () => ({ action: "allow" as const }));
    const tools: ToolProviderPort = {
      tools: kind === "static" ? [spec] : [],
      listTools: kind === "dynamic" ? async () => [spec] : undefined,
      execute,
    };
    await executeTurn({
      execution, provider: model({ count: "one" }), tools, approvalPolicy: { evaluate },
      contextBuilder: defaultContextBuilder,
    }, input);
    expect(execute).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
    expect(execution.toolExecutionRecords()).toMatchObject([{ status: "rejected", error: expect.stringContaining("invalid_tool_input") }]);
  });

  it("does not execute a tool absent from this Step's refreshed discovery", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const execution = store();
    await executeTurn({
      execution, provider: model(), contextBuilder: defaultContextBuilder,
      tools: { tools: [spec], listTools: async () => [], execute },
    }, input);
    expect(execute).not.toHaveBeenCalled();
    expect(execution.toolExecutionRecords()[0]?.error).toBe("unregistered_tool: lookup");
  });

  it("uses an isolated discovery snapshot for schema and safety despite model-side mutation", async () => {
    const current = { ...spec, safetyLevel: "privileged" as const, budget: { timeoutMs: 50 } };
    const evaluate = vi.fn(async () => ({ action: "deny" as const, reason: "privileged" }));
    const execute = vi.fn(async () => ({ ok: true }));
    const execution = store();
    await executeTurn({
      execution, contextBuilder: defaultContextBuilder, approvalPolicy: { evaluate },
      provider: model({ count: 1 }, tools => {
        tools[0]!.safetyLevel = "read_only";
        tools[0]!.budget!.timeoutMs = 1;
        current.budget.timeoutMs = 1;
      }),
      tools: { tools: [], listTools: async () => [current], execute },
    }, input);
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ safetyLevel: "privileged" }), expect.anything());
    expect(execute).not.toHaveBeenCalled();
  });

  it("enforces a dynamic timeout at the declared boundary and aborts the handler", async () => {
    vi.useFakeTimers();
    const execution = store();
    const entered = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    const pending = executeTurn({
      execution, provider: model(), contextBuilder: defaultContextBuilder,
      options: { toolTimeoutMs: 5 },
      tools: {
        tools: [], listTools: async () => [{ ...spec, budget: { timeoutMs: 30 } }],
        execute: async args => { signal = args.signal; entered.resolve(); return new Promise(() => {}); },
      },
    }, input);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(29);
    expect(signal?.aborted).toBe(false);
    expect(execution.toolExecutionRecords()[0]?.status).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe("completed");
    expect(signal?.aborted).toBe(true);
    expect(execution.toolExecutionRecords()[0]).toMatchObject({ status: "timeout_error", error: "tool_timeout" });
  });

  it("cannot extend the parent's deadline with a longer declared timeout", async () => {
    vi.useFakeTimers();
    const parent = new ControlContext({ deadlineEpochMs: Date.now() + 10 });
    const entered = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    const pending = executeTurn({
      execution: store(), provider: model(), contextBuilder: defaultContextBuilder, controlContext: parent,
      tools: {
        tools: [ { ...spec, budget: { timeoutMs: 100 } } ],
        execute: async args => { signal = args.signal; entered.resolve(); return new Promise(() => {}); },
      },
    }, input);
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(10);
      expect(signal?.aborted).toBe(true);
      expect(await pending).toMatchObject({ status: "interrupted", reason: "deadline_exceeded" });
    } finally { parent.dispose(); }
  });

  it.each([0, -1, NaN, Infinity, 2 ** 31, 1.5])("rejects invalid declared timeout %s without dispatch", async timeoutMs => {
    const execute = vi.fn(async () => ({ ok: true }));
    const result = await runToolExecution({
      ...input, executionId: "e", call: { id: "c", name: "lookup", arguments: { count: 1 } },
      tools: { tools: [{ ...spec, budget: { timeoutMs } }], execute }, toolTimeoutMs: 50,
      prematureTermination: async () => null,
      finalizeInterrupted: async reason => ({ status: "failed", attemptId: "a", reason }),
    });
    expect(result).toMatchObject({ ok: false, failureKind: "rejected", error: expect.stringContaining("invalid_tool_budget") });
    expect(execute).not.toHaveBeenCalled();
  });

  it("supports an explicitly injected validator for a host-specific dialect", async () => {
    const toolValidator = vi.fn(() => ({ valid: false }));
    const execute = vi.fn(async () => ({ ok: true }));
    await executeTurn({
      execution: store(), provider: model(), contextBuilder: defaultContextBuilder, toolValidator,
      tools: { tools: [{ ...spec, parameters: { hostDialect: "custom" } }], execute },
    }, input);
    expect(toolValidator).toHaveBeenCalledWith({ hostDialect: "custom" }, { count: 1 });
    expect(execute).not.toHaveBeenCalled();
  });

  it("approval decorator refreshes dynamic declarations and preserves a stricter safety level", async () => {
    const evaluate = vi.fn(async () => ({ action: "deny" as const, reason: "denied" }));
    const execute = vi.fn(async () => ({ ok: true }));
    const wrapped = withApprovalPolicy({
      tools: [], listTools: async () => [{ ...spec, safetyLevel: "destructive" }], execute,
    }, { evaluate });
    await wrapped.listTools!();
    const result = await wrapped.execute({ ...input, invocationId: "c", name: "lookup", arguments: { count: 1 } });
    expect(result).toMatchObject({ ok: false, error: "denied" });
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ safetyLevel: "destructive" }));
    expect(execute).not.toHaveBeenCalled();
  });
});
