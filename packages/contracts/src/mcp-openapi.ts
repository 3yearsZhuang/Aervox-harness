/** MCP 契约注册；Schema 与路径分阶段接入同一个内核 registry，保留生成顺序。 */
import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { mcpToolSchema } from "./persona-schemas.js";
import {
  mcpPresetServerSchema,
  mcpServerConfigSchema,
  mcpConnectServerRequestSchema,
  mcpServerToolEntrySchema,
} from "./mcp-schemas.js";

export function registerMcpOpenApiSchemas(registry: OpenAPIRegistry): void {
  registry.register("McpTool", mcpToolSchema);
  registry.register("McpPresetServer", mcpPresetServerSchema);
  registry.register("McpServerConfig", mcpServerConfigSchema);
  registry.register("McpServerToolEntry", mcpServerToolEntrySchema);
}

export function registerMcpOpenApiPaths(registry: OpenAPIRegistry, commonHeaders: z.ZodObject): void {
  registry.registerPath({ method: "get", path: "/v1/mcp/tools", summary: "列出 MCP 工具", tags: ["MCP"], request: { headers: commonHeaders }, responses: { 200: { description: "MCP tools", content: { "application/json": { schema: z.object({ tools: z.array(mcpToolSchema) }) } } } } });
  registry.registerPath({ method: "get", path: "/v1/mcp/presets", summary: "列出预设 MCP 服务器（含本机接入状态）", tags: ["MCP"], responses: { 200: { description: "Presets", content: { "application/json": { schema: z.object({ presets: z.array(mcpPresetServerSchema) }) } } } } });
  registry.registerPath({ method: "get", path: "/v1/mcp/servers", summary: "列出已配置 MCP 服务器（token 脱敏）", tags: ["MCP"], responses: { 200: { description: "Servers", content: { "application/json": { schema: z.object({ servers: z.array(mcpServerConfigSchema) }) } } } } });
  registry.registerPath({ method: "get", path: "/v1/mcp/servers/{serverId}/tools", summary: "列出 MCP 服务器已同步工具", tags: ["MCP"], request: { params: z.object({ serverId: z.string().min(1) }) }, responses: { 200: { description: "Tools", content: { "application/json": { schema: z.object({ tools: z.array(mcpServerToolEntrySchema) }) } } }, 404: { description: "MCP server not connected" } } });
  registry.registerPath({ method: "post", path: "/v1/mcp/servers/{serverId}/connect", summary: "接入预设 MCP 服务器（携带 Token 并同步工具）", tags: ["MCP"], request: { params: z.object({ serverId: z.string().min(1) }), body: { content: { "application/json": { schema: mcpConnectServerRequestSchema } } } }, responses: { 200: { description: "Connected", content: { "application/json": { schema: z.object({ server: mcpServerConfigSchema }) } } }, 404: { description: "Unknown preset" }, 502: { description: "MCP_UPSTREAM_ERROR" } } });
  registry.registerPath({ method: "post", path: "/v1/mcp/servers/{serverId}/sync", summary: "重新同步 MCP 服务器工具", tags: ["MCP"], request: { params: z.object({ serverId: z.string().min(1) }) }, responses: { 200: { description: "Synced", content: { "application/json": { schema: z.object({ server: mcpServerConfigSchema }) } } }, 404: { description: "MCP server not connected" }, 502: { description: "MCP_UPSTREAM_ERROR" } } });
  registry.registerPath({ method: "post", path: "/v1/mcp/servers/{serverId}/disconnect", summary: "断开 MCP 服务器并注销同步工具", tags: ["MCP"], request: { params: z.object({ serverId: z.string().min(1) }) }, responses: { 200: { description: "Disconnected", content: { "application/json": { schema: z.object({ server: mcpServerConfigSchema }) } } }, 404: { description: "MCP server not connected" } } });
  registry.registerPath({ method: "get", path: "/v1/mcp/dsh", summary: "DSH 本地 MCP 服务端点探活", tags: ["MCP"], responses: { 200: { description: "DSH MCP server info", content: { "application/json": { schema: z.object({ status: z.string(), server: z.string(), protocolVersion: z.string() }) } } } } });
  const dshRpcRequestSchema = z.object({
    jsonrpc: z.string().optional(),
    id: z.union([z.number(), z.string(), z.null()]).optional(),
    method: z.string(),
    params: z.record(z.string(), z.unknown()).optional(),
  });

  const dshRpcResponseSchema = z.object({
    jsonrpc: z.string(),
    id: z.union([z.number(), z.string(), z.null()]),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.number(),
        message: z.string(),
        data: z.unknown().optional(),
      })
      .optional(),
  });

  registry.registerPath({
    method: "post",
    path: "/v1/mcp/dsh",
    summary: "DSH 本地 MCP Streamable HTTP JSON-RPC 2.0 端点",
    tags: ["MCP"],
    request: {
      body: {
        content: {
          "application/json": {
            schema: dshRpcRequestSchema,
          },
        },
      },
    },
    responses: {
      200: {
        description: "JSON-RPC response",
        content: {
          "application/json": {
            schema: dshRpcResponseSchema,
          },
        },
      },
    },
  });
}
