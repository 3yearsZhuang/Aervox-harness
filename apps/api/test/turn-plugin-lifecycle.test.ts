import { afterEach, describe, expect, it, vi } from "vitest";
import type { IExtensionRepository, IPluginConfigRepository } from "@aervox/repositories";
import type { ServerTurnPlugin, TurnPluginContext } from "@aervox/host-plugin-api";
import { ServerPluginRegistry } from "@aervox/host-runtime/modules/ecosystem/plugins/turn-plugins/registry";
import {
  executeAfterTurnPlugins, executeBeforeTurnPlugins,
  type TurnPluginHostContext, type TurnPluginRunnerDeps,
} from "@aervox/host-runtime/modules/ecosystem/plugins/turn-plugins/runner";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(plugin: Omit<ServerTurnPlugin, "id"> = {}) {
  const record = { id: "probe", enabled: 1, availability: "available", lifecycleGeneration: "first-generation" };
  const getPlugin = vi.fn(async () => record);
  const registry = new ServerPluginRegistry();
  registry.register({ id: "probe", ...plugin });
  const controller = new AbortController();
  const appendEvent = vi.fn(async () => ({
    id: "event", turnId: "turn", sequence: 1, eventType: "probe", payloadVersion: 1,
    occurredAt: new Date().toISOString(), data: {},
  }));
  const context: TurnPluginHostContext = {
    turnId: "turn", sessionId: "session", attemptId: "attempt", userMessage: "hello",
    signal: controller.signal,
    stream: { readEvents: vi.fn(async () => []), appendEvent },
  };
  const deps: TurnPluginRunnerDeps = {
    tenant: { workspaceId: "local", subjectUserId: "local" },
    extRepo: { getPlugin } as unknown as IExtensionRepository,
    onPluginError: vi.fn(),
  };
  return { record, getPlugin, registry, controller, appendEvent, context, deps };
}

afterEach(() => vi.useRealTimers());

describe("first-party Turn Hook lifecycle", () => {
  it.each(["disabled", "unavailable", "missing"])("never invokes a %s plugin", async (state) => {
    const hook = vi.fn();
    const f = fixture({ beforeTurn: hook, afterTurn: hook });
    if (state === "disabled") f.record.enabled = 0;
    if (state === "unavailable") f.record.availability = "missing";
    if (state === "missing") f.getPlugin.mockResolvedValue(null as never);
    const before = await executeBeforeTurnPlugins(f.registry, f.context, f.deps);
    await executeAfterTurnPlugins(f.registry, { ...f.context, status: "Completed" }, f.deps, before.pluginResults, before.snapshots);
    expect(hook).not.toHaveBeenCalled();
  });

  it("retains the turn configuration but rechecks enablement before afterTurn", async () => {
    const after = vi.fn();
    const f = fixture({ beforeTurn: () => ({ state: { prepared: true } }), afterTurn: after });
    const getConfig = vi.fn(async () => ({ valuesJson: { setting: "original" } }));
    f.deps.configRepo = { getConfig } as unknown as IPluginConfigRepository;
    const before = await executeBeforeTurnPlugins(f.registry, f.context, f.deps);
    getConfig.mockResolvedValue({ valuesJson: { setting: "new" } });
    await executeAfterTurnPlugins(f.registry, { ...f.context, status: "Completed" }, f.deps, before.pluginResults, before.snapshots);
    expect(after).toHaveBeenCalledWith(expect.anything(), { setting: "original" }, { state: { prepared: true } });
    expect(getConfig).toHaveBeenCalledTimes(1);
    after.mockClear();
    f.record.enabled = 0;
    await executeAfterTurnPlugins(f.registry, { ...f.context, status: "Completed" }, f.deps, before.pluginResults, before.snapshots);
    expect(after).not.toHaveBeenCalled();
  });

  it("does not start a Hook revoked while its configuration was loading", async () => {
    const config = deferred<{ valuesJson: object }>();
    const reading = deferred<void>();
    const hook = vi.fn();
    const f = fixture({ beforeTurn: hook });
    f.deps.configRepo = { getConfig: () => { reading.resolve(); return config.promise; } } as unknown as IPluginConfigRepository;
    const running = executeBeforeTurnPlugins(f.registry, f.context, f.deps);
    await reading.promise;
    f.record.enabled = 0;
    config.resolve({ valuesJson: {} });
    await running;
    expect(hook).not.toHaveBeenCalled();
  });

  it("does not start afterTurn from a previous activation even when enabled again", async () => {
    const after = vi.fn();
    const f = fixture({ afterTurn: after });
    const before = await executeBeforeTurnPlugins(f.registry, f.context, f.deps);
    f.record.enabled = 0;
    f.record.lifecycleGeneration = "disabled-generation";
    f.record.enabled = 1;
    f.record.lifecycleGeneration = "reenabled-generation";
    await executeAfterTurnPlugins(f.registry, { ...f.context, status: "Completed" }, f.deps, before.pluginResults, before.snapshots);
    expect(after).not.toHaveBeenCalled();
    expect(f.deps.onPluginError).toHaveBeenCalledWith("probe", "afterTurn", expect.objectContaining({ message: "plugin_hook_generation_changed" }));
  });

  it("never restores an in-flight Hook after disable and re-enable", async () => {
    const started = deferred<TurnPluginContext>();
    const resume = deferred<void>();
    const f = fixture({ afterTurn: async ctx => {
      started.resolve(ctx);
      await resume.promise;
      await ctx.stream.appendEvent({ eventType: "probe", data: {} });
    } });
    const running = executeAfterTurnPlugins(f.registry, { ...f.context, status: "Completed" }, f.deps);
    const scope = await started.promise;
    f.record.enabled = 0;
    f.record.lifecycleGeneration = "disabled-generation";
    f.record.enabled = 1;
    f.record.lifecycleGeneration = "reenabled-generation";
    resume.resolve();
    await running;
    expect(scope.signal.aborted).toBe(true);
    expect(f.appendEvent).not.toHaveBeenCalled();
  });

  it("bounds a non-cooperative Hook by the earlier parent deadline and discards its late result", async () => {
    vi.useFakeTimers();
    const blocked = deferred<{ extraSections: string[] }>();
    let scope!: TurnPluginContext;
    const f = fixture({ beforeTurn: ctx => { scope = ctx; return blocked.promise; } });
    f.context.deadlineEpochMs = Date.now() + 20;
    f.deps.hookTimeoutMs = 50;
    const running = executeBeforeTurnPlugins(f.registry, f.context, f.deps);
    await vi.advanceTimersByTimeAsync(20);
    const result = await running;
    expect(scope.signal.aborted).toBe(true);
    expect(result.extraSections).toEqual([]);
    expect(f.deps.onPluginError).toHaveBeenCalledWith("probe", "beforeTurn", expect.objectContaining({ message: "plugin_hook_timeout" }));
    blocked.resolve({ extraSections: ["late injection"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(result.extraSections).toEqual([]);
    await expect(scope.stream.appendEvent({ eventType: "probe", data: {} })).rejects.toThrow("plugin_hook_timeout");
    expect(f.appendEvent).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds unavailable repository calls and prevents a late lookup from starting a Hook", async () => {
    vi.useFakeTimers();
    const hook = vi.fn();
    const f = fixture({ beforeTurn: hook });
    const lookup = deferred<typeof f.record>();
    f.getPlugin.mockReturnValue(lookup.promise);
    f.deps.hookTimeoutMs = 10;
    const running = executeBeforeTurnPlugins(f.registry, f.context, f.deps);
    await vi.advanceTimersByTimeAsync(10);
    await running;
    lookup.resolve(f.record);
    await vi.advanceTimersByTimeAsync(0);
    expect(hook).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a running Hook without waiting for its promise or accepting late writes", async () => {
    const started = deferred<TurnPluginContext>();
    const release = deferred<void>();
    const late = deferred<unknown>();
    const f = fixture({ beforeTurn: async ctx => {
      started.resolve(ctx);
      await release.promise;
      try { await ctx.stream.appendEvent({ eventType: "probe", data: {} }); }
      catch (error) { late.resolve(error); }
      return { extraSections: ["late"] };
    } });
    const running = executeBeforeTurnPlugins(f.registry, f.context, f.deps);
    const scope = await started.promise;
    f.controller.abort(new Error("user_cancelled"));
    expect((await running).extraSections).toEqual([]);
    expect(scope.signal.aborted).toBe(true);
    release.resolve();
    expect(await late.promise).toEqual(new Error("user_cancelled"));
    expect(f.appendEvent).not.toHaveBeenCalled();
  });

  it("closes all captured ports after a successful Hook", async () => {
    let scope!: TurnPluginContext;
    const f = fixture({ beforeTurn: ctx => { scope = ctx; return { extraSections: ["accepted"] }; } });
    const model = vi.fn(async () => "answer");
    f.context.llm = { generate: model };
    expect((await executeBeforeTurnPlugins(f.registry, f.context, f.deps)).extraSections).toEqual(["accepted"]);
    await expect(scope.stream.readEvents("turn", 0)).rejects.toThrow("plugin_hook_finished");
    await expect(scope.llm!.generate("late")).rejects.toThrow("plugin_hook_finished");
    expect(model).not.toHaveBeenCalled();
  });

  it("rechecks revoked enablement after stream preparation and before committing a write", async () => {
    const preparing = deferred<void>();
    const prepared = deferred<void>();
    const commit = vi.fn();
    const f = fixture({ afterTurn: async ctx => { await ctx.stream.appendEvent({ eventType: "probe", data: {} }); } });
    f.context.stream.appendEvent = async (_input, control) => {
      preparing.resolve();
      await prepared.promise;
      await control!.checkActive();
      commit();
      return f.appendEvent();
    };
    const running = executeAfterTurnPlugins(f.registry, { ...f.context, status: "Completed" }, f.deps);
    await preparing.promise;
    f.record.enabled = 0;
    prepared.resolve();
    await running;
    expect(commit).not.toHaveBeenCalled();
    expect(f.deps.onPluginError).toHaveBeenCalledWith("probe", "afterTurn", expect.objectContaining({ message: "plugin_hook_unavailable" }));
  });

  it("passes an unrelaxable cancellation signal to a model and rejects its late result", async () => {
    const invoked = deferred<AbortSignal>();
    const modelResult = deferred<string>();
    const f = fixture({ afterTurn: async ctx => {
      const value = await ctx.llm!.generate("extract", { signal: new AbortController().signal });
      await ctx.stream.appendEvent({ eventType: "probe", data: value });
    } });
    f.context.llm = { generate: (_prompt, options) => { invoked.resolve(options!.signal!); return modelResult.promise; } };
    const running = executeAfterTurnPlugins(f.registry, { ...f.context, status: "Completed" }, f.deps);
    const signal = await invoked.promise;
    f.controller.abort(new Error("user_cancelled"));
    await running;
    expect(signal.aborted).toBe(true);
    modelResult.resolve("late answer");
    await Promise.resolve();
    expect(f.appendEvent).not.toHaveBeenCalled();
  });
});
