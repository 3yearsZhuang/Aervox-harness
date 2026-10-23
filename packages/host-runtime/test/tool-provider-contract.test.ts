import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolExecutionInput, ToolProviderPort, ToolSpec } from "@aervox/core";
import {
  createInMemoryDatabase,
  SqliteConversationRepository,
  SqliteToolRegistryRepository,
} from "@aervox/repositories";
import {
  createApprovalGatedToolProvider,
  createRuntimeToolProvider,
} from "../src/modules/companion/conversation/tool-providers.js";
import { ToolRuntime } from "../src/modules/ecosystem/tools/runtime.js";
import type { ProactiveActionPort } from "../src/modules/proactive/proactive/index.js";
import { setRequestToolApprovalMode } from "../src/shared/tool-approval-policy.js";

const local = { workspaceId: "local", subjectUserId: "local" };
const input: ToolExecutionInput = {
  turnId: "turn",
  attemptId: "attempt",
  invocationId: "call",
  name: "contract_tool",
  arguments: { count: 2 },
};
const parameters = {
  type: "object",
  properties: { count: { type: "integer", minimum: 1 } },
  required: ["count"],
  additionalProperties: false,
};

describe("host tool contracts before execution and approval", () => {
  let cleanup: () => Promise<void>;
  let repo: SqliteConversationRepository;
  let registry: SqliteToolRegistryRepository;
  let runtime: ToolRuntime;

  beforeEach(async () => {
    const memory = await createInMemoryDatabase();
    cleanup = memory.cleanup;
    repo = new SqliteConversationRepository(memory.db);
    registry = new SqliteToolRegistryRepository(memory.db);
    runtime = new ToolRuntime({ registry });
    setRequestToolApprovalMode(local, "ask");
    await repo.getOrCreateSession(local, "session", "Tool contract");
    await repo.createTurnWithOutbox(
      local,
      { id: input.turnId, sessionId: "session", idempotencyKey: "contract" },
      { id: "message", content: "Run tool" },
    );
    await repo.createTurnAttempt(local, input.turnId, { id: input.attemptId });
  });

  afterEach(async () => {
    runtime.dispose();
    await cleanup();
  });

  function staticProvider(overrides: Partial<ToolSpec> = {}, authorizer?: ProactiveActionPort) {
    const execute = vi.fn(async () => ({ ok: true, output: "executed" }));
    const provider: ToolProviderPort = {
      tools: [{ name: input.name, description: "contract", readOnly: true, parameters, ...overrides }],
      execute,
    };
    return { execute, gated: createApprovalGatedToolProvider(provider, local, repo, authorizer) };
  }

  it.each([true, false])("invalid static arguments are rejected before handler or approval (readOnly=%s)", async readOnly => {
    setRequestToolApprovalMode(local, "full_access");
    const { execute, gated } = staticProvider({ readOnly });
    const rejected = await gated.execute({ ...input, arguments: { count: "two" } });
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toMatch(/^invalid_tool_input:/);
    expect(rejected.needsApproval).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    expect(await repo.listToolApprovalsByTurn(local, input.turnId)).toEqual([]);
  });

  it("static boolean false schema rejects all input, while valid read-only input executes", async () => {
    const blocked = staticProvider({ parameters: false });
    expect((await blocked.gated.execute(input)).error).toMatch(/^invalid_tool_input:/);
    expect(blocked.execute).not.toHaveBeenCalled();
    const allowed = staticProvider();
    expect(await allowed.gated.execute(input)).toMatchObject({ ok: true, output: "executed" });
    expect(allowed.execute).toHaveBeenCalledOnce();
  });

  it.each(["privileged", "destructive"])("readOnly and full_access cannot lower explicit %s safety", async safetyLevel => {
    setRequestToolApprovalMode(local, "full_access");
    const { execute, gated } = staticProvider({ safetyLevel, readOnly: true });
    const pending = await gated.execute(input);
    expect(pending.needsApproval?.toolName).toBe(input.name);
    expect(execute).not.toHaveBeenCalled();
    expect((await repo.listToolApprovalsByTurn(local, input.turnId))[0]?.state).toBe("pending");
    await repo.decideToolApproval(local, pending.needsApproval!.approvalId, "granted", "local");
    expect(await gated.execute(input)).toMatchObject({ ok: true });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("unknown safety stays closed even with a previously granted matching approval", async () => {
    const approval = await repo.recordToolApproval(local, {
      turnId: input.turnId,
      attemptId: input.attemptId,
      toolName: input.name,
      argumentsHash: '{"count":2}',
      requester: "local",
      state: "pending",
    });
    await repo.decideToolApproval(local, approval.id, "granted", "local");
    setRequestToolApprovalMode(local, "full_access");
    const { execute, gated } = staticProvider({ safetyLevel: "future_level" });
    expect(await gated.execute(input)).toMatchObject({ ok: false, error: expect.stringContaining("未支持的安全级别") });
    expect(execute).not.toHaveBeenCalled();
    expect(await repo.listToolApprovalsByTurn(local, input.turnId)).toHaveLength(1);
  });

  it("an explicit read_only label cannot lower a write declaration", async () => {
    const { execute, gated } = staticProvider({ readOnly: false, safetyLevel: "read_only" });
    expect((await gated.execute(input)).needsApproval).toBeDefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["privileged", "destructive"])("proactive authorization receives the actual %s scope before any side effect", async safetyLevel => {
    setRequestToolApprovalMode(local, "full_access");
    const authorize = vi.fn(async () => ({ authorized: false as const, reason: "missing_grant", scopes: [] }));
    const authorizer: ProactiveActionPort = {
      authorize,
      markRunning: vi.fn(),
      markExecuted: vi.fn(),
      markFailed: vi.fn(),
    };
    const { execute, gated } = staticProvider({ safetyLevel }, authorizer);
    expect((await gated.execute(input)).needsApproval).toBeDefined();
    expect(authorize).toHaveBeenCalledWith(local, expect.objectContaining({
      safetyLevel,
      irreversible: safetyLevel === "destructive",
    }));
    expect(execute).not.toHaveBeenCalled();
    expect(authorizer.markRunning).not.toHaveBeenCalled();
  });

  it.each(["read_only", "write_with_approval"])("SQLite runtime input is validated before %s handler or approval", async safetyLevel => {
    const handler = vi.fn(async () => "executed");
    await runtime.registerContribution({
      id: "registered",
      name: input.name,
      description: "contract",
      category: "system",
      safetyLevel,
      inputSchema: parameters,
    }, { call: handler });
    const provider = createRuntimeToolProvider(runtime, local, { conversationRepo: repo });
    await provider.listTools!();
    const result = await provider.execute({ ...input, arguments: { count: 0 } });
    expect(result.error).toMatch(/^schema_validation_failed:/);
    expect(result.needsApproval).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
    expect(await repo.listToolApprovalsByTurn(local, input.turnId)).toEqual([]);
  });

  it("SQLite false schema remains in the advertised contract and blocks direct and provider calls", async () => {
    const handler = vi.fn(async () => "executed");
    await runtime.registerContribution({
      id: "registered",
      name: input.name,
      description: "contract",
      category: "system",
      safetyLevel: "read_only",
      inputSchema: false,
    }, { call: handler });
    const provider = createRuntimeToolProvider(runtime, local, { conversationRepo: repo });
    expect((await provider.listTools!())[0]?.parameters).toBe(false);
    expect((await provider.execute(input)).error).toMatch(/^schema_validation_failed:/);
    await expect(runtime.callTool(local, "registered", input.arguments)).rejects.toMatchObject({ code: "SCHEMA_VALIDATION_FAILED" });
    expect(handler).not.toHaveBeenCalled();
    expect(await repo.listToolApprovalsByTurn(local, input.turnId)).toEqual([]);
  });

  it.each([
    { type: "object", properties: { count: { const: 1 } } },
    { type: "object", properties: { count: { anyOf: [{ type: "string" }, { const: null }] } } },
    { type: "object", properties: { unused: { pattern: "^safe$" } } },
  ])("strict schema %j rejects both static and SQLite calls before approval", async inputSchema => {
    const { execute, gated } = staticProvider({ readOnly: false, parameters: inputSchema });
    expect((await gated.execute(input)).error).toMatch(/^invalid_tool_input:/);
    expect(execute).not.toHaveBeenCalled();
    const handler = vi.fn(async () => "executed");
    await runtime.registerContribution({
      id: "registered", name: input.name, description: "strict contract", category: "system",
      safetyLevel: "write_with_approval", inputSchema,
    }, { call: handler });
    const provider = createRuntimeToolProvider(runtime, local, { conversationRepo: repo });
    await provider.listTools!();
    const rejected = await provider.execute(input);
    expect(rejected.error).toMatch(/^schema_validation_failed:/);
    expect(rejected.needsApproval).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
    expect(await repo.listToolApprovalsByTurn(local, input.turnId)).toEqual([]);
  });

  it("SQLite runtime budget survives typed adapter listing without becoming persisted metadata", async () => {
    await runtime.registerContribution({
      id: "registered",
      name: input.name,
      description: "contract",
      category: "system",
      safetyLevel: "read_only",
      inputSchema: parameters,
      budget: { timeoutMs: 250 },
    }, { call: async () => "executed" });
    expect((await runtime.listTools())[0]?.budget).toEqual({ timeoutMs: 250 });
    expect((await runtime.exportRegistry())[0]?.budget).toEqual({ timeoutMs: 250 });
    const provider = createRuntimeToolProvider(runtime, local, { conversationRepo: repo });
    expect((await provider.listTools!())[0]?.budget).toEqual({ timeoutMs: 250 });
    expect(await registry.getTool("registered")).not.toHaveProperty("budget");
    expect(await provider.execute(input)).toMatchObject({ ok: true, output: "executed" });
    const freshRuntime = new ToolRuntime({ registry });
    try {
      freshRuntime.registerHandler("registered", { call: async () => "executed" });
      expect((await freshRuntime.exportRegistry())[0]?.budget).toBeUndefined();
    } finally {
      freshRuntime.dispose();
    }
  });

  it("redeclaring a replacement handler cannot reuse its old approval even when persistent updatedAt is unchanged", async () => {
    const first = vi.fn(async () => "first"); const replacement = vi.fn(async () => "replacement");
    await runtime.registerContribution({ id: "registered", name: input.name, description: "contract", category: "system",
      safetyLevel: "write_with_approval", inputSchema: parameters }, { call: first });
    const provider = createRuntimeToolProvider(runtime, local, { conversationRepo: repo });
    await provider.listTools!();
    const pending = await provider.execute(input);
    await repo.decideToolApproval(local, pending.needsApproval!.approvalId, "granted", "local");
    const previous = await registry.getTool("registered");
    runtime.registerHandler("registered", { call: replacement });
    expect((await registry.getTool("registered"))!.updatedAt).toBe(previous!.updatedAt);
    expect((await provider.execute(input)).error).toBe("tool_not_declared");
    await provider.listTools!();
    const next = await provider.execute(input);
    expect(next.needsApproval).toBeDefined();
    expect(next.needsApproval!.approvalId).not.toBe(pending.needsApproval!.approvalId);
    expect(replacement).not.toHaveBeenCalled(); expect(first).not.toHaveBeenCalled();
    await repo.decideToolApproval(local, next.needsApproval!.approvalId, "granted", "local");
    expect(await provider.execute(input)).toMatchObject({ ok: true, output: "replacement" });
    expect(replacement).toHaveBeenCalledOnce();
  });

  it.each([false, true])("restart reuses a persisted approval only with an explicit stable implementation revision (durable=%s)", async durable => {
    const handler = vi.fn(async () => "executed");
    const registration = { id: "registered", name: input.name, description: "contract", category: "system", safetyLevel: "write_with_approval", inputSchema: parameters };
    await runtime.registerContribution(registration, { call: handler, ...(durable ? { approvalRevision: "impl:v1" } : {}) });
    const first = createRuntimeToolProvider(runtime, local, { conversationRepo: repo });
    await first.listTools!();
    const pending = await first.execute(input);
    await repo.decideToolApproval(local, pending.needsApproval!.approvalId, "granted", "local");
    runtime.dispose(); runtime = new ToolRuntime({ registry });
    await runtime.registerContribution(registration, { call: handler, ...(durable ? { approvalRevision: "impl:v1" } : {}) });
    const restarted = createRuntimeToolProvider(runtime, local, { conversationRepo: repo });
    await restarted.listTools!();
    const result = await restarted.execute(input);
    if (durable) { expect(result).toMatchObject({ ok: true }); expect(handler).toHaveBeenCalledOnce(); }
    else { expect(result.needsApproval).toBeDefined(); expect(handler).not.toHaveBeenCalled(); }
  });

  it("changed durable implementation or declaration revisions require distinct pending approvals", async () => {
    const handler = vi.fn(async () => "executed");
    const registration = { id: "registered", name: input.name, description: "contract", category: "system", safetyLevel: "write_with_approval", inputSchema: parameters };
    await runtime.registerContribution(registration, { call: handler, approvalRevision: "impl:v1" });
    const provider = createRuntimeToolProvider(runtime, local, { conversationRepo: repo });
    await provider.listTools!();
    const first = await provider.execute(input);
    runtime.registerHandler("registered", { call: handler, approvalRevision: "impl:v2" });
    await provider.listTools!(); const second = await provider.execute(input);
    await runtime.registerContribution({ ...registration, inputSchema: { ...parameters, additionalProperties: true } }, { call: handler, approvalRevision: "impl:v2" });
    await provider.listTools!(); const third = await provider.execute(input);
    const ids = [first, second, third].map(result => result.needsApproval!.approvalId);
    expect(new Set(ids).size).toBe(3);
    expect(handler).not.toHaveBeenCalled();
  });

  it("a stable runtime implementation never carries its grant into another plugin generation", async () => {
    const handler = vi.fn(async () => "executed"); let generation = "one";
    await runtime.registerContribution({ id: "registered", name: input.name, description: "plugin contract", category: "system",
      pluginId: "plugin", safetyLevel: "write_with_approval", inputSchema: parameters }, { call: handler, approvalRevision: "impl:v1" });
    const provider = createRuntimeToolProvider(runtime, local, { conversationRepo: repo, generationFor: () => generation });
    await provider.listTools!();
    const old = await provider.execute(input);
    await repo.decideToolApproval(local, old.needsApproval!.approvalId, "granted", "local");
    generation = "two";
    expect((await provider.execute(input)).error).toBe("tool_not_declared");
    await provider.listTools!();
    const fresh = await provider.execute(input);
    expect(fresh.needsApproval).toBeDefined();
    expect(fresh.needsApproval!.approvalId).not.toBe(old.needsApproval!.approvalId);
    expect(handler).not.toHaveBeenCalled();
  });

  it("a legacy unversioned grant cannot authorize a newly declared implementation", async () => {
    const old = await repo.recordToolApproval(local, { turnId: input.turnId, attemptId: input.attemptId,
      toolName: input.name, argumentsHash: '{"count":2}', requester: "local", state: "pending" });
    await repo.decideToolApproval(local, old.id, "granted", "local");
    const { execute, gated } = staticProvider({ readOnly: false });
    expect((await gated.execute(input)).needsApproval).toBeDefined();
    expect(execute).not.toHaveBeenCalled();
  });
});
