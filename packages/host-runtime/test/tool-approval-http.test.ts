import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScriptedProvider, defaultContextBuilder, executeTurn, type ToolProviderPort } from "@aervox/core";
import { SqliteExecutionStore } from "@aervox/host-agent";
import { createInMemoryDatabase, SqliteConversationRepository, SqliteExtensionRepository, SqliteToolRegistryRepository } from "@aervox/repositories";
import { loadExecutionConfig } from "@aervox/config";
import { registerConversationRoutes, type ConversationRouteDeps } from "../src/modules/companion/conversation/routes.js";
import { createContributionToolProvider, createRuntimeToolProvider } from "../src/modules/companion/conversation/tool-providers.js";
import { ToolRuntime } from "../src/modules/ecosystem/tools/runtime.js";

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
    await repo.createTurnWithOutbox(local, { id: call.turnId, sessionId: "session", idempotencyKey: "http" }, { id: "message", content: "run" });
    await repo.createTurnAttempt(local, call.turnId, { id: call.attemptId });
  });
  afterEach(async () => { vi.restoreAllMocks(); await app.close(); runtime.dispose(); await memory.cleanup(); });

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
