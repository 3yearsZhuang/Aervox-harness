import { describe, expect, it, vi } from "vitest";
import type { HostToolRuntime } from "../src/host-tool-runtime.js";

/** Identical behavioral fixtures run through memory and the production API adapter. */
export function runtimeContract(name: string, create: () => HostToolRuntime) {
  describe(name, () => {
    it("declaration revision cannot invoke a replaced handler", async () => {
      const runtime = create(); const ctx = { workspaceId: "local", subjectUserId: "local" };
      const def = { id: "x", name: "x", category: "test", description: "test", safetyLevel: "read_only" };
      await runtime.registerContribution(def, { call: async () => "old" });
      const [snapshot] = await runtime.exportRegistry();
      const replacement = vi.fn(async () => "new");
      await runtime.registerContribution(def, { call: replacement });
      await expect(runtime.callTool(ctx, "x", {}, { expectedRevision: snapshot!.runtimeRevision })).rejects.toThrow("declaration expired");
      expect(replacement).not.toHaveBeenCalled(); runtime.dispose();
    });
    it("malformed gates and missing equals values are denied in discovery and dispatch", async () => {
      const runtime = create();
      for (const gatingConditions of [{ field: "x" }, [null], [{ field: "x", operator: "equals" }]]) {
        await runtime.registerContribution({ id: "x", name: "x", category: "test", description: "test", safetyLevel: "read_only", gatingConditions }, { call: async () => "no" });
        expect(await runtime.exportRegistry()).toEqual([]);
        await expect(runtime.callTool({ workspaceId: "local", subjectUserId: "local" }, "x", {})).rejects.toThrow("gated");
      }
      runtime.dispose();
    });
    it("missing context, false context and unknown operators cannot authorize handlers", async () => {
      const runtime = create(); const call = vi.fn(async () => "ran");
      for (const operator of ["truthy", "equals", "unknown"]) {
        await runtime.registerContribution({ id: "g", name: "g", category: "test", description: "test", safetyLevel: "read_only", gatingConditions: [{ field: "authorized", operator, value: true }] }, { call });
        await expect(runtime.callTool({ workspaceId: "local", subjectUserId: "local" }, "g", {})).rejects.toThrow("gated");
        await expect(runtime.callTool({ workspaceId: "local", subjectUserId: "local" }, "g", {}, { gatingContext: { authorized: false } })).rejects.toThrow("gated");
      }
      expect(call).not.toHaveBeenCalled(); runtime.dispose();
    });
    it("pre-cancelled caller never starts a handler; in-flight caller cancellation propagates", async () => {
      const runtime = create(); const caller = new AbortController();
      let started!: (signal: AbortSignal) => void;
      const signal = new Promise<AbortSignal>(r => { started = r; });
      const call = vi.fn(async (_ctx, _args, context) => { started(context.signal); return new Promise(() => {}); });
      await runtime.registerContribution({ id: "r", name: "r", category: "test", description: "test", safetyLevel: "read_only" }, { call });
      const args = { workspaceId: "local", subjectUserId: "local" };
      const pending = runtime.callTool(args, "r", {}, { signal: caller.signal });
      const rejected = expect(pending).rejects.toThrow();
      const received = await signal; caller.abort(); await rejected;
      expect(received.aborted).toBe(true);
      await expect(runtime.callTool(args, "r", {}, { signal: caller.signal })).rejects.toThrow();
      expect(call).toHaveBeenCalledTimes(1); runtime.dispose();
    });
  });
}
