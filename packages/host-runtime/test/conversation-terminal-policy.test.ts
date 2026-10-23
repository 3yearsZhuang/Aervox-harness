import { afterEach, describe, expect, it } from "vitest";
import { createInMemoryDatabase, SqliteConversationRepository } from "@aervox/repositories";
import { loadExecutionConfig } from "@aervox/config";
import { claimAttemptExecution, ControlContext, type AdapterDriverPort } from "@aervox/core";
import { SqliteExecutionStore } from "@aervox/host-agent";
import { executeConversationTurn } from "../src/modules/companion/conversation/execution.js";
import { runDshAdapterTurn } from "../src/modules/companion/conversation/dsh-adapter.js";

const local = { workspaceId: "local", subjectUserId: "local" };
const input = { turnId: "turn", attemptId: "attempt", sessionId: "session", userMessage: "hello" };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture() {
  const database = await createInMemoryDatabase(); cleanups.push(database.cleanup);
  const repo = new SqliteConversationRepository(database.db);
  await repo.getOrCreateSession(local, input.sessionId);
  await repo.acceptTurn(local, { ...input, idempotencyKey: "turn", execution: "api", message: { id: "message", content: "hello" } });
  return { repo, database };
}

describe("one terminal policy across conversation admission and drivers", () => {
  it.each(["native", "dsh"] as const)("stops %s preparation when its source is removed after admission", async loopDriver => {
    const { repo } = await fixture(); let driverCalled = false;
    await executeConversationTurn(repo, local, input, {
      executionConfig: { ...loadExecutionConfig({ AERVOX_LOOP_PROVIDER: "replay" }), loopDriver },
      prepareExecution: async () => { await repo.deleteMessage(local, "message"); },
      dshResolver: { resolve: async () => { driverCalled = true; return { ok: false, reason: "must_not_resolve" }; }, close: async () => {} },
    });
    expect(driverCalled).toBe(false);
    expect((await repo.listTurnAttempts(local, input.turnId))[0]?.status).toBe("Interrupted");
    const events = await repo.getStreamEvents(local, input.turnId);
    expect(events.filter(event => ["done", "error"].includes(event.eventType))).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ eventType: "done", data: { status: "Interrupted", isComplete: false, reason: "deletion_blocked" } });
  });

  it.each(["native", "dsh"] as const)("interrupts %s when deletion becomes blocked after admission", async loopDriver => {
    const { repo } = await fixture(); let blocked = false; let driverCalled = false;
    await executeConversationTurn(repo, local, input, {
      executionConfig: { ...loadExecutionConfig({ AERVOX_LOOP_PROVIDER: "replay" }), loopDriver },
      prepareExecution: async () => { blocked = true; },
      privacyRepo: { hasPendingDeletionRequest: async () => blocked } as never,
      dshResolver: { resolve: async () => { driverCalled = true; return { ok: false, reason: "must_not_resolve" }; }, close: async () => {} },
    });
    expect(driverCalled).toBe(false);
    expect((await repo.listTurnAttempts(local, input.turnId))[0]?.status).toBe("Interrupted");
    const events = await repo.getStreamEvents(local, input.turnId);
    expect(events.filter(event => ["done", "error"].includes(event.eventType))).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ eventType: "done", data: {
      status: "Interrupted", isComplete: false, reason: "deletion_blocked", lastSequence: events.at(-1)?.sequence,
    } });
  });

  it.each(["unclaimed", "admission", "preload", "dsh"] as const)("uses the same cancelled payload for %s", async phase => {
    const { repo } = await fixture();
    if (phase === "unclaimed") await repo.requestCancelTurnAttempt(local, input);
    const controller = new AbortController();
    await executeConversationTurn(repo, local, { ...input, signal: controller.signal }, {
      executionConfig: { ...loadExecutionConfig({ AERVOX_LOOP_PROVIDER: "replay" }), loopDriver: phase === "dsh" ? "dsh" : "native" },
      prepareExecution: phase === "admission" ? async () => { controller.abort(); throw controller.signal.reason; } : undefined,
      dshResolver: { resolve: async () => { controller.abort(); throw controller.signal.reason; }, close: async () => {} },
      personaLoader: phase === "preload" ? async () => { controller.abort(); return undefined; } : undefined,
    });
    const events = await repo.getStreamEvents(local, input.turnId);
    expect((await repo.listTurnAttempts(local, input.turnId))[0]?.status).toBe("Cancelled");
    expect(events.filter(event => event.eventType === "done")).toHaveLength(1);
    expect(events.at(-1)?.data).toMatchObject({ status: "Cancelled", isComplete: false, reason: "cancelled", lastSequence: events.at(-1)?.sequence });
  });

  it("includes the authoritative sequence for a DSH admission failure", async () => {
    const { repo } = await fixture();
    await executeConversationTurn(repo, local, input, {
      executionConfig: { ...loadExecutionConfig({ AERVOX_LOOP_PROVIDER: "replay" }), loopDriver: "dsh" },
      dshResolver: { resolve: async () => ({ ok: false, reason: "dsh_not_available" }), close: async () => {} },
    });
    const events = await repo.getStreamEvents(local, input.turnId);
    expect(events.at(-1)).toMatchObject({ eventType: "error", data: {
      code: "ADAPTER_UNAVAILABLE", retryable: false, lastSequence: events.at(-1)?.sequence,
    } });
  });

  it("settles cancellation when an admitted DSH driver cannot receive the preparation lease", async () => {
    const { repo } = await fixture();
    const store = new SqliteExecutionStore(repo, local);
    const parent = new ControlContext();
    const lifecycle = await claimAttemptExecution(input, { execution: store, controlContext: parent });
    if (!lifecycle.ok) throw new Error("admission_failed");
    let adapterCalled = false;
    const driver: AdapterDriverPort = { id: "dsh", async *run() { adapterCalled = true; } };
    // The production handoff refuses the claim if cancellation reaches its
    // preparation owner after admission but before the driver receives it.
    store.claimTurnAttempt = async () => {
      parent.abort(new Error("turn_cancel_requested"));
      return { ok: false, reason: "already_claimed" };
    };
    try {
      await runDshAdapterTurn(store, { ...input, signal: lifecycle.control.abortSignal }, {
        resolve: async () => ({ ok: true, driver, close: async () => {} }), close: async () => {},
      }, lifecycle.terminator);
      expect(adapterCalled).toBe(false);
      expect((await repo.listTurnAttempts(local, input.turnId))[0]?.status).toBe("Cancelled");
      const events = await repo.getStreamEvents(local, input.turnId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ eventType: "done", data: {
        status: "Cancelled", isComplete: false, reason: "cancelled", lastSequence: events[0]?.sequence,
      } });
    } finally { lifecycle.dispose(); parent.dispose(); }
  });

  it("does not publish a setup error after its preparation fence is lost", async () => {
    const { repo, database } = await fixture();
    await executeConversationTurn(repo, local, input, {
      executionConfig: loadExecutionConfig({ AERVOX_LOOP_PROVIDER: "replay" }),
      prepareExecution: async () => {
        await database.client.execute("UPDATE turn_attempts SET fencing_token=fencing_token+1 WHERE id='attempt'");
        throw new Error("late_setup_failure");
      },
    });
    expect((await repo.listTurnAttempts(local, input.turnId))[0]?.status).toBe("Running");
    expect((await repo.getStreamEvents(local, input.turnId)).some(event => ["error", "done"].includes(event.eventType))).toBe(false);
  });
});
