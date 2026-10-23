import { describe, expect, it, vi } from "vitest";
import { ControlContext, InMemoryExecutionStore, defaultContextBuilder, executeTurn } from "@aervox/core";
import type { AdapterDriverPort, DeletionGatePort, ModelProviderPort } from "@aervox/core";
import { runAdapterTurn } from "../src/adapter-turn.js";
const input = { turnId: "turn", sessionId: "session", attemptId: "attempt", userMessage: "hello" };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const manifest = { adapterId: "dsh" as const, version: "test", sha256: "test", license: "MIT", terminationPolicy: "every" as const };
for (const mode of ["native", "adapter"] as const) describe(`${mode} shared Attempt lifecycle`, () => {
  function setup(options: { signal?: AbortSignal; deletionGate?: DeletionGatePort; silent?: boolean; heartbeat?: number; maxTurnDurationMs?: number; deadlineEpochMs?: number } = {}) {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: input.attemptId, turnId: input.turnId });
    const started = vi.fn();
    const run = async function* () { started(); if (options.silent) await new Promise(() => {}); };
    const parent = new ControlContext({ abortSignal: options.signal, deadlineEpochMs: options.deadlineEpochMs });
    const execution = mode === "native"
      ? executeTurn({ execution: store, provider: { id: "test", stream: run } as ModelProviderPort,
          contextBuilder: defaultContextBuilder, controlContext: parent, deletionGate: options.deletionGate,
          options: { leaseHeartbeatIntervalMs: options.heartbeat ?? 10, maxTurnDurationMs: options.maxTurnDurationMs } }, input)
      : runAdapterTurn(store, { id: "dsh", manifest, run } as AdapterDriverPort,
          { ...input, controlContext: parent, deletionGate: options.deletionGate, leaseHeartbeatIntervalMs: options.heartbeat ?? 10, maxTurnDurationMs: options.maxTurnDurationMs });
    return { store, started, execution: execution.finally(() => parent.dispose()) };
  }
  it("does not invoke the driver after caller cancellation and commits one cancelled terminal", async () => {
    const controller = new AbortController(); controller.abort();
    const { store, started, execution } = setup({ signal: controller.signal });
    expect((await execution).status.toLowerCase()).toBe("cancelled");
    expect(started).not.toHaveBeenCalled();
    expect((await store.listEvents(input.turnId)).filter(event => event.eventType === "done")).toHaveLength(1);
    expect(await store.attemptStatus(input.attemptId)).toBe("Cancelled");
  });
  it("cancels a silent uncooperative source after a persisted cancellation", async () => {
    const { store, started, execution } = setup({ silent: true });
    await vi.waitFor(() => expect(started).toHaveBeenCalled());
    await store.requestCancelAttempt({ turnId: input.turnId, attemptId: input.attemptId });
    expect((await execution).status.toLowerCase()).toBe("cancelled");
    expect(await store.attemptStatus(input.attemptId)).toBe("Cancelled");
    expect((await store.listEvents(input.turnId)).filter(event => event.eventType === "done")).toHaveLength(1);
  });
  it("interrupts silent work when deletion becomes blocked", async () => {
    let blocked = false;
    const { store, started, execution } = setup({ silent: true, deletionGate: { isBlocked: async () => blocked } });
    await vi.waitFor(() => expect(started).toHaveBeenCalled()); blocked = true;
    const result = await execution;
    expect(result.status.toLowerCase()).toBe("interrupted");
    expect(result).toMatchObject({ reason: "deletion_blocked" });
    expect(await store.attemptStatus(input.attemptId)).toBe("Interrupted");
  });
  it("propagates host shutdown while a driver is silent", async () => {
    const controller = new AbortController();
    const { store, started, execution } = setup({ silent: true, signal: controller.signal });
    await vi.waitFor(() => expect(started).toHaveBeenCalled());
    controller.abort(new Error("host_shutdown"));
    expect((await execution).status.toLowerCase()).toBe("cancelled");
    expect(await store.attemptStatus(input.attemptId)).toBe("Cancelled");
    expect((await store.listEvents(input.turnId)).filter(event => event.eventType === "done")).toHaveLength(1);
  });
  it.each(["deadline", "duration"] as const)("interrupts silent work on %s expiry", async budget => {
    const { store, execution } = setup({ silent: true, ...(budget === "deadline" ? { deadlineEpochMs: Date.now() + 100 } : { maxTurnDurationMs: 100 }) });
    const result = await execution;
    expect(result).toMatchObject({ reason: budget === "deadline" ? "deadline_exceeded" : "turn_timeout" });
    expect(await store.attemptStatus(input.attemptId)).toBe("Interrupted");
  });
  it("reports a contested terminal without writing a standalone done", async () => {
    const controller = new AbortController(); controller.abort();
    const { store, execution } = setup({ signal: controller.signal });
    vi.spyOn(store, "finalizeAttemptWithEvent").mockResolvedValue({ ok: false });
    expect(await execution).toMatchObject({ reason: "cancelled_finalize_contested" });
    expect((await store.listEvents(input.turnId)).filter(event => event.eventType === "done")).toHaveLength(0);
  });
  it("renews during silent work and fences a lost lease without terminal writes", async () => {
    const { store, started, execution } = setup({ silent: true });
    await vi.waitFor(() => expect(started).toHaveBeenCalled());
    await sleep(30); expect(store.leaseRenewals()).toBeGreaterThan(0);
    store.simulateLeaseLoss(input.attemptId);
    expect(await execution).toMatchObject({ reason: "lease_lost" });
    expect((await store.listEvents(input.turnId)).filter(event => ["done", "error"].includes(event.eventType))).toHaveLength(0);
  });
});
