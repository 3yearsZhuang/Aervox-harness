import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteConversationRepository,
  type AervoxDatabase,
} from "@aervox/repositories";
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
      tools: [{ name: "workflow_run", description: "run", readOnly: false }],
      execute,
    };
    setRequestToolApprovalMode(tenant, "ask");

    const result = await createApprovalGatedToolProvider(provider, tenant, repo).execute({
      turnId: "turn_ask",
      attemptId: "attempt_ask",
      invocationId: "call_ask",
      name: "workflow_run",
      arguments: { name: "demo" },
    });

    expect(result.needsApproval?.toolName).toBe("workflow_run");
    expect(execute).not.toHaveBeenCalled();
    expect((await repo.listToolApprovalsByTurn(tenant, "turn_ask"))[0]?.state).toBe("pending");
  });

  it("完全访问放行静态写工具，恢复 ask 后不复用自动授权", async () => {
    await createTurn("turn_full", "attempt_full");
    const execute = vi.fn(async () => ({ ok: true, output: { done: true } }));
    const provider: ToolProviderPort = {
      tools: [{ name: "subagent_delegate", description: "delegate", readOnly: false }],
      execute,
    };
    const gated = createApprovalGatedToolProvider(provider, tenant, repo);
    setRequestToolApprovalMode(tenant, "full_access");

    const fullResult = await gated.execute({
      turnId: "turn_full",
      attemptId: "attempt_full",
      invocationId: "call_full",
      name: "subagent_delegate",
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
      name: "subagent_delegate",
      arguments: { task: "demo" },
    });

    expect(askResult.needsApproval).toBeTruthy();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("完全访问下，高危技能晋升工具（aervox_skill_promote）依然强制拦截为 pending 待用户确认", async () => {
    await createTurn("turn_skill_danger", "attempt_skill_danger");
    const execute = vi.fn(async () => ({ ok: true, output: { promoted: true } }));
    const provider: ToolProviderPort = {
      tools: [{ name: "aervox_skill_promote", description: "promote skill to production", readOnly: false }],
      execute,
    };
    const gated = createApprovalGatedToolProvider(provider, tenant, repo);
    setRequestToolApprovalMode(tenant, "full_access");

    const result = await gated.execute({
      turnId: "turn_skill_danger",
      attemptId: "attempt_skill_danger",
      invocationId: "call_skill_danger",
      name: "aervox_skill_promote",
      arguments: { candidateId: "cand_123" },
    });

    expect(result.ok).toBe(false);
    expect(result.needsApproval?.toolName).toBe("aervox_skill_promote");
    expect(execute).not.toHaveBeenCalled();
    const [approval] = await repo.listToolApprovalsByTurn(tenant, "turn_skill_danger");
    expect(approval?.state).toBe("pending");
  });

  it("完全访问下，高危物理安防动作（ha_call_service 门锁/报警）强制拦截，普通家电放行", async () => {
    await createTurn("turn_ha_lock", "attempt_ha_lock");
    const execute = vi.fn(async () => ({ ok: true, output: { success: true } }));
    const provider: ToolProviderPort = {
      tools: [{ name: "ha_call_service", description: "ha service", readOnly: false }],
      execute,
    };
    const gated = createApprovalGatedToolProvider(provider, tenant, repo);
    setRequestToolApprovalMode(tenant, "full_access");

    // 高危门锁操作：拦截
    const lockResult = await gated.execute({
      turnId: "turn_ha_lock",
      attemptId: "attempt_ha_lock",
      invocationId: "call_ha_lock",
      name: "ha_call_service",
      arguments: {
        connectionId: "conn_1",
        entityId: "lock.front_door",
        service: "unlock",
      },
    });
    expect(lockResult.ok).toBe(false);
    expect(lockResult.needsApproval?.toolName).toBe("ha_call_service");
    expect(execute).not.toHaveBeenCalled();

    // 普通家电操作：自动放行
    await createTurn("turn_ha_light", "attempt_ha_light");
    const lightResult = await gated.execute({
      turnId: "turn_ha_light",
      attemptId: "attempt_ha_light",
      invocationId: "call_ha_light",
      name: "ha_call_service",
      arguments: {
        connectionId: "conn_1",
        entityId: "light.living_room",
        service: "turn_on",
      },
    });
    expect(lightResult.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("恶意路径穿越参数（path: ../../etc/passwd）被前置拦截，不产生授权、不执行工具", async () => {
    await createTurn("turn_malicious", "attempt_malicious");
    const execute = vi.fn(async () => ({ ok: true, output: { done: true } }));
    const provider: ToolProviderPort = {
      tools: [{ name: "read_notes", description: "read notes", readOnly: true }],
      execute,
    };
    const gated = createApprovalGatedToolProvider(provider, tenant, repo);

    const result = await gated.execute({
      turnId: "turn_malicious",
      attemptId: "attempt_malicious",
      invocationId: "call_malicious",
      name: "read_notes",
      arguments: {
        path: "../../etc/passwd",
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("unsafe_tool_arguments");
    expect(result.error).toContain("path_traversal_sequence");
    expect(execute).not.toHaveBeenCalled();
    const approvals = await repo.listToolApprovalsByTurn(tenant, "turn_malicious");
    expect(approvals).toHaveLength(0);
  });
});
