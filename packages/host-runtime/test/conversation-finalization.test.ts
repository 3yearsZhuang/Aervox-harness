import Fastify from "fastify";
import { createConversationApplication } from "../src/modules/companion/conversation/application.js";
import { registerConversationRoutes } from "../src/modules/companion/conversation/routes.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryDatabase, SqliteConversationRepository, SqliteExtensionRepository, SqlitePrivacyRepository } from "@aervox/repositories";
import { loadExecutionConfig } from "@aervox/config";
import { executeConversationTurn } from "../src/modules/companion/conversation/execution.js";
import { createPluginApiRegistry } from "../src/plugin-api-registry.js";
import { ServerPluginRegistry } from "../src/modules/ecosystem/plugins/turn-plugins/registry.js";

const local = { workspaceId: "local", subjectUserId: "local" };
const input = { turnId: "turn", sessionId: "session", attemptId: "attempt", userMessage: "hello" };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const database = await createInMemoryDatabase(); cleanups.push(database.cleanup);
  const repo = new SqliteConversationRepository(database.db);
  const extensionRepo = new SqliteExtensionRepository(database.db);
  await extensionRepo.createPlugin({ id: "probe", publisher: "test", version: "1", checksum: "test", enabled: 1 });
  await repo.getOrCreateSession(local, input.sessionId, "Finalization");
  await repo.acceptTurn(local, { ...input, idempotencyKey: "turn", execution: "worker", message: { id: "message", content: "hello" } });
  const pluginRegistry = new ServerPluginRegistry();
  const apiRegistry = createPluginApiRegistry(); apiRegistry.registerPluginApiContribution({ streamEventTypes: ["probe"] });
  const deps = { privacyRepo: new SqlitePrivacyRepository(database.db), executionConfig: loadExecutionConfig({ AERVOX_LOOP_PROVIDER: "replay" }), extensionRepo, pluginRegistry, apiRegistry };
  return { database, repo, extensionRepo, pluginRegistry, deps };
}
describe("Conversation authoritative finalization", () => {
  for (const phase of ["beforeTurn", "afterTurn"] as const) it.each(["disabled", "reenabled", "replaced", "cancelled", "deletion", "fence"] as const)(`checks ${phase} identity inside the Hook writer on %s`, async cause => {
    const f = await fixture();
    const original = f.repo.appendPluginHookEvent.bind(f.repo);
    vi.spyOn(f.repo, "appendPluginHookEvent").mockImplementation(async (...args) => {
      if (cause === "disabled" || cause === "reenabled") await f.extensionRepo.setPluginEnabled("probe", false);
      if (cause === "reenabled") await f.extensionRepo.setPluginEnabled("probe", true);
      if (cause === "replaced") await f.extensionRepo.createPlugin({ id: "probe", publisher: "test", version: "2", checksum: "new" });
      if (cause === "cancelled") await f.repo.requestCancelTurnAttempt(local, input);
      if (cause === "deletion") await f.deps.privacyRepo.createDeletionRequest(local, { id: "deletion", idempotencyKey: "deletion", scope: "memory", ownerModule: "memory", targets: [] });
      if (cause === "fence") await f.database.client.execute("UPDATE turn_attempts SET fencing_token=fencing_token+1 WHERE id='attempt'");
      return original(...args);
    });
    f.pluginRegistry.register({ id: "probe", [phase]: async (ctx: import("@aervox/host-plugin-api").TurnPluginContext) => {
      await ctx.stream.appendEvent({ eventType: "probe", data: {} });
    } });
    await executeConversationTurn(f.repo, local, input, f.deps);
    expect((await f.repo.getStreamEvents(local, input.turnId)).filter(event => event.eventType === "probe")).toHaveLength(0);
  });
  it("keeps a claimed Attempt active until bounded postprocessing events are durable", async () => {
    const f = await fixture(); let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    f.pluginRegistry.register({ id: "probe", afterTurn: async ctx => {
      entered(); await pending; await ctx.stream.appendEvent({ eventType: "probe", data: {} });
    } });
    const application = createConversationApplication(f.repo, f.deps);
    const app = Fastify(); registerConversationRoutes(app, application); await app.ready();
    const execution = application.commands.execute(local, input);
    await started;
    let observationFinished = false;
    const observation = app.inject({ method: "GET", url: "/v1/turns/turn/events" }).then(response => { observationFinished = true; return response; });
    await new Promise(resolve => setImmediate(resolve));
    try {
      expect(observationFinished).toBe(false);
      expect((await f.repo.getStreamReplayState(local, input.turnId)).settled).toBe(false);
      expect((await f.repo.getStreamEvents(local, input.turnId)).some(event => event.eventType === "done")).toBe(false);
    } finally { release(); await execution; }
    const stream = await observation;
    expect(stream.body.indexOf('"eventType":"probe"')).toBeLessThan(stream.body.indexOf('"eventType":"done"'));
    await app.close(); await application.close();
    const events = await f.repo.getStreamEvents(local, input.turnId);
    expect(events.at(-1)?.eventType).toBe("done");
    expect(events.find(event => event.eventType === "probe")?.attemptId).toBe(input.attemptId);
    expect((events.at(-1)?.data as { lastSequence: number }).lastSequence).toBe(events.at(-1)?.sequence);
  });
  it("atomically settles cancellation before any driver claims the Attempt", async () => {
    const f = await fixture();
    await f.repo.requestCancelTurnAttempt(local, input);
    await executeConversationTurn(f.repo, local, input, f.deps);
    expect((await f.repo.listTurnAttempts(local, input.turnId))[0]?.status).toBe("Cancelled");
    expect((await f.repo.getStreamReplayState(local, input.turnId)).settled).toBe(true);
    expect((await f.repo.getStreamEvents(local, input.turnId)).filter(event => event.eventType === "done")).toHaveLength(1);
  });
});
