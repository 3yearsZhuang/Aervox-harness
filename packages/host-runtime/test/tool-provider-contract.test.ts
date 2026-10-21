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
});
