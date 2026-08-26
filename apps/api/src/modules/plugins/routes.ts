/**
 * Aervox｜思隅 @aervox/api — 插件运行时路由（CAP-020）
 *
 * - POST   /v1/plugins                安装插件（登记 + 工具注册联动）；
 * - GET    /v1/plugins                列出插件；
 * - PATCH  /v1/plugins/:id            启停（联动工具）；
 * - DELETE /v1/plugins/:id            卸载（注销工具 + 删插件）；
 * - POST   /v1/plugins/:id/grants     授予权限；
 * - DELETE /v1/plugins/:id/grants/:grantId 撤销权限；
 * - GET    /v1/plugins/:id/permissions/:permission 查询权限。
 */
import type { FastifyInstance } from "fastify";
import { resolveTenant } from "../../shared/tenant.js";
import type { PluginService } from "./service.js";

let seq = 0;
const id = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}_${(++seq).toString(36)}`;

export function registerPluginRoutes(app: FastifyInstance, service: PluginService): void {
  // 安装
  app.post("/v1/plugins", async (req, reply) => {
    const body = (req.body ?? {}) as {
      id?: string;
      publisher?: string;
      version?: string;
      checksum?: string;
      signature?: string | null;
      permissions?: unknown;
      installSource?: string;
      tools?: unknown;
    };
    if (
      !body.id ||
      !body.publisher ||
      !body.version
    ) {
      return reply.code(400).send({ error: "id/publisher/version are required" });
    }
    const plugin = await service.installPlugin({
      id: body.id,
      publisher: body.publisher,
      version: body.version,
      checksum: body.checksum,
      signature: body.signature,
      permissions: body.permissions,
      installSource: body.installSource,
      tools: (body.tools ?? undefined) as never,
    });
    return reply.code(201).send(plugin);
  });

  // 列出
  app.get("/v1/plugins", async () => {
    const rows = await service.listPlugins();
    return { items: rows };
  });

  // 启停
  app.patch("/v1/plugins/:id", async (req, reply) => {
    const { id: pluginId } = req.params as { id: string };
    const body = (req.body ?? {}) as { enabled?: boolean };
    if (typeof body.enabled !== "boolean") {
      return reply.code(400).send({ error: "enabled is required" });
    }
    const plugin = await service.setEnabled(pluginId, body.enabled);
    if (!plugin) return reply.code(404).send({ error: "plugin not found" });
    return plugin;
  });

  // 卸载
  app.delete("/v1/plugins/:id", async (req, reply) => {
    const { id: pluginId } = req.params as { id: string };
    const ok = await service.uninstallPlugin(pluginId);
    if (!ok) return reply.code(404).send({ error: "plugin not found" });
    return reply.code(204).send();
  });

  // 授予权限
  app.post("/v1/plugins/:id/grants", async (req, reply) => {
    const { id: pluginId } = req.params as { id: string };
    const tenant = resolveTenant(req);
    const body = (req.body ?? {}) as { permission?: string; scope?: string };
    if (!body.permission || !body.scope) {
      return reply.code(400).send({ error: "permission/scope are required" });
    }
    const grant = await service.grant(tenant, {
      id: id("grant"),
      pluginId,
      permission: body.permission,
      scope: body.scope,
    });
    return reply.code(201).send(grant);
  });

  // 撤销权限
  app.delete("/v1/plugins/:id/grants/:grantId", async (req, reply) => {
    const { grantId } = req.params as { id: string; grantId: string };
    const tenant = resolveTenant(req);
    const grant = await service.revoke(tenant, grantId);
    if (!grant) return reply.code(404).send({ error: "grant not found" });
    return grant;
  });

  // 查询权限
  app.get("/v1/plugins/:id/permissions/:permission", async (req, reply) => {
    const { id: pluginId, permission } = req.params as {
      id: string;
      permission: string;
    };
    const tenant = resolveTenant(req);
    const has = await service.hasPermission(tenant, pluginId, permission);
    return { pluginId, permission, granted: has };
  });
}