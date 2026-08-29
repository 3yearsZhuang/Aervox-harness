/**
 * Aervox｜思隅 @aervox/api — 工具系统 + 插件运行时集成测试（T-04 / AST-04 / PET-05 / CAP-020）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createInMemoryDatabase, initDatabaseSchema, type AervoxDatabase } from "@aervox/database";
import { buildApp } from "../src/app.js";
import { derivePetSheetState } from "../src/modules/tools/mcp.js";
import type { FastifyInstance } from "fastify";
import type { Client } from "@libsql/client";

const headers = {
  "x-workspace-id": "ws_it",
  "x-user-id": "usr_it",
} as const;

describe("Codex Pets 兼容：工具结果 → 桌宠状态行", () => {
  it("成功调用派生 waving（行 3，Codex Pets 9 态之一）", () => {
    expect(derivePetSheetState({ isError: false })).toBe("waving");
  });
  it("失败调用派生 failed（行 5，9 态之一）", () => {
    expect(derivePetSheetState({ isError: true })).toBe("failed");
  });
});

describe("T-04/PET-05 工具系统接线", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
    await initDatabaseSchema(client);
    const built = await buildApp({ db, client });
    app = built.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  it("内置 MemoryStoreTool 已注册且 read_only 之外需授权", async () => {
    const list = await app.inject({ method: "GET", url: "/v1/tools" });
    expect(list.statusCode).toBe(200);
    const names = list.json().items.map((t: { name: string }) => t.name);
    expect(names).toContain("aervox_memory_store");
  });

  it("B3 replay 声明透传：POST /v1/tools 支持 safe/never，非法值 400", async () => {
    const safe = await app.inject({
      method: "POST",
      url: "/v1/tools",
      headers,
      payload: { id: "b3_tool_safe", name: "b3_tool_safe", description: "可合成", category: "system", replay: "safe" },
    });
    expect(safe.statusCode).toBe(201);
    expect(safe.json().replay).toBe("safe");

    const never = await app.inject({
      method: "POST",
      url: "/v1/tools",
      headers,
      payload: { id: "b3_tool_never", name: "b3_tool_never", description: "不可重放", category: "system", replay: "never" },
    });
    expect(never.statusCode).toBe(201);
    expect(never.json().replay).toBe("never");

    // 省略 → 未声明（fail-closed）
    const omitted = await app.inject({
      method: "POST",
      url: "/v1/tools",
      headers,
      payload: { id: "b3_tool_unset", name: "b3_tool_unset", description: "未声明", category: "system" },
    });
    expect(omitted.statusCode).toBe(201);
    expect(omitted.json().replay ?? null).toBeNull();

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/tools",
      headers,
      payload: { id: "b3_tool_bad", name: "b3_tool_bad", description: "非法", category: "system", replay: "maybe" },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("MemoryStoreTool 未授权调用被拒（write_with_approval）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/aervox_memory_store/call",
      headers,
      payload: { arguments: { content: "用户喜欢夜晚学习", source: "user_said" } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().isError).toBe(true);
  });

  it("MemoryStoreTool 授权调用写入长期记忆（user_said → verified）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tools/aervox_memory_store/call",
      headers,
      payload: {
        arguments: { content: "用户喜欢夜晚学习", source: "user_said", category: "preference", keywords: ["夜晚", "学习"] },
        approval: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isError).toBeUndefined();
    const text = res.json().content[0].text as string;
    const result = JSON.parse(text) as { memoryId: string; isCandidate: boolean };
    expect(result.memoryId).toBeTruthy();
    expect(result.isCandidate).toBe(false);

    const memories = await app.inject({
      method: "GET",
      url: "/v1/memory/nodes",
      headers,
    });
    expect(memories.statusCode).toBe(200);
  });

  it("注册 + 启停工具", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/tools",
      payload: {
        id: "test_pet_tool_read",
        name: "test_pet_tool_read",
        description: "读取宠物状态（演示）",
        category: "system",
        safetyLevel: "read_only",
      },
    });
    expect(create.statusCode).toBe(201);

    const disable = await app.inject({
      method: "PATCH",
      url: "/v1/tools/test_pet_tool_read",
      payload: { enabled: false },
    });
    expect(disable.statusCode).toBe(200);
    expect(disable.json().enabled).toBe(0);
  });
});

describe("CAP-020 插件运行时", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
    await initDatabaseSchema(client);
    const built = await buildApp({ db, client });
    app = built.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  it("安装插件（含工具声明）→ 启停联动 → 卸载联动", async () => {
    const install = await app.inject({
      method: "POST",
      url: "/v1/plugins",
      payload: {
        id: "pet-skill-pack",
        publisher: "aervox-labs",
        version: "0.1.0",
        permissions: ["memory:read"],
        tools: [
          {
            name: "pet_tip",
            description: "返回一条宠物学习小贴士",
            category: "learning",
            safetyLevel: "read_only",
          },
        ],
      },
    });
    expect(install.statusCode, install.body).toBe(201);

    // 工具随插件注册（name 保留插件内名，id 带插件前缀）
    const tools = await app.inject({ method: "GET", url: "/v1/tools" });
    const toolNames = tools.json().items.map((t: { name: string }) => t.name);
    expect(toolNames).toContain("pet_tip");
    const toolIds = tools.json().items.map((t: { id: string }) => t.id);
    expect(toolIds).toContain("pet-skill-pack.pet_tip");

    // 停用插件 → 工具联动禁用
    await app.inject({
      method: "PATCH",
      url: "/v1/plugins/pet-skill-pack",
      payload: { enabled: false },
    });
    const afterDisable = await app.inject({ method: "GET", url: "/v1/tools" });
    const disabledTool = afterDisable.json().items.find(
      (t: { name: string }) => t.name === "pet_tip",
    );
    expect(disabledTool.enabled).toBe(0);

    // 卸载 → 工具注销
    const uninstall = await app.inject({
      method: "DELETE",
      url: "/v1/plugins/pet-skill-pack",
    });
    expect(uninstall.statusCode).toBe(204);
    const afterUninstall = await app.inject({ method: "GET", url: "/v1/tools" });
    const remaining = afterUninstall.json().items.filter(
      (t: { name: string }) => t.name === "pet-skill-pack.pet_tip",
    );
    expect(remaining).toHaveLength(0);
  });

  it("权限授予/撤销/查询", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/plugins",
      payload: { id: "perm-demo", publisher: "aervox-labs", version: "1.0.0" },
    });
    const grant = await app.inject({
      method: "POST",
      url: "/v1/plugins/perm-demo/grants",
      headers,
      payload: { permission: "memory:read", scope: "self" },
    });
    expect(grant.statusCode).toBe(201);

    const ok = await app.inject({
      method: "GET",
      url: "/v1/plugins/perm-demo/permissions/memory:read",
      headers,
    });
    expect(ok.json().granted).toBe(true);

    const revoke = await app.inject({
      method: "DELETE",
      url: `/v1/plugins/perm-demo/grants/${grant.json().id}`,
      headers,
    });
    expect(revoke.statusCode).toBe(200);
  });
});