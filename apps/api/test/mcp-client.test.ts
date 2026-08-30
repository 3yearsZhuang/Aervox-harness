/**
 * Aervox｜思隅 @aervox/api — MCP 客户端单测（JSON-RPC 解析 / SSE 提取 / 安全分级 / 脱敏）
 */
import { describe, expect, it } from "vitest";
import {
  McpHttpClient,
  McpUpstreamError,
  extractRpcResponse,
} from "../src/modules/mcp/client.js";
import { classifyToolSafety, maskToken, mcpToolId } from "../src/modules/mcp/service.js";

describe("extractRpcResponse（SSE 响应提取）", () => {
  it("从多条 data 行中提取与请求 id 匹配的 JSON-RPC 响应", () => {
    const sse = [
      ": ping",
      'data: {"jsonrpc":"2.0","method":"notifications/progress"}',
      'data: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}',
    ].join("\n");
    const parsed = extractRpcResponse(sse, 1);
    expect(parsed?.result).toEqual({ tools: [] });
  });

  it("无匹配 id 时返回 undefined", () => {
    expect(extractRpcResponse('data: {"jsonrpc":"2.0","id":9,"result":{}}', 1)).toBeUndefined();
    expect(extractRpcResponse("event: message", 1)).toBeUndefined();
  });
});

describe("McpHttpClient", () => {
  it("JSON 响应：initialize 握手一次 + tools/list 解析", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      calls.push(body.method);
      const result =
        body.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mock" } }
          : body.method === "tools/list"
            ? { tools: [{ name: "query-meals", description: "菜单" }] }
            : undefined;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new McpHttpClient({ endpointUrl: "https://mcp.test", token: "t0k", fetchImpl });
    await client.initialize();
    await client.initialize(); // 幂等：每实例仅握手一次
    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(calls.filter((m) => m === "initialize")).toHaveLength(1);
    expect(calls).toContain("notifications/initialized");
  });

  it("SSE 响应：text/event-stream 按 data 行解析 tools/list", async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      if (body.method !== "tools/list") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const sse = `event: message\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: [{ name: "campaign-calendar" }] },
      })}\n\n`;
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const client = new McpHttpClient({ endpointUrl: "https://mcp.test", fetchImpl });
    await client.initialize();
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["campaign-calendar"]);
  });

  it("401/429/JSON-RPC 错误映射为 McpUpstreamError", async () => {
    const fetchImpl = (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      if (body.method === "initialize" && statusMode === "unauthorized") {
        return new Response("unauthorized", { status: 401 });
      }
      if (body.method === "initialize" && statusMode === "limited") {
        return new Response("too many", { status: 429 });
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32000, message: "bad request params" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    let statusMode = "unauthorized";
    const client = new McpHttpClient({ endpointUrl: "https://mcp.test", fetchImpl });
    await expect(client.initialize()).rejects.toThrow(/401/);

    statusMode = "limited";
    const client2 = new McpHttpClient({ endpointUrl: "https://mcp.test", fetchImpl });
    await expect(client2.initialize()).rejects.toThrow(/429/);

    statusMode = "ok";
    const client3 = new McpHttpClient({ endpointUrl: "https://mcp.test", fetchImpl });
    await expect(client3.callTool("x", {})).rejects.toBeInstanceOf(McpUpstreamError);
  });

  it("Bearer Token 写入 Authorization 头", async () => {
    let authHeader: string | undefined;
    const fetchImpl = (async (_input, init) => {
      authHeader = (init?.headers as Record<string, string>).Authorization;
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const client = new McpHttpClient({
      endpointUrl: "https://mcp.test",
      token: "secret-token",
      fetchImpl,
    });
    await client.initialize();
    expect(authHeader).toBe("Bearer secret-token");
  });
});

describe("classifyToolSafety（PET-05 保守分级）", () => {
  it("官方查询/列表类工具 → read_only", () => {
    for (const name of [
      "list-nutrition-foods",
      "query-meals",
      "delivery-query-addresses",
      "query-nearby-stores",
      "campaign-calendar",
      "available-coupons",
      "query-my-account",
      "mall-points-products",
      "mall-order-list",
      "now-time-info",
      "calculate-price",
    ]) {
      expect(classifyToolSafety(name)).toBe("read_only");
    }
  });

  it("下单/领券/写地址等副作用工具 → write_with_approval", () => {
    for (const name of [
      "create-order",
      "delivery-create-address",
      "auto-bind-coupons",
      "mall-create-order",
      "mall-create-order-physical",
      "anything-unknown",
    ]) {
      expect(classifyToolSafety(name)).toBe("write_with_approval");
    }
  });
});

describe("maskToken / mcpToolId", () => {
  it("脱敏保留首尾、短 token 全打码、空值透传", () => {
    expect(maskToken("abcd1234wxyz")).toBe("abcd****wxyz");
    expect(maskToken("short")).toBe("****");
    expect(maskToken(null)).toBeNull();
    expect(maskToken(undefined)).toBeNull();
  });

  it("工具命名空间：mcp__<serverId>__<toolName>", () => {
    expect(mcpToolId("mcd-mcp", "create-order")).toBe("mcp__mcd-mcp__create-order");
  });
});
