import { z } from "zod";
import type { ApiEndpoint } from "./http-api.js";
import { mcpPresetServerSchema, mcpServerConfigSchema, mcpServerToolEntrySchema, mcpConnectServerRequestSchema } from "./mcp-schemas.js";
export const mcpApi = {
  presets: { method: "get", path: "/v1/mcp/presets", operationId: "mcp_presets", summary: "MCP presets", tags: ["MCP"], response: z.object({ presets: z.array(mcpPresetServerSchema) }) },
  servers: { method: "get", path: "/v1/mcp/servers", operationId: "mcp_servers", summary: "MCP servers", tags: ["MCP"], response: z.object({ servers: z.array(mcpServerConfigSchema) }) },
  tools: { method: "get", path: "/v1/mcp/servers/{serverId}/tools", operationId: "mcp_tools", summary: "MCP tools", tags: ["MCP"], response: z.object({ tools: z.array(mcpServerToolEntrySchema) }), params: z.object({ serverId: z.string().min(1) }), errors: {"404":"MCP server not connected"} },
  connect: { method: "post", path: "/v1/mcp/servers/{serverId}/connect", operationId: "mcp_connect", summary: "MCP connect", tags: ["MCP"], response: z.object({ server: mcpServerConfigSchema }), body: mcpConnectServerRequestSchema.optional(), params: z.object({ serverId: z.string().min(1) }), errors: {"404":"MCP server not connected","502":"MCP_UPSTREAM_ERROR"} },
  sync: { method: "post", path: "/v1/mcp/servers/{serverId}/sync", operationId: "mcp_sync", summary: "MCP sync", tags: ["MCP"], response: z.object({ server: mcpServerConfigSchema }), params: z.object({ serverId: z.string().min(1) }), errors: {"404":"MCP server not connected","502":"MCP_UPSTREAM_ERROR"} },
  disconnect: { method: "post", path: "/v1/mcp/servers/{serverId}/disconnect", operationId: "mcp_disconnect", summary: "MCP disconnect", tags: ["MCP"], response: z.object({ server: mcpServerConfigSchema }), params: z.object({ serverId: z.string().min(1) }), errors: {"404":"MCP server not connected"} },
} as const satisfies Record<string, ApiEndpoint>;
