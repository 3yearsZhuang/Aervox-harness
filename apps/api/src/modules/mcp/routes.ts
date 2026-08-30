/**
 * Aervox｜思隅 @aervox/api — MCP 预设路由（CAP-020）
 *
 * - GET  /v1/mcp/presets                    预设 MCP 服务器清单（含本机接入状态）
 * - GET  /v1/mcp/servers                    已配置服务器（token 脱敏，不回传原文）
 * - GET  /v1/mcp/servers/:serverId/tools    服务器内已同步工具
 * - POST /v1/mcp/servers/:serverId/connect  接入（body: { token? }）并同步工具
 * - POST /v1/mcp/servers/:serverId/sync     重新同步工具
 * - POST /v1/mcp/servers/:serverId/disconnect 断开并注销同步工具
 *
 * 上游失败（无法连接 / 401 / 429）统一映射 502 MCP_UPSTREAM_ERROR；
 * 服务器配置状态仍落库（status=error + lastError）供 UI 展示。
 */
import type { FastifyInstance } from "fastify";
import { McpUpstreamError } from "./client.js";
import type { McpService } from "./service.js";

export function registerMcpRoutes(app: FastifyInstance, service: McpService): void {
  app.get("/v1/mcp/presets", async () => ({ presets: await service.listPresets() }));

  app.get("/v1/mcp/servers", async () => ({ servers: await service.listServers() }));

  app.get("/v1/mcp/servers/:serverId/tools", async (req, reply) => {
    const { serverId } = req.params as { serverId: string };
    try {
      return { tools: await service.listServerTools(serverId) };
    } catch (err) {
      return mapServiceError(reply, err);
    }
  });

  app.post("/v1/mcp/servers/:serverId/connect", async (req, reply) => {
    const { serverId } = req.params as { serverId: string };
    const body = (req.body ?? {}) as { token?: string };
    try {
      const server = await service.connectServer(serverId, body.token);
      return { server };
    } catch (err) {
      return mapServiceError(reply, err);
    }
  });

  app.post("/v1/mcp/servers/:serverId/sync", async (req, reply) => {
    const { serverId } = req.params as { serverId: string };
    try {
      const server = await service.syncServer(serverId);
      return { server };
    } catch (err) {
      return mapServiceError(reply, err);
    }
  });

  app.post("/v1/mcp/servers/:serverId/disconnect", async (req, reply) => {
    const { serverId } = req.params as { serverId: string };
    try {
      const server = await service.disconnectServer(serverId);
      return { server };
    } catch (err) {
      return mapServiceError(reply, err);
    }
  });
}

function mapServiceError(reply: {
  code: (statusCode: number) => { send: (payload: unknown) => unknown };
}, err: unknown): unknown {
  if (err instanceof McpUpstreamError) {
    return reply.code(502).send({ error: "MCP_UPSTREAM_ERROR", message: err.message });
  }
  throw err;
}
