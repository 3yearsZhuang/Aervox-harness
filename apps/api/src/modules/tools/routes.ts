/**
 * Aervox｜思隅 @aervox/api — 工具注册表路由（T-04 / AST-04 / PET-05 接线）
 *
 * 面向管理与 AI 运行时：
 * - GET    /v1/tools              注册表全量（含 enabled/gating/safety）；
 * - POST   /v1/tools              注册工具（幂等）；
 * - GET    /v1/tools/export       导出运行时可调用快照（enabled + 门控过滤）；
 * - PATCH  /v1/tools/:id          启停（enabled 开关）；
 * - DELETE /v1/tools/:id          注销（内置工具拒绝）；
 * - POST   /v1/tools/:id/call     调用（PET-05 安全级别在运行时强制）。
 */
import type { FastifyInstance } from "fastify";
import type { ToolRuntime } from "./runtime.js";
import { listTools as mcplList, callTool as mcplCall } from "./mcp.js";
import { resolveTenant } from "../../shared/tenant.js";

export function registerToolRoutes(app: FastifyInstance, runtime: ToolRuntime): void {
  // 列出注册表全量
  app.get("/v1/tools", async () => ({ items: await runtime.listTools() }));

  // 导出运行时可调用快照
  app.get("/v1/tools/export", async (req) => {
    const { category, disabled } = (req.query ?? {}) as {
      category?: string;
      disabled?: string;
    };
    const items = await runtime.exportRegistry({
      category,
      disabledToolIds: disabled ? String(disabled).split(",").filter(Boolean) : undefined,
    });
    return { tools: items, disabledToolIds: [], exportVersion: Date.now() };
  });

  // 注册工具（幂等：同 id 覆盖元数据，enabled 保持）
  app.post("/v1/tools", async (req, reply) => {
    const body = (req.body ?? {}) as {
      id?: string;
      name?: string;
      description?: string;
      category?: string;
      safetyLevel?: string;
      requiredPermissions?: unknown;
      inputSchema?: unknown;
      builtin?: boolean;
      pluginId?: string | null;
      gatingConditions?: unknown;
      priority?: number;
    };
    if (!body.id || !body.name || !body.description) {
      return reply.code(400).send({ error: "id/name/description are required" });
    }
    const tool = await runtime.registerTool({
      id: body.id,
      name: body.name,
      description: body.description,
      category: body.category ?? "memory",
      safetyLevel: body.safetyLevel,
      requiredPermissions: body.requiredPermissions,
      inputSchema: body.inputSchema,
      builtin: body.builtin,
      pluginId: body.pluginId ?? null,
      gatingConditions: body.gatingConditions,
      priority: body.priority,
    });
    return reply.code(201).send(tool);
  });

  // 启停
  app.patch("/v1/tools/:id", async (req, reply) => {
    const { id } = (req.params as { id: string });
    const body = (req.body ?? {}) as { enabled?: boolean };
    if (typeof body.enabled !== "boolean") {
      return reply.code(400).send({ error: "enabled is required" });
    }
    const tool = await runtime.setEnabled(id, body.enabled);
    if (!tool) return reply.code(404).send({ error: "tool not found" });
    return tool;
  });

  // 注销（内置拒绝）
  app.delete("/v1/tools/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await runtime.unregisterTool(id);
    if (!ok) return reply.code(409).send({ error: "unregister failed（内置工具不可注销或不存在）" });
    return reply.code(204).send();
  });

  // 调用（MCP 形态）
  app.post("/v1/tools/:id/call", async (req, reply) => {
    const { id } = req.params as { id: string };
    const tenant = resolveTenant(req);
    const body = (req.body ?? {}) as { arguments?: unknown; approval?: boolean };
    const result = await mcplCall(runtime, tenant, { name: id, ...body });
    if (result.isError) return reply.code(400).send(result);
    return result;
  });

  // MCP 形态列表（供运行时探测）
  app.get("/v1/tools/mcp/list", async () => mcplList(runtime));
}