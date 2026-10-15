import { describe, expect, it } from "vitest";
import { ControlContext, HostToolRuntime } from "@aervox/core";
import { createHostToolProvider } from "../src/tool-adapter.js";

describe("host tool control propagation", () => {
  it.each(["signal", "controlContext"] as const)("cancels the handler through %s", async (mode) => {
    const runtime = new HostToolRuntime();
    const controller = new AbortController();
    const controlContext = new ControlContext({ abortSignal: controller.signal });
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let stopped = false;
    await runtime.registerContribution({ id: "wait", name: "wait", description: "wait", safetyLevel: "read_only" }, {
      call: (_ctx, _args, control) => new Promise((_resolve, reject) => {
        control.signal.addEventListener("abort", () => { stopped = true; reject(control.signal.reason); }, { once: true });
        started();
      }),
    });
    const pending = createHostToolProvider(runtime).execute({
      turnId: "t", attemptId: "a", invocationId: "i", name: "wait", arguments: {},
      ...(mode === "signal" ? { signal: controller.signal } : { controlContext }),
    });
    await ready;
    controller.abort(new Error("cancelled by caller"));
    expect(await pending).toMatchObject({ ok: false, error: "cancelled by caller" });
    expect(stopped).toBe(true);
    controlContext.dispose();
    await runtime.dispose();
  });

  it("does not auto-approve writes", async () => {
    const runtime = new HostToolRuntime();
    let calls = 0;
    await runtime.registerContribution({ id: "write", name: "write", description: "write", safetyLevel: "write_with_approval" }, {
      async call() { calls++; return {}; },
    });
    expect(await createHostToolProvider(runtime).execute({ turnId: "t", attemptId: "a", invocationId: "i", name: "write", arguments: {} })).toMatchObject({ ok: false });
    expect(calls).toBe(0);
    await runtime.dispose();
  });
});
