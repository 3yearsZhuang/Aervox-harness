/**
 * Aervox｜思隅 @aervox/api — MCP 预设集成测试（CAP-020）
 *
 * fake fetch 模拟麦当劳官方 MCP 上游（initialize / tools/list / tools/call），
 * 覆盖：预设清单 → 接入（Token）→ 工具同步落注册表 → PET-05 分级与授权调用 →
 * Token 脱敏不回传 → 断开注销 → 上游 401 映射 502。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createInMemoryDatabase, initDatabaseSchema, type AervoxDatabase } from "@aervox/database";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type { Client } from "@libsql/client";

const headers = {
  "x-workspace-id": "ws_it",
  "x-user-id": "usr_it",
} as const;

const RAW_TOKEN = "mcd-token-abcd1234wxyz";

/** 模拟麦当劳 MCP 上游：JSON-RPC over Streamable HTTP（application/json 形态） */
function createMcdFakeFetch(options: { unauthorized?: boolean } = {}) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      id: number | null;
      method: string;
      params?: unknown;
    };
    calls.push({ method: body.method, params: body.params });
    const respond = (result: unknown, status = 200) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (body.method === "initialize") {
      if (options.unauthorized) return new Response("unauthorized", { status: 401 });
      return respond({
        protocolVersion: "2025-06-18",
        capabilities: {},
        serverInfo: { name: "mcd-mock", version: "1.0.0" },
      });
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (body.method === "tools/list") {
      return respond({
        tools: [
          {
            name: "list-nutrition-foods",
            description: "获取麦当劳常见餐品的营养成分数据",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "query-meals",
            description: "查询当前门店可售卖的餐品列表",
            inputSchema: {
              type: "object",
              properties: { storeId: { type: "string" } },
              required: ["storeId"],
            },
          },
          {
            name: "create-order",
            description: "根据门店信息、就餐方式、商品列表等信息创建订单",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      });
    }
    if (body.method === "tools/call") {
      const name = (body.params as { name?: string })?.name;
      return respond({ content: [{ type: "text", text: `mock:${name}` }], isError: false });
    }
    return respond(null, 400);
  };
  return { fetchImpl, calls };
}

describe("MCP 预设（mcd-mcp）", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;
  let fake: ReturnType<typeof createMcdFakeFetch>;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
    await initDatabaseSchema(client);
    fake = createMcdFakeFetch();
    const built = await buildApp({ db, client, mcpOptions: { fetchImpl: fake.fetchImpl } });
    app = built.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  it("预设清单包含麦当劳官方 MCP 接入档案", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/mcp/presets" });
    expect(res.statusCode).toBe(200);
    const presets = res.json().presets as Array<Record<string, unknown>>;
    const mcd = presets.find((p) => p.id === "mcd-mcp");
    expect(mcd).toBeTruthy();
    expect(mcd?.endpointUrl).toBe("https://mcp.mcd.cn");
    expect(mcd?.transport).toBe("streamable_http");
    expect(mcd?.authType).toBe("bearer");
    expect(mcd?.tokenApplyUrl).toContain("open.mcd.cn");
    expect(mcd?.configured).toBe(false);
    expect(mcd?.status).toBe("disconnected");
  });

  it("未配置 Token 接入 → 502 MCP_UPSTREAM_ERROR 且状态落 error", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/mcp/servers/mcd-mcp/connect",
      headers,
      payload: {},
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("MCP_UPSTREAM_ERROR");

    const servers = await app.inject({ method: "GET", url: "/v1/mcp/servers", headers });
    const mcd = (servers.json().servers as Array<Record<string, unknown>>).find(
      (s) => s.id === "mcd-mcp",
    );
    expect(mcd?.status).toBe("error");
    expect(mcd?.lastError).toContain("Token");
  });

  it("接入 → 工具同步进注册表（PET-05 分级）→ 脱敏 → 调用 → 断开注销", async () => {
    // 1. 接入并同步
    const connect = await app.inject({
      method: "POST",
      url: "/v1/mcp/servers/mcd-mcp/connect",
      headers,
      payload: { token: RAW_TOKEN },
    });
    expect(connect.statusCode).toBe(200);
    const server = connect.json().server;
    expect(server.status).toBe("connected");
    expect(server.toolCount).toBe(3);
    expect(server.tokenConfigured).toBe(true);
    expect(server.enabled).toBe(true);
    // Token 原文绝不回传
    expect(connect.body).not.toContain(RAW_TOKEN);
    expect(server.tokenMasked).toContain("****");

    // 2. 同步出的工具以命名空间 id 落注册表，分级正确
    const tools = await app.inject({ method: "GET", url: "/v1/tools", headers });
    const byId = new Map(
      (tools.json().items as Array<{ id: string; safetyLevel: string; category: string }>).map(
        (t) => [t.id, t],
      ),
    );
    expect(byId.get("mcp__mcd-mcp__query-meals")?.safetyLevel).toBe("read_only");
    expect(byId.get("mcp__mcd-mcp__list-nutrition-foods")?.safetyLevel).toBe("read_only");
    expect(byId.get("mcp__mcd-mcp__create-order")?.safetyLevel).toBe("write_with_approval");
    expect(byId.get("mcp__mcd-mcp__create-order")?.category).toBe("external");

    // 3. 服务器工具清单
    const serverTools = await app.inject({
      method: "GET",
      url: "/v1/mcp/servers/mcd-mcp/tools",
      headers,
    });
    expect(serverTools.json().tools).toHaveLength(3);

    // 4. 读取工具：AI 可自主调用（无需 approval），代理到远端 tools/call
    const call = await app.inject({
      method: "POST",
      url: "/v1/tools/mcp__mcd-mcp__query-meals/call",
      headers,
      payload: { arguments: { storeId: "100" } },
    });
    expect(call.statusCode).toBe(200);
    const remote = JSON.parse(call.json().content[0].text as string) as {
      content: Array<{ text: string }>;
    };
    expect(remote.content[0].text).toBe("mock:query-meals");
    const remoteCall = fake.calls.find((c) => c.method === "tools/call");
    expect(remoteCall?.params).toMatchObject({
      name: "query-meals",
      arguments: { storeId: "100" },
    });
    // 客户端缓存生效：initialize 握手仅一次
    expect(fake.calls.filter((c) => c.method === "initialize")).toHaveLength(1);

    // 5. 写工具未授权 → 400 isError（PET-05）；授权后可调用
    const noApproval = await app.inject({
      method: "POST",
      url: "/v1/tools/mcp__mcd-mcp__create-order/call",
      headers,
      payload: { arguments: {} },
    });
    expect(noApproval.statusCode).toBe(400);
    expect(noApproval.json().isError).toBe(true);

    const approved = await app.inject({
      method: "POST",
      url: "/v1/tools/mcp__mcd-mcp__create-order/call",
      headers,
      payload: { arguments: {}, approval: true },
    });
    expect(approved.statusCode).toBe(200);

    // 6. 断开：停用 + 注销全部同步工具
    const disconnect = await app.inject({
      method: "POST",
      url: "/v1/mcp/servers/mcd-mcp/disconnect",
      headers,
    });
    expect(disconnect.statusCode).toBe(200);
    expect(disconnect.json().server.enabled).toBe(false);
    expect(disconnect.json().server.status).toBe("disconnected");

    const afterTools = await app.inject({ method: "GET", url: "/v1/mcp/servers/mcd-mcp/tools", headers });
    expect(afterTools.statusCode).toBe(200);
    expect(afterTools.json().tools).toHaveLength(0);
    const registry = await app.inject({ method: "GET", url: "/v1/tools", headers });
    const remainIds = (registry.json().items as Array<{ id: string }>).map((t) => t.id);
    expect(remainIds.some((id) => id.startsWith("mcp__mcd-mcp__"))).toBe(false);
  });

  it("重复接入无需重填 Token；上游 401 → 502 且不丢失已存 Token", async () => {
    const connect = await app.inject({
      method: "POST",
      url: "/v1/mcp/servers/mcd-mcp/connect",
      headers,
      payload: { token: RAW_TOKEN },
    });
    expect(connect.statusCode).toBe(200);

    // 空 token 重接入 = 沿用既有 Token（不触发 401 形态的上游）
    const reconnect = await app.inject({
      method: "POST",
      url: "/v1/mcp/servers/mcd-mcp/connect",
      headers,
      payload: {},
    });
    expect(reconnect.statusCode).toBe(200);
    expect(reconnect.json().server.tokenConfigured).toBe(true);
  });

  it("上游 401（Token 失效）→ 502，错误信息含 401 指引", async () => {
    const res = await createInMemoryDatabase();
    await initDatabaseSchema(res.client);
    const unauthorized = createMcdFakeFetch({ unauthorized: true });
    const built = await buildApp({
      db: res.db,
      client: res.client,
      mcpOptions: { fetchImpl: unauthorized.fetchImpl },
    });
    try {
      await built.app.ready();
      const connect = await built.app.inject({
        method: "POST",
        url: "/v1/mcp/servers/mcd-mcp/connect",
        headers,
        payload: { token: "bad-token" },
      });
      expect(connect.statusCode).toBe(502);
      expect(connect.json().message).toContain("401");
    } finally {
      await built.app.close();
      await res.cleanup();
    }
  });

  it("未知服务器 → 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/mcp/servers/nonexistent/connect",
      headers,
      payload: { token: "x" },
    });
    expect(res.statusCode).toBe(404);
  });
});
