import { afterEach, describe, expect, it, vi } from "vitest";
import type { createDSHAdapterDriver } from "@aervox/host-agent";
import { createDshTurnAdapterResolver, runDshAdapterTurn } from "../src/modules/companion/conversation/dsh-adapter.js";

function admitted(close = vi.fn(async () => {})) {
  return { probe: { ready: true }, handle: { driver: { id: "dsh" }, close } };
}
describe("host-scoped DSH admission", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("captures the inherited environment before lazy admission, including absent keys", async () => {
    vi.stubEnv("DSH_MODEL_ID", "captured");
    vi.stubEnv("AERVOX_DSH_LATE_KEY", undefined);
    const factory = vi.fn().mockResolvedValue({ probe: { ready: false, reason: "not_ready" } });
    const host = createDshTurnAdapterResolver({ repoRoot: "/root", workingDirectory: "/root", environment: { ...process.env }, env: { DSH_MODEL_ID: "override" } }, factory as unknown as typeof createDSHAdapterDriver);
    vi.stubEnv("DSH_MODEL_ID", "later"); vi.stubEnv("AERVOX_DSH_LATE_KEY", "later");
    await host.resolve();
    const environment = factory.mock.calls[0]?.[0].env;
    expect(environment?.DSH_MODEL_ID).toBe("override");
    expect(Object.hasOwn(environment ?? {}, "AERVOX_DSH_LATE_KEY")).toBe(false);
    // A resolver with no overrides must still receive the startup environment.
    const secondFactory = vi.fn().mockResolvedValue({ probe: { ready: false, reason: "not_ready" } });
    const second = createDshTurnAdapterResolver({ repoRoot: "/root", workingDirectory: "/root", environment: { DSH_MODEL_ID: "startup" } }, secondFactory as unknown as typeof createDSHAdapterDriver);
    await second.resolve(); expect(secondFactory.mock.calls[0]?.[0].env).toEqual({ DSH_MODEL_ID: "startup" });
    await host.close(); await second.close();
  });
  it("shares one concurrent admission per host, isolates hosts, and closes owned processes", async () => {
    const closeA = vi.fn(async () => {}); const closeB = vi.fn(async () => {});
    const factory = vi.fn().mockResolvedValueOnce(admitted(closeA)).mockResolvedValueOnce(admitted(closeB));
    const a = createDshTurnAdapterResolver({ repoRoot: "/a", workingDirectory: "/a", environment: {} }, factory as unknown as typeof createDSHAdapterDriver);
    const b = createDshTurnAdapterResolver({ repoRoot: "/b", workingDirectory: "/b", environment: {} }, factory as unknown as typeof createDSHAdapterDriver);
    const [first, again, other] = await Promise.all([a.resolve(), a.resolve(), b.resolve()]);
    expect(first).toBe(again); expect(other).not.toBe(first); expect(factory).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenCalledWith({ repoRoot: "/a", env: {} });
    expect(factory).toHaveBeenCalledWith({ repoRoot: "/b", env: {} });
    await a.close(); await a.close(); expect(closeA).toHaveBeenCalledOnce(); expect(closeB).not.toHaveBeenCalled();
    expect(await a.resolve()).toMatchObject({ ok: false, reason: "dsh_resolver_closed" });
    await b.close(); expect(closeB).toHaveBeenCalledOnce();
  });
  it("closes an admission that completes after host shutdown without exposing its driver", async () => {
    const close = vi.fn(async () => {});
    let complete!: (value: ReturnType<typeof admitted>) => void;
    const factory = vi.fn(() => new Promise(resolve => { complete = resolve; }));
    const host = createDshTurnAdapterResolver({ repoRoot: "/root", workingDirectory: "/root", environment: {} }, factory as unknown as typeof createDSHAdapterDriver);
    const resolution = host.resolve(); const closing = host.close(); complete(admitted(close));
    expect(await resolution).toMatchObject({ ok: false }); await closing; expect(close).toHaveBeenCalledOnce();
  });
  it("cancels a pending admission immediately without dispatching a late admitted driver", async () => {
    const close = vi.fn(async () => {}); const run = vi.fn();
    let complete!: (value: ReturnType<typeof admitted>) => void;
    const factory = vi.fn(() => new Promise(resolve => { complete = resolve; }));
    const host = createDshTurnAdapterResolver({ repoRoot: "/root", workingDirectory: "/root", environment: {} }, factory as unknown as typeof createDSHAdapterDriver);
    const controller = new AbortController();
    const pending = runDshAdapterTurn({} as never,
      { turnId: "turn", sessionId: "session", attemptId: "attempt", userMessage: "hello", signal: controller.signal }, host, {} as never);
    controller.abort(new Error("admission_cancelled"));
    await expect(pending).rejects.toThrow("admission_cancelled");
    complete({ ...admitted(close), handle: { driver: { id: "dsh", run }, close } } as ReturnType<typeof admitted>);
    expect(await host.resolve()).toMatchObject({ ok: true });
    expect(run).not.toHaveBeenCalled(); await host.close(); expect(close).toHaveBeenCalledOnce();
  });
  it("captures relative roots and environment options before their caller changes", async () => {
    const env = { DSH_MODEL_ID: "first" }; const factory = vi.fn().mockResolvedValue({ probe: { ready: false, reason: "not_ready" } });
    const host = createDshTurnAdapterResolver({ repoRoot: "reference", workingDirectory: "/captured", environment: {}, env }, factory as unknown as typeof createDSHAdapterDriver);
    env.DSH_MODEL_ID = "second";
    expect(await host.resolve()).toMatchObject({ ok: false, reason: "dsh_probe_failed: not_ready" });
    await host.resolve(); expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith({ repoRoot: "/captured/reference", env: { DSH_MODEL_ID: "first" } });
    await host.close();
  });
});
