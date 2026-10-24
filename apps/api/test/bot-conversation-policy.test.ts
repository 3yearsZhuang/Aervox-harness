import { loadExecutionConfig } from "@aervox/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { errorEventDataSchema } from "@aervox/contracts";
import {
  createInMemoryDatabase, SqliteConversationRepository, SqliteToolRegistryRepository, SqliteMemoryRepository,
  SqliteExtensionRepository, SqliteAgentInboxRepository, SqliteBotRepository, FULL_PROFILE_SOURCE_MANIFEST,
  type AervoxDatabase, type ConversationExecutionPolicy,
} from "@aervox/repositories";
import type { Client } from "@libsql/client";
import { registerConversationRoutes, type ConversationRouteDeps } from "./conversation-fixture.js";
import { acceptConversationTurn, createConversationApplication } from "@aervox/host-runtime-test/modules/companion/conversation/application";
import { ApiOwnedTurnRecovery } from "@aervox/host-runtime-test/modules/companion/conversation/api-owned-recovery";
import { runLoopTurnOnce } from "@aervox/host-runtime-test/modules/companion/conversation/agent-executor";
import { ToolRuntime } from "@aervox/host-runtime-test/modules/ecosystem/tools/runtime";
import { ServerPluginRegistry } from "@aervox/host-runtime-test/modules/ecosystem/plugins/turn-plugins/registry";
import { contributeMemoryTool, type MemoryWritePort } from "@aervox/host-runtime/modules/companion/memory/index";
import { createToolApprovalPolicyHook, setRequestToolApprovalMode } from "@aervox/host-runtime/shared/tool-approval-policy";

const local = { workspaceId: "local", subjectUserId: "local" };
type ModelRequest = { messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }> };
const textSse = (text = "公开回复") => `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
const toolSse = (name: string, args: unknown) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`;


async function executeAcceptedConversationTurn(repo: SqliteConversationRepository, ctx: typeof local, input: Parameters<ReturnType<typeof createConversationApplication>["commands"]["execute"]>[1], deps: ConversationRouteDeps) {
  return createConversationApplication(repo, deps).commands.execute(ctx, input);
}
describe("API Bot execution audience enforcement", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;
  let repo: SqliteConversationRepository;
  let runtime: ToolRuntime;
  let dependencies: ConversationRouteDeps;
  let requests: ModelRequest[];
  let replyFor: (request: ModelRequest) => string;

  beforeEach(async () => {
    vi.stubEnv("AERVOX_LOOP_PROVIDER", "llm");
    vi.stubEnv("AERVOX_LOOP_DRIVER", "dsh");
    vi.stubEnv("AERVOX_TURN_EXECUTION", "inline");
    vi.stubEnv("AERVOX_LOOP_DISPATCH", "worker");
    vi.stubEnv("AERVOX_MODEL_ROUTING_FEATURE_FLAGS", "");
    ({ db, client, cleanup } = await createInMemoryDatabase());
    repo = new SqliteConversationRepository(db);
    runtime = new ToolRuntime({ registry: new SqliteToolRegistryRepository(db) });
    requests = [];
    replyFor = () => textSse();
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as ModelRequest;
      requests.push(request);
      return new Response(replyFor(request), { status: 200 });
    }));
    dependencies = {
      executionConfig: loadExecutionConfig(),
      llmConfigService: {
        getConfig: async () => ({ enabled: true, providerType: "custom_openai", baseUrl: "http://127.0.0.1:9999/v1", modelId: "test", temperature: 0, maxTokens: 512, settings: {} }),
        listPresets: async () => ({ presets: [], activePresetId: null }),
      },
      toolRuntime: runtime,
    };
    app = Fastify();
    app.addHook("preValidation", createToolApprovalPolicyHook());
    registerConversationRoutes(app, repo, dependencies);
  });
  afterEach(async () => { await app.close(); await runtime.dispose(); await cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  async function session(id: string, policy: ConversationExecutionPolicy) {
    await repo.createSession(local, id, { id, executionPolicy: policy });
  }
  async function httpTurn(id: string, content = "你好") {
    const response = await app.inject({ method: "POST", url: `/v1/sessions/${id}/turns`, payload: {
      message: { content, contentType: "text" }, clientVersion: "test", references: [], toolApprovalMode: "full_access",
      metadata: { executionPolicy: "local-v1", mode: "PRIVATE_METADATA_SECRET", toolApprovalMode: "full_access" },
    } });
    expect(response.statusCode).toBe(201);
    return response.json().turnId as string;
  }
  async function accept(id: string) {
    const turnId = `turn_${id}`;
    await acceptConversationTurn(repo, local, { turnId, sessionId: id, idempotencyKey: turnId, attemptId: `attempt_${id}`, message: { id: `message_${id}`, content: "已受理正文" }, consumeInbox: true });
    return { turnId, sessionId: id, attemptId: `attempt_${id}`, userMessage: "SUBSTITUTED_INPUT_SECRET" };
  }

  it("group HTTP turns bypass every private loader/hook and ignore full_access, DSH, Worker dispatch and metadata", async () => {
    await session("group", "bot-group-member-v1");
    const personaLoader = vi.fn(async () => ({ name: "PRIVATE_PERSONA_SECRET", prompt: "PRIVATE_PERSONA_SECRET" }));
    const skillLoader = vi.fn(async () => [{ name: "private", description: "PRIVATE_SKILL_SECRET" }]);
    const recall = vi.fn(async () => [{ id: "private", content: "PRIVATE_MEMORY_SECRET", source: "fts" as const }]);
    const profile = vi.fn(async () => { throw new Error("PRIVATE_PROFILE_SECRET"); });
    const pluginRegistry = new ServerPluginRegistry();
    const before = vi.fn(() => ({ extraSections: ["PRIVATE_HOOK_SECRET"] }));
    const after = vi.fn();
    pluginRegistry.register({ id: "private-plugin", beforeTurn: before, afterTurn: after });
    const extensionRepo = new SqliteExtensionRepository(db);
    await extensionRepo.createPlugin({ id: "private-plugin", publisher: "test", version: "1", checksum: "test", enabled: 1 });
    const pluginLookup = vi.spyOn(extensionRepo, "getPlugin");
    const contributions = vi.fn(() => []);
    const hostServices = vi.fn(() => { throw new Error("PRIVATE_LEARNING_FACT_SECRET"); });
    const listTools = vi.spyOn(runtime, "listTools");
    const inbox = new SqliteAgentInboxRepository(db);
    await inbox.enqueue(local, { id: "inbox", idempotencyKey: "inbox", sessionId: "group", type: "followup", sourceActor: "owner", payload: "PRIVATE_INBOX_SECRET" });
    Object.assign(dependencies, { personaLoader, skillLoader, memoryRecall: { recall }, pluginRegistry, extensionRepo,
      pluginRegistrations: contributions, pluginHostServices: hostServices, inboxRepo: inbox,
      proactiveRepository: { getEffectiveStatus: profile },
    });
    const turnId = await httpTurn("group");
    expect((await repo.getTurn(local, turnId))).toMatchObject({ status: "Completed", executionPolicy: "bot-group-member-v1", dispatchTarget: "api" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.tools ?? []).toEqual([]);
    expect(JSON.stringify(requests)).not.toContain("SECRET");
    for (const spy of [personaLoader, skillLoader, recall, profile, before, after, pluginLookup, contributions, hostServices, listTools]) expect(spy).not.toHaveBeenCalled();
    expect((await inbox.getByIdempotencyKey(local, "inbox"))?.status).toBe("pending");
  });

  it("hallucinated group tool calls cannot reach a registered write handler", async () => {
    await session("group", "bot-group-member-v1");
    const write = vi.fn(async () => ({ written: true }));
    await runtime.registerContribution({ id: "private_write", name: "private_write", description: "PRIVATE_TOOL_SECRET", category: "system", safetyLevel: "write_with_approval", builtin: true, requiredPermissions: [] }, { call: write });
    replyFor = request => request.messages.some(message => message.role === "tool") ? textSse() : toolSse("private_write", {});
    const turnId = await httpTurn("group");
    expect(write).not.toHaveBeenCalled();
    expect(JSON.stringify(requests)).not.toContain("PRIVATE_TOOL_SECRET");
    expect((await repo.listToolExecutionsByTurn(local, turnId)).every(execution => execution.status !== "executed")).toBe(true);
  });

  it("continues only the addressed member's group history", async () => {
    await session("member_a", "bot-group-member-v1");
    await session("member_b", "bot-group-member-v1");
    await httpTurn("member_a", "MEMBER_A_ONLY");
    await httpTurn("member_b", "MEMBER_B_ONLY");
    await httpTurn("member_a", "继续我的话题");
    expect(JSON.stringify(requests[1])).not.toContain("MEMBER_A_ONLY");
    expect(JSON.stringify(requests[2])).toContain("MEMBER_A_ONLY");
    expect(JSON.stringify(requests[2])).not.toContain("MEMBER_B_ONLY");
  });

  it("owner turns reuse ordinary persona and memory while excluding every CAP-033 source and plugin", async () => {
    await session("owner", "bot-owner-v1");
    const personaLoader = vi.fn(async () => ({ name: "OWNER_PERSONA", prompt: "OWNER_PERSONA_SECRET" }));
    const recall = vi.fn(async () => [{ id: "owner", content: "OWNER_MEMORY_SECRET", source: "fts" as const }]);
    const profile = vi.fn(async () => { throw new Error("CAP033_PROFILE_SECRET"); });
    for (const [index, source] of FULL_PROFILE_SOURCE_MANIFEST.entries()) {
      await runtime.registerContribution({ id: `cap_${index}`, name: `cap_${index}`, description: `CAP033_SOURCE_SECRET_${source.sourceKey}`, category: "system", safetyLevel: "read_only", builtin: true, requiredPermissions: [source.sourceKey] }, { call: async () => "CAP033_TOOL_SECRET" });
    }
    const extensionRepo = new SqliteExtensionRepository(db);
    await extensionRepo.createPlugin({ id: "cap-plugin", publisher: "test", version: "1", checksum: "test", enabled: 1, permissions: ["aervox.activity"] });
    const pluginRegistry = new ServerPluginRegistry();
    const hook = vi.fn(() => ({ extraSections: ["CAP033_PLUGIN_SECRET"] }));
    pluginRegistry.register({ id: "cap-plugin", beforeTurn: hook });
    Object.assign(dependencies, { personaLoader, memoryRecall: { recall }, extensionRepo, pluginRegistry, proactiveRepository: { getEffectiveStatus: profile } });
    const turnId = await httpTurn("owner");
    expect((await repo.getTurn(local, turnId))?.status).toBe("Completed");
    expect(personaLoader).toHaveBeenCalledOnce();
    expect(recall).toHaveBeenCalledOnce();
    expect(JSON.stringify(requests)).toContain("OWNER_PERSONA_SECRET");
    expect(JSON.stringify(requests)).toContain("OWNER_MEMORY_SECRET");
    expect(JSON.stringify(requests)).not.toContain("CAP033");
    expect(requests[0]?.tools ?? []).toEqual([]);
    expect(profile).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
  });

  it("owner memory writes still need approval and bind the actual Turn instead of model-supplied group provenance", async () => {
    await session("owner", "bot-owner-v1");
    await session("group", "bot-group-member-v1");
    await accept("group");
    const memoryRepo = new SqliteMemoryRepository(db, client);
    const store = vi.fn<MemoryWritePort["store"]>(async (ctx, input) => {
      const record = await memoryRepo.createRecord(ctx, { id: "saved", layer: "long_term", type: "user_fact", content: input.content, sourceTurnId: input.sourceTurnId });
      return { memoryId: record.id, isCandidate: false, embeddingStatus: "skipped" as const };
    });
    await contributeMemoryTool(runtime, { store });
    replyFor = request => request.messages.some(message => message.role === "tool") ? textSse() : toolSse("avx_aervox_memory_store", { content: "本人偏好", sourceTurnId: "turn_group" });
    const first = await httpTurn("owner");
    expect(store).not.toHaveBeenCalled();
    const [approval] = await repo.listToolApprovalsByTurn(local, first);
    expect(approval?.state).toBe("pending");
    expect((await repo.getTurn(local, first))?.status).toBe("Interrupted");
    await repo.decideToolApproval(local, approval!.id, "granted", "owner");
    const second = await httpTurn("owner");
    expect(store).toHaveBeenCalledOnce();
    expect((await memoryRepo.getRecord(local, "saved"))?.sourceTurnId).toBe(second);
    expect((await repo.getTurn(local, second))?.status).toBe("Completed");
  });

  it("rejects cross-member session/attempt substitution without mutating either accepted Turn", async () => {
    await session("member_a", "bot-group-member-v1");
    await session("member_b", "bot-group-member-v1");
    const input = await accept("member_a");
    await accept("member_b");
    await expect(executeAcceptedConversationTurn(repo, local, { ...input, sessionId: "member_b" }, dependencies)).rejects.toThrow("conversation_policy_mismatch");
    await expect(executeAcceptedConversationTurn(repo, local, { ...input, attemptId: "attempt_member_b" }, dependencies)).rejects.toThrow("conversation_attempt_mismatch");
    expect(requests).toEqual([]);
    expect((await repo.getTurn(local, input.turnId))?.status).toBe("Created");
  });

  it("direct executor calls also enforce persisted policy and accepted text", async () => {
    await session("group", "bot-group-member-v1");
    const input = await accept("group");
    const recall = vi.fn(async () => [{ id: "private", content: "PRIVATE_MEMORY_SECRET", source: "fts" as const }]);
    setRequestToolApprovalMode(local, "full_access");
    await runLoopTurnOnce(repo, local, input, { executionConfig: dependencies.executionConfig, llmConfigService: dependencies.llmConfigService, toolRuntime: runtime,
      memoryRecall: { recall }, persona: { prompt: "PRIVATE_PERSONA_SECRET" },
    });
    expect(JSON.stringify(requests)).toContain("已受理正文");
    expect(JSON.stringify(requests)).not.toContain("SECRET");
    expect(recall).not.toHaveBeenCalled();
    expect((await repo.getTurn(local, input.turnId))?.status).toBe("Completed");
  });

  it("records a sanitized failure event for preload errors and preserves completed attempts on duplicate calls", async () => {
    await session("owner", "bot-owner-v1");
    const input = await accept("owner");
    await executeAcceptedConversationTurn(repo, local, input, { ...dependencies, personaLoader: async () => { throw new Error("PRIVATE_FAILURE_SECRET"); } });
    expect((await repo.getTurn(local, input.turnId))?.status).toBe("Failed");
    const events = await repo.getStreamEvents(local, input.turnId);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("error");
    expect(errorEventDataSchema.safeParse(events[0]?.data).success).toBe(true);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_FAILURE_SECRET");
    await session("complete", "bot-owner-v1");
    const completed = await accept("complete");
    await executeAcceptedConversationTurn(repo, local, completed, dependencies);
    await executeAcceptedConversationTurn(repo, local, completed, { ...dependencies, personaLoader: async () => { throw new Error("late"); } });
    expect((await repo.getTurn(local, completed.turnId))?.status).toBe("Completed");
  });

  it("recovers an accepted workbench group turn through the full policy-aware API executor", async () => {
    await session("recovered-group", "bot-group-member-v1");
    const input = await accept("recovered-group");
    const privateLoader = vi.fn(async () => ({ prompt: "PRIVATE_RECOVERY_SECRET" }));
    const recovery = new ApiOwnedTurnRecovery(repo, createConversationApplication(repo, { ...dependencies, personaLoader: privateLoader }).commands.execute, { before: "2999-01-01T00:00:00.000Z" });
    await recovery.reconcile();
    await recovery.reconcile();
    await recovery.close();
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests)).toContain("已受理正文");
    expect(JSON.stringify(requests)).not.toContain("SECRET");
    expect(privateLoader).not.toHaveBeenCalled();
    expect((await repo.getTurn(local, input.turnId))).toMatchObject({ status: "Completed", dispatchTarget: "api", executionPolicy: "bot-group-member-v1" });
  });

  it("never takes a platform turn during the inbox turn-id commit window or new live requests", async () => {
    const bots = new SqliteBotRepository(db);
    await bots.createConnection({ id: "connection", adapterId: "fake", pluginId: "fake", displayName: "Fake", createdAt: new Date().toISOString() });
    await session("platform-group", "bot-group-member-v1");
    await bots.enqueue({ id: "inbound", connectionId: "connection", sessionId: "platform-group", connectionRevision: 1, messageJson: "{}", createdAt: new Date().toISOString() });
    await acceptConversationTurn(repo, local, { turnId: "platform-turn", sessionId: "platform-group", idempotencyKey: "bot:inbound",
      attemptId: "platform-attempt", message: { id: "platform-message", content: "平台队列" } });
    const recovery = new ApiOwnedTurnRecovery(repo, createConversationApplication(repo, dependencies).commands.execute, { before: "2999-01-01T00:00:00.000Z" });
    await recovery.reconcile();
    expect((await repo.getTurn(local, "platform-turn"))?.status).toBe("Created");
    expect(requests).toEqual([]);
    await session("new-group", "bot-group-member-v1");
    await accept("new-group");
    const beforeStartup = new ApiOwnedTurnRecovery(repo, createConversationApplication(repo, dependencies).commands.execute, { before: "2000-01-01T00:00:00.000Z" });
    await beforeStartup.reconcile();
    expect(requests).toEqual([]);
    await recovery.close(); await beforeStartup.close();
  });

  it("retires expired API-owned attempts with fencing and never replays uncertain tools", async () => {
    await session("expired-owner", "bot-owner-v1");
    const input = await accept("expired-owner");
    const claim = await repo.claimTurnAttempt(local, { turnId: input.turnId, attemptId: input.attemptId, expectedFencingToken: 0, leaseId: "lost-host", ttlMs: -1 });
    await repo.recordToolExecution(local, { turnId: input.turnId, attemptId: input.attemptId, invocationId: "uncertain", name: "write", status: "pending", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
    const recovery = new ApiOwnedTurnRecovery(repo, createConversationApplication(repo, dependencies).commands.execute, { before: "2999-01-01T00:00:00.000Z" });
    await recovery.reconcile(); await recovery.reconcile(); await recovery.close();
    expect(requests).toEqual([]);
    expect((await repo.getTurn(local, input.turnId))?.status).toBe("Interrupted");
    expect((await repo.listTurnAttempts(local, input.turnId))[0]).toMatchObject({ status: "Interrupted", fencingToken: claim.fencingToken + 1 });
    expect((await repo.listToolExecutionsByTurn(local, input.turnId))[0]?.status).toBe("outcome_unknown");
    expect(await repo.finalizeTurnAttempt(local, { turnId: input.turnId, attemptId: input.attemptId, status: "Completed", expectedFencingToken: claim.fencingToken })).toBeNull();
    expect(await repo.getStreamEvents(local, input.turnId)).toHaveLength(1);
  });

  it("preserves live leases and joins concurrent dispatch instead of loading owner dependencies twice", async () => {
    await session("live-owner", "bot-owner-v1");
    const input = await accept("live-owner");
    const privateLoader = vi.fn(async () => ({ prompt: "OWNER_RECOVERY_CONTEXT" }));
    const deps = { ...dependencies, personaLoader: privateLoader };
    const recovery = new ApiOwnedTurnRecovery(repo, createConversationApplication(repo, deps).commands.execute, { before: "2999-01-01T00:00:00.000Z" });
    await Promise.all([executeAcceptedConversationTurn(repo, local, input, deps), recovery.reconcile()]);
    expect(requests).toHaveLength(1);
    expect(privateLoader).toHaveBeenCalledOnce();
    await session("leased-owner", "bot-owner-v1");
    const leased = await accept("leased-owner");
    await repo.claimTurnAttempt(local, { turnId: leased.turnId, attemptId: leased.attemptId, expectedFencingToken: 0, leaseId: "live-host" });
    await recovery.reconcile(); await recovery.close();
    expect(requests).toHaveLength(1);
    expect((await repo.listTurnAttempts(local, leased.turnId))[0]?.status).toBe("Running");
  });
});
