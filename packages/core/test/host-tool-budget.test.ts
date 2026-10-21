import { afterEach, describe, expect, it, vi } from "vitest";
import { HostToolRuntime } from "../src/index.js";

afterEach(() => vi.useRealTimers());
const definition = { id: "budgeted", name: "budgeted", description: "bounded tool", category: "test", safetyLevel: "read_only" };
const local = { workspaceId: "local", subjectUserId: "local" };

describe("direct host tool budget", () => {
  it("copies registration budgets, aborts at the deadline and never retries the handler", async () => {
    vi.useFakeTimers();
    const runtime = new HostToolRuntime();
    const budget = { timeoutMs: 30, maxRetries: 3 };
    let signal: AbortSignal | undefined;
    const entered = Promise.withResolvers<void>();
    const handler = vi.fn(async (_ctx, _args, options) => {
      signal = options.signal;
      entered.resolve();
      return new Promise(() => {});
    });
    await runtime.registerContribution({ ...definition, budget }, { call: handler });
    budget.timeoutMs = 1;
    const result = runtime.callTool(local, definition.id, {});
    const rejection = expect(result).rejects.toMatchObject({ code: "TOOL_TIMEOUT" });
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(29);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejection;
      expect(signal?.aborted).toBe(true);
      expect(handler).toHaveBeenCalledOnce();
      expect((await runtime.exportRegistry())[0]?.budget).toEqual({ timeoutMs: 30 });
    } finally { await runtime.dispose(); }
  });

  it.each([0, -1, 1.5, NaN, Infinity, 2 ** 31])("rejects invalid timeout %s before registering a handler", async timeoutMs => {
    const runtime = new HostToolRuntime();
    try {
      await expect(runtime.registerContribution({ ...definition, budget: { timeoutMs } }, { call: async () => "unexpected" }))
        .rejects.toMatchObject({ code: "INVALID_TOOL_BUDGET" });
      expect(await runtime.exportRegistry()).toEqual([]);
    } finally { await runtime.dispose(); }
  });
});
