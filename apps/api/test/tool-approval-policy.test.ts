import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteConversationRepository,
  type AervoxDatabase,
} from "@aervox/database";
import type { ToolProviderPort } from "@aervox/agent-loop";
import {
  createApprovalGatedToolProvider,
  FULL_ACCESS_DECIDER_PREFIX,
} from "../src/modules/conversation/agent-executor.js";
import { setRequestToolApprovalMode } from "../src/shared/tool-approval-policy.js";

const tenant = { workspaceId: "ws_policy", subjectUserId: "usr_policy" } as const;

describe("Turn 级工具授权策略", () => {
  let db: AervoxDatabase;
  let repo: SqliteConversationRepository;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const memory = await createInMemoryDatabase();
    await initDatabaseSchema(memory.client);
    db = memory.db;
    cleanup = memory.cleanup;
    repo = new SqliteConversationRepository(db);
    await repo.getOrCreateSession(tenant, "ses_policy", "Policy test");
  });

  afterEach(async () => {
    await cleanup();
  });

  async function createTurn(turnId: string, attemptId: string) {
    await repo.createTurnWithOutbox(
      tenant,
      { id: turnId, sessionId: "ses_policy", idempotencyKey: `idem_${turnId}` },
      { id: `msg_${turnId}`, content: "run tool" },
    );
    await repo.createTurnAttempt(tenant, turnId, { id: attemptId });
  }

  it("ask 模式拦截静态写工具并生成 pending 授权", async () => {
    await createTurn("turn_ask", "attempt_ask");
    const execute = vi.fn(async () => ({ ok: true, output: { done: true } }));
    const provider: ToolProviderPort = {
      tools: [{ name: "workflow.run", description: "run", readOnly: false }],
      execute,
    };
    setRequestToolApprovalMode(tenant, "ask");

    const result = await createApprovalGatedToolProvider(provider, tenant, repo).execute({
      turnId: "turn_ask",
      attemptId: "attempt_ask",
      invocationId: "call_ask",
      name: "workflow.run",
      arguments: { name: "demo" },
    });

    expect(result.needsApproval?.toolName).toBe("workflow.run");
    expect(execute).not.toHaveBeenCalled();
    expect((await repo.listToolApprovalsByTurn(tenant, "turn_ask"))[0]?.state).toBe("pending");
  });

  it("完全访问放行静态写工具，恢复 ask 后不复用自动授权", async () => {
    await createTurn("turn_full", "attempt_full");
    const execute = vi.fn(async () => ({ ok: true, output: { done: true } }));
    const provider: ToolProviderPort = {
      tools: [{ name: "subagent.delegate", description: "delegate", readOnly: false }],
      execute,
    };
    const gated = createApprovalGatedToolProvider(provider, tenant, repo);
    setRequestToolApprovalMode(tenant, "full_access");

    const fullResult = await gated.execute({
      turnId: "turn_full",
      attemptId: "attempt_full",
      invocationId: "call_full",
      name: "subagent.delegate",
      arguments: { task: "demo" },
    });

    expect(fullResult.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    const [approval] = await repo.listToolApprovalsByTurn(tenant, "turn_full");
    expect(approval?.state).toBe("granted");
    expect(approval?.decidedBy).toBe(`${FULL_ACCESS_DECIDER_PREFIX}${tenant.subjectUserId}`);

    await createTurn("turn_ask_after", "attempt_ask_after");
    setRequestToolApprovalMode(tenant, "ask");
    const askResult = await gated.execute({
      turnId: "turn_ask_after",
      attemptId: "attempt_ask_after",
      invocationId: "call_ask_after",
      name: "subagent.delegate",
      arguments: { task: "demo" },
    });

    expect(askResult.needsApproval).toBeTruthy();
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
