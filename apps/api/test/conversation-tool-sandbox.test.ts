/**
 * Aervox｜思隅 @aervox/api — B 阶段安全加固集成测试
 *
 * 覆盖：
 * 1. 动态 ToolRuntime.callTool 直接调用的沙箱参数校验与防逃逸；
 * 2. createRuntimeToolProvider 面对高危不可免审工具（如 aervox_skill_promote）的 full_access 强制阻断与审批挂起；
 * 3. 面对恶意参数（路径穿越、空字节）在 ToolProvider 执行侧的 Fail-closed 拦截；
 * 4. 正常写工具在 full_access 模式下的平滑免审执行。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteConversationRepository,
  SqliteToolRegistryRepository,
  type AervoxDatabase,
} from "@aervox/repositories";
import {
  createRuntimeToolProvider,
} from "../src/modules/conversation/agent-executor.js";
import { setRequestToolApprovalMode } from "../src/shared/tool-approval-policy.js";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import { ForbiddenError } from "../src/shared/errors.js";

const tenant = { workspaceId: "ws_sandbox", subjectUserId: "usr_sandbox" } as const;

describe("B 阶段安全加固：工具沙箱与不可绕过策略执行机制", () => {
  let db: AervoxDatabase;
  let repo: SqliteConversationRepository;
  let registry: SqliteToolRegistryRepository;
  let app: FastifyInstance;
  let built: Awaited<ReturnType<typeof buildApp>>;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const memory = await createInMemoryDatabase();
    await initDatabaseSchema(memory.client);
    db = memory.db;
    cleanup = memory.cleanup;
    repo = new SqliteConversationRepository(db);
    registry = new SqliteToolRegistryRepository(db);
    built = await buildApp({ db, client: memory.client });
    app = built.app;
    await app.ready();
    await repo.getOrCreateSession(tenant, "ses_sandbox", "Sandbox security test");
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  async function createTurn(turnId: string, attemptId: string) {
    await repo.createTurnWithOutbox(
      tenant,
      { id: turnId, sessionId: "ses_sandbox", idempotencyKey: `idem_${turnId}` },
      { id: `msg_${turnId}`, content: "test sandbox" },
    );
    await repo.createTurnAttempt(tenant, turnId, { id: attemptId });
  }

  describe("1. ToolRuntime.callTool 入口参数沙箱防线（直接/REST/MCP 调用不可绕过）", () => {
    it("恶意路径穿越参数（path: ../../etc/shadow）直接抛出 ForbiddenError 拒绝", async () => {
      await registry.registerTool({
        id: "test_reader",
        name: "test_reader",
        description: "读取文件内容",
        category: "system",
        safetyLevel: "read_only",
        requiredPermissions: [],
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
        builtin: false,
        gatingConditions: [],
        priority: 10,
      });
      built.toolRuntime.registerHandler("test_reader", {
        call: async () => ({ content: "secret" }),
      });

      await expect(
        built.toolRuntime.callTool(tenant, "test_reader", { path: "../../etc/shadow" }),
      ).rejects.toThrow(ForbiddenError);

      await expect(
        built.toolRuntime.callTool(tenant, "test_reader", { path: "../../etc/shadow" }),
      ).rejects.toThrow(/unsafe tool arguments/);
    });

    it("空字节注入参数（\\0）直接拦截并抛出 ForbiddenError", async () => {
      await registry.registerTool({
        id: "test_uploader",
        name: "test_uploader",
        description: "上传测试",
        category: "system",
        safetyLevel: "read_only",
        requiredPermissions: [],
        inputSchema: { type: "object", properties: { file: { type: "string" } } },
        builtin: false,
        gatingConditions: [],
        priority: 10,
      });
      built.toolRuntime.registerHandler("test_uploader", {
        call: async () => ({ uploaded: true }),
      });

      await expect(
        built.toolRuntime.callTool(tenant, "test_uploader", { file: "avatar.jpg\0.sh" }),
      ).rejects.toThrow(/null_byte_injection/);
    });

    it("合法参数正常执行", async () => {
      await registry.registerTool({
        id: "test_safe",
        name: "test_safe",
        description: "安全操作",
        category: "system",
        safetyLevel: "read_only",
        requiredPermissions: [],
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
        builtin: false,
        gatingConditions: [],
        priority: 10,
      });
      built.toolRuntime.registerHandler("test_safe", {
        call: async (_t, args) => ({ echo: (args as { query: string }).query }),
      });

      const res = await built.toolRuntime.callTool(tenant, "test_safe", { query: "三角函数" });
      expect(res).toEqual({ echo: "三角函数" });
    });
  });

  describe("2. createRuntimeToolProvider 动态工具执行防线（Agent 执行管线不可绕过）", () => {
    it("full_access 模式下，高危技能生产变更工具（aervox_skill_promote）强制阻断并生成 pending 授权", async () => {
      await createTurn("turn_skill_test", "attempt_skill_test");
      await registry.registerTool({
        id: "aervox_skill_promote",
        name: "aervox_skill_promote",
        description: "晋级技能到生产目录",
        category: "system",
        safetyLevel: "write_with_approval",
        requiredPermissions: [],
        inputSchema: { type: "object", properties: { candidateId: { type: "string" } } },
        builtin: false,
        gatingConditions: [],
        priority: 10,
      });
      built.toolRuntime.registerHandler("aervox_skill_promote", {
        call: async () => ({ promoted: true }),
      });

      const provider = createRuntimeToolProvider(built.toolRuntime, tenant, {
        conversationRepo: repo,
      });
      setRequestToolApprovalMode(tenant, "full_access");

      const result = await provider.execute({
        turnId: "turn_skill_test",
        attemptId: "attempt_skill_test",
        invocationId: "call_promote_1",
        name: "aervox_skill_promote",
        arguments: { candidateId: "cand_999" },
      });

      // 验证未被免审放行，生成 pending 授权
      expect(result.ok).toBe(false);
      expect(result.needsApproval?.toolName).toBe("aervox_skill_promote");
      const [approval] = await repo.listToolApprovalsByTurn(tenant, "turn_skill_test");
      expect(approval?.state).toBe("pending");
    });

    it("full_access 模式下，普通写工具（aervox_normal_write）正常自动放行", async () => {
      await createTurn("turn_normal_test", "attempt_normal_test");
      await registry.registerTool({
        id: "aervox_normal_write",
        name: "aervox_normal_write",
        description: "记录日常笔记",
        category: "memory",
        safetyLevel: "write_with_approval",
        requiredPermissions: [],
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
        builtin: false,
        gatingConditions: [],
        priority: 10,
      });
      built.toolRuntime.registerHandler("aervox_normal_write", {
        call: async (_t, args) => ({ written: true, text: (args as { text: string }).text }),
      });

      const provider = createRuntimeToolProvider(built.toolRuntime, tenant, {
        conversationRepo: repo,
      });
      setRequestToolApprovalMode(tenant, "full_access");

      const result = await provider.execute({
        turnId: "turn_normal_test",
        attemptId: "attempt_normal_test",
        invocationId: "call_normal_1",
        name: "aervox_normal_write",
        arguments: { text: "今天天气很好" },
      });

      expect(result.ok).toBe(true);
      expect(result.output).toEqual({ written: true, text: "今天天气很好" });
      const [approval] = await repo.listToolApprovalsByTurn(tenant, "turn_normal_test");
      expect(approval?.state).toBe("granted");
    });

    it("工具入参包含路径穿越攻击时，在执行前直接 fail-closed 拒绝且不写授权账本", async () => {
      await createTurn("turn_traversal_test", "attempt_traversal_test");
      await registry.registerTool({
        id: "aervox_file_save",
        name: "aervox_file_save",
        description: "保存文件",
        category: "system",
        safetyLevel: "write_with_approval",
        requiredPermissions: [],
        inputSchema: { type: "object", properties: { target_path: { type: "string" } } },
        builtin: false,
        gatingConditions: [],
        priority: 10,
      });
      built.toolRuntime.registerHandler("aervox_file_save", {
        call: async () => ({ saved: true }),
      });

      const provider = createRuntimeToolProvider(built.toolRuntime, tenant, {
        conversationRepo: repo,
      });

      const result = await provider.execute({
        turnId: "turn_traversal_test",
        attemptId: "attempt_traversal_test",
        invocationId: "call_traversal_1",
        name: "aervox_file_save",
        arguments: { target_path: "../../config/credentials.json" },
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("unsafe_tool_arguments");
      expect(result.error).toContain("path_traversal_sequence");
      const approvals = await repo.listToolApprovalsByTurn(tenant, "turn_traversal_test");
      expect(approvals).toHaveLength(0);
    });
  });
});
