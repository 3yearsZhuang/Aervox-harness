/**
 * Aervox｜思隅 @aervox/api — CR-043/N2a 本地模型能力分层与 L1 工具收紧测试
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteConversationRepository,
  SqliteToolRegistryRepository,
  type AervoxDatabase,
} from "@aervox/repositories";
import { ToolRuntime } from "../src/modules/tools/runtime.js";
import { createRuntimeToolProvider } from "../src/modules/conversation/agent-executor.js";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type { Client } from "@libsql/client";

describe("CR-043 N2a: 本地模型能力分层与 L1 工具受限测试", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;
  let convRepo: SqliteConversationRepository;
  let runtime: ToolRuntime;

  const tenant = { workspaceId: "local", subjectUserId: "local_user" };

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
    const built = await buildApp({ db, client });
    app = built.app;
    await app.ready();
    runtime = built.toolRuntime;
    convRepo = new SqliteConversationRepository(db);

    const registry = new SqliteToolRegistryRepository(db);
    // 注册只读工具
    await registry.registerTool({
      id: "tool_search_notes",
      name: "search_notes",
      displayName: "搜索笔记",
      description: "检索用户笔记",
      category: "general",
      safetyLevel: "read_only",
      enabled: 1,
    });
    runtime.registerHandler("tool_search_notes", {
      call: async (_ctx, args) => ({ matches: [`result for ${(args as any).query}`] }),
    });

    // 注册写入工具
    await registry.registerTool({
      id: "tool_create_note",
      name: "create_note",
      displayName: "创建笔记",
      description: "创建新笔记",
      category: "general",
      safetyLevel: "write_with_approval",
      enabled: 1,
    });
    runtime.registerHandler("tool_create_note", {
      call: async (_ctx, args) => ({ created: true, title: (args as any).title }),
    });
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  it("正常未受限模式下只读工具正常执行", async () => {
    const provider = createRuntimeToolProvider(runtime, tenant, {
      conversationRepo: convRepo,
    });

    const result = await provider.execute({
      name: "search_notes",
      arguments: { query: "微积分" },
    });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ matches: ["result for 微积分"] });
  });

  it("L1 受限模式 (capabilityTier=restricted) 下允许只读工具执行", async () => {
    const provider = createRuntimeToolProvider(runtime, tenant, {
      conversationRepo: convRepo,
      capabilityTier: "restricted",
    });

    const result = await provider.execute({
      name: "search_notes",
      arguments: { query: "线性代数" },
    });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ matches: ["result for 线性代数"] });
  });

  it("L1 受限模式 (capabilityTier=restricted) 下主动阻断写工具执行并返回 safe error", async () => {
    const provider = createRuntimeToolProvider(runtime, tenant, {
      conversationRepo: convRepo,
      capabilityTier: "restricted",
    });

    const result = await provider.execute({
      name: "create_note",
      arguments: { title: "新笔记" },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("tool_restricted_in_tier_l1");
    expect(result.error).toContain("create_note");
  });
});
