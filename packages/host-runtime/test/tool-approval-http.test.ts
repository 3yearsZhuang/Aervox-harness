import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScriptedProvider, defaultContextBuilder, executeTurn, type ToolProviderPort } from "@aervox/core";
import { SqliteExecutionStore } from "@aervox/host-agent";
import { createInMemoryDatabase, SqliteConversationRepository, SqliteExtensionRepository, SqliteToolRegistryRepository } from "@aervox/repositories";
import { loadExecutionConfig } from "@aervox/config";
import { registerConversationRoutes, type ConversationRouteDeps } from "../src/modules/companion/conversation/routes.js";
import { createContributionToolProvider, createRuntimeToolProvider } from "../src/modules/companion/conversation/tool-providers.js";
import { ToolRuntime } from "../src/modules/ecosystem/tools/runtime.js";
import { setRequestLocalContext } from "../src/shared/local-context.js";

const local = { workspaceId: "local", subjectUserId: "local" };
const spec = { name: "privileged_probe", description: "privileged probe", readOnly: true, safetyLevel: "privileged", parameters: { type: "object" } };
const call = { name: spec.name, arguments: { nested: { z: 1, a: 2 } }, turnId: "turn", attemptId: "attempt", invocationId: "call" };

describe("HTTP approvals use the authoritative binding for every tool origin", () => {
  let memory: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let repo: SqliteConversationRepository;
  let extensions: SqliteExtensionRepository;
  let runtime: ToolRuntime;
  let app: ReturnType<typeof Fastify>;
  let plugin: Awaited<ReturnType<SqliteExtensionRepository["createPlugin"]>>;
  const dispatched = vi.fn(async () => ({ ok: true, output: "executed" }));

  beforeEach(async () => {
    memory = await createInMemoryDatabase();
    repo = new SqliteConversationRepository(memory.db);
    extensions = new SqliteExtensionRepository(memory.db);
    runtime = new ToolRuntime({ registry: new SqliteToolRegistryRepository(memory.db) });
    app = Fastify();
    plugin = await extensions.createPlugin({ id: "plugin", publisher: "test", version: "1", checksum: "test" });
    dispatched.mockClear();
    await repo.getOrCreateSession(local, "session", "HTTP binding contract");
    await repo.acceptTurn(local, { turnId: call.turnId, sessionId: "session", idempotencyKey: "http", attemptId: call.attemptId,
      message: {id: "message", content: "run"}, consumeInbox: false });
  });
  afterEach(async () => { vi.restoreAllMocks(); await app.close(); runtime.dispose(); await memory.cleanup(); });

  it('restores accepted metadata, approval mode and actor through HTTP acceptance and repeated approval', async () => {
    let actor = 'accepted-actor';
    app.addHook('onRequest', async request => setRequestLocalContext(request, actor));
    const inputs: import('../src/modules/companion/conversation/execution.js').ConversationTurnInput[] = [];
    const executions: Promise<unknown>[] = [];
    const tools = createContributionToolProvider([{provider: {tools: [spec], execute: dispatched}}], local, repo);
    registerConversationRoutes(app, repo, {executionConfig: {...loadExecutionConfig(), turnExecution: 'inline', adminIds: ['admin']}}, async input => {
      inputs.push(input);
      const execution = executeTurn({tools, execution: new SqliteExecutionStore(repo, local), contextBuilder: defaultContextBuilder,
        provider: createScriptedProvider(input.resume ? [{text: 'finished'}] : [{toolCalls: [{id: 'call', name: spec.name, arguments: {}}]}]),
        options: {resume: input.resume}}, input);
      executions.push(execution); await execution;
    });
    const metadata = {mode: 'focus', userAddress: 'Alice'};
    const created = await app.inject({method: 'POST', url: '/v1/sessions/accepted/turns', headers: {'idempotency-key': 'accepted'},
      payload: {message: {content: 'run', contentType: 'text'}, clientVersion: 'test', metadata, toolApprovalMode: 'full_access'}});
    expect(created.statusCode, created.body).toBe(201);
    const turnId = created.json().turnId;
    const [approval] = await repo.listToolApprovalsByTurn(local, turnId);
    actor = 'later-actor';
    const decide = () => app.inject({method: 'POST', url: `/v1/turns/${turnId}/tool-approvals`, headers: {'x-admin-user-id': 'admin'},
      payload: {approvalId: approval!.id, decision: 'granted'}});
    const first = await decide(); const replay = await decide();
    expect(first.statusCode, first.body).toBe(200); expect(replay.json()).toEqual(first.json());
    await Promise.all(executions);
    expect(inputs).toHaveLength(2);
    for (const input of inputs) expect(input).toMatchObject({metadata, toolApprovalMode: 'full_access', actorId: 'accepted-actor'});
    expect(inputs[1]?.resume?.pendingApprovalResolution?.approvalId).toBe(approval!.id);
    expect(await repo.listTurnAttempts(local, turnId)).toHaveLength(2);
    expect(dispatched).toHaveBeenCalledOnce();
  });

  async function pending(origin: "static" | "runtime" | "plugin") {
    let tools: ToolProviderPort;
    if (origin === "runtime") {
      await runtime.registerContribution({ id: spec.name, name: spec.name, description: spec.description,
        category: "system", safetyLevel: "privileged", inputSchema: spec.parameters }, { call: async () => dispatched() });
      tools = createRuntimeToolProvider(runtime, local, { conversationRepo: repo });
    } else {
      const generation = plugin.lifecycleGeneration;
      tools = createContributionToolProvider([{ provider: { tools: [spec], execute: dispatched },
        ...(origin === "plugin" ? { owner: "plugin", generation,
          checkActive: async () => {
            const current = await extensions.getPlugin("plugin");
            return current?.enabled === 1 && current.availability === "available" && current.lifecycleGeneration === generation;
          } } : {}),
      }], local, repo);
    }
    await executeTurn({ tools, execution: new SqliteExecutionStore(repo, local), contextBuilder: defaultContextBuilder,
      provider: createScriptedProvider([{ toolCalls: [{ id: call.invocationId, name: call.name, arguments: call.arguments }] }]),
    }, { ...call, sessionId: "session", userMessage: "run" });
    const [approval] = await repo.listToolApprovalsByTurn(local, call.turnId);
    expect(approval!.state).toBe("pending");
    expect(approval!.argumentsHash).toBe('{"nested":{"a":2,"z":1}}');
    expect((await repo.getTurn(local, call.turnId))!.status).toBe("Interrupted");
    const resumed: Promise<unknown>[] = [];
    const deps: ConversationRouteDeps = { toolRuntime: runtime,
      executionConfig: { ...loadExecutionConfig(), adminIds: ["admin"] },
      extensionRepo: extensions,
    };
    registerConversationRoutes(app, repo, deps, async turnInput => {
      const result = executeTurn({ tools, execution: new SqliteExecutionStore(repo, local), contextBuilder: defaultContextBuilder,
        provider: createScriptedProvider([{ text: "finished" }, { text: "finished" }]), options: { resume: turnInput.resume },
      }, turnInput);
      resumed.push(result); await result;
    });
    await app.ready();
    const decide = (decision: "granted" | "denied", admin?: string) => app.inject({ method: "POST",
      url: `/v1/turns/${call.turnId}/tool-approvals`, payload: { approvalId: approval!.id, decision },
      headers: admin ? { "x-admin-user-id": admin } : {} });
    return { tools, approval: approval!, decide, resumed, deps };
  }

  it.each(["static", "runtime", "plugin"] as const)("%s privileged approval rejects ordinary callers and executes only after valid admin approval", async origin => {
    const { decide, approval, resumed } = await pending(origin);
    expect((await decide("granted")).statusCode).toBe(403);
    expect((await decide("granted", "unlisted")).statusCode).toBe(403);
    expect((await repo.getToolApproval(local, approval.id))!.state).toBe("pending");
    expect(dispatched).not.toHaveBeenCalled();
    const granted = await decide("granted", "admin");
    expect(granted.statusCode).toBe(200);
    await Promise.all(resumed);
    expect(dispatched).toHaveBeenCalledOnce();
    expect((await repo.getTurn(local, call.turnId))!.status).toBe("Completed");
  });

  it.each(['missing-receipt', 'changed-intent'] as const)('rejects %s before reserving an approval continuation', async failure => {
    const {decide, approval, resumed} = await pending('static');
    if (failure === 'missing-receipt') await memory.client.execute("DELETE FROM outbox_events WHERE id='outbox_turn'");
    else await memory.client.execute("UPDATE outbox_events SET payload=json_set(payload,'$.intent.toolApprovalMode','full_access') WHERE id='outbox_turn'");
    const result = await decide('granted', 'admin');
    expect(result.statusCode).toBe(409);
    expect(result.json().error).toBe('turn_intent_unavailable');
    expect((await repo.getToolApproval(local, approval.id))?.state).toBe('pending');
    expect((await repo.getTurn(local, call.turnId))?.status).toBe('Interrupted');
    expect(await repo.listTurnAttempts(local, call.turnId)).toHaveLength(1);
    expect(resumed).toHaveLength(0); expect(dispatched).not.toHaveBeenCalled();
  });

  it.each(["disabled", "reenabled", "unavailable"])("rejects a plugin's %s binding before recording or resuming a grant", async change => {
    const { decide, approval, resumed } = await pending("plugin");
    if (change === "disabled") await extensions.setPluginEnabled("plugin", false);
    if (change === "reenabled") {
      await extensions.setPluginEnabled("plugin", false);
      await extensions.setPluginEnabled("plugin", true);
    }
    if (change === "unavailable") await extensions.setPluginAvailability("plugin", "missing");
    const rejected = await decide("granted", "admin");
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error).toBe("approval_binding_expired");
    expect((await repo.getToolApproval(local, approval.id))!.state).toBe("pending");
    expect(await repo.listTurnAttempts(local, call.turnId)).toHaveLength(1);
    expect(dispatched).not.toHaveBeenCalled();
    expect((await decide("denied")).statusCode).toBe(200);
    await Promise.all(resumed);
  });

  it.each(["disabled", "reenabled", "unavailable"])("atomically rejects a plugin's %s binding when revocation lands after the HTTP precheck", async change => {
    const { decide, approval } = await pending("plugin");
    const commit = repo.decideToolApprovalAndResume.bind(repo);
    const reserve = vi.spyOn(repo, "decideToolApprovalAndResume").mockImplementationOnce(async (context, input) => {
      if (change === "unavailable") await extensions.setPluginAvailability("plugin", "missing");
      else {
        await extensions.setPluginEnabled("plugin", false);
        if (change === "reenabled") await extensions.setPluginEnabled("plugin", true);
      }
      return commit(context, input);
    });
    const rejected = await decide("granted", "admin");
    expect(reserve).toHaveBeenCalledOnce();
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error).toBe("approval_binding_expired");
    expect((await repo.getToolApproval(local, approval.id))!.state).toBe("pending");
    expect((await repo.getTurn(local, call.turnId))!.status).toBe("Interrupted");
    expect(await repo.listTurnAttempts(local, call.turnId)).toHaveLength(1);
    expect((await repo.getStreamEvents(local, call.turnId, 0)).some(event => event.eventType === "tool_approval_granted")).toBe(false);
    expect(dispatched).not.toHaveBeenCalled();
  });

  it("static privileged approval requires an administrator when no runtime service exists", async () => {
    const { decide, deps, resumed } = await pending("static");
    deps.toolRuntime = undefined;
    expect((await decide("granted")).statusCode).toBe(403);
    expect((await decide("granted", "admin")).statusCode).toBe(200);
    await Promise.all(resumed);
    expect(dispatched).toHaveBeenCalledOnce();
  });

  it.each(["replace_handler", "disable", "restart"])("rejects a runtime's %s pending binding", async change => {
    const { decide, approval, deps } = await pending("runtime");
    if (change === "disable") await runtime.setEnabled(spec.name, false);
    else if (change === "replace_handler") runtime.registerHandler(spec.name, { call: async () => dispatched() });
    else {
      runtime.dispose(); runtime = new ToolRuntime({ registry: new SqliteToolRegistryRepository(memory.db) });
      runtime.registerHandler(spec.name, { call: async () => dispatched() }); deps.toolRuntime = runtime;
    }
    expect((await decide("granted", "admin")).statusCode).toBe(409);
    expect((await repo.getToolApproval(local, approval.id))!.state).toBe("pending");
    expect(dispatched).not.toHaveBeenCalled();
  });

  it("does not treat a legacy pending row without binding metadata as an ordinary write approval", async () => {
    const { decide, approval, resumed } = await pending("static");
    await memory.client.execute({ sql: "UPDATE tool_approvals SET tool_version = NULL WHERE id = ?", args: [approval.id] });
    expect((await decide("granted", "admin")).statusCode).toBe(409);
    expect((await decide("denied")).statusCode).toBe(200);
    await Promise.all(resumed);
    expect(dispatched).not.toHaveBeenCalled();
  });
});
