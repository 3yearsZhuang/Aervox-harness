import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  createInMemoryDatabase, initDatabaseSchema, SqliteConversationRepository, SqliteExtensionRepository,
  type IExtensionRepository,
} from "@aervox/repositories";
import type { TurnPluginContext } from "@aervox/host-plugin-api";
import { registerConversationRoutes } from "./conversation-fixture.js";
import { executeConversationTurn } from "@aervox/host-runtime-test/modules/companion/conversation/execution";
import { ServerPluginRegistry } from "@aervox/host-runtime-test/modules/ecosystem/plugins/turn-plugins/registry";
import { executeBeforeTurnPlugins, executeAfterTurnPlugins, type TurnPluginHostContext } from "@aervox/host-runtime-test/modules/ecosystem/plugins/turn-plugins/runner";

describe("accepted Turn cancellation reaches first-party Hooks", () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let repo: SqliteConversationRepository;
  let extensions: SqliteExtensionRepository;
  const local = { workspaceId: "local", subjectUserId: "local" };

  beforeEach(async () => {
    vi.stubEnv("AERVOX_LOOP_PROVIDER", "replay");
    vi.stubEnv("AERVOX_LOOP_DISPATCH", "api");
    vi.stubEnv("AERVOX_TURN_EXECUTION", "background");
    const database = await createInMemoryDatabase();
    cleanup = database.cleanup;
    await initDatabaseSchema(database.client);
    repo = new SqliteConversationRepository(database.db);
    extensions = new SqliteExtensionRepository(database.db);
    app = Fastify();
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
    vi.unstubAllEnvs();
  });

  it("cancels an uncooperative beforeTurn and finalizes the unclaimed Attempt", async () => {
    let started!: (scope: TurnPluginContext) => void;
    const hookStarted = new Promise<TurnPluginContext>(resolve => { started = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let lateFinished!: () => void;
    const lateCompletion = new Promise<void>(resolve => { lateFinished = resolve; });
    const lateErrors: unknown[] = [];
    const registry = new ServerPluginRegistry();
    registry.register({
      id: "probe",
      async beforeTurn(scope) {
        started(scope);
        await blocked;
        try { await scope.stream.appendEvent({ eventType: "done", data: { malicious: "late" } }); }
        catch (error) { lateErrors.push(error); }
        finally { lateFinished(); }
      },
    });
    registerConversationRoutes(app, repo, {
      pluginRegistry: registry,
      extensionRepo: { getPlugin: async () => ({ id: "probe", enabled: 1, availability: "available", lifecycleGeneration: "test-generation" }) } as unknown as IExtensionRepository,
    });
    const create = await app.inject({
      method: "POST", url: "/v1/sessions/hook_cancel/turns",
      payload: { message: { content: "hello", contentType: "text" }, clientVersion: "test", references: [] },
    });
    expect(create.statusCode, create.body).toBe(201);
    const { turnId } = create.json();
    const scope = await hookStarted;
    // Completion of the POST request is not cancellation of the accepted work.
    expect(scope.signal.aborted).toBe(false);
    const cancel = await app.inject({ method: "POST", url: `/v1/turns/${turnId}/cancel` });
    expect(cancel.statusCode).toBe(200);
    expect(scope.signal.aborted).toBe(true);
    await vi.waitFor(async () => {
      expect((await repo.listTurnAttempts(local, turnId))[0]?.status).toBe("Cancelled");
      expect((await repo.getTurn(local, turnId))?.status).toBe("Cancelled");
    });
    release();
    await lateCompletion;
    expect(lateErrors).toHaveLength(1);
    const events = await repo.getStreamEvents(local, turnId, 0);
    expect(events.filter(event => event.eventType === "done")).toHaveLength(1);
    expect(events.some(event => JSON.stringify(event.data).includes("malicious"))).toBe(false);
  });

  it("observes persisted cancellation when a Worker owns the same shared Hook execution", async () => {
    vi.stubEnv("AERVOX_LOOP_DISPATCH", "worker");
    let started!: (scope: TurnPluginContext) => void;
    const hookStarted = new Promise<TurnPluginContext>(resolve => { started = resolve; });
    const registry = new ServerPluginRegistry();
    registry.register({ id: "probe", beforeTurn: scope => { started(scope); return new Promise(() => {}); } });
    const deps = {
      pluginRegistry: registry,
      extensionRepo: { getPlugin: async () => ({ id: "probe", enabled: 1, availability: "available", lifecycleGeneration: "worker-generation" }) } as unknown as IExtensionRepository,
    };
    registerConversationRoutes(app, repo, deps);
    const create = await app.inject({ method: "POST", url: "/v1/sessions/worker_hook_cancel/turns",
      payload: { message: { content: "hello", contentType: "text" }, clientVersion: "test", references: [] } });
    expect(create.statusCode, create.body).toBe(201);
    const { turnId } = create.json();
    const attempt = (await repo.listTurnAttempts(local, turnId))[0]!;
    const running = executeConversationTurn(repo, local, { turnId, sessionId: "worker_hook_cancel", attemptId: attempt.id, userMessage: "hello" }, deps);
    const scope = await hookStarted;
    expect((await app.inject({ method: "POST", url: `/v1/turns/${turnId}/cancel` })).statusCode).toBe(200);
    await vi.waitFor(() => expect(scope.signal.aborted).toBe(true));
    await running;
    expect((await repo.listTurnAttempts(local, turnId))[0]!.status).toBe("Cancelled");
    expect((await repo.getTurn(local, turnId))!.status).toBe("Cancelled");
  });

  it.each([
    ["enabled", "before-afterTurn"], ["enabled", "during-afterTurn"],
    ["availability", "before-afterTurn"], ["availability", "during-afterTurn"],
  ])("persisted %s off/on transition invalidates the old invocation %s", async (transition, phase) => {
    await extensions.createPlugin({ id: "generation-probe", publisher: "test", version: "1", checksum: "test" });
    let started!: () => void;
    const hookStarted = new Promise<void>(resolve => { started = resolve; });
    let resume!: () => void;
    const blocked = new Promise<void>(resolve => { resume = resolve; });
    const write = vi.fn(async () => ({ id: "event", turnId: "turn", sequence: 1, eventType: "probe", payloadVersion: 1, occurredAt: "now", data: {} }));
    const after = vi.fn(async (scope: TurnPluginContext) => {
      started();
      if (phase === "during-afterTurn") await blocked;
      await scope.stream.appendEvent({ eventType: "probe", data: {} });
    });
    const registry = new ServerPluginRegistry();
    registry.register({ id: "generation-probe", afterTurn: after });
    const context: TurnPluginHostContext = {
      turnId: "turn", sessionId: "session", attemptId: "attempt", userMessage: "hello",
      stream: { readEvents: async () => [], appendEvent: write },
    };
    const deps = { tenant: local, extRepo: extensions, onPluginError: vi.fn() };
    const before = await executeBeforeTurnPlugins(registry, context, deps);
    const afterTurn = () => executeAfterTurnPlugins(registry, { ...context, status: "Completed" }, deps, before.pluginResults, before.snapshots);
    const running = phase === "during-afterTurn" ? afterTurn() : undefined;
    if (running) await hookStarted;
    if (transition === "enabled") {
      await extensions.setPluginEnabled("generation-probe", false);
      await extensions.setPluginEnabled("generation-probe", true);
    } else {
      await extensions.setPluginAvailability("generation-probe", "missing");
      await extensions.setPluginAvailability("generation-probe", "available");
    }
    expect((await extensions.getPlugin("generation-probe"))!.enabled).toBe(1);
    if (running) { resume(); await running; }
    else { await afterTurn(); expect(after).not.toHaveBeenCalled(); }
    expect(write).not.toHaveBeenCalled();
    expect(deps.onPluginError).toHaveBeenCalledWith("generation-probe", "afterTurn", expect.objectContaining({ message: "plugin_hook_generation_changed" }));
  });
});
