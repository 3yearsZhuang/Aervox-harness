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
